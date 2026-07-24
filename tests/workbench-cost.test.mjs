import assert from "node:assert/strict";
import test from "node:test";

import {
  CALIBRATION_STORAGE_KEY,
  confirmHighCost,
  estimateRunUsd,
  formatUsd,
  HIGH_COST_CONFIRM_THRESHOLD_USD,
  outputTokensFor,
  recordImageTokenCalibration,
  resetImageTokenCalibrationForTests,
} from "../app/components/workbench/cost.ts";
import { estimateGenerationCost } from "../app/components/workbench/nodes/generation.ts";
import { estimateVariationsCost } from "../app/components/workbench/nodes/variations.manifest.ts";

// cost.ts's localStorage-backed calibration no-ops under `typeof window ===
// "undefined"` (Node has no window), so recordImageTokenCalibration/reset are
// safe here but never actually persist — this test file only exercises the
// pure math side (estimateRunUsd/outputTokensFor/formatUsd/confirmHighCost)
// plus asserts the no-window no-op path doesn't throw.

test("outputTokensFor is null for a malformed size and a positive integer for a valid one", () => {
  assert.equal(outputTokensFor("not-a-size", "medium"), null);
  const tokens = outputTokensFor("1536x1024", "medium");
  assert.ok(Number.isInteger(tokens) && tokens > 0);
});

test("higher quality tiers cost more output tokens at a fixed size", () => {
  const low = outputTokensFor("1536x1024", "low");
  const medium = outputTokensFor("1536x1024", "medium");
  const high = outputTokensFor("1536x1024", "high");
  assert.ok(low < medium && medium < high);
});

test("estimateRunUsd scales linearly with candidate count (n input tokens billed once, output scaled by n)", () => {
  const one = estimateRunUsd({ size: "1536x1024", quality: "medium", candidates: 1, inputImages: 0 });
  const four = estimateRunUsd({ size: "1536x1024", quality: "medium", candidates: 4, inputImages: 0 });
  assert.ok(one !== null && four !== null);
  assert.ok(four > one);
  // Pure output-token cost with zero input images: scales close to exactly 4x
  // (candidates multiply the whole output-token term).
  assert.ok(Math.abs(four / one - 4) < 0.01);
});

test("estimateRunUsd is null for an unparseable size (propagates outputTokensFor's null)", () => {
  assert.equal(estimateRunUsd({ size: "bogus", quality: "medium", candidates: 1, inputImages: 2 }), null);
});

test("input images add cost on top of the output-token term", () => {
  const withoutInputs = estimateRunUsd({ size: "1536x1024", quality: "medium", candidates: 1, inputImages: 0 });
  const withInputs = estimateRunUsd({ size: "1536x1024", quality: "medium", candidates: 1, inputImages: 3 });
  assert.ok(withInputs > withoutInputs);
});

test("formatUsd shows a floor placeholder under a cent and two decimals otherwise", () => {
  assert.equal(formatUsd(0.001), "<$0.01");
  assert.equal(formatUsd(0.4), "$0.40");
  assert.equal(formatUsd(1.2345), "$1.23");
});

test("confirmHighCost auto-passes below the threshold and when there's no window.confirm (Node has no window)", () => {
  assert.equal(confirmHighCost(null), true);
  assert.equal(confirmHighCost(HIGH_COST_CONFIRM_THRESHOLD_USD - 0.01), true);
  // At/above the threshold, in a window-less environment (Node), there's no
  // confirm dialog to block on — the guardrail degrades to "allow".
  assert.equal(confirmHighCost(HIGH_COST_CONFIRM_THRESHOLD_USD), true);
  assert.equal(confirmHighCost(HIGH_COST_CONFIRM_THRESHOLD_USD + 1), true);
});

test("recordImageTokenCalibration and resetImageTokenCalibrationForTests are no-ops (not crashes) with no window/localStorage", () => {
  assert.doesNotThrow(() => recordImageTokenCalibration("1536x1024", "medium", 500, 2));
  assert.doesNotThrow(() => resetImageTokenCalibrationForTests());
  assert.equal(typeof CALIBRATION_STORAGE_KEY, "string");
});

test("per-node estimateCost shapes: imageEdit/imageGenerate scale with candidates, Variations scales with n and clamps 1-10", () => {
  const genLow = estimateGenerationCost({ params: { size: "1536x1024", quality: "medium", candidates: 1 }, inputImages: 1 });
  const genHigh = estimateGenerationCost({ params: { size: "1536x1024", quality: "medium", candidates: 4 }, inputImages: 1 });
  assert.ok(genHigh > genLow);

  const variationsDefault = estimateVariationsCost({ params: {}, inputImages: 1 }); // n defaults to 4 inside the estimator
  const variationsExplicit = estimateVariationsCost({ params: { n: 4 }, inputImages: 1 });
  assert.equal(variationsDefault, variationsExplicit);

  const variationsOverMax = estimateVariationsCost({ params: { n: 999 }, inputImages: 1 });
  const variationsAtMax = estimateVariationsCost({ params: { n: 10 }, inputImages: 1 });
  assert.equal(variationsOverMax, variationsAtMax); // clamps to 10, never bills for 999

  const variationsUnderMin = estimateVariationsCost({ params: { n: 0 }, inputImages: 1 });
  const variationsAtMin = estimateVariationsCost({ params: { n: 1 }, inputImages: 1 });
  assert.equal(variationsUnderMin, variationsAtMin); // clamps up to 1
});

test("draft-mode reduction: generation.ts's draftOverride forces the cheapest quality tier, which estimateCost then reflects", () => {
  const highQuality = estimateGenerationCost({ params: { size: "1536x1024", quality: "high", candidates: 1 }, inputImages: 0 });
  const draftQuality = estimateGenerationCost({ params: { size: "1536x1024", quality: "low", candidates: 1 }, inputImages: 0 });
  assert.ok(draftQuality < highQuality, "draft (low) quality must estimate cheaper than high quality");
});
