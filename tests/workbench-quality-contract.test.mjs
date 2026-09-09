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

  // The pinned snapshot goes on the wire, and no tier is downgraded any more.
  assert.deepEqual(new Set(submitted.map((body) => body.model)), new Set(["gpt-image-2.5-sunburst-2026-09-08"]));
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

test("an unsupported quality or a non-Sunburst model is refused", async (t) => {
  let called = false;
  t.mock.method(globalThis, "fetch", async () => { called = true; return Response.json({}); });

  assert.equal((await POST(request({ quality: "ultra" }))).status, 400);
  const legacy = await POST(request({ model: "gpt-image-2" }));
  assert.equal(legacy.status, 400);
  assert.match((await legacy.json()).error, /no longer supported/i);
  assert.equal(called, false);
});
