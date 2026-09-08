import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateSunburstUsageCost,
  isSunburstModel,
  LEGACY_IMAGE_MODEL,
  LEGACY_IMAGE_QUALITIES,
  resolveLegacyImageQuality,
  resolveWireModel,
  SUNBURST_DEFAULT_INPUT_FIDELITY,
  SUNBURST_MODEL,
  SUNBURST_MODEL_SNAPSHOT,
  SUNBURST_QUALITIES,
} from "../app/lib/sunburst.ts";

test("Sunburst contracts expose the migrated model and all supported quality tiers", () => {
  assert.equal(SUNBURST_MODEL, "gpt-image-2.5-sunburst");
  assert.deepEqual(SUNBURST_QUALITIES, ["low", "medium", "high", "xhigh", "max", "auto"]);
});

test("the stored Sunburst identity is the alias while the wire model is the pinned snapshot", () => {
  // Storage keeps the alias so old plans, saved workflows and cache keys stay
  // valid across snapshot bumps; only the upstream request is pinned.
  assert.equal(SUNBURST_MODEL_SNAPSHOT, "gpt-image-2.5-sunburst-2026-09-08");
  assert.equal(resolveWireModel(SUNBURST_MODEL), SUNBURST_MODEL_SNAPSHOT);
  assert.notEqual(SUNBURST_MODEL, SUNBURST_MODEL_SNAPSHOT);
});

test("resolveWireModel passes through an explicit snapshot and the legacy model untouched", () => {
  assert.equal(resolveWireModel(SUNBURST_MODEL_SNAPSHOT), SUNBURST_MODEL_SNAPSHOT);
  assert.equal(resolveWireModel(LEGACY_IMAGE_MODEL), LEGACY_IMAGE_MODEL);
  assert.equal(resolveWireModel("gpt-image-2.5-flare"), "gpt-image-2.5-flare");
});

test("isSunburstModel accepts the alias and its dated snapshots but not other models", () => {
  assert.equal(isSunburstModel(SUNBURST_MODEL), true);
  assert.equal(isSunburstModel(SUNBURST_MODEL_SNAPSHOT), true);
  assert.equal(isSunburstModel(LEGACY_IMAGE_MODEL), false);
  assert.equal(isSunburstModel("gpt-image-2.5-flare"), false);
});

test("input_fidelity stays unsent until the live probe confirms Sunburst honours it", () => {
  // The edits schema accepts the field, but the guide documents it only for
  // earlier GPT Image models. Until scripts/probe-input-fidelity.mjs settles
  // it, no paid render may carry an unverified parameter.
  assert.equal(SUNBURST_DEFAULT_INPUT_FIDELITY, undefined);
});

test("legacy Workbench quality contract keeps xhigh and max on their prior medium fallback", () => {
  assert.deepEqual(LEGACY_IMAGE_QUALITIES, ["low", "medium", "high", "auto"]);
  assert.equal(resolveLegacyImageQuality("high"), "high");
  assert.equal(resolveLegacyImageQuality("xhigh"), "medium");
  assert.equal(resolveLegacyImageQuality("max"), "medium");
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

test("calculateSunburstUsageCost applies the Batch 50 percent discount only when requested", () => {
  const usage = {
    input_tokens: 1_000_000,
    input_tokens_details: { text_tokens: 250_000, image_tokens: 750_000 },
    output_tokens: 100_000,
  };
  const standard = calculateSunburstUsageCost(usage, "standard");
  const batch = calculateSunburstUsageCost(usage, "batch");
  assert.equal(standard, 10.25);
  assert.equal(batch, 5.125);
  assert.equal(calculateSunburstUsageCost(usage, { multiplier: 0.25 }), 2.5625);
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
  }, "batch"), null);
});
