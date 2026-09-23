#!/usr/bin/env node
//
// Downloads candidate reference photos, measures them, and stitches a labelled
// contact sheet so a person can look at all of them at once.
//
//   node --experimental-strip-types scripts/autoboard/review-candidates.mjs <candidates.json> [--out <dir>]
//
// Why this exists: a scraper can verify that a URL returns HTTP 200 with an
// image content type, and that check passes things that are not a picture of
// the product. Caught this way on 651 Belmont alone: an Energy Guide label, a
// CDN placeholder card, chrome shots filed under matte-black SKUs, "What's in
// the Box" marketing graphics, a hexagon mosaic sold as a square one, and a
// freezer drawer full of food standing in for a refrigerator. Nothing short of
// looking catches those, so this makes looking cheap.
//
// Input is the shape the image manifest uses, keyed by imageKey:
//   { "<key>": { "note": "...", "images": [{ "url": "...", "kind": "face" }] } }
// Output is <out>/files/<key>-<n>.<ext>, <out>/sheets/<name>.png, and a
// <name>-verified.json carrying each file's real dimensions, bytes and sha256 —
// the fields scripts/autoboard/projects/<project>-images.json wants.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import sharp from "sharp";

import { downloadImage } from "./lib/download-image.mjs";

const EXTENSION_BY_TYPE = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/avif": ".avif" };
const TILE = 330;
const LABEL = 30;
const COLUMNS = 4;

const { values, positionals } = parseArgs({ options: { out: { type: "string" } }, allowPositionals: true });
const source = positionals[0];
if (!source) {
  console.error("usage: node --experimental-strip-types scripts/autoboard/review-candidates.mjs <candidates.json> [--out <dir>]");
  process.exit(2);
}
const name = path.basename(source, ".json");
const outDir = path.resolve(values.out ?? path.dirname(source));
const filesDir = path.join(outDir, "files");
const sheetsDir = path.join(outDir, "sheets");
mkdirSync(filesDir, { recursive: true });
mkdirSync(sheetsDir, { recursive: true });

const candidates = JSON.parse(readFileSync(source, "utf8"));
const report = {};
const tiles = [];

for (const [key, entry] of Object.entries(candidates)) {
  const images = [];
  for (const [index, image] of (entry.images ?? []).entries()) {
    const record = { url: image.url, kind: image.kind ?? "face", source: image.source ?? "" };
    try {
      const { buffer, contentType } = await downloadImage(image.url);
      const meta = await sharp(buffer).metadata();
      const file = `${key}-${index + 1}${EXTENSION_BY_TYPE[contentType] ?? ".bin"}`;
      writeFileSync(path.join(filesDir, file), buffer);
      Object.assign(record, {
        file,
        bytes: buffer.length,
        contentType,
        width: meta.width,
        height: meta.height,
        sha256: createHash("sha256").update(buffer).digest("hex"),
      });
      tiles.push({
        label: `${key} ${meta.width}x${meta.height}`,
        // flatten() so a transparent PNG does not read as a blank tile.
        buffer: await sharp(buffer).flatten({ background: "#ffffff" }).resize(TILE, TILE, { fit: "contain", background: "#ffffff" }).toBuffer(),
      });
    } catch (error) {
      record.error = error.message;
    }
    images.push(record);
  }
  report[key] = { note: entry.note ?? "", images };
  const summary = images.map((image) => (image.width ? `${image.width}x${image.height} ${(image.bytes / 1024).toFixed(0)}KB` : `FAILED ${image.error}`));
  console.log(`${key.padEnd(30)} ${summary.join("  |  ") || "NO IMAGES"}`);
}

// Identical bytes across different products means a CDN placeholder, not a photo.
const byDigest = new Map();
for (const [key, entry] of Object.entries(report)) {
  for (const image of entry.images) {
    if (!image.sha256) continue;
    if (!byDigest.has(image.sha256)) byDigest.set(image.sha256, []);
    byDigest.get(image.sha256).push(`${key}/${image.file}`);
  }
}
const duplicates = [...byDigest.values()].filter((uses) => uses.length > 1);
if (duplicates.length) {
  console.log("\nidentical bytes under different products (likely a placeholder):");
  for (const uses of duplicates) console.log(`  ${uses.join(" , ")}`);
}

writeFileSync(path.join(outDir, `${name}-verified.json`), `${JSON.stringify(report, null, 2)}\n`);

if (tiles.length) {
  const rows = Math.ceil(tiles.length / COLUMNS);
  const composites = [];
  tiles.forEach((tile, index) => {
    const left = (index % COLUMNS) * TILE;
    const top = Math.floor(index / COLUMNS) * (TILE + LABEL);
    composites.push({ input: tile.buffer, left, top: top + LABEL });
    composites.push({
      input: Buffer.from(
        `<svg width="${TILE}" height="${LABEL}"><rect width="100%" height="100%" fill="#1d1d1d"/><text x="6" y="20" font-size="13" fill="#ffffff" font-family="sans-serif">${tile.label.slice(0, 42)}</text></svg>`,
      ),
      left,
      top,
    });
  });
  const sheet = path.join(sheetsDir, `${name}.png`);
  await sharp({ create: { width: COLUMNS * TILE, height: rows * (TILE + LABEL), channels: 3, background: "#ffffff" } })
    .composite(composites)
    .png()
    .toFile(sheet);
  console.log(`\nlook at ${sheet} before recording any of these in an image manifest`);
}
