import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import sharp from "sharp";

import { indexTileCodes, readImageSize, resolveTileCode, tileLibraryDir } from "../scripts/autoboard/lib/tiles.mjs";

function withFakeTileLibrary(filenames, fn) {
  const libraryRoot = mkdtempSync(path.join(tmpdir(), "autoboard-tiles-test-"));
  const dir = tileLibraryDir(libraryRoot);
  mkdirSync(dir, { recursive: true });
  for (const name of filenames) writeFileSync(path.join(dir, name), "");
  try {
    return fn(libraryRoot);
  } finally {
    rmSync(libraryRoot, { recursive: true, force: true });
  }
}

// Like withFakeTileLibrary, but writes real sharp-encoded PNGs of the given
// sizes instead of empty placeholder files — needed for tests that exercise
// indexTileCodes' pixel-count tie-break, which reads real image headers.
async function withFakeTileLibraryImages(fileSpecs, fn) {
  const libraryRoot = mkdtempSync(path.join(tmpdir(), "autoboard-tiles-test-"));
  const dir = tileLibraryDir(libraryRoot);
  mkdirSync(dir, { recursive: true });
  for (const { name, width, height } of fileSpecs) {
    const buffer = await sharp({ create: { width, height, channels: 3, background: { r: 120, g: 120, b: 120 } } }).png().toBuffer();
    writeFileSync(path.join(dir, name), buffer);
  }
  try {
    return await fn(libraryRoot);
  } finally {
    rmSync(libraryRoot, { recursive: true, force: true });
  }
}

async function withTempDir(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "autoboard-tiles-readsize-test-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("indexTileCodes parses a single-code filename into code + material name", () => {
  withFakeTileLibrary(["AT1_Clara_Caviar.jpg"], (libraryRoot) => {
    const index = indexTileCodes(libraryRoot);
    const tile = resolveTileCode(index, "AT1");
    assert.equal(tile.materialName, "Clara Caviar");
    assert.ok(tile.filePath.endsWith("AT1_Clara_Caviar.jpg"));
  });
});

test("indexTileCodes maps a compound filename's photo to each of its codes", () => {
  withFakeTileLibrary(["FT1_WT1_Cortar_Bone.jpg"], (libraryRoot) => {
    const index = indexTileCodes(libraryRoot);
    const floor = resolveTileCode(index, "FT1");
    const wall = resolveTileCode(index, "WT1");
    assert.equal(floor.filePath, wall.filePath);
    assert.equal(floor.materialName, "Cortar Bone");
  });
});

// Real, equal-size fixtures (not the empty placeholder files most tests
// above use) — the tie-break now reads actual pixel counts, so this needs
// two files that genuinely tie in order to exercise the alphabetical
// fallback rather than the separate "both unreadable" fallback.
test("indexTileCodes picks the alphabetically-first file when a code has same-size duplicates", async () => {
  await withFakeTileLibraryImages(
    [
      { name: "WT5_Tones_Sapphire.png", width: 400, height: 400 },
      { name: "WT5_Tones_Sapphire_field.png", width: 400, height: 400 },
    ],
    (libraryRoot) => {
      const index = indexTileCodes(libraryRoot);
      const tile = resolveTileCode(index, "WT5");
      assert.ok(tile.filePath.endsWith("WT5_Tones_Sapphire.png"));
    },
  );
});

test("indexTileCodes prefers the larger image when a code has duplicates of different sizes", async () => {
  await withFakeTileLibraryImages(
    [
      { name: "WT5_a.png", width: 122, height: 1200 }, // thin reference strip
      { name: "WT5_b_field.png", width: 1980, height: 2829 }, // proper field photo
    ],
    (libraryRoot) => {
      const index = indexTileCodes(libraryRoot);
      const tile = resolveTileCode(index, "WT5");
      // Alphabetically "WT5_a.png" sorts first, but the larger field photo
      // must still win the tie-break regardless of name order.
      assert.ok(tile.filePath.endsWith("WT5_b_field.png"));
    },
  );
});

test("indexTileCodes falls back to alphabetical when a duplicate's size can't be read", () => {
  withFakeTileLibrary(["WT5_Tones_Sapphire.png", "WT5_Tones_Sapphire_field.png"], (libraryRoot) => {
    const index = indexTileCodes(libraryRoot);
    const tile = resolveTileCode(index, "WT5");
    assert.ok(tile.filePath.endsWith("WT5_Tones_Sapphire.png"));
  });
});

test("resolveTileCode is case-insensitive and returns null for an unknown code", () => {
  withFakeTileLibrary(["AT2_Tones_Sandstone.png"], (libraryRoot) => {
    const index = indexTileCodes(libraryRoot);
    assert.ok(resolveTileCode(index, "at2"));
    assert.equal(resolveTileCode(index, "AT99"), null);
  });
});

test("indexTileCodes ignores non-image files and files with no leading code", () => {
  withFakeTileLibrary(["README.txt", "loose_photo_no_code.jpg", "WT2_Cortar_Bone_Reed.jpg"], (libraryRoot) => {
    const index = indexTileCodes(libraryRoot);
    assert.equal(index.size, 1);
    assert.ok(resolveTileCode(index, "WT2"));
  });
});

test("readImageSize reads width/height from a PNG header", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "sample.png");
    const buffer = await sharp({ create: { width: 321, height: 654, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer();
    writeFileSync(filePath, buffer);
    assert.deepEqual(readImageSize(filePath), { width: 321, height: 654 });
  });
});

test("readImageSize reads width/height from a JPEG header", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "sample.jpg");
    const buffer = await sharp({ create: { width: 800, height: 450, channels: 3, background: { r: 10, g: 20, b: 30 } } }).jpeg().toBuffer();
    writeFileSync(filePath, buffer);
    assert.deepEqual(readImageSize(filePath), { width: 800, height: 450 });
  });
});

test("readImageSize reads width/height from a WebP header", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "sample.webp");
    const buffer = await sharp({ create: { width: 500, height: 375, channels: 3, background: { r: 10, g: 20, b: 30 } } }).webp().toBuffer();
    writeFileSync(filePath, buffer);
    assert.deepEqual(readImageSize(filePath), { width: 500, height: 375 });
  });
});

test("readImageSize reads a JPEG whose SOF sits after a large segment past the 64KB peek", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "padded.jpg");
    const original = await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 5, g: 5, b: 5 } } }).jpeg().toBuffer();
    assert.equal(original[0], 0xff);
    assert.equal(original[1], 0xd8); // SOI
    // Splice large COM (comment) segments right after SOI so the SOF marker
    // lands well past the 64KB peek, forcing readImageSize's whole-file
    // re-read. A COM segment's length field is a u16 (max 65535), so use
    // several segments rather than one to clear 64KB total.
    const segmentPayloadSize = 40 * 1024;
    const comSegment = Buffer.alloc(4 + segmentPayloadSize);
    comSegment[0] = 0xff;
    comSegment[1] = 0xfe; // COM marker
    comSegment.writeUInt16BE(2 + segmentPayloadSize, 2); // segment length excludes the marker itself
    comSegment.fill(0x20, 4);
    const padded = Buffer.concat([original.subarray(0, 2), comSegment, comSegment, original.subarray(2)]);
    writeFileSync(filePath, padded);
    assert.ok(padded.length > 64 * 1024);
    assert.deepEqual(readImageSize(filePath), { width: 640, height: 480 });
  });
});

test("readImageSize returns null for a file it can't parse", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "not-an-image.png");
    writeFileSync(filePath, Buffer.from("not actually an image"));
    assert.equal(readImageSize(filePath), null);
  });
});
