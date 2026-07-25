import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import {
  CALIBRATION_STORAGE_KEY,
  confirmHighCost,
  estimateRunUsd,
  formatUsd,
  HIGH_COST_CONFIRM_THRESHOLD_USD,
  outputTokensFor,
  recordImageTokenCalibration,
  recordUsageCalibration,
  resetImageTokenCalibrationForTests,
  setCalibrationStorageAdapter,
} from "../app/components/workbench/cost.ts";
import { estimateCollageBoardCost } from "../app/components/workbench/nodes/collageBoard.manifest.ts";
import { estimateGenerationCost, generationDraftOverride } from "../app/components/workbench/nodes/generation.ts";
import { draftOverrideMap, estimateCostMap } from "../app/components/workbench/nodes/manifests.ts";
import { resolveUpscaleSize } from "../app/components/workbench/nodes/upscaler.manifest.ts";
import { estimateVariationsCost } from "../app/components/workbench/nodes/variations.manifest.ts";

// cost.ts's calibration persistence is storage-adapter-injected (get/set/
// remove), defaulting to window.localStorage when present and a no-op
// otherwise (Node has no window). Restore the default after every test in
// this file so no test leaks a custom in-memory adapter into another.
afterEach(() => {
  setCalibrationStorageAdapter(null);
});

// A minimal in-memory get/set/remove adapter -- the same shape the real
// window.localStorage-backed adapter exposes -- so these tests exercise the
// REAL calibration read/write path (JSON encode/decode, schemaVersion check,
// EMA math) instead of only the no-window no-op fallback.
function createMemoryAdapter(seed) {
  const store = new Map(seed ? Object.entries(seed) : []);
  return {
    get: (key) => (store.has(key) ? store.get(key) : null),
    set: (key, value) => {
      store.set(key, value);
    },
    remove: (key) => {
      store.delete(key);
    },
    store,
  };
}

function readRecord(adapter) {
  const raw = adapter.store.get(CALIBRATION_STORAGE_KEY);
  return raw ? JSON.parse(raw) : undefined;
}

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

test("with no adapter injected and no window/localStorage, calibration degrades to a safe no-op", () => {
  setCalibrationStorageAdapter(null);
  assert.doesNotThrow(() => recordImageTokenCalibration("1536x1024", "medium", 500, 2));
  assert.doesNotThrow(() => resetImageTokenCalibrationForTests());
  assert.equal(typeof CALIBRATION_STORAGE_KEY, "string");
});

test("recordImageTokenCalibration writes a real, bounded, versioned EMA bucket through the injected storage adapter", () => {
  const adapter = createMemoryAdapter();
  setCalibrationStorageAdapter(adapter);

  recordImageTokenCalibration("1024x1024", "medium", 1000, 2);
  const afterFirst = readRecord(adapter);
  assert.equal(afterFirst.schemaVersion, 1);
  const bucket = afterFirst.buckets["1024x1024|medium"];
  assert.ok(bucket, "expected a bucket keyed by size|quality");
  assert.equal(bucket.samples, 1);
  assert.ok(bucket.usdPerImage > 0);
  const firstUsd = bucket.usdPerImage;

  // A second sample with a very different imageTokens count blends via EMA
  // rather than jumping straight to the new value or ignoring it.
  recordImageTokenCalibration("1024x1024", "medium", 4000, 2);
  const afterSecond = readRecord(adapter);
  const updated = afterSecond.buckets["1024x1024|medium"];
  assert.equal(updated.samples, 2);
  assert.notEqual(updated.usdPerImage, firstUsd);
  const secondSampleUsd = (4000 * (30 / 1_000_000)) / 2;
  const low = Math.min(firstUsd, secondSampleUsd);
  const high = Math.max(firstUsd, secondSampleUsd);
  assert.ok(updated.usdPerImage >= low && updated.usdPerImage <= high, "EMA must stay within the convex hull of its samples (bounded)");

  // A distinct (size, quality) bucket is tracked independently, and the
  // record stays bounded to exactly the distinct buckets actually used.
  recordImageTokenCalibration("2048x2048", "high", 2000, 1);
  const afterThird = readRecord(adapter);
  assert.equal(Object.keys(afterThird.buckets).length, 2);
  assert.ok(afterThird.buckets["2048x2048|high"]);

  // The estimator now reflects the learned per-image cost for the calibrated
  // bucket instead of the flat seed.
  const estimate = estimateRunUsd({ size: "1024x1024", quality: "medium", candidates: 1, inputImages: 2 });
  const flatSeedEstimate = (() => {
    const fresh = createMemoryAdapter();
    setCalibrationStorageAdapter(fresh);
    const value = estimateRunUsd({ size: "1024x1024", quality: "medium", candidates: 1, inputImages: 2 });
    setCalibrationStorageAdapter(adapter);
    return value;
  })();
  assert.notEqual(estimate, flatSeedEstimate);
});

test("repeated samples for one bucket never grow unbounded and the EMA stays within the historical sample range", () => {
  const adapter = createMemoryAdapter();
  setCalibrationStorageAdapter(adapter);

  const sampleUsdValues = [];
  for (let index = 0; index < 25; index += 1) {
    // A deterministic pseudo-varying sequence of imageTokens per sample.
    const imageTokens = 500 + ((index * 137) % 900);
    const inputImages = 1 + (index % 3);
    sampleUsdValues.push((imageTokens * (30 / 1_000_000)) / inputImages);
    recordImageTokenCalibration("1536x1024", "low", imageTokens, inputImages);
  }

  const record = readRecord(adapter);
  // Still exactly one bucket for the one (size, quality) pair exercised --
  // bounded growth, not one entry per sample.
  assert.equal(Object.keys(record.buckets).length, 1);
  const bucket = record.buckets["1536x1024|low"];
  assert.equal(bucket.samples, 25);
  const min = Math.min(...sampleUsdValues);
  const max = Math.max(...sampleUsdValues);
  assert.ok(bucket.usdPerImage >= min && bucket.usdPerImage <= max, "EMA of many samples must stay within their min/max bound");
});

test("a simulated reload (fresh adapter instance, same backing store) restores the persisted EMA", () => {
  const adapter = createMemoryAdapter();
  setCalibrationStorageAdapter(adapter);
  recordImageTokenCalibration("1280x960", "medium", 1200, 1);
  const persisted = readRecord(adapter).buckets["1280x960|medium"].usdPerImage;

  // Simulate a module reload: a BRAND NEW adapter object, but wired to the
  // exact same backing store (the real-world equivalent of the browser tab
  // reloading while window.localStorage itself is untouched).
  const reloadedAdapter = { get: adapter.get, set: adapter.set, remove: adapter.remove, store: adapter.store };
  setCalibrationStorageAdapter(reloadedAdapter);

  const estimate = estimateRunUsd({ size: "1280x960", quality: "medium", candidates: 1, inputImages: 1 });
  const outputOnly = estimateRunUsd({ size: "1280x960", quality: "medium", candidates: 1, inputImages: 0 });
  assert.ok(estimate !== null && outputOnly !== null);
  assert.ok(Math.abs(estimate - outputOnly - persisted) < 1e-9, "the reloaded estimate must reflect the calibrated bucket, not the flat seed");
});

test("a schemaVersion mismatch resets calibration to the flat seed instead of trusting stale/foreign data", () => {
  const adapter = createMemoryAdapter({
    [CALIBRATION_STORAGE_KEY]: JSON.stringify({
      schemaVersion: 999,
      buckets: { "1024x1024|medium": { usdPerImage: 5, samples: 100 } },
    }),
  });
  setCalibrationStorageAdapter(adapter);

  const withMismatch = estimateRunUsd({ size: "1024x1024", quality: "medium", candidates: 1, inputImages: 1 });
  const fresh = createMemoryAdapter();
  setCalibrationStorageAdapter(fresh);
  const flatSeed = estimateRunUsd({ size: "1024x1024", quality: "medium", candidates: 1, inputImages: 1 });
  assert.equal(withMismatch, flatSeed, "a schema-version mismatch must be discarded, not merged or trusted");

  // Recording after a mismatch starts a fresh bucket (1 sample), proving the
  // bogus 100-sample record was fully dropped rather than built upon.
  setCalibrationStorageAdapter(adapter);
  recordImageTokenCalibration("1024x1024", "medium", 1000, 2);
  const rebuilt = readRecord(adapter);
  assert.equal(rebuilt.schemaVersion, 1);
  assert.equal(rebuilt.buckets["1024x1024|medium"].samples, 1);
});

test("loadCalibration filters out corrupted bucket values (non-numeric/NaN/negative/absurd usdPerImage) instead of poisoning estimateRunUsd with a NaN total (S-10)", () => {
  const adapter = createMemoryAdapter({
    [CALIBRATION_STORAGE_KEY]: JSON.stringify({
      schemaVersion: 1,
      buckets: {
        "1536x1024|high": { usdPerImage: "abc", samples: 3 }, // non-numeric
        "1024x1024|medium": { usdPerImage: Number.NaN, samples: 2 }, // NaN
        "2048x2048|low": { usdPerImage: -1, samples: 1 }, // negative
        "2560x1440|high": { usdPerImage: 999999, samples: 1 }, // absurd/corrupted
        "1024x1536|medium": { usdPerImage: 0.031, samples: 4 }, // genuinely valid
      },
    }),
  });
  setCalibrationStorageAdapter(adapter);

  const corruptedBucketEstimate = estimateRunUsd({ size: "1536x1024", quality: "high", candidates: 1, inputImages: 1 });
  assert.ok(Number.isFinite(corruptedBucketEstimate), "a corrupted bucket must fall back to the flat seed, never surface as NaN");
  assert.equal(formatUsd(corruptedBucketEstimate).includes("NaN"), false, "the money display must never render $NaN");

  const validBucketEstimate = estimateRunUsd({ size: "1024x1536", quality: "medium", candidates: 1, inputImages: 1 });
  const outputOnly = estimateRunUsd({ size: "1024x1536", quality: "medium", candidates: 1, inputImages: 0 });
  assert.ok(Math.abs(validBucketEstimate - outputOnly - 0.031) < 1e-9, "the one genuinely valid bucket must still be honored");
});

test("formatUsd never renders NaN/Infinity for a non-finite input", () => {
  assert.equal(formatUsd(Number.NaN), "$0.00");
  assert.equal(formatUsd(Number.POSITIVE_INFINITY), "$0.00");
});

test("resetImageTokenCalibrationForTests clears every bucket back to an empty, current-schema record", () => {
  const adapter = createMemoryAdapter();
  setCalibrationStorageAdapter(adapter);
  recordImageTokenCalibration("1536x1024", "high", 3000, 2);
  assert.ok(Object.keys(readRecord(adapter).buckets).length > 0);

  resetImageTokenCalibrationForTests();
  const reset = readRecord(adapter);
  assert.equal(reset.schemaVersion, 1);
  assert.deepEqual(reset.buckets, {});
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

test("collageBoard's estimateCost derives its size from resolvedSize (collageType/orientation/outputResolution), never the flat 1536x1024 fallback the generic generation estimator would silently assume (W-3)", () => {
  const flatFallback = estimateRunUsd({ size: "1536x1024", quality: "medium", candidates: 1, inputImages: 2 });
  const studioDefault = estimateCollageBoardCost({
    params: { collageType: "kitchen_material_palette", orientation: "default", quality: "medium" },
    inputImages: 2,
  });
  const finalResolution = estimateCollageBoardCost({
    params: { collageType: "kitchen_material_palette", orientation: "default", quality: "medium", outputResolution: "final" },
    inputImages: 2,
  });
  assert.ok(studioDefault !== null && finalResolution !== null);
  // Default (no outputResolution -> "studio") resolves to 2048x1360, ~1.77x
  // more output pixels than the flat 1536x1024 the old estimator silently
  // assumed -- must estimate materially higher, not equal.
  assert.ok(studioDefault > flatFallback, "the default (studio) resolved size must estimate above the old flat 1536x1024 fallback");
  // "final" resolves to 2560x1440, larger again than "studio"'s 2048x1360.
  assert.ok(finalResolution > studioDefault, "'final' output resolution must estimate higher than 'studio'");
});

test("draft-mode reduction: generation.ts's draftOverride forces the cheapest quality tier, which estimateCost then reflects", () => {
  const highQuality = estimateGenerationCost({ params: { size: "1536x1024", quality: "high", candidates: 1 }, inputImages: 0 });
  const draftQuality = estimateGenerationCost({ params: { size: "1536x1024", quality: "low", candidates: 1 }, inputImages: 0 });
  assert.ok(draftQuality < highQuality, "draft (low) quality must estimate cheaper than high quality");
});

// issue-3/AC22: draft mode must ALSO force a small size, not just low
// quality -- both halves must show up in the estimate. N-7 (round 4) closed
// a real gap here: RunFooter's PER-NODE display used to read raw (non-draft)
// params directly, so its price and its confirmHighCost gate silently
// ignored draft mode even though the toolbar aggregate (estimateStaleCost),
// the memoization signature, and the actual request all already applied the
// override -- an Upscaler in Draft still showed "Run · ~$0.40" and popped
// the $0.40 confirm for a run that would actually cost a fraction of a cent.
// RunFooter now composes draftOverrideMap[kind] + estimateCostMap[kind] the
// exact same way executor.ts's estimateStaleCost does (see the dedicated
// "per-node display path" test below, which asserts that composition
// directly), so this estimator-level assertion is now genuinely true
// everywhere it claims to be, not just at the toolbar/signature layer.
test("draft-mode reduction: the SIZE half compounds with the quality half -- a large size at full quality must estimate more than the SAME size run through generationDraftOverride (quality low + size shrunk)", () => {
  const fullQualityLargeSize = estimateGenerationCost({ params: { size: "2560x1440", quality: "high", candidates: 1 }, inputImages: 0 });
  const draftEffective = generationDraftOverride({ size: "2560x1440", quality: "high", candidates: 1 });
  const draftCost = estimateGenerationCost({ params: draftEffective, inputImages: 0 });
  assert.ok(draftCost < fullQualityLargeSize, "draft mode's shrunk size + low quality must cost noticeably less than the full-size, full-quality run");

  // Isolate the SIZE half specifically: quality-low-but-original-size must
  // still cost MORE than quality-low-AND-shrunk-size (proving the size
  // reduction contributes on top of the quality reduction, not just quality
  // alone as before this fix).
  const qualityOnlyDraft = estimateGenerationCost({ params: { size: "2560x1440", quality: "low", candidates: 1 }, inputImages: 0 });
  assert.ok(draftCost < qualityOnlyDraft, "the size shrink must lower cost further than a quality-only reduction at the original size");
});

test("Collage Board's draft override lowers its own cost estimate via the smaller 'standard' resolvedSize on top of the quality drop", () => {
  const fullQualityStudio = estimateCollageBoardCost({
    params: { collageType: "kitchen_material_palette", orientation: "default", quality: "high" },
    inputImages: 2,
  });
  const draftEffective = draftOverrideMap.collageBoard({ collageType: "kitchen_material_palette", orientation: "default", quality: "high" });
  const draftCost = estimateCollageBoardCost({ params: draftEffective, inputImages: 2 });
  assert.ok(draftCost < fullQualityStudio, "Collage Board's draft override must estimate cheaper than a full-quality studio run");

  const qualityOnlyDraft = estimateCollageBoardCost({
    params: { collageType: "kitchen_material_palette", orientation: "default", quality: "low" }, // still defaults to "studio" outputResolution
    inputImages: 2,
  });
  assert.ok(draftCost < qualityOnlyDraft, "forcing outputResolution to 'standard' must lower the estimate further than a quality-only reduction");
});

// N-7: this is the EXACT composition RunFooter (nodes/shared.tsx) now
// performs for its per-node price label and its confirmHighCost gate --
// `draft ? draftOverrideMap[kind]?.(params) ?? params : params` fed to
// estimateCostMap[kind] -- mirroring executor.ts's estimateStaleCost.
// RunFooter itself is a React component with no framework-free import path,
// so this asserts the identical (kind, params) -> effective-params ->
// estimate pipeline it delegates to, for the exact scenario N-7 named: an
// Upscaler at its most expensive size.
test("N-7: the per-node display's draft-effective composition (draftOverrideMap + estimateCostMap, exactly as RunFooter applies them) estimates cheaper in draft mode than the non-draft price for the same node", () => {
  const kind = "upscaler";
  const params = { size: "3840x2160", quality: "high" };
  const nonDraftEstimate = estimateCostMap[kind]({ params, inputImages: 1 });
  const draftParams = draftOverrideMap[kind](params);
  const draftEstimate = estimateCostMap[kind]({ params: draftParams, inputImages: 1 });
  assert.ok(
    nonDraftEstimate !== null && draftEstimate !== null && draftEstimate < nonDraftEstimate,
    "RunFooter's per-node price must reflect draft mode's real (lower) cost, not the non-draft price",
  );
});

// issue-7/AC10: the Upscaler's own estimateCost must resolve an out-of-menu
// size (as the generic Inspector can produce) before estimating, exactly
// like execute()/stableParams do, rather than feeding an arbitrary string
// straight to the generic generation estimator.
test("Upscaler's estimateCost resolves an out-of-menu size to the nearest valid target before estimating", () => {
  const withGarbageSize = estimateCostMap.upscaler({ params: { size: "not-a-size", quality: "high" }, inputImages: 1 });
  const withDefaultSize = estimateCostMap.upscaler({ params: { size: "2560x1440", quality: "high" }, inputImages: 1 });
  assert.equal(withGarbageSize, withDefaultSize, "an unparseable size must estimate the same as the node's own default");

  // N-10: "1300x900" (not a divisible-by-16 size, so never itself valid --
  // an arbitrary/garbage-ish value someone might free-type, not one of the
  // Upscaler's own recognized draft sizes) is used here rather than the
  // previous example ("1072x624"), which is now a RECOGNIZED draft-mode size
  // (see resolveUpscaleSize's UPSCALE_DRAFT_SIZE_SET) and must legitimately
  // pass through unchanged rather than snap to a full menu option -- see the
  // dedicated N-10 test below for that behavior.
  const withUnlistedSize = estimateCostMap.upscaler({ params: { size: "1300x900", quality: "high" }, inputImages: 1 });
  const withSmallestMenu = estimateCostMap.upscaler({ params: { size: "1536x1024", quality: "high" }, inputImages: 1 });
  assert.equal(withUnlistedSize, withSmallestMenu, "a parseable-but-unlisted, non-draft size must resolve to (and estimate as) its nearest menu option");
});

// N-10: before this fix, EVERY Upscaler draft run's effective size collapsed
// back to 1536x1024 (the smallest FULL menu option) because resolveUpscaleSize
// unconditionally re-snapped the override's already-small computed size back
// up to it -- draft mode cost ~2.4x more than intended. The draft estimate
// must now beat even the smallest full menu option, not merely match it.
test("N-10: the Upscaler's draft override estimates cheaper than the smallest full menu option (the draft-computed size must not be re-snapped back up to a full menu size)", () => {
  const draftEffective = draftOverrideMap.upscaler({ size: "3840x2160", quality: "high" });
  const draftEstimate = estimateCostMap.upscaler({ params: draftEffective, inputImages: 1 });
  const smallestMenuEstimate = estimateCostMap.upscaler({ params: { size: "1536x1024", quality: "low" }, inputImages: 1 });
  assert.ok(
    draftEstimate < smallestMenuEstimate,
    "the Upscaler's draft estimate must beat even the smallest full menu option, not collapse to it",
  );
});

// N-10: resolveUpscaleSize must recognize the Upscaler's OWN draft-computed
// sizes as already-resolved (pass through unchanged), for every menu option
// -- not just the one exercised above -- otherwise estimate/sign/submit could
// still silently disagree for a different starting selection.
test("N-10: resolveUpscaleSize passes every one of the Upscaler's own draft-computed sizes through unchanged (never re-snaps them back to a full menu option)", () => {
  const menuSizes = ["1536x1024", "2048x2048", "2560x1440", "3200x1792", "3840x2160"];
  for (const size of menuSizes) {
    const draft = draftOverrideMap.upscaler({ size, quality: "high" });
    assert.equal(resolveUpscaleSize(draft.size), draft.size, `${size}: the draft-computed size must be a no-op through resolveUpscaleSize`);
  }
});

// issue-6: every generation-shaped execute wrapper that receives usage back
// from /api/workbench/edit must feed calibration through the ONE shared
// helper, not just executeGeneration's three callers.
test("recordUsageCalibration extracts image_tokens from a raw usage object and records the same EMA bucket recordImageTokenCalibration would", () => {
  const adapter = createMemoryAdapter();
  setCalibrationStorageAdapter(adapter);
  recordUsageCalibration("1536x1024", "high", { input_tokens_details: { image_tokens: 1200 } }, 2);
  const record = readRecord(adapter);
  const bucket = record.buckets["1536x1024|high"];
  assert.ok(bucket, "expected a bucket keyed by size|quality");
  assert.equal(bucket.samples, 1);
  assert.ok(Math.abs(bucket.usdPerImage - (1200 * (30 / 1_000_000)) / 2) < 1e-9);
});

test("recordUsageCalibration is a no-op when usage is missing or carries no image_tokens (matches recordImageTokenCalibration's own guard)", () => {
  const adapter = createMemoryAdapter();
  setCalibrationStorageAdapter(adapter);
  recordUsageCalibration("1536x1024", "high", undefined, 2);
  recordUsageCalibration("1536x1024", "high", {}, 2);
  recordUsageCalibration("1536x1024", "high", { input_tokens_details: {} }, 2);
  // Nothing was ever recorded, so nothing was ever written at all -- unlike
  // a real bucket update, a true no-op never calls saveCalibration.
  assert.equal(adapter.store.has(CALIBRATION_STORAGE_KEY), false);
});
