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
