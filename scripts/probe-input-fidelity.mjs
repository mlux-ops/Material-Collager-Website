#!/usr/bin/env node
// Settles one question the published docs leave open: does the pinned Sunburst
// snapshot accept `input_fidelity` on /v1/images/edits?
//
// The edits schema lists `input_fidelity: "high" | "low"` with no model
// restriction, but the image generation guide documents the parameter only
// under "Earlier GPT Image models" and states that gpt-image-2 rejects it.
// Nothing in the app sends the field until this probe answers, because an
// unverified parameter must not ride along on a paid board render.
//
// Cost: two 1024x1024 low-quality edits with one tiny synthetic reference.
// That is the cheapest request the endpoint will take. It is still a real,
// billed API call — this script never runs on its own.
//
//   OPENAI_API_KEY=sk-... node scripts/probe-input-fidelity.mjs
//
// Exit code 0 means the probe ran and printed a verdict; 1 means it could not
// reach a verdict (missing key, network fault, or an error unrelated to the
// parameter under test).

import { SUNBURST_MODEL_SNAPSHOT } from "../app/lib/sunburst.ts";

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error("Set OPENAI_API_KEY. This probe makes two real, billed requests.");
  process.exit(1);
}

// A 1x1 red PNG. The endpoint upscales the reference to the requested size, so
// the payload stays trivial while still exercising the reference-image path
// that input_fidelity is supposed to govern.
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

async function attempt(label, inputFidelity) {
  const form = new FormData();
  form.append("model", SUNBURST_MODEL_SNAPSHOT);
  form.append("prompt", "Keep the supplied swatch exactly as it is on a white background.");
  form.append("size", "1024x1024");
  form.append("quality", "low");
  form.append("background", "opaque");
  form.append("output_format", "png");
  form.append("image[]", new Blob([ONE_PIXEL_PNG], { type: "image/png" }), "swatch.png");
  if (inputFidelity) form.append("input_fidelity", inputFidelity);

  const started = Date.now();
  const response = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(300_000),
  });
  const requestId = response.headers.get("x-request-id") ?? "(none)";
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const usage = parsed?.usage;
  console.log(`\n[${label}] HTTP ${response.status}  request-id ${requestId}  ${Date.now() - started}ms`);
  if (response.ok) {
    console.log(`  usage: ${JSON.stringify(usage ?? {})}`);
  } else {
    const error = parsed?.error ?? {};
    console.log(`  error.type=${error.type ?? "?"} error.param=${error.param ?? "?"} error.code=${error.code ?? "?"}`);
    console.log(`  error.message=${error.message ?? text.slice(0, 400)}`);
  }
  return { ok: response.ok, status: response.status, error: parsed?.error, usage, requestId };
}

const IMAGE_INPUT_USD_PER_MILLION = 8;

function imageTokens(result) {
  const value = result.usage?.input_tokens_details?.image_tokens;
  return typeof value === "number" ? value : undefined;
}

const baseline = await attempt("baseline: no input_fidelity", undefined);
if (!baseline.ok) {
  console.error("\nVERDICT: inconclusive — the baseline request failed, so the probe never tested the parameter.");
  process.exit(1);
}

// Both directions matter. "high" is the quality question; "low" is the cost
// question, and on gpt-image-1 the gap between them is a flat 4160-6240 image
// input tokens PER REFERENCE, which dominates a 16-reference board's bill.
const high = await attempt("probe: input_fidelity=high", "high");
const low = high.ok ? await attempt("probe: input_fidelity=low", "low") : { ok: false, status: 0 };

console.log("\n--------------------------------------------------------------");
if (!high.ok && high.status === 400) {
  console.log("VERDICT: REJECTED. Sunburst does not take input_fidelity; leave");
  console.log("         SUNBURST_DEFAULT_INPUT_FIDELITY undefined. Reference fidelity is");
  console.log("         the model's own decision, as it is for gpt-image-2, and it is not");
  console.log("         available as a per-render cost lever.");
  process.exit(0);
}
if (!high.ok) {
  console.log(`VERDICT: inconclusive — HTTP ${high.status} is not a parameter-validation answer. Re-run.`);
  process.exit(1);
}

const baseTokens = imageTokens(baseline);
const highTokens = imageTokens(high);
const lowTokens = imageTokens(low);
console.log("VERDICT: ACCEPTED. The pinned Sunburst snapshot takes input_fidelity.");
console.log(`  image input tokens for ONE 1x1 reference:`);
console.log(`    default (unset): ${baseTokens ?? "?"}`);
console.log(`    high:            ${highTokens ?? "?"}`);
console.log(`    low:             ${lowTokens ?? "?"}`);

if (typeof highTokens === "number" && typeof lowTokens === "number") {
  const perReference = highTokens - lowTokens;
  if (perReference > 0) {
    const perBoard = perReference * 16;
    console.log(`\n  high costs ${perReference} more image input tokens per reference than low.`);
    console.log(`  On a full 16-reference board that is ${perBoard} tokens, or about`);
    console.log(`  $${(perBoard * IMAGE_INPUT_USD_PER_MILLION / 1_000_000).toFixed(4)} per render at $${IMAGE_INPUT_USD_PER_MILLION}/1M image input.`);
    console.log(`  Default appears to be ${baseTokens === highTokens ? "HIGH" : baseTokens === lowTokens ? "LOW" : "neither high nor low"}.`);
    console.log("\n  Cost lever: send input_fidelity \"low\" for drafts, \"high\" for confirm/final.");
  } else {
    console.log("\n  NOTE: high and low report identical image input tokens on this input.");
    console.log("        The field is accepted but looks inert here. Re-probe with a large,");
    console.log("        detailed reference before treating it as a cost or quality lever.");
  }
}
console.log("\n  Then set SUNBURST_DEFAULT_INPUT_FIDELITY in app/lib/sunburst.ts accordingly.");
