import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  decodeUploadedImage,
  isValidTileCode,
  sanitizeNamePart,
  saveUploadedRowImage,
  saveUploadedTileImage,
  uploadedImagesFor,
  withUploads,
} from "../scripts/autoboard/lib/uploads.mjs";

async function withTempRoot(fn) {
  const root = mkdtempSync(path.join(tmpdir(), "autoboard-uploads-test-"));
  try {
    return await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("isValidTileCode accepts the real naming convention and rejects junk", () => {
  assert.equal(isValidTileCode("WT14"), true);
  assert.equal(isValidTileCode("AT3"), true);
  assert.equal(isValidTileCode("wt14"), false); // caller must uppercase first
  assert.equal(isValidTileCode("W14"), false);
  assert.equal(isValidTileCode("WT"), false);
  assert.equal(isValidTileCode("../../etc"), false);
});

test("sanitizeNamePart strips unsafe characters and collapses whitespace", () => {
  assert.equal(sanitizeNamePart("Cortar Bone Reed"), "Cortar_Bone_Reed");
  assert.equal(sanitizeNamePart("../../etc/passwd"), "....etcpasswd"); // '/' stripped entirely, no traversal risk
  assert.equal(sanitizeNamePart("   "), "image");
  assert.equal(sanitizeNamePart(""), "image");
});

test("decodeUploadedImage validates mime type, emptiness, and size", () => {
  const png = Buffer.from([1, 2, 3]).toString("base64");
  const { buffer, ext } = decodeUploadedImage({ mimeType: "image/png", dataBase64: png });
  assert.equal(ext, ".png");
  assert.equal(buffer.length, 3);

  assert.throws(() => decodeUploadedImage({ mimeType: "text/plain", dataBase64: png }), (error) => error.status === 400);
  assert.throws(() => decodeUploadedImage({ mimeType: "image/png", dataBase64: "" }), (error) => error.status === 400);
  assert.throws(() => decodeUploadedImage({ mimeType: "image/png", dataBase64: Buffer.alloc(0).toString("base64") }), (error) => error.status === 400);
  const huge = Buffer.alloc(21 * 1024 * 1024).toString("base64");
  assert.throws(() => decodeUploadedImage({ mimeType: "image/png", dataBase64: huge }), (error) => error.status === 400);
});

test("uploadedImagesFor / withUploads: an uploaded photo takes over from the base resolver", async () => {
  await withTempRoot((root) => {
    const base = (rowId) => [`/fake/base-${rowId}.png`];
    const wrapped = withUploads(base, root);
    assert.deepEqual(wrapped("123"), ["/fake/base-123.png"]); // nothing uploaded yet

    const dir = path.join(root, "123");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "photo.jpg"), "");
    assert.deepEqual(uploadedImagesFor("123", root), [path.join(dir, "photo.jpg")]);
    assert.deepEqual(wrapped("123"), [path.join(dir, "photo.jpg")]);
    assert.deepEqual(wrapped("456"), ["/fake/base-456.png"]); // unrelated row unaffected
  });
});

test("saveUploadedRowImage writes into <root>/<rowId>/ and is retrievable via uploadedImagesFor", async () => {
  await withTempRoot(async (root) => {
    const filePath = await saveUploadedRowImage("999", Buffer.from("fake-bytes"), ".jpg", root);
    assert.ok(filePath.startsWith(path.join(root, "999")));
    assert.equal(readFileSync(filePath, "utf8"), "fake-bytes");
    assert.deepEqual(uploadedImagesFor("999", root), [filePath]);
  });
});

test("saveUploadedTileImage writes <CODE>_<name>.<ext> and refuses to overwrite an existing file", async () => {
  await withTempRoot(async (libraryRoot) => {
    const filePath = await saveUploadedTileImage(libraryRoot, "WT14", "New Material", Buffer.from("bytes"), ".jpg");
    assert.ok(filePath.endsWith(path.join("Tile", "tiles", "WT14_New_Material.jpg")));
    assert.equal(readFileSync(filePath, "utf8"), "bytes");

    await assert.rejects(
      saveUploadedTileImage(libraryRoot, "WT14", "New Material", Buffer.from("other-bytes"), ".jpg"),
      (error) => error.status === 400 && /already exists/.test(error.message),
    );
  });
});
