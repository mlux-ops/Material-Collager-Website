import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateSunburstUsageCost,
  LEGACY_IMAGE_QUALITIES,
  resolveLegacyImageQuality,
  SUNBURST_MODEL,
  SUNBURST_QUALITIES,
} from "../app/lib/sunburst.ts";

test("Sunburst contracts expose the migrated model and all supported quality tiers", () => {
  assert.equal(SUNBURST_MODEL, "gpt-image-2.5-sunburst");
  assert.deepEqual(SUNBURST_QUALITIES, ["low", "medium", "high", "xhigh", "max", "auto"]);
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
