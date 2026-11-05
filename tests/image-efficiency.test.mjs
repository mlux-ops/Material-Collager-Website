import assert from "node:assert/strict";
import test from "node:test";
import { createImageEdit, isRetryableImageError } from "../app/lib/image-edit.ts";
import { OpenAIRequestError, readOpenAIResponse } from "../app/lib/openai-server.ts";
import { buildGenerationPrompt } from "../app/lib/collage.ts";

const request = {
  collageType: "bathroom_fixture_collage", orientation: "landscape", quality: "high",
  items: [{ id: "faucet", role: "vanity faucet", imageNames: ["front.png", "side.png"] }],
};
const body = {
  model: "gpt-image-2.6-sunburst", prompt: "Preserve the faucet finish.", size: "2560x1440",
  quality: "high", background: "opaque", output_format: "png",
  references: [{ blob: new Blob(["original pixels"], { type: "image/png" }), filename: "front.png" }],
};

test("ambiguous network failures do not automatically repeat a paid render", () => {
  assert.equal(isRetryableImageError(new TypeError("fetch failed")), false);
});

test("quota and moderation codes are terminal even when the HTTP status is transient", () => {
  for (const code of ["insufficient_quota", "billing_hard_limit_reached", "moderation_blocked"]) {
    assert.equal(isRetryableImageError(new OpenAIRequestError("Request failed", 429, code)), false);
  }
  assert.equal(isRetryableImageError(new OpenAIRequestError("Busy", 503)), true);
});

test("error parsing preserves server retry delay and user-correctable error type", async () => {
  await assert.rejects(readOpenAIResponse(new Response(JSON.stringify({
    error: { message: "Change input", type: "image_generation_user_error", code: "invalid_image" },
  }), { status: 503, headers: { "retry-after": "3", "x-request-id": "req_test" } })), (error) => {
    assert.equal(error.retryAfterMs, 3000);
    assert.equal(error.requestId, "req_test");
    assert.equal(isRetryableImageError(error), false);
    return true;
  });
});

test("a cancelled request does not submit even its first paid call", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json({ data: [{ b64_json: "AA==" }] });
  });
  await assert.rejects(createImageEdit("test-only", body, [], AbortSignal.abort()));
  assert.equal(calls, 0);
});

test("overlong prompts fail before uploading any references", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json({ data: [{ b64_json: "AA==" }] });
  });
  await assert.rejects(createImageEdit("test-only", { ...body, prompt: "x".repeat(32001) }, []), /32,000/);
  assert.equal(calls, 0);
});

test("compact prompts retain user notes, reference mapping, and an explicit styling exception", () => {
  const notes = "Keep the 8-inch handle; do not mirror it.";
  const prompt = buildGenerationPrompt({ ...request, items: [{ ...request.items[0], notes }] });
  assert.ok(prompt.length < 3800, `Prompt contains ${prompt.length} characters`);
  assert.ok(prompt.includes(notes));
  assert.match(prompt, /primary identity view: Image 1/);
  assert.match(prompt, /supporting views of this same physical item: Image 2/);
  assert.match(prompt, /Styling props are excluded from this product count/);
  assert.doesNotMatch(prompt, /nothing outside them earns a place/);
});

test("an approved draft wins over composition presets to prevent final-render layout drift", () => {
  const prompt = buildGenerationPrompt({ ...request, layoutReference: true, composition: "catalog", density: "airy" });
  assert.match(prompt, /Image 1 -> approved draft/);
  assert.doesNotMatch(prompt, /Polished luxury product arrangement|approximately one third/);
  assert.doesNotMatch(prompt, /True overhead camera|Soft, neutral daylight from the upper left/);
  assert.match(prompt, /Keep the approved draft camera and lighting direction/);
});

test("a retryable provider failure never triggers a second paid call", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json({ error: { message: "Busy" } }, { status: 503 });
  });
  await assert.rejects(createImageEdit("test-only", body, []));
  assert.equal(calls, 1);
});

test("Retry-After is surfaced without an automatic repeat", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json({ error: { message: "Busy" } }, { status: 429, headers: { "retry-after": "120" } });
  });
  await assert.rejects(createImageEdit("test-only", body, []));
  assert.equal(calls, 1);
});

test("input_fidelity never reaches the wire, because no model this app uses accepts it", async (t) => {
  // Settled live on 2026-09-08: gpt-image-2.5-sunburst-2026-09-08 answers
  // HTTP 400 invalid_input_fidelity_model, and gpt-image-2 rejected the field
  // too. gpt-image-2.6-sunburst does not document it. The /v1/images/edits
  // schema lists it without a model restriction, so this guard exists to stop
  // the schema tempting it back in.
  const sent = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    sent.push(init.body);
    return Response.json({ data: [{ b64_json: "AA==" }], usage: {} });
  });

  await createImageEdit("k", { ...body, model: "gpt-image-2.6-sunburst", input_fidelity: "low" }, []);
  assert.equal(sent[0].has("input_fidelity"), false);
  assert.equal(sent[0].get("model"), "gpt-image-2.6-sunburst");

  // A retired id that slips through is coerced to 2.6 Sunburst on the wire.
  await createImageEdit("k", { ...body, model: "gpt-image-2" }, []);
  assert.equal(sent[1].has("input_fidelity"), false);
  assert.equal(sent[1].get("model"), "gpt-image-2.6-sunburst");
});

test("references and the mask always go up as multipart bytes, never as file ids", async (t) => {
  let sent;
  let headers;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    sent = init.body;
    headers = init.headers;
    return Response.json({ data: [{ b64_json: "AA==" }], usage: {} });
  });
  await createImageEdit("k", {
    ...body,
    model: "gpt-image-2.6-sunburst",
    references: [
      { filename: "faucet.png", blob: new Blob(["a"], { type: "image/png" }) },
      { filename: "tile.png", blob: new Blob(["b"], { type: "image/png" }) },
    ],
    mask: { filename: "mask.png", blob: new Blob(["m"], { type: "image/png" }) },
  }, []);
  assert.ok(sent instanceof FormData);
  assert.equal(headers["Content-Type"], undefined, "fetch sets the multipart boundary itself");
  assert.deepEqual(sent.getAll("image[]").map((file) => file.name), ["faucet.png", "tile.png"]);
  assert.equal(sent.get("mask").name, "mask.png");
  assert.equal(sent.get("model"), "gpt-image-2.6-sunburst");
  assert.equal(sent.has("images"), false);
});
