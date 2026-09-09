import assert from "node:assert/strict";
import test from "node:test";

import {
  estimateOutputUsd,
  lookupOutputTokens,
  outputTokenKey,
  outputTokensFromUsage,
  outputTokensToUsd,
  recordOutputTokens,
} from "../app/lib/output-tokens.ts";
import { outputTokenTableFrom, stageSize } from "../scripts/autoboard/lib/render.mjs";

const MODEL = "gpt-image-2.5-sunburst";

test("a combination that has never rendered has no estimate, rather than a neighbour's", () => {
  const table = {};
  recordOutputTokens(table, { model: MODEL, size: "1536x1024", quality: "low", outputTokens: 158 });

  assert.equal(lookupOutputTokens(table, MODEL, "1536x1024", "low"), 158);
  // Same size, unmeasured tier: high sits in a 16x gap between medium and max,
  // so substituting anything here would be a guess.
  assert.equal(lookupOutputTokens(table, MODEL, "1536x1024", "high"), undefined);
  // Same tier, unmeasured size: output tokens do not scale cleanly with pixels.
  assert.equal(lookupOutputTokens(table, MODEL, "2560x1440", "low"), undefined);
  assert.equal(estimateOutputUsd(table, { model: MODEL, size: "2560x1440", quality: "low" }), null);
});

test("the model is part of the key, so a snapshot bump retires old counts instead of misreporting", () => {
  const table = {};
  recordOutputTokens(table, { model: MODEL, size: "1536x1024", quality: "max", outputTokens: 5488 });
  assert.equal(lookupOutputTokens(table, `${MODEL}-2027-01-01`, "1536x1024", "max"), undefined);
  assert.notEqual(outputTokenKey(MODEL, "1536x1024", "max"), outputTokenKey("other", "1536x1024", "max"));
});

test("observations are folded in, and a changed count wins over the old one", () => {
  const table = {};
  assert.equal(recordOutputTokens(table, { model: MODEL, size: "1536x1024", quality: "low", outputTokens: 158 }), true);
  // Deterministic counts mean a repeat is not new information.
  assert.equal(recordOutputTokens(table, { model: MODEL, size: "1536x1024", quality: "low", outputTokens: 158 }), false);
  // A different count means upstream behaviour changed, so the newer one wins.
  assert.equal(recordOutputTokens(table, { model: MODEL, size: "1536x1024", quality: "low", outputTokens: 170 }), true);
  assert.equal(lookupOutputTokens(table, MODEL, "1536x1024", "low"), 170);
});

test("an incomplete observation is ignored rather than recorded as zero", () => {
  const table = {};
  for (const partial of [
    { model: MODEL, size: "1536x1024", quality: "low" },
    { model: MODEL, size: "1536x1024", outputTokens: 158 },
    { model: MODEL, quality: "low", outputTokens: 158 },
    { size: "1536x1024", quality: "low", outputTokens: 158 },
    { model: MODEL, size: "1536x1024", quality: "low", outputTokens: 0 },
    { model: MODEL, size: "1536x1024", quality: "low", outputTokens: Number.NaN },
  ]) {
    assert.equal(recordOutputTokens(table, partial), false);
  }
  assert.deepEqual(table, {});
});

test("output tokens are read from the nested detail, falling back to the flat total", () => {
  assert.equal(outputTokensFromUsage({ output_tokens_details: { image_tokens: 158 }, output_tokens: 158 }), 158);
  assert.equal(outputTokensFromUsage({ output_tokens: 343 }), 343);
  assert.equal(outputTokensFromUsage({}), undefined);
  assert.equal(outputTokensFromUsage(null), undefined);
});

test("the measured draft and final combinations price out to what those renders actually billed", () => {
  // Real recorded usage: 1536x1024 low reported 158 output tokens on 18
  // separate renders; 2560x1440 max reported 7,370.
  assert.ok(Math.abs(outputTokensToUsd(158) - 0.00474) < 1e-5);
  assert.ok(Math.abs(outputTokensToUsd(7370) - 0.2211) < 1e-4);

  const table = {};
  recordOutputTokens(table, { model: MODEL, size: "1536x1024", quality: "low", outputTokens: 158 });
  // Four drafts of the same variant cost four times one draft's output.
  const four = estimateOutputUsd(table, { model: MODEL, size: "1536x1024", quality: "low", count: 4 });
  assert.ok(Math.abs(four - 0.00474 * 4) < 1e-5);
});

test("the table builds itself from a run's completed renders, skipping records with no size", () => {
  const results = {
    renders: {
      "board-a": {
        drafts: [
          { model: MODEL, size: "1536x1024", quality: "low", usage: { output_tokens_details: { image_tokens: 158 } } },
          // Written before size was recorded: contributes nothing, no crash.
          { model: MODEL, quality: "low", usage: { output_tokens_details: { image_tokens: 158 } } },
        ],
        confirmed: [
          { model: MODEL, size: "1536x1024", quality: "medium", usage: { output_tokens_details: { image_tokens: 343 } } },
        ],
        finals: [
          { model: MODEL, size: "2560x1440", quality: "max", usage: { output_tokens_details: { image_tokens: 7370 } } },
        ],
      },
      "board-b": { drafts: [], confirmed: [], finals: [] },
    },
  };
  const table = outputTokenTableFrom(results);
  assert.equal(lookupOutputTokens(table, MODEL, "1536x1024", "low"), 158);
  assert.equal(lookupOutputTokens(table, MODEL, "1536x1024", "medium"), 343);
  assert.equal(lookupOutputTokens(table, MODEL, "2560x1440", "max"), 7370);
  assert.equal(Object.keys(table).length, 3);
});

test("outputTokenTableFrom tolerates an empty or malformed results file", () => {
  assert.deepEqual(outputTokenTableFrom({}), {});
  assert.deepEqual(outputTokenTableFrom({ renders: {} }), {});
  assert.deepEqual(outputTokenTableFrom({ renders: { a: {} } }), {});
});

test("stageSize matches the sizes the payload builders actually request", () => {
  // The lookup only works if it keys on the same string the render reports.
  assert.equal(stageSize("draft"), "1536x1024");
  assert.equal(stageSize("confirm"), "1536x1024");
  assert.equal(stageSize("final"), "2560x1440");
});
