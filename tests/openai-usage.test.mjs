import assert from "node:assert/strict";
import test from "node:test";
import {
  cacheHitRate,
  extractOpenAIUsage,
  logOpenAIUsage,
  readOpenAIResponse,
} from "../app/lib/openai-server.ts";

function jsonResponse(payload, init = {}) {
  return new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

function captureInfo(run) {
  const original = console.info;
  const lines = [];
  console.info = (...args) => lines.push(args.join(" "));
  try {
    return { result: run(), lines };
  } finally {
    console.info = original;
  }
}

test("extractOpenAIUsage reads Responses API cached tokens", () => {
  const usage = extractOpenAIUsage({
    usage: {
      input_tokens: 4000,
      output_tokens: 120,
      input_tokens_details: { cached_tokens: 3072 },
    },
  });
  assert.deepEqual(usage, { inputTokens: 4000, cachedInputTokens: 3072, outputTokens: 120 });
});

test("extractOpenAIUsage reads Chat Completions cached tokens", () => {
  const usage = extractOpenAIUsage({
    usage: {
      prompt_tokens: 2048,
      completion_tokens: 64,
      prompt_tokens_details: { cached_tokens: 1024 },
    },
  });
  assert.deepEqual(usage, { inputTokens: 2048, cachedInputTokens: 1024, outputTokens: 64 });
});

test("extractOpenAIUsage treats a missing details block as zero cache hits", () => {
  const usage = extractOpenAIUsage({ usage: { input_tokens: 500, output_tokens: 10 } });
  assert.deepEqual(usage, { inputTokens: 500, cachedInputTokens: 0, outputTokens: 10 });
});

test("extractOpenAIUsage returns undefined for payloads with no usage block", () => {
  // Uploads, files, and batches share readOpenAIResponse but report no usage;
  // they must be omitted from metrics, not counted as 0% cache hits.
  assert.equal(extractOpenAIUsage({ id: "file_123" }), undefined);
  assert.equal(extractOpenAIUsage({ usage: null }), undefined);
  assert.equal(extractOpenAIUsage(null), undefined);
  assert.equal(extractOpenAIUsage("not-an-object"), undefined);
});

test("extractOpenAIUsage ignores a usage block with no token counts", () => {
  assert.equal(extractOpenAIUsage({ usage: { something_else: 1 } }), undefined);
});

test("cacheHitRate divides cached by total input, and never divides by zero", () => {
  assert.equal(cacheHitRate({ inputTokens: 4000, cachedInputTokens: 3000, outputTokens: 0 }), 0.75);
  assert.equal(cacheHitRate({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }), 0);
});

test("logOpenAIUsage emits one greppable line with label and model", () => {
  const { lines } = captureInfo(() =>
    logOpenAIUsage(
      { inputTokens: 4000, cachedInputTokens: 3072, outputTokens: 120 },
      { label: "qa", model: "gpt-5.4-mini" },
    ),
  );
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[openai-usage\]/);
  assert.match(lines[0], /label=qa/);
  assert.match(lines[0], /model=gpt-5\.4-mini/);
  assert.match(lines[0], /input=4000/);
  assert.match(lines[0], /cached=3072/);
  assert.match(lines[0], /hit=76\.8%/);
  assert.match(lines[0], /output=120/);
});

test("logOpenAIUsage falls back to unknown when context is omitted", () => {
  const { lines } = captureInfo(() =>
    logOpenAIUsage({ inputTokens: 10, cachedInputTokens: 0, outputTokens: 1 }),
  );
  assert.match(lines[0], /label=unknown model=unknown/);
});

test("readOpenAIResponse logs usage on a successful call", async () => {
  const original = console.info;
  const lines = [];
  console.info = (...args) => lines.push(args.join(" "));
  try {
    const payload = await readOpenAIResponse(
      jsonResponse({
        output: [],
        usage: { input_tokens: 1000, output_tokens: 50, input_tokens_details: { cached_tokens: 500 } },
      }),
      { label: "qa", model: "gpt-5.6" },
    );
    assert.deepEqual(payload.usage.input_tokens, 1000);
  } finally {
    console.info = original;
  }
  assert.equal(lines.length, 1);
  assert.match(lines[0], /label=qa model=gpt-5\.6 input=1000 cached=500 hit=50\.0% output=50/);
});

test("readOpenAIResponse stays silent for responses without usage", async () => {
  const original = console.info;
  const lines = [];
  console.info = (...args) => lines.push(args.join(" "));
  try {
    await readOpenAIResponse(jsonResponse({ id: "upload_123" }), { label: "upload" });
  } finally {
    console.info = original;
  }
  assert.equal(lines.length, 0);
});

test("readOpenAIResponse does not log usage for a failed call", async () => {
  const original = console.info;
  const lines = [];
  console.info = (...args) => lines.push(args.join(" "));
  try {
    await assert.rejects(
      readOpenAIResponse(
        jsonResponse({ error: { message: "rate limited", code: "rate_limit" } }, { status: 429 }),
        { label: "qa" },
      ),
      /rate limited/,
    );
  } finally {
    console.info = original;
  }
  assert.equal(lines.length, 0);
});
