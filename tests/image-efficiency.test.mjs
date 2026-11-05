import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGenerationBody,
  createImageEdit,
  createImageGeneration,
  isRetryableImageError,
  validateGifSize,
} from "../app/lib/image-edit.ts";
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

test("createImageEdit sends complexity only when set and refuses it for the 2.5 snapshot", async (t) => {
  const sent = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    sent.push(init.body);
    return Response.json({ data: [{ b64_json: "AA==" }], usage: {} });
  });
  await createImageEdit("k", body, []);
  await createImageEdit("k", { ...body, complexity: "low" }, []);
  assert.equal(sent[0].has("complexity"), false);
  assert.equal(sent[1].get("complexity"), "low");
  assert.equal(sent[1].has("input_fidelity"), false);

  await assert.rejects(
    createImageEdit("k", { ...body, model: "gpt-image-2.5-sunburst-2026-09-08", complexity: "high" }, []),
    /2\.6/,
  );
  await assert.rejects(createImageEdit("k", { ...body, complexity: "extreme" }, []), /complexity/i);
  assert.equal(sent.length, 2, "a refused complexity never reaches the wire");
});

test("markup is appended as its own form file and is never combined with a mask", async (t) => {
  const sent = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    sent.push(init.body);
    return Response.json({ data: [{ b64_json: "AA==" }], usage: {} });
  });
  const markup = { filename: "markup.png", blob: new Blob(["m"], { type: "image/png" }) };
  await createImageEdit("k", { ...body, markup }, []);
  assert.equal(sent[0].get("markup").name, "markup.png");
  assert.equal(sent[0].has("mask"), false);

  await assert.rejects(
    createImageEdit("k", { ...body, markup, mask: { filename: "mask.png", blob: new Blob(["x"], { type: "image/png" }) } }, []),
    /markup and a mask/i,
  );
  await assert.rejects(createImageEdit("k", { ...body, references: [], markup }, []), /input image/i);
  await assert.rejects(createImageEdit("k", { ...body, output_format: "svg" }, []), /text-to-image/);
  assert.equal(sent.length, 1);
});

test("generation bodies: SVG is one uncompressed image, GIF carries rounded frame params, complexity only when set", () => {
  const base = { prompt: "A looping candle flame.", size: "512x512", quality: "low" };
  const svg = buildGenerationBody({ ...base, output_format: "svg", n: 3, output_compression: 70 });
  assert.equal(svg.output_format, "svg");
  assert.equal("n" in svg, false);
  assert.equal("output_compression" in svg, false);
  assert.equal("complexity" in svg, false);
  assert.equal("frame_count" in svg, false);

  const gif = buildGenerationBody({ ...base, output_format: "gif", frame_count: 30, frame_duration_ms: 333, output_compression: 70, n: 2, complexity: "medium" });
  assert.equal(gif.frame_count, 30);
  assert.equal(gif.frame_duration_ms, 330);
  assert.equal("output_compression" in gif, false);
  assert.equal(gif.n, 2);
  assert.equal(gif.complexity, "medium");

  // Frame params never ride along with a still format.
  const webp = buildGenerationBody({ ...base, size: "1024x1024", output_format: "webp", frame_count: 9, output_compression: 70 });
  assert.equal("frame_count" in webp, false);
  assert.equal(webp.output_compression, 70);
  assert.equal(webp.model, "gpt-image-2.6-sunburst");
});

test("createImageGeneration refuses SVG, GIF and complexity on the 2.5 snapshot, and out-of-range frames", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json({ data: [{ b64_json: "AA==" }] });
  });
  const base = { prompt: "A looping candle flame.", size: "512x512", quality: "low" };
  const test25 = "gpt-image-2.5-sunburst-2026-09-08";
  await assert.rejects(createImageGeneration("k", { ...base, model: test25, output_format: "svg" }, []), /2\.6/);
  await assert.rejects(createImageGeneration("k", { ...base, model: test25, output_format: "gif" }, []), /2\.6/);
  await assert.rejects(createImageGeneration("k", { ...base, model: test25, complexity: "low" }, []), /2\.6/);
  await assert.rejects(createImageGeneration("k", { ...base, output_format: "gif", frame_count: 65 }, []), /frame count/i);
  await assert.rejects(createImageGeneration("k", { ...base, output_format: "gif", frame_duration_ms: 19 }, []), /frame duration/i);
  assert.equal(calls, 0);
});

test("GIF sizes skip the still-image pixel floor but keep the multiple-of-16, edge and aspect rules", () => {
  assert.equal(validateGifSize("512x512"), null);
  assert.equal(validateGifSize("768x512"), null);
  assert.notEqual(validateGifSize("500x500"), null);
  assert.notEqual(validateGifSize("2048x512"), null, "4:1 is past the 3:1 aspect bound");
  assert.notEqual(validateGifSize("4096x2048"), null);
});
