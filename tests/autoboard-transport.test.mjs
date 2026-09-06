import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import sharp from "sharp";

import { prepareReferenceForUpload } from "../scripts/autoboard/lib/transport.mjs";

async function withTempDir(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "autoboard-transport-test-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("prepareReferenceForUpload resizes an oversized PNG (4000x2000) to a 2048 long edge as JPEG", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "large.png");
    const buffer = await sharp({ create: { width: 4000, height: 2000, channels: 3, background: { r: 200, g: 150, b: 100 } } })
      .png()
      .toBuffer();
    writeFileSync(filePath, buffer);

    const prepared = await prepareReferenceForUpload(filePath);
    assert.equal(prepared.resized, true);
    assert.equal(prepared.mime, "image/jpeg");
    assert.equal(prepared.filename, "large.jpg");
    assert.equal(prepared.width, 2048);
    assert.equal(prepared.height, 1024);

    const decoded = await sharp(prepared.bytes).metadata();
    assert.equal(decoded.format, "jpeg");
    assert.equal(decoded.width, 2048);
    assert.equal(decoded.height, 1024);
  });
});

test("prepareReferenceForUpload passes a small JPEG through untouched", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "small.jpg");
    const buffer = await sharp({ create: { width: 900, height: 900, channels: 3, background: { r: 5, g: 5, b: 5 } } })
      .jpeg({ quality: 80 })
      .toBuffer();
    writeFileSync(filePath, buffer);

    const prepared = await prepareReferenceForUpload(filePath);
    assert.equal(prepared.resized, false);
    assert.equal(prepared.mime, "image/jpeg");
    assert.equal(prepared.filename, "small.jpg");
    assert.equal(prepared.width, 900);
    assert.equal(prepared.height, 900);
    assert.ok(prepared.bytes.equals(readFileSync(filePath)), "bytes must be returned unmodified");
  });
});

test("prepareReferenceForUpload never upscales a small image, even when a bloated file forces a resize pass", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "tiny-but-heavy.png");
    const small = await sharp({ create: { width: 265, height: 265, channels: 3, background: { r: 10, g: 20, b: 30 } } })
      .png()
      .toBuffer();
    // Pad well past the 1.5 MB threshold with trailing bytes after PNG's IEND
    // chunk — decoders (including sharp/libvips) ignore trailing garbage, so
    // the image content and its real 265x265 dimensions are unaffected; only
    // the on-disk byte count crosses the size threshold that forces a resize
    // pass, which is exactly the case this test exists to guard.
    const padded = Buffer.concat([small, Buffer.alloc(2 * 1024 * 1024, 1)]);
    writeFileSync(filePath, padded);
    assert.ok(padded.length > 1.5 * 1024 * 1024);

    const prepared = await prepareReferenceForUpload(filePath);
    assert.equal(prepared.resized, true, "the oversized file should still trigger the resize/recompress pass");
    assert.equal(prepared.width, 265);
    assert.equal(prepared.height, 265);
    assert.equal(prepared.mime, "image/jpeg");

    const decoded = await sharp(prepared.bytes).metadata();
    assert.equal(decoded.width, 265);
    assert.equal(decoded.height, 265);
  });
});

test("prepareReferenceForUpload respects custom maxLongEdge/jpegQuality options", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "custom.png");
    const buffer = await sharp({ create: { width: 1200, height: 800, channels: 3, background: { r: 1, g: 2, b: 3 } } })
      .png()
      .toBuffer();
    writeFileSync(filePath, buffer);

    const prepared = await prepareReferenceForUpload(filePath, { maxLongEdge: 600, jpegQuality: 50 });
    assert.equal(prepared.resized, true);
    assert.equal(prepared.width, 600);
    assert.equal(prepared.height, 400);
    assert.equal(prepared.mime, "image/jpeg");
  });
});
