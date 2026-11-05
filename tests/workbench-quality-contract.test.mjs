import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";

const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@/")) {
      return next(new URL(`../${specifier.slice(2)}.ts`, import.meta.url).href, context);
    }
    return next(specifier, context);
  },
});
const { POST } = await import("../app/api/workbench/edit/route.ts");
hooks.deregister();

const TEST_KEY = "test-only";

function request(payload) {
  const form = new FormData();
  form.append("payload", JSON.stringify({
    prompt: "Generate a simple material board.",
    size: "1024x1024",
    apiKey: TEST_KEY,
    ...payload,
  }));
  return new Request("http://localhost/api/workbench/edit", { method: "POST", body: form });
}

test("the Workbench runs Sunburst and keeps its xhigh and max tiers intact", async (t) => {
  const submitted = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    submitted.push(JSON.parse(init.body));
    return Response.json({ data: [{ b64_json: "AA==" }] });
  });

  for (const quality of ["low", "medium", "high", "xhigh", "max", "auto"]) {
    const response = await POST(request({ quality }));
    assert.equal(response.status, 200, `quality ${quality} should be accepted`);
  }

  // 2.6 Sunburst goes on the wire, and no tier is downgraded any more.
  assert.deepEqual(new Set(submitted.map((body) => body.model)), new Set(["gpt-image-2.6-sunburst"]));
  assert.deepEqual(submitted.map((body) => body.quality), ["low", "medium", "high", "xhigh", "max", "auto"]);
});

test("background and output format reach the upstream call and set the response MIME type", async (t) => {
  let submitted;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    submitted = JSON.parse(init.body);
    return Response.json({ data: [{ b64_json: "AA==" }] });
  });

  const response = await POST(request({ background: "transparent", outputFormat: "webp" }));
  assert.equal(response.status, 200);
  assert.equal(submitted.background, "transparent");
  assert.equal(submitted.output_format, "webp");
  // The bytes are webp, so the response must not keep claiming png — the blob
  // cache, thumbnails, library and export all key off this.
  assert.equal((await response.json()).mimeType, "image/webp");
});

test("an impossible transparent JPEG is rejected before anything is spent", async (t) => {
  let called = false;
  t.mock.method(globalThis, "fetch", async () => { called = true; return Response.json({}); });
  const response = await POST(request({ background: "transparent", outputFormat: "jpeg" }));
  assert.equal(response.status, 400);
  assert.equal(called, false);
});

test("a stale tab or saved workflow sending a 2.5 Sunburst id is rendered with 2.6 Sunburst", async (t) => {
  const submitted = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    submitted.push(JSON.parse(init.body));
    return Response.json({ data: [{ b64_json: "AA==" }] });
  });
  for (const model of ["gpt-image-2.5-sunburst", "gpt-image-2.5-sunburst-2026-01-01", "gpt-image-2.6-sunburst"]) {
    const response = await POST(request({ model }));
    assert.equal(response.status, 200, model);
  }
  assert.deepEqual(submitted.map((body) => body.model), Array(3).fill("gpt-image-2.6-sunburst"));
});

test("the Test node is registered on 2.5 and every other generation payload stays on 2.6", async () => {
  const { MANIFESTS } = await import("../app/components/workbench/nodes/manifests.ts");
  const { buildGenerationPayload } = await import("../app/components/workbench/nodes/generation.ts");
  const prompt = [{ kind: "text", text: "a test board" }];
  assert.equal(MANIFESTS.test.spec.title, "Test");
  assert.equal(MANIFESTS.test.paid, true);
  assert.equal(MANIFESTS.test.defaultParams.model, "gpt-image-2.5-sunburst-2026-09-08");
  // The model comes from the node kind, never from params: a param naming the
  // 2.5 snapshot on an ordinary node does not move it off 2.6.
  assert.equal(buildGenerationPayload({ model: "gpt-image-2.5-sunburst-2026-09-08" }, prompt).model, "gpt-image-2.6-sunburst");
  assert.equal(
    buildGenerationPayload(MANIFESTS.test.defaultParams, prompt, "gpt-image-2.5-sunburst-2026-09-08").model,
    "gpt-image-2.5-sunburst-2026-09-08",
  );
  for (const [kind, manifest] of Object.entries(MANIFESTS)) {
    if (kind === "test") continue;
    assert.notEqual(manifest.defaultParams.model, "gpt-image-2.5-sunburst-2026-09-08", kind);
  }
});

test("only the Test node's exact 2.5 snapshot is rendered on 2.5", async (t) => {
  const submitted = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    submitted.push(JSON.parse(init.body));
    return Response.json({ data: [{ b64_json: "AA==" }] });
  });
  const response = await POST(request({ model: "gpt-image-2.5-sunburst-2026-09-08" }));
  assert.equal(response.status, 200);
  assert.deepEqual(submitted.map((body) => body.model), ["gpt-image-2.5-sunburst-2026-09-08"]);
  assert.equal((await response.json()).diagnostics.wireModel, "gpt-image-2.5-sunburst-2026-09-08");
});

test("an unsupported quality or a non-Sunburst model is refused", async (t) => {
  let called = false;
  t.mock.method(globalThis, "fetch", async () => { called = true; return Response.json({}); });

  assert.equal((await POST(request({ quality: "ultra" }))).status, 400);
  const legacy = await POST(request({ model: "gpt-image-2" }));
  assert.equal(legacy.status, 400);
  assert.match((await legacy.json()).error, /no longer supported/i);
  // Flare is not a model this app renders with anywhere.
  assert.equal((await POST(request({ model: "gpt-image-2.6-flare" }))).status, 400);
  assert.equal(called, false);
});

// --- GPT Image 2.6 capabilities: complexity, markup, SVG and GIF output ----

const TEST_MODEL = "gpt-image-2.5-sunburst-2026-09-08";

function requestWithFiles(payload, files = {}) {
  const form = new FormData();
  form.append("payload", JSON.stringify({
    prompt: "Recolor the vase inside the red circle. Remove the red circle.",
    size: "1024x1024",
    apiKey: TEST_KEY,
    ...payload,
  }));
  for (const file of files.images ?? []) form.append("image[]", file, file.name);
  if (files.mask) form.append("mask", files.mask, "mask.png");
  if (files.markup) form.append("markup", files.markup, "markup.png");
  return new Request("http://localhost/api/workbench/edit", { method: "POST", body: form });
}

const png = (name) => new File(["png bytes"], name, { type: "image/png" });

function captureFetch(t) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url: String(url), body: init.body });
    return Response.json({ data: [{ b64_json: "AA==" }] });
  });
  return calls;
}

test("complexity reaches the wire only when set, on both generation and edits", async (t) => {
  const calls = captureFetch(t);
  assert.equal((await POST(request({}))).status, 200);
  assert.equal((await POST(request({ complexity: "low" }))).status, 200);
  assert.equal((await POST(requestWithFiles({}, { images: [png("room.png")] }))).status, 200);
  assert.equal((await POST(requestWithFiles({ complexity: "medium" }, { images: [png("room.png")] }))).status, 200);

  const [unsetGeneration, lowGeneration, unsetEdit, mediumEdit] = calls;
  assert.equal("complexity" in JSON.parse(unsetGeneration.body), false, "unset keeps the API default");
  assert.equal(JSON.parse(lowGeneration.body).complexity, "low");
  assert.equal(unsetEdit.body.has("complexity"), false);
  assert.equal(mediumEdit.body.get("complexity"), "medium");
});

test("complexity is recorded in the diagnostics only when it was sent", async (t) => {
  captureFetch(t);
  const sent = await (await POST(request({ complexity: "high" }))).json();
  assert.equal(sent.diagnostics.complexity, "high");
  const unset = await (await POST(request({}))).json();
  assert.equal("complexity" in unset.diagnostics, false);
});

test("an unsupported complexity is refused before anything is spent", async (t) => {
  const calls = captureFetch(t);
  const response = await POST(request({ complexity: "extreme" }));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /complexity/i);
  assert.equal(calls.length, 0);
});

test("complexity, SVG and GIF on the Test node's 2.5 snapshot are refused with no fetch", async (t) => {
  const calls = captureFetch(t);
  for (const payload of [
    { complexity: "low" },
    { outputFormat: "svg" },
    { outputFormat: "gif", size: "512x512" },
  ]) {
    const response = await POST(request({ model: TEST_MODEL, ...payload }));
    assert.equal(response.status, 400, JSON.stringify(payload));
    assert.match((await response.json()).error, /2\.6/);
  }
  const edit = await POST(requestWithFiles({ model: TEST_MODEL, complexity: "high" }, { images: [png("room.png")] }));
  assert.equal(edit.status, 400);
  assert.equal(calls.length, 0);
});

test("markup goes up as the edit's markup form file, alongside the input images", async (t) => {
  const calls = captureFetch(t);
  const response = await POST(requestWithFiles({}, { images: [png("room.png"), png("swatch.png")], markup: png("markup.png") }));
  assert.equal(response.status, 200);
  assert.equal(calls[0].url, "https://api.openai.com/v1/images/edits");
  const form = calls[0].body;
  assert.ok(form.get("markup") instanceof File);
  assert.equal(form.get("markup").name, "markup.png");
  assert.equal(form.get("markup").type, "image/png");
  assert.equal(form.getAll("image[]").length, 2);
  assert.equal(form.has("mask"), false);
  assert.equal((await response.json()).diagnostics.markup, true);
});

test("markup with a mask, markup without an input image, or a non-PNG markup is refused", async (t) => {
  const calls = captureFetch(t);
  const both = await POST(requestWithFiles({}, { images: [png("room.png")], mask: png("mask.png"), markup: png("markup.png") }));
  assert.equal(both.status, 400);
  assert.match((await both.json()).error, /markup and a mask/i);
  assert.equal((await POST(requestWithFiles({}, { markup: png("markup.png") }))).status, 400);
  const jpeg = new File(["jpeg"], "markup.jpg", { type: "image/jpeg" });
  assert.equal((await POST(requestWithFiles({}, { images: [png("room.png")], markup: jpeg }))).status, 400);
  assert.equal(calls.length, 0);
});

test("SVG output forces one image, sends no compression and answers image/svg+xml", async (t) => {
  const calls = captureFetch(t);
  const response = await POST(request({ outputFormat: "svg", n: 4, outputCompression: 80, background: "transparent" }));
  assert.equal(response.status, 200);
  assert.equal(calls[0].url, "https://api.openai.com/v1/images/generations");
  const body = JSON.parse(calls[0].body);
  assert.equal(body.output_format, "svg");
  assert.equal("n" in body, false, "n=1 is the API default and SVG allows nothing else");
  assert.equal("output_compression" in body, false);
  assert.equal(body.background, "transparent");
  assert.equal((await response.json()).mimeType, "image/svg+xml");
});

test("GIF output sends its frame params, allows a 512x512 size and answers image/gif", async (t) => {
  const calls = captureFetch(t);
  const response = await POST(request({ outputFormat: "gif", size: "512x512", frameCount: 12, frameDurationMs: 154, outputCompression: 50 }));
  assert.equal(response.status, 200);
  const body = JSON.parse(calls[0].body);
  assert.equal(body.output_format, "gif");
  assert.equal(body.size, "512x512");
  assert.equal(body.frame_count, 12);
  assert.equal(body.frame_duration_ms, 150, "rounded to 10 as OpenAI does");
  assert.equal("output_compression" in body, false);
  const json = await response.json();
  assert.equal(json.mimeType, "image/gif");
  assert.equal(json.diagnostics.frameCount, 12);
  assert.equal(json.diagnostics.frameDurationMs, 150);
});

test("out-of-range GIF frame params, or frame params on a still format, are refused", async (t) => {
  const calls = captureFetch(t);
  for (const payload of [
    { outputFormat: "gif", size: "512x512", frameCount: 1 },
    { outputFormat: "gif", size: "512x512", frameCount: 65 },
    { outputFormat: "gif", size: "512x512", frameCount: 9.5 },
    { outputFormat: "gif", size: "512x512", frameDurationMs: 10 },
    { outputFormat: "gif", size: "512x512", frameDurationMs: 2001 },
    { outputFormat: "png", frameCount: 9 },
  ]) {
    assert.equal((await POST(request(payload))).status, 400, JSON.stringify(payload));
  }
  assert.equal(calls.length, 0);
});

test("SVG or GIF output with input images (the edit path) is refused", async (t) => {
  const calls = captureFetch(t);
  for (const outputFormat of ["svg", "gif"]) {
    const response = await POST(requestWithFiles({ outputFormat, size: "1024x1024" }, { images: [png("room.png")] }));
    assert.equal(response.status, 400, outputFormat);
    assert.match((await response.json()).error, /text-to-image only/);
  }
  assert.equal(calls.length, 0);
});

test("an SVG or GIF sent as an input image is refused before upload", async (t) => {
  const calls = captureFetch(t);
  for (const file of [
    new File(["<svg/>"], "board.svg", { type: "image/svg+xml" }),
    new File(["GIF89a"], "board.gif", { type: "image/gif" }),
  ]) {
    const response = await POST(requestWithFiles({}, { images: [file] }));
    assert.equal(response.status, 400, file.type);
    assert.match((await response.json()).error, /PNG or WebP/);
  }
  assert.equal(calls.length, 0);
});

test("buildGenerationPayload carries complexity and the GIF params, and keeps SVG/GIF to Image Generation", async () => {
  const { buildGenerationPayload } = await import("../app/components/workbench/nodes/generation.ts");
  const prompt = [{ kind: "text", text: "a looping flame" }];
  assert.equal("complexity" in buildGenerationPayload({}, prompt), false);
  assert.equal(buildGenerationPayload({ complexity: "low" }, prompt).complexity, "low");
  // Never for the 2.5 snapshot, even if a param somehow carries one.
  assert.equal("complexity" in buildGenerationPayload({ complexity: "low" }, prompt, TEST_MODEL), false);

  const gif = buildGenerationPayload(
    { outputFormat: "gif", frameCount: 16, frameDurationMs: 95, candidates: 2 },
    prompt,
    undefined,
    { allowVectorAndAnimated: true },
  );
  assert.equal(gif.outputFormat, "gif");
  assert.equal(gif.frameCount, 16);
  assert.equal(gif.frameDurationMs, 100);
  assert.equal(gif.size, "512x512", "an unset GIF size starts at the guide's 512x512");
  assert.equal(gif.n, 2);
  const gifDefaults = buildGenerationPayload({ outputFormat: "gif" }, prompt, undefined, { allowVectorAndAnimated: true });
  assert.equal(gifDefaults.frameCount, 9);
  assert.equal(gifDefaults.frameDurationMs, 200);
  assert.throws(
    () => buildGenerationPayload({ outputFormat: "gif", frameCount: 99 }, prompt, undefined, { allowVectorAndAnimated: true }),
    /frame count/i,
  );

  const svg = buildGenerationPayload({ outputFormat: "svg", candidates: 4 }, prompt, undefined, { allowVectorAndAnimated: true });
  assert.equal(svg.outputFormat, "svg");
  assert.equal(svg.n, 1);
  assert.equal("frameCount" in svg, false);

  // Any other node, and the Test node, fall back to PNG.
  assert.equal(buildGenerationPayload({ outputFormat: "svg" }, prompt).outputFormat, "png");
  assert.equal(
    buildGenerationPayload({ outputFormat: "gif" }, prompt, TEST_MODEL, { allowVectorAndAnimated: true }).outputFormat,
    "png",
  );
});

test("import rules accept complexity on 2.6 nodes and SVG/GIF only on Image Generation; the Test node has neither", async () => {
  const { EXPORT_FORMAT, EXPORT_VERSION, validateImport } = await import("../app/components/workbench/export-import.ts");
  const { MANIFESTS } = await import("../app/components/workbench/nodes/manifests.ts");
  const imported = (kind, params) => validateImport({
    format: EXPORT_FORMAT, version: EXPORT_VERSION, exportedAt: 0, graphOnly: true, images: {}, edges: [],
    nodes: [{ id: "n1", kind, params, position: { x: 0, y: 0 } }],
  }).nodes[0].params;

  for (const kind of ["imageGenerate", "imageEdit", "relight", "variations", "maskedEdit", "upscaler", "collageBoard"]) {
    assert.ok(MANIFESTS[kind].importSchema.paramKeys.complexity, `${kind} declares complexity`);
    assert.equal(imported(kind, { complexity: "medium" }).complexity, "medium", kind);
    assert.equal(imported(kind, { complexity: "extreme" }).complexity, undefined, kind);
  }

  const generate = imported("imageGenerate", { outputFormat: "gif", frameCount: 24, frameDurationMs: 120 });
  assert.equal(generate.outputFormat, "gif");
  assert.equal(generate.frameCount, 24);
  assert.equal(generate.frameDurationMs, 120);
  assert.equal(imported("imageGenerate", { outputFormat: "svg" }).outputFormat, "svg");
  assert.equal(imported("imageGenerate", { frameCount: 65 }).frameCount, undefined);
  // A refused value falls back to the node default (png).
  assert.equal(imported("imageEdit", { outputFormat: "svg" }).outputFormat, "png", "edits never return SVG");
  assert.equal(imported("variations", { outputFormat: "gif" }).outputFormat, "png");

  assert.equal(MANIFESTS.test.importSchema.paramKeys.complexity, undefined);
  assert.equal(imported("test", { complexity: "low" }).complexity, undefined);
  assert.equal(imported("test", { outputFormat: "svg" }).outputFormat, "png");
});

test("the Test node's card hides Complexity; every other 2.6 render card shows it", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = (name) => readFile(new URL(`../app/components/workbench/nodes/${name}.tsx`, import.meta.url), "utf8");
  assert.match(await source("test"), /<GenerationSettings[^>]*showComplexity=\{false\}/);
  for (const name of ["imageGenerate", "imageEdit", "relight", "variations", "maskedEdit"]) {
    assert.doesNotMatch(await source(name), /showComplexity=\{false\}/, name);
  }
  for (const name of ["upscaler", "collageBoard"]) {
    assert.match(await source(name), /<ComplexityField /, name);
  }
});

test("SVG and GIF cached images are refused as model inputs, and the Markup rules hold", async () => {
  const { modelInputTypeError, markupLayerError } = await import("../app/components/workbench/nodes/generation.ts");
  assert.match(modelInputTypeError("image/svg+xml"), /SVG[\s\S]*PNG or WebP/);
  assert.match(modelInputTypeError("image/gif"), /GIF[\s\S]*PNG or WebP/);
  for (const type of ["image/png", "image/jpeg", "image/webp"]) assert.equal(modelInputTypeError(type), null);

  const ok = { type: "image/png", bytes: 1000, markupWidth: 1536, markupHeight: 1024, baseWidth: 1536, baseHeight: 1024, hasTransparency: true };
  assert.equal(markupLayerError(ok), null);
  assert.match(markupLayerError({ ...ok, type: "image/jpeg" }), /PNG/);
  assert.match(markupLayerError({ ...ok, markupWidth: 1024 }), /1024×1024, but the input image is 1536×1024/);
  assert.match(markupLayerError({ ...ok, hasTransparency: false }), /no transparent pixels/);
  assert.match(markupLayerError({ ...ok, bytes: 50 * 1024 * 1024 + 1 }), /50 MB/);
  assert.match(
    markupLayerError({ ...ok, markupWidth: 5000, markupHeight: 4000, baseWidth: 5000, baseHeight: 4000 }),
    /16,777,216/,
  );
});
