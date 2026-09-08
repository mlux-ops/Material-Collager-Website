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

function request(quality) {
  const form = new FormData();
  form.append("payload", JSON.stringify({
    prompt: "Generate a simple material board.",
    size: "1024x1024",
    quality,
    apiKey: "test-only",
  }));
  return new Request("http://localhost/api/workbench/edit", { method: "POST", body: form });
}

test("legacy Workbench falls back to medium for Sunburst-only xhigh and max tiers", async (t) => {
  const submitted = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    submitted.push(JSON.parse(init.body));
    return Response.json({ data: [{ b64_json: "AA==" }] });
  });

  for (const quality of ["xhigh", "max"]) {
    const response = await POST(request(quality));
    assert.equal(response.status, 200);
  }

  assert.deepEqual(submitted.map((body) => body.model), ["gpt-image-2", "gpt-image-2"]);
  assert.deepEqual(submitted.map((body) => body.quality), ["medium", "medium"]);
});
