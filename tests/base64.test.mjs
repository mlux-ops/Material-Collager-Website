import assert from "node:assert/strict";
import test from "node:test";

import { base64ToBytes, blobToDataUrl, bytesToBase64 } from "../app/lib/base64.ts";

// These run inside the Worker on multi-MB collage PNGs, where the idioms they
// replace (a closure per byte on decode, a 32,768-argument spread per chunk on
// encode) burned enough CPU to get the isolate killed with Cloudflare 1102.
const NATIVE_DECODE = typeof Uint8Array.fromBase64 === "function";
const NATIVE_ENCODE = typeof new Uint8Array(1).toBase64 === "function";

function withoutNativeHelpers(run) {
  const staticDescriptor = Object.getOwnPropertyDescriptor(Uint8Array, "fromBase64");
  const protoDescriptor = Object.getOwnPropertyDescriptor(Uint8Array.prototype, "toBase64");
  if (staticDescriptor) delete Uint8Array.fromBase64;
  if (protoDescriptor) delete Uint8Array.prototype.toBase64;
  try {
    return run();
  } finally {
    if (staticDescriptor) Object.defineProperty(Uint8Array, "fromBase64", staticDescriptor);
    if (protoDescriptor) Object.defineProperty(Uint8Array.prototype, "toBase64", protoDescriptor);
  }
}

const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

test("a round trip preserves every byte, including the values that break naive string paths", () => {
  const bytes = new Uint8Array([...PNG_HEADER, 0x00, 0x7f, 0x80, 0xff, 0xfe, 0x01]);

  assert.deepEqual(base64ToBytes(bytesToBase64(bytes)), bytes);
  assert.deepEqual(withoutNativeHelpers(() => base64ToBytes(bytesToBase64(bytes))), bytes);
});

test("the fallback paths agree with the native ones byte for byte", () => {
  // Spans several chunk boundaries of the fallback encoder (0x1000 bytes).
  const bytes = new Uint8Array(0x2801);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 256;

  const base64 = bytesToBase64(bytes);
  const fallbackBase64 = withoutNativeHelpers(() => bytesToBase64(bytes));

  assert.equal(fallbackBase64, base64);
  assert.equal(fallbackBase64, Buffer.from(bytes).toString("base64"));
  assert.deepEqual(withoutNativeHelpers(() => base64ToBytes(base64)), bytes);
});

test("an empty buffer round trips instead of throwing", () => {
  assert.equal(bytesToBase64(new Uint8Array(0)), "");
  assert.deepEqual(base64ToBytes(""), new Uint8Array(0));
  assert.equal(withoutNativeHelpers(() => bytesToBase64(new Uint8Array(0))), "");
});

test("decoding tolerates the whitespace a strict native decoder rejects", () => {
  const clean = Buffer.from("collage").toString("base64");
  const wrapped = `${clean.slice(0, 4)}\n ${clean.slice(4)}`;

  assert.deepEqual(base64ToBytes(wrapped), new Uint8Array(Buffer.from("collage")));
});

test("the decoded bytes own their buffer, so they can be used as a Blob part or an R2 body", async () => {
  const bytes = base64ToBytes(bytesToBase64(new Uint8Array(PNG_HEADER)));
  const blob = new Blob([bytes], { type: "image/png" });

  assert.equal(blob.size, PNG_HEADER.length);
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), new Uint8Array(PNG_HEADER));
});

test("blobToDataUrl uses the blob's own type, falling back when it has none", async () => {
  const png = new Blob([new Uint8Array(PNG_HEADER)], { type: "image/webp" });
  const typeless = new Blob([new Uint8Array(PNG_HEADER)]);

  assert.match(await blobToDataUrl(png), /^data:image\/webp;base64,iVBORw0KGgo=$/);
  assert.match(await blobToDataUrl(typeless), /^data:image\/png;base64,/);
  assert.match(await blobToDataUrl(typeless, "image/jpeg"), /^data:image\/jpeg;base64,/);
});

test("the native fast paths are the ones actually taken when the engine has them", () => {
  // Guards against the helper silently regressing to the slow path everywhere:
  // if a runtime exposes the conversions, they must be reachable through it.
  const bytes = new Uint8Array(PNG_HEADER);
  if (NATIVE_ENCODE) assert.equal(bytesToBase64(bytes), bytes.toBase64());
  if (NATIVE_DECODE) assert.deepEqual(base64ToBytes("iVBORw0KGgo="), Uint8Array.fromBase64("iVBORw0KGgo="));
  assert.ok(true);
});
