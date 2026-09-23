import assert from "node:assert/strict";
import test from "node:test";
import { fileFingerprint, transportCacheKey } from "../app/lib/image-transport.ts";

test("two different images that share a fingerprint get different transport cache keys", async () => {
  // How Workbench builds every reference (fileFromCacheKey): a fixed
  // "input.<ext>" name, and lastModified from the same millisecond.
  const lastModified = 1_700_000_000_000;
  const a = new File([new Uint8Array([1, 2, 3, 4])], "input.png", { type: "image/png", lastModified });
  const b = new File([new Uint8Array([4, 3, 2, 1])], "input.png", { type: "image/png", lastModified });
  assert.equal(fileFingerprint(a), fileFingerprint(b));
  assert.notEqual(await transportCacheKey(a, 1000), await transportCacheKey(b, 1000));
});

test("the same bytes under different names share a key, and the target size is part of it", async () => {
  const bytes = new Uint8Array([9, 8, 7]);
  const a = new File([bytes], "input.png", { type: "image/png" });
  const b = new File([bytes], "renamed.png", { type: "image/png" });
  assert.equal(await transportCacheKey(a, 1000), await transportCacheKey(b, 1000));
  assert.notEqual(await transportCacheKey(a, 1000), await transportCacheKey(a, 2000));
});
