import assert from "node:assert/strict";
import test from "node:test";

import * as sunburst from "../app/lib/sunburst.ts";

import {
  calculateSunburstUsageCost,
  isSunburstModel,
  normalizeImageModelParams,
  normalizeStoredModel,
  resolveWireModel,
  SUNBURST_SUPPORTS_INPUT_FIDELITY,
  SUNBURST_MODEL,
  SUNBURST_QUALITIES,
  TEST_MODEL_2_5,
} from "../app/lib/sunburst.ts";

// Every id that must never reach the wire as itself. The bare 2.5 alias is
// here on purpose: it is what stale tabs and saved workflows carry, so only
// the Test node's exact dated snapshot (TEST_MODEL_2_5) may render on 2.5.
const RETIRED_IDS = [
  "gpt-image-2",
  "gpt-image-2.5-sunburst",
  "gpt-image-2.5-sunburst-2026-01-01",
  "gpt-image-2.5-flare",
  "gpt-image-2.6-flare",
  "gpt-image-1",
  "",
  "not-a-model",
];

test("Sunburst contracts expose the 2.6 model and all supported quality tiers", () => {
  assert.equal(SUNBURST_MODEL, "gpt-image-2.6-sunburst");
  assert.deepEqual(SUNBURST_QUALITIES, ["low", "medium", "high", "xhigh", "max", "auto"]);
});

test("the retired model constants, the pinned 2.5 snapshot, Flare and Batch pricing are gone", () => {
  assert.equal("LEGACY_IMAGE_MODEL" in sunburst, false);
  assert.equal("SUNBURST_MODEL_SNAPSHOT" in sunburst, false);
  assert.equal("FLARE_MODEL" in sunburst, false);
  assert.equal("SUNBURST_BATCH_COST_MULTIPLIER" in sunburst, false);
});

test("resolveWireModel sends 2.6 Sunburst for every value except the Test node's 2.5 snapshot", () => {
  // 2.6 Sunburst has no dated snapshot, so the alias itself is the wire id.
  assert.equal(resolveWireModel(SUNBURST_MODEL), "gpt-image-2.6-sunburst");
  for (const id of RETIRED_IDS) assert.equal(resolveWireModel(id), SUNBURST_MODEL, id);
  assert.equal(resolveWireModel(undefined), SUNBURST_MODEL);
  assert.equal(resolveWireModel(null), SUNBURST_MODEL);
  assert.equal(TEST_MODEL_2_5, "gpt-image-2.5-sunburst-2026-09-08");
  assert.equal(resolveWireModel(TEST_MODEL_2_5), TEST_MODEL_2_5);
});

test("normalizeStoredModel maps every legacy stored value onto 2.6 Sunburst and keeps a Test node's 2.5", () => {
  assert.equal(normalizeStoredModel(SUNBURST_MODEL), SUNBURST_MODEL);
  for (const id of RETIRED_IDS) assert.equal(normalizeStoredModel(id), SUNBURST_MODEL, id);
  assert.equal(normalizeStoredModel(42), SUNBURST_MODEL);
  assert.equal(normalizeStoredModel(TEST_MODEL_2_5), TEST_MODEL_2_5);
  const testParams = { model: TEST_MODEL_2_5 };
  assert.equal(normalizeImageModelParams(testParams), testParams);
});

test("normalizeImageModelParams rewrites only gpt-image-* model params", () => {
  const legacy = { model: "gpt-image-2.5-sunburst", size: "1024x1024" };
  assert.deepEqual(normalizeImageModelParams(legacy), { model: SUNBURST_MODEL, size: "1024x1024" });
  assert.equal(legacy.model, "gpt-image-2.5-sunburst", "the input record is not mutated");
  assert.deepEqual(normalizeImageModelParams({ model: "gpt-image-2" }), { model: SUNBURST_MODEL });
  // Text-model params (AI Assistant, CLI nodes) are left alone.
  const text = { model: "gpt-5.4-mini" };
  assert.equal(normalizeImageModelParams(text), text);
  const current = { model: SUNBURST_MODEL };
  assert.equal(normalizeImageModelParams(current), current);
  const none = { size: "1024x1024" };
  assert.equal(normalizeImageModelParams(none), none);
});

test("isSunburstModel accepts current and historical Sunburst ids but not other models", () => {
  assert.equal(isSunburstModel(SUNBURST_MODEL), true);
  assert.equal(isSunburstModel("gpt-image-2.5-sunburst"), true);
  assert.equal(isSunburstModel("gpt-image-2.5-sunburst-2026-09-08"), true);
  assert.equal(isSunburstModel("gpt-image-2"), false);
  assert.equal(isSunburstModel("gpt-image-2.6-flare"), false);
  assert.equal(isSunburstModel("gpt-image-2.5-flare"), false);
  assert.equal(isSunburstModel("gpt-image-2.5-sunburstx"), false);
});

test("Sunburst is recorded as not supporting input_fidelity", () => {
  // Verified live: HTTP 400 invalid_input_fidelity_model from
  // gpt-image-2.5-sunburst-2026-09-08 on 2026-09-08. 2.6 does not document
  // the field, so it stays unsent.
  assert.equal(SUNBURST_SUPPORTS_INPUT_FIDELITY, false);
});

test("every surface now shares one quality contract, with no legacy downgrade left", () => {
  // The Workbench was the last caller clamping xhigh/max down to medium. It
  // runs Sunburst now (tests/workbench-quality-contract.test.mjs), so the
  // legacy quality subset is gone rather than merely unused.
  assert.equal("LEGACY_IMAGE_QUALITIES" in sunburst, false);
  assert.equal("resolveLegacyImageQuality" in sunburst, false);
});

test("calculateSunburstUsageCost prices complete text, image, and output usage", () => {
  const cost = calculateSunburstUsageCost({
    input_tokens: 1_000_000,
    input_tokens_details: { text_tokens: 250_000, image_tokens: 750_000 },
    output_tokens: 100_000,
  });
  assert.equal(cost, 10.25);
});

test("calculateSunburstUsageCost applies documented cache rates by modality", () => {
  const cost = calculateSunburstUsageCost({
    input_tokens: 1_000_000,
    input_tokens_details: {
      text_tokens: 500_000,
      image_tokens: 500_000,
      cached_text_tokens: 100_000,
      cached_image_tokens: 200_000,
      cached_tokens: 300_000,
    },
    output_tokens: 100_000,
  });
  assert.ok(Math.abs(cost - (5 * 0.4 + 1.25 * 0.1 + 8 * 0.3 + 2 * 0.2 + 30 * 0.1)) < 1e-12);
});

test("calculateSunburstUsageCost stays unavailable when usage is incomplete", () => {
  assert.equal(calculateSunburstUsageCost(undefined), null);
  assert.equal(calculateSunburstUsageCost({ input_tokens: 10, output_tokens: 20 }), null);
  assert.equal(calculateSunburstUsageCost({
    input_tokens: 10,
    input_tokens_details: { image_tokens: 5, cached_tokens: 2 },
    output_tokens: 20,
  }), null);
  assert.equal(calculateSunburstUsageCost({
    input_tokens: 10,
    input_tokens_details: { image_tokens: 5 },
  }), null);
});
