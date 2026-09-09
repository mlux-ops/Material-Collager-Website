import assert from "node:assert/strict";
import test from "node:test";

import {
  estimateOutputOnlyUsd,
  formatOutputUsd,
  OUTPUT_TOKEN_STORAGE_KEY,
  recordRunOutputTokens,
  resetOutputTokenTableForTests,
  setCalibrationStorageAdapter,
} from "../app/components/workbench/cost.ts";
import { estimateSunburstCost } from "../app/components/workbench/nodes/generation.ts";

const MODEL = "gpt-image-2.5-sunburst";

// An in-memory store so the real persistence path runs under the test runner,
// where there is no window.localStorage.
function memoryStorage() {
  const map = new Map();
  return {
    map,
    get: (key) => (map.has(key) ? map.get(key) : null),
    set: (key, value) => { map.set(key, value); },
    remove: (key) => { map.delete(key); },
  };
}

test.beforeEach(() => {
  setCalibrationStorageAdapter(memoryStorage());
  resetOutputTokenTableForTests();
});

test.after(() => setCalibrationStorageAdapter(null));

test("a node with no completed run at its size and quality has no estimate", () => {
  assert.equal(estimateOutputOnlyUsd({ model: MODEL, size: "1536x1024", quality: "low" }), null);
  assert.equal(estimateSunburstCost({ params: { size: "1536x1024", quality: "low" }, inputImages: 2 }), null);
});

test("one completed run teaches the estimate for the next run at the same size and quality", () => {
  recordRunOutputTokens(
    { model: MODEL, size: "1536x1024", quality: "low" },
    { output_tokens_details: { image_tokens: 158 } },
  );
  const usd = estimateSunburstCost({ params: { model: MODEL, size: "1536x1024", quality: "low" }, inputImages: 2 });
  assert.ok(Math.abs(usd - 0.00474) < 1e-5);

  // A different tier at the same size stays unknown; the 16x gap between
  // medium and max means neighbours are not substitutes.
  assert.equal(estimateSunburstCost({ params: { model: MODEL, size: "1536x1024", quality: "max" }, inputImages: 2 }), null);
});

test("candidates multiply the estimate, and Variations' n counts the same as candidates", () => {
  recordRunOutputTokens({ model: MODEL, size: "1536x1024", quality: "max" }, { output_tokens_details: { image_tokens: 5488 } });
  const one = estimateSunburstCost({ params: { model: MODEL, size: "1536x1024", quality: "max" }, inputImages: 1 });
  const four = estimateSunburstCost({ params: { model: MODEL, size: "1536x1024", quality: "max", candidates: 4 }, inputImages: 1 });
  const viaN = estimateSunburstCost({ params: { model: MODEL, size: "1536x1024", quality: "max", n: 4 }, inputImages: 1 });
  assert.ok(Math.abs(four - one * 4) < 1e-9);
  assert.equal(viaN, four);
  // Four max candidates is real money and should read as such, not "<$0.01".
  assert.ok(four > 0.65);
});

test("runs that teach nothing are ignored rather than recorded as zero", () => {
  const storage = memoryStorage();
  setCalibrationStorageAdapter(storage);
  // A text or vision node: no size in its params.
  recordRunOutputTokens({ model: MODEL, quality: "low" }, { output_tokens_details: { image_tokens: 158 } });
  // An image node whose response carried no usage.
  recordRunOutputTokens({ model: MODEL, size: "1536x1024", quality: "low" }, undefined);
  assert.equal(storage.get(OUTPUT_TOKEN_STORAGE_KEY), null, "nothing should have been written");
});

test("the learned table survives a reload and defaults the model when a node omits it", () => {
  const storage = memoryStorage();
  setCalibrationStorageAdapter(storage);
  recordRunOutputTokens({ size: "1024x1024", quality: "medium" }, { output_tokens_details: { image_tokens: 343 } });

  // Simulated reload: a fresh adapter over the same backing store.
  const reloaded = { get: (k) => storage.get(k), set: (k, v) => storage.set(k, v), remove: (k) => storage.remove(k) };
  setCalibrationStorageAdapter(reloaded);
  const usd = estimateOutputOnlyUsd({ size: "1024x1024", quality: "medium" });
  assert.ok(Math.abs(usd - 343 * 30 / 1_000_000) < 1e-9);
});

test("a corrupted stored entry never reaches a price label", () => {
  const storage = memoryStorage();
  storage.set(OUTPUT_TOKEN_STORAGE_KEY, JSON.stringify({ [`${MODEL}|1536x1024|low`]: "not-a-number" }));
  setCalibrationStorageAdapter(storage);
  assert.equal(estimateOutputOnlyUsd({ model: MODEL, size: "1536x1024", quality: "low" }), null);

  storage.set(OUTPUT_TOKEN_STORAGE_KEY, "{ not json");
  assert.equal(estimateOutputOnlyUsd({ model: MODEL, size: "1536x1024", quality: "low" }), null);
});

test("sub-cent output prices stay distinguishable instead of collapsing to <$0.01", () => {
  // formatUsd renders anything under a cent as "<$0.01", which would make a
  // low draft and a medium draft look identical.
  assert.equal(formatOutputUsd(0.00474), "$0.0047");
  assert.equal(formatOutputUsd(0.0103), "$0.01");
  assert.equal(formatOutputUsd(0.6584), "$0.66");
  assert.equal(formatOutputUsd(Number.NaN), "$0.00");
});
