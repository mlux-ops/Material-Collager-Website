import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";

// Resolve the app's Next aliases for Node's native TypeScript test runner.
// Only storage is replaced: route parsing, prompt building and API calls run.
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@/app/lib/generation-jobs") {
      return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(`
        export const persistGenerationOutput = async (input) => {
          globalThis.savedRender = input;
          if (globalThis.failStorage) throw new Error('storage unavailable');
          return { id: 'saved' };
        };
      `) };
    }
    if (specifier.startsWith("@/")) return next(new URL(`../${specifier.slice(2)}.ts`, import.meta.url).href, context);
    return next(specifier, context);
  },
});
const { POST } = await import("../app/api/generate/route.ts");
hooks.deregister();

function request(overrides = {}, signal, url = "http://localhost/api/generate") {
  const form = new FormData();
  form.append("payload", JSON.stringify({
    collageType: "bathroom_fixture_collage", orientation: "landscape", quality: "low",
    outputResolution: "final", apiKey: "test-only",
    items: [{ id: "faucet", role: "faucet", imageNames: ["faucet.png"] }], ...overrides,
  }));
  form.append("image[]", new Blob(["original image"], { type: "image/png" }), "faucet.png");
  return new Request(url, { method: "POST", body: form, signal });
}

test("Final uses high quality, original pixels, requested dimensions and lossless PNG", async (t) => {
  let submitted;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    submitted = init.body;
    return Response.json({ data: [{ b64_json: "AA==" }], usage: { total_tokens: 123 } });
  });
  const response = await POST(request({ outputFormat: "jpeg", outputCompression: 50 }));
  assert.equal(response.status, 200);
  assert.equal(submitted.get("model"), "gpt-image-2.6-sunburst");
  assert.equal(submitted.get("quality"), "high");
  assert.equal(submitted.get("background"), "opaque");
  assert.equal(submitted.get("size"), "2560x1440");
  assert.equal(submitted.get("output_format"), "png");
  assert.equal(submitted.has("output_compression"), false);
  assert.equal(submitted.has("input_fidelity"), false);
  assert.equal(await submitted.get("image[]").text(), "original image");
  assert.equal(globalThis.savedRender.payload.quality, "high");
  assert.equal(globalThis.savedRender.model, "gpt-image-2.6-sunburst");
  assert.equal(globalThis.savedRender.background, "opaque");
  const json = await response.json();
  assert.equal(json.usage.total_tokens, 123);
  // The caller asked for "low"; the upgrade must be reported, not silent.
  assert.match(json.notice, /requested "low" quality was upgraded/);
});

test("immediate completion reports usage cost even when history storage fails", async (t) => {
  globalThis.failStorage = true;
  t.after(() => {
    delete globalThis.failStorage;
  });
  t.mock.method(globalThis, "fetch", async () => Response.json({
    data: [{ b64_json: "AA==" }],
    usage: {
      input_tokens: 3_000,
      input_tokens_details: { text_tokens: 1_000, image_tokens: 2_000 },
      output_tokens: 1_000,
    },
  }));
  const response = await POST(request({ outputFormat: "png" }));
  assert.equal(response.status, 200);
  const json = await response.json();
  assert.equal(json.costUsd, 0.051);
  assert.match(json.notice, /could not be added to the six-month history/);
});

test("Final preserves explicit xhigh and max quality tiers", async (t) => {
  const qualities = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    qualities.push(init.body.get("quality"));
    return Response.json({ data: [{ b64_json: "AA==" }] });
  });
  for (const quality of ["xhigh", "max"]) {
    const response = await POST(request({ quality }));
    assert.equal(response.status, 200);
  }
  assert.deepEqual(qualities, ["xhigh", "max"]);
});

test("transparent generation sends Sunburst background and preserves only the background prompt change", async (t) => {
  let submitted;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    submitted = init.body;
    return Response.json({ data: [{ b64_json: "AA==" }] });
  });
  const response = await POST(request({
    outputResolution: "studio",
    background: "transparent",
    outputFormat: "webp",
  }));
  assert.equal(response.status, 200);
  assert.equal(submitted.get("model"), "gpt-image-2.6-sunburst");
  assert.equal(submitted.get("quality"), "low");
  assert.equal(submitted.get("background"), "transparent");
  assert.equal(submitted.get("output_format"), "webp");
  assert.match(globalThis.savedRender.prompt, /Transparent background with preserved alpha and no white matte/);
  assert.match(globalThis.savedRender.prompt, /Preserve recognizable product identity, silhouette, component count, proportions, edge profile/);
});

test("diagnostic isolation sends Sunburst with the selected background and quality contract", async (t) => {
  let submitted;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    submitted = init.body;
    return Response.json({ data: [{ b64_json: "AA==" }] });
  });
  const response = await POST(request(
    { outputResolution: "studio", background: "transparent", quality: "max" },
    undefined,
    "http://localhost/api/generate?diagnostic=isolation&count=1",
  ));
  assert.equal(response.status, 200);
  assert.equal(submitted.get("model"), "gpt-image-2.6-sunburst");
  assert.equal(submitted.get("quality"), "low");
  assert.equal(submitted.get("background"), "transparent");
  assert.equal(submitted.get("output_format"), "png");
});

test("a Final that already requested high quality gets no upgrade notice", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: [{ b64_json: "AA==" }] }));
  const response = await POST(request({ quality: "high" }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).notice, undefined);
});

test("a rate limit forwards the provider's Retry-After to the client", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: { message: "Busy", type: "server_error" } }, { status: 429, headers: { "retry-after": "120" } }));
  const response = await POST(request());
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "120");
  const json = await response.json();
  assert.equal(json.retryAfterMs, 120_000);
  assert.equal(json.errorType, "server_error");
  const failed = json.diagnostics.attempts.find((attempt) => attempt.stage === "image_edit");
  assert.equal(failed.retryAfterMs, 120_000);
});

test("transient failures preserve the requested render and make one paid call", async (t) => {
  const sizes = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    sizes.push(init.body.get("size"));
    return Response.json({ error: { message: "Temporary failure" } }, { status: 503, headers: { "retry-after": "0" } });
  });
  const response = await POST(request());
  assert.equal(response.status, 503);
  assert.deepEqual(sizes, ["2560x1440"]);
});

test("collage cancellation reaches the paid upstream render", async (t) => {
  const controller = new AbortController();
  let reached;
  const started = new Promise((resolve) => { reached = resolve; });
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    reached();
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    });
  });
  const rendering = POST(request({}, controller.signal));
  await started;
  controller.abort();
  const result = await Promise.race([rendering, new Promise((resolve) => setTimeout(() => resolve(null), 100))]);
  assert.ok(result, "route should finish promptly when cancelled");
});

test("a Generator payload naming a retired model still renders with 2.6 Sunburst", async (t) => {
  // /api/generate never reads a model from the request; a stale tab or an old
  // saved draft that sends one must not change what goes on the wire.
  const submitted = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    submitted.push(init.body.get("model"));
    return Response.json({ data: [{ b64_json: "AA==" }] });
  });
  for (const model of ["gpt-image-2", "gpt-image-2.5-sunburst"]) {
    const response = await POST(request({ model }));
    assert.equal(response.status, 200, model);
    assert.equal(globalThis.savedRender.model, "gpt-image-2.6-sunburst");
  }
  assert.deepEqual(submitted, ["gpt-image-2.6-sunburst", "gpt-image-2.6-sunburst"]);
});
