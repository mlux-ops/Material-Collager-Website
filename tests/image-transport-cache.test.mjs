import assert from "node:assert/strict";
import test from "node:test";
import { fileFingerprint, transportCacheKey, mapWithLimit, createByteBudgetCache, compressedReferenceCount } from "../app/lib/image-transport.ts";

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

test("mapWithLimit keeps order and never runs more than `limit` at once", async () => {
  let running = 0;
  let peak = 0;
  const results = await mapWithLimit([30, 10, 20, 5, 15], 2, async (ms, index) => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, ms));
    running -= 1;
    return index;
  });
  assert.deepEqual(results, [0, 1, 2, 3, 4]);
  assert.equal(peak, 2);
});

test("mapWithLimit with a limit of 0 still runs (one worker), instead of returning holes", async () => {
  assert.deepEqual(await mapWithLimit([1, 2, 3], 0, async (item) => item * 2), [2, 4, 6]);
});

test("transportCacheKey needs crypto.subtle, which is why optimizeReferenceForTransport skips its cache without it", async () => {
  // Plain http (a LAN address during a draft, say) leaves crypto.subtle
  // undefined; globalThis.crypto is an accessor with no setter, so it has to
  // be swapped via defineProperty, not assignment, and restored the same way.
  const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  try {
    Object.defineProperty(globalThis, "crypto", { value: { subtle: undefined }, configurable: true, writable: true, enumerable: true });
    await assert.rejects(() => transportCacheKey(new File([new Uint8Array([1, 2, 3])], "x.png"), 1000));
  } finally {
    Object.defineProperty(globalThis, "crypto", original);
  }
});

test("the transport cache evicts oldest entries once it holds more bytes than its budget", () => {
  const cache = createByteBudgetCache(10);
  const file = (size) => new File([new Uint8Array(size)], "x.jpg", { type: "image/jpeg" });
  cache.set("a", file(4));
  cache.set("b", file(4));
  cache.set("c", file(4)); // 12 bytes > 10: "a" goes
  assert.equal(cache.get("a"), undefined);
  assert.ok(cache.get("b"));
  assert.ok(cache.get("c"));
  assert.equal(cache.bytes, 8);
});

test("an entry larger than the whole budget is still kept on its own", () => {
  const cache = createByteBudgetCache(10);
  cache.set("big", new File([new Uint8Array(20)], "x.jpg", { type: "image/jpeg" }));
  assert.ok(cache.get("big"));
});

test("compressedReferenceCount counts the references that were replaced by a re-encoded copy", () => {
  const a = new File([new Uint8Array([1])], "a.png", { type: "image/png" });
  const b = new File([new Uint8Array([2])], "b.png", { type: "image/png" });
  const bCompressed = new File([new Uint8Array([2])], "b-optimized.jpg", { type: "image/jpeg" });
  assert.equal(compressedReferenceCount([a, b], [a, b]), 0);
  assert.equal(compressedReferenceCount([a, b], [a, bCompressed]), 1);
});
