import assert from "node:assert/strict";
import test from "node:test";

import { customSizeError, GENERATION_PARAM_RULES, parseSize, sizeForInput } from "../app/components/workbench/nodes/generation.ts";

test("parseSize accepts WxH and rejects anything else", () => {
  assert.deepEqual(parseSize("1536x1024"), { width: 1536, height: 1024 });
  assert.deepEqual(parseSize(" 960x688 "), { width: 960, height: 688 });
  assert.equal(parseSize("1536×1024"), null);
  assert.equal(parseSize("auto"), null);
  assert.equal(parseSize(1536), null);
});

test("sizeForInput keeps an already-valid crop size exactly and snaps an invalid one", () => {
  assert.equal(sizeForInput(960, 688), "960x688"); // a rect-crop output: already valid
  assert.equal(sizeForInput(1113, 1062), "1120x1056"); // raw polygon bounds -> 16-grid
  const tiny = sizeForInput(300, 200);
  const [w, h] = tiny.split("x").map(Number);
  assert.ok(w * h >= 655_360, "snapped up to the pixel floor");
  assert.equal(w % 16, 0);
  assert.equal(h % 16, 0);
});

test("customSizeError explains malformed and out-of-limit sizes and passes valid ones", () => {
  assert.equal(customSizeError("1536x1024"), null);
  assert.equal(customSizeError("960x688"), null);
  assert.ok(customSizeError("1000x1000"));
  assert.ok(customSizeError("4096x256"));
  assert.ok(customSizeError("nope"));
});

test("import rules accept any short size string plus a sizeMode enum", () => {
  assert.equal(GENERATION_PARAM_RULES.size.type, "string");
  assert.deepEqual(GENERATION_PARAM_RULES.sizeMode.values, ["preset", "input", "custom"]);
});

test("Image Generation exposes an optional Image input ahead of the required prompt", async () => {
  const { imageGenerateManifest } = await import("../app/components/workbench/nodes/imageGenerate.manifest.ts");
  assert.deepEqual(
    imageGenerateManifest.spec.inputs.map((port) => [port.id, port.kind, port.required ?? false]),
    [["image", "image", false], ["prompt", "text", true], ["references", "image", false]],
  );
});
