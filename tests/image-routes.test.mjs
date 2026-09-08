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
        export const cleanupExpiredJobs = async () => {};
        export const ensureJobStorage = async () => globalThis.testJobDb;
        export const publicJob = (row) => row;
        export const RETENTION_MS = 1000;
        export const runtimeStorage = () => globalThis.testRuntimeStorage || {};
      `) };
    }
    if (specifier.startsWith("@/")) return next(new URL(`../${specifier.slice(2)}.ts`, import.meta.url).href, context);
    return next(specifier, context);
  },
});
const { POST } = await import("../app/api/generate/route.ts");
const { POST: postEconomy, GET: pollEconomy } = await import("../app/api/economy/route.ts");
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
  assert.equal(submitted.get("model"), "gpt-image-2.5-sunburst-2026-09-08");
  assert.equal(submitted.get("quality"), "high");
  assert.equal(submitted.get("background"), "opaque");
  assert.equal(submitted.get("size"), "2560x1440");
  assert.equal(submitted.get("output_format"), "png");
  assert.equal(submitted.has("output_compression"), false);
  assert.equal(submitted.has("input_fidelity"), false);
  assert.equal(await submitted.get("image[]").text(), "original image");
  assert.equal(globalThis.savedRender.payload.quality, "high");
  assert.equal(globalThis.savedRender.model, "gpt-image-2.5-sunburst");
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
  assert.equal(submitted.get("model"), "gpt-image-2.5-sunburst-2026-09-08");
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
  assert.equal(submitted.get("model"), "gpt-image-2.5-sunburst-2026-09-08");
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

test("a failed Economy job is recorded without purchasing a lower-resolution retry", async (t) => {
  const row = { id: "job", openai_batch_id: "batch_test", format: "2560x1440", payload_json: "{}", reference_ids_json: "[]" };
  const updates = [];
  globalThis.testJobDb = { prepare(sql) {
    return {
      all: async () => ({ results: sql.includes("mode = 'economy'") ? [row] : [] }),
      bind(...args) { updates.push({ sql, args }); return this; },
      run: async () => ({ meta: { changes: 1 } }),
    };
  } };
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-only";
  t.after(() => {
    delete globalThis.testJobDb;
    delete globalThis.savedRender;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  });
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url, method: init.method || "GET" });
    return Response.json({ status: "failed", errors: { data: [{ message: "Invalid request" }] } });
  });
  assert.equal((await pollEconomy()).status, 200);
  assert.equal(calls.length, 1);
  assert.deepEqual(updates[0].args.slice(0, 2), ["failed", "Invalid request"]);
});

test("Economy submission sends Sunburst with selected quality/background and stores cost as unavailable", async (t) => {
  const inserts = [];
  globalThis.testJobDb = {
    prepare(sql) {
      return {
        bind(...args) {
          inserts.push({ sql, args });
          return this;
        },
        run: async () => ({ meta: { changes: 1 } }),
      };
    },
  };
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-only";
  let requestLine;
  t.after(() => {
    delete globalThis.testJobDb;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  });
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (url.endsWith("/files")) {
      requestLine = JSON.parse((await init.body.get("file").text()).trim());
      return Response.json({ id: "file_input" });
    }
    JSON.parse(init.body);
    return Response.json({ id: "batch_test", status: "validating" });
  });
  const response = await postEconomy(new Request("http://localhost/api/economy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ payload: {
      collageType: "bathroom_fixture_collage",
      orientation: "landscape",
      quality: "max",
      background: "transparent",
      outputResolution: "final",
      layoutReference: true,
      layoutReferenceFileId: "file-layout",
      items: [{ id: "faucet", role: "faucet", imageFileIds: ["file-product"] }],
    } }),
  }));
  assert.equal(response.status, 200);
  assert.equal(requestLine.body.model, "gpt-image-2.5-sunburst-2026-09-08");
  assert.equal(requestLine.body.quality, "max");
  assert.equal(requestLine.body.background, "transparent");
  assert.equal(requestLine.body.output_format, "png");
  const insert = inserts.find((entry) => entry.sql.includes("INSERT INTO generation_jobs"));
  assert.ok(insert);
  assert.equal(insert.args.includes("gpt-image-2.5-sunburst"), true);
  assert.equal(insert.args.includes("max"), true);
  assert.equal(insert.args.includes("transparent"), true);
  assert.equal((await response.json()).estimatedUsd, null);
});

test("completed Economy usage is stored at the documented Batch half-price", async (t) => {
  const updates = [];
  const row = {
    id: "job_batch_cost",
    mode: "economy",
    status: "validating",
    openai_batch_id: "batch_cost",
    output_key: null,
    finalize_attempts: 0,
  };
  globalThis.testJobDb = {
    prepare(sql) {
      return {
        all: async () => ({ results: [row] }),
        bind(...args) {
          updates.push({ sql, args });
          return this;
        },
        run: async () => ({ meta: { changes: 1 } }),
      };
    },
  };
  globalThis.testRuntimeStorage = { OUTPUTS: { put: async () => {} } };
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-only";
  t.after(() => {
    delete globalThis.testJobDb;
    delete globalThis.testRuntimeStorage;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  });
  t.mock.method(globalThis, "fetch", async (url) => {
    if (url.endsWith("/batches/batch_cost")) {
      return Response.json({ status: "completed", output_file_id: "file_output" });
    }
    return new Response(`${JSON.stringify({
      response: {
        body: {
          data: [{ b64_json: "AA==" }],
          usage: {
            input_tokens: 3_000,
            input_tokens_details: { text_tokens: 1_000, image_tokens: 2_000 },
            output_tokens: 1_000,
          },
        },
      },
    })}\n`, { status: 200 });
  });
  const response = await pollEconomy();
  assert.equal(response.status, 200);
  const costUpdate = updates.find((entry) => entry.sql.includes("cost_usd"));
  assert.ok(costUpdate);
  assert.equal(costUpdate.args[2], 0.0255);
});
