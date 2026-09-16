import assert from "node:assert/strict";
import test from "node:test";

import { GENERATION_SIZES } from "../app/components/workbench/nodes/generation.ts";
import { UPSCALE_SIZES } from "../app/components/workbench/nodes/upscaler.manifest.ts";
import { classifySize } from "../app/lib/image-model-limits.ts";

// Regression guard: catches anyone adding a menu size OpenAI would reject
// outright. Experimental (above the 3,686,400 px line) is fine and expected
// here — legal is the only hard requirement for a picker entry.
test("every GENERATION_SIZES entry is legal per classifySize", () => {
  for (const size of GENERATION_SIZES) {
    const verdict = classifySize(size);
    assert.ok(verdict.legal, `${size} is illegal: ${verdict.reasons.join(", ")}`);
  }
});

test("every UPSCALE_SIZES entry is legal per classifySize", () => {
  for (const size of UPSCALE_SIZES) {
    const verdict = classifySize(size);
    assert.ok(verdict.legal, `${size} is illegal: ${verdict.reasons.join(", ")}`);
  }
});

test("GENERATION_SIZES' experimental set is exactly {2048x2048}", () => {
  const experimental = GENERATION_SIZES.filter((size) => classifySize(size).experimental);
  assert.deepEqual(experimental, ["2048x2048"]);
});

test("UPSCALE_SIZES' experimental set is exactly {2048x2048, 3200x1792, 3840x2160}", () => {
  const experimental = UPSCALE_SIZES.filter((size) => classifySize(size).experimental);
  assert.deepEqual(experimental, ["2048x2048", "3200x1792", "3840x2160"]);
});
