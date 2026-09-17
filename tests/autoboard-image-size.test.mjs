// The header-only dimension parsers, checked against sharp.
//
// They were rewritten from node:Buffer onto Uint8Array/DataView so the Worker
// and the browser bundle can use them (app/lib compiles into both, and Buffer
// is not in the browser one). A hand-rolled binary parser rewritten by hand is
// exactly the change that can look right and be wrong on one format, so every
// case here is a real encoded image and sharp is the ground truth.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

import { readImageSizeFromBytes, sniffImageType } from "../app/lib/autoboard/image-size.ts";
import { readImageSize } from "../scripts/autoboard/lib/tiles.mjs";

// Deliberately not square and not round numbers, so a width/height swap or an
// off-by-one in a packed bit field cannot pass by coincidence.
const W = 613;
const H = 227;

function source() {
  return sharp({ create: { width: W, height: H, channels: 3, background: "#28685b" } });
}

const CASES = [
  ["png", () => source().png().toBuffer(), "image/png"],
  ["jpeg", () => source().jpeg({ quality: 80 }).toBuffer(), "image/jpeg"],
  ["webp lossy", () => source().webp({ lossless: false }).toBuffer(), "image/webp"],
  ["webp lossless", () => source().webp({ lossless: true }).toBuffer(), "image/webp"],
];

for (const [label, encode, expectedType] of CASES) {
  test(`readImageSizeFromBytes reads ${label} dimensions, and sharp agrees`, async () => {
    const buffer = await encode();
    const truth = await sharp(buffer).metadata();
    assert.equal(truth.width, W);
    assert.equal(truth.height, H);

    const bytes = new Uint8Array(buffer);
    assert.deepEqual(readImageSizeFromBytes(bytes), { width: W, height: H });
    assert.equal(sniffImageType(bytes), expectedType);
  });
}

test("readImageSizeFromBytes reads an extended-container (VP8X) webp", async () => {
  // An alpha channel makes sharp emit VP8X, the third of the three webp
  // dimension layouts and the only one that packs them as 24-bit LE.
  const buffer = await sharp({ create: { width: W, height: H, channels: 4, background: { r: 40, g: 104, b: 91, alpha: 0.5 } } })
    .webp()
    .toBuffer();
  const bytes = new Uint8Array(buffer);
  assert.equal(String.fromCharCode(...bytes.slice(12, 16)), "VP8X");
  assert.deepEqual(readImageSizeFromBytes(bytes), { width: W, height: H });
});

test("readImageSizeFromBytes returns null rather than guessing on non-images", () => {
  assert.equal(readImageSizeFromBytes(new Uint8Array(0)), null);
  assert.equal(readImageSizeFromBytes(new TextEncoder().encode("<!doctype html><html>")), null);
  assert.equal(readImageSizeFromBytes(new Uint8Array([0x47, 0x49, 0x46, 0x38])), null); // GIF: unsupported, not a crash
  assert.equal(sniffImageType(new TextEncoder().encode("not an image at all")), null);
  // A truncated PNG header must not read past the end of the buffer.
  assert.equal(readImageSizeFromBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), null);
});

test("readImageSizeFromBytes respects a Uint8Array's byteOffset", async () => {
  // A view into a larger buffer must parse from ITS start, not the backing
  // buffer's — the DataView rewrite is where that goes wrong silently.
  const buffer = await source().png().toBuffer();
  const padded = new Uint8Array(buffer.length + 64);
  padded.set(new Uint8Array(buffer), 64);
  const view = padded.subarray(64);
  assert.equal(view.byteOffset, 64);
  assert.deepEqual(readImageSizeFromBytes(view), { width: W, height: H });
});

// The file-reading half stayed in tiles.mjs and peeks 64 KB before committing
// to a second read. A JPEG whose SOF sits past a large EXIF segment is the case
// that path exists for, and the only one where the peek is not the answer.
test("readImageSize re-reads the whole file when the 64 KB peek is inconclusive", async (t) => {
  // Built by splicing APP1 segments in after the SOI rather than asking sharp
  // for a big EXIF block (it will not embed one this large). A JPEG segment
  // caps at 65535 bytes, so two are needed to push the SOF past the peek —
  // which is exactly the shape of a real photo carrying a full EXIF thumbnail.
  const jpeg = await source().jpeg({ quality: 80 }).toBuffer();
  const app1 = () => {
    const payload = Buffer.alloc(65533, 0x20);
    payload.write("Exif\0\0", 0);
    const header = Buffer.from([0xff, 0xe1, 0xff, 0xff]); // marker + length (65535 = 2 + payload)
    return Buffer.concat([header, payload]);
  };
  const buffer = Buffer.concat([jpeg.subarray(0, 2), app1(), app1(), jpeg.subarray(2)]);
  assert.ok(buffer.length > 64 * 1024, `fixture must exceed the peek; got ${buffer.length}`);

  const head = new Uint8Array(buffer.subarray(0, 64 * 1024));
  assert.equal(readImageSizeFromBytes(head), null, "the peek must be inconclusive for this to test anything");

  const dir = mkdtempSync(path.join(os.tmpdir(), "autoboard-imagesize-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "big-exif.jpg");
  writeFileSync(filePath, buffer);

  assert.deepEqual(readImageSize(filePath), { width: W, height: H });
});

test("readImageSize returns null for a file that is not an image", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "autoboard-imagesize-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "notes.txt");
  writeFileSync(filePath, "just some text");
  assert.equal(readImageSize(filePath), null);
});
