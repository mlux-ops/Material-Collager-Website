import assert from "node:assert/strict";
import test from "node:test";

import {
  OUTPUT_FORMATS,
  buildGenerationPrompt,
  resolvedOutputFormat,
  validateCollageRequest,
} from "../app/lib/collage.ts";

// F12 (app side): draft/studio renders may ask OpenAI for jpeg or webp output
// instead of always png, to save transfer/storage size. A Final render must
// stay png regardless, since it is the archival, library-visible artifact.
function request(overrides = {}) {
  return {
    collageType: "bathroom_fixture_collage",
    orientation: "default",
    quality: "medium",
    items: [{ id: "faucet", role: "vanity faucet", imageKeys: ["a.png"] }],
    ...overrides,
  };
}

test("validateCollageRequest accepts every declared output format", () => {
  for (const outputFormat of OUTPUT_FORMATS) {
    assert.doesNotThrow(() => validateCollageRequest(request({ outputFormat })));
  }
});

test("validateCollageRequest rejects an unsupported output format", () => {
  assert.throws(() => validateCollageRequest(request({ outputFormat: "gif" })), /supported output format/);
});

test("validateCollageRequest accepts a valid output compression and rejects out-of-range or non-integer values", () => {
  assert.doesNotThrow(() => validateCollageRequest(request({ outputFormat: "jpeg", outputCompression: 0 })));
  assert.doesNotThrow(() => validateCollageRequest(request({ outputFormat: "jpeg", outputCompression: 100 })));
  assert.doesNotThrow(() => validateCollageRequest(request({ outputFormat: "webp", outputCompression: 72 })));

  assert.throws(() => validateCollageRequest(request({ outputCompression: -1 })), /whole number between 0 and 100/);
  assert.throws(() => validateCollageRequest(request({ outputCompression: 101 })), /whole number between 0 and 100/);
  assert.throws(() => validateCollageRequest(request({ outputCompression: 50.5 })), /whole number between 0 and 100/);
});

test("resolvedOutputFormat defaults to png and otherwise honors an explicit request", () => {
  assert.equal(resolvedOutputFormat(request()), "png");
  assert.equal(resolvedOutputFormat(request({ outputFormat: "webp" })), "webp");
  assert.equal(resolvedOutputFormat(request({ outputFormat: "jpeg" })), "jpeg");
});

test("resolvedOutputFormat forces png for a final render regardless of the requested format", () => {
  assert.equal(resolvedOutputFormat(request({ outputFormat: "webp", renderKind: "final" })), "png");
  assert.equal(resolvedOutputFormat(request({ outputFormat: "jpeg", outputResolution: "final" })), "png");
});

test("resolvedOutputFormat does not force png for a non-final render at any other output resolution or render kind", () => {
  assert.equal(resolvedOutputFormat(request({ outputFormat: "webp", outputResolution: "studio" })), "webp");
  assert.equal(resolvedOutputFormat(request({ outputFormat: "webp", renderKind: "draft" })), "webp");
});

test("the generation prompt is identical regardless of the requested output format", () => {
  const base = buildGenerationPrompt(request());
  for (const outputFormat of OUTPUT_FORMATS) {
    assert.equal(buildGenerationPrompt(request({ outputFormat, outputCompression: 80 })), base);
  }
});
