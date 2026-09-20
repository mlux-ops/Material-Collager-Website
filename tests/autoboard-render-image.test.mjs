// Regression coverage for the bug reported live: a board's "generated
// render" showed as a broken image and would neither open nor save.
//
// /api/generate answers a JSON envelope (summary, prompt, imageBase64,
// mimeType, costUsd, ...), not raw image bytes in the response body.
// autoboard-renders.ts once stored the response body verbatim, so every
// stored "render-<id>.png" was really that JSON text, byte for byte — a file
// no image viewer can open. decodeGeneratedImage is the exact parsing step
// that was wrong, pulled out so it can be tested without cloudflare:workers,
// D1, or R2 (autoboard-renders.ts imports cloudflare:workers at module scope,
// which plain Node cannot resolve at all).

import assert from "node:assert/strict";
import { test } from "node:test";

import { decodeGeneratedImage } from "../app/lib/generated-image.ts";

// A real, tiny (2x2) PNG, base64-encoded — enough to prove the bytes decoded
// really are the image and not the JSON that carried it.
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR42mNk+M9QDwAChAGAgApp1AAAAABJRU5ErkJggg==";
const TINY_PNG_BYTES = Uint8Array.from(atob(TINY_PNG_BASE64), (c) => c.charCodeAt(0));

test("decodeGeneratedImage recovers the real image bytes from the JSON envelope, not the envelope itself", () => {
  const decoded = decodeGeneratedImage({ imageBase64: TINY_PNG_BASE64, mimeType: "image/png", costUsd: 0.07 });
  assert.deepEqual([...decoded.bytes], [...TINY_PNG_BYTES]);
  // A PNG's magic bytes, as a direct check that this is image data and not
  // (for instance) the UTF-8 text of the envelope that contained it.
  assert.deepEqual([...decoded.bytes.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(decoded.contentType, "image/png");
  assert.equal(decoded.costUsd, 0.07);
});

test("decodeGeneratedImage falls back to image/png when the envelope omits mimeType", () => {
  const decoded = decodeGeneratedImage({ imageBase64: TINY_PNG_BASE64 });
  assert.equal(decoded.contentType, "image/png");
});

test("decodeGeneratedImage throws a readable error when the envelope carries no image at all", () => {
  // This is exactly what the old code silently "succeeded" on: a JSON error
  // envelope like {"ok":false,"error":"..."} that slipped past response.ok
  // somehow, or any success shape missing the field.
  assert.throws(() => decodeGeneratedImage({}), /came back empty/);
  assert.throws(() => decodeGeneratedImage({ imageBase64: "" }), /came back empty/);
});

test("decodeGeneratedImage treats a zero or negative cost as absent, same as the header-based check it replaced", () => {
  assert.equal(decodeGeneratedImage({ imageBase64: TINY_PNG_BASE64, costUsd: 0 }).costUsd, null);
  assert.equal(decodeGeneratedImage({ imageBase64: TINY_PNG_BASE64, costUsd: -1 }).costUsd, null);
  assert.equal(decodeGeneratedImage({ imageBase64: TINY_PNG_BASE64 }).costUsd, null);
});
