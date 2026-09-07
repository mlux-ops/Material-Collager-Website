import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";

// Resolve the app's Next aliases for Node's native TypeScript test runner.
// Only storage is replaced: route parsing, prompt building and API calls run.
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@/app/lib/generation-jobs") {
      return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(`
        export const persistGenerationOutput = async (input) => { globalThis.savedRender = input; return { id: 'saved' }; };
        export const cleanupExpiredJobs = async () => {};
        export const ensureJobStorage = async () => globalThis.testJobDb;
        export const publicJob = (row) => row;
        export const RETENTION_MS = 1000;
        export const runtimeStorage = () => ({});
      `) };
    }
    if (specifier.startsWith("@/")) return next(new URL(`../${specifier.slice(2)}.ts`, import.meta.url).href, context);
    return next(specifier, context);
  },
});
const { POST } = await import("../app/api/generate/route.ts");
const { GET: pollEconomy } = await import("../app/api/economy/route.ts");
hooks.deregister();

function request(overrides = {}, signal) {
  const form = new FormData();
  form.append("payload", JSON.stringify({
    collageType: "bathroom_fixture_collage", orientation: "landscape", quality: "low",
    outputResolution: "final", apiKey: "test-only",
    items: [{ id: "faucet", role: "faucet", imageNames: ["faucet.png"] }], ...overrides,
  }));
  form.append("image[]", new Blob(["original image"], { type: "image/png" }), "faucet.png");
  return new Request("http://localhost/api/generate", { method: "POST", body: form, signal });
}

test("Final uses high quality, original pixels, requested dimensions and lossless PNG", async (t) => {
  let submitted;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    submitted = init.body;
    return Response.json({ data: [{ b64_json: "AA==" }], usage: { total_tokens: 123 } });
  });
  const response = await POST(request({ outputFormat: "jpeg", outputCompression: 50 }));
  assert.equal(response.status, 200);
  assert.equal(submitted.get("quality"), "high");
  assert.equal(submitted.get("size"), "2560x1440");
  assert.equal(submitted.get("output_format"), "png");
  assert.equal(submitted.has("output_compression"), false);
  assert.equal(submitted.has("input_fidelity"), false);
  assert.equal(await submitted.get("image[]").text(), "original image");
  assert.equal(globalThis.savedRender.payload.quality, "high");
  assert.equal((await response.json()).usage.total_tokens, 123);
});

test("transient failures never trigger a smaller or different-aspect render", async (t) => {
  const sizes = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    sizes.push(init.body.get("size"));
    return Response.json({ error: { message: "Temporary failure" } }, { status: 503, headers: { "retry-after": "0" } });
  });
  const response = await POST(request());
  assert.equal(response.status, 503);
  assert.deepEqual(sizes, ["2560x1440", "2560x1440"]);
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
