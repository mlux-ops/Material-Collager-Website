import assert from "node:assert/strict";
import test from "node:test";

import { clampToValidEditSize, validateEditSize } from "../app/lib/image-edit.ts";
import { UPSCALE_LONG_RUN_THRESHOLD, UPSCALE_SIZES } from "../app/components/workbench/nodes/upscaler.manifest.ts";

test("validateEditSize accepts a well-formed gpt-image-2 size and rejects a malformed string", () => {
  assert.equal(validateEditSize("1536x1024"), null);
  assert.equal(validateEditSize("not-a-size"), "Size must look like 1536x1024.");
});

test("validateEditSize enforces divisible-by-16 dimensions", () => {
  assert.ok(validateEditSize("1000x1000"));
  assert.equal(validateEditSize("1024x1024"), null);
});

test("validateEditSize enforces the 1:3-3:1 aspect ratio bound", () => {
  assert.ok(validateEditSize("4096x256")); // way past 3:1
  assert.equal(validateEditSize("1536x1536"), null); // 1:1 is fine
});

test("validateEditSize enforces the 3840 longest-edge ceiling", () => {
  assert.equal(validateEditSize("3840x2160"), null); // exactly the ceiling
  assert.ok(validateEditSize("3856x2160")); // over it
});

test("validateEditSize enforces the 655,360-8,294,400 total-pixel bounds", () => {
  assert.ok(validateEditSize("128x128")); // 16,384 px — far under the floor
  assert.equal(validateEditSize("1024x640"), null); // 655,360 exactly — the floor
  assert.ok(validateEditSize("4096x4096")); // way over the ceiling (also fails aspect/edge first)
});

// NOTE: clampToValidEditSize's own comment documents "a few passes converge
// aspect/longest-edge/pixel-count clamps back onto a multiple of 16" — it is
// not guaranteed to converge for arbitrarily extreme raw aspect ratios (e.g.
// a 40:1 source), a pre-existing limitation out of scope for this test
// scaffolding pass. These cases stay within the realistic range Resize/Crop/
// Upscaler actually feed it (photos, renders, crops of same).
test("clampToValidEditSize always converges on a size validateEditSize accepts, for realistic image dimensions", () => {
  const cases = [
    [10, 10],
    [16, 16],
    [4000, 4000],
    [8000, 3000],
    [3000, 8000],
    [3840, 2160],
    [1536, 1024],
    [1600, 900],
    [900, 1600],
  ];
  for (const [w, h] of cases) {
    const { width, height } = clampToValidEditSize(w, h);
    assert.equal(validateEditSize(`${width}x${height}`), null, `clamp of ${w}x${h} -> ${width}x${height} must be valid`);
  }
});

test("clampToValidEditSize keeps dimensions divisible by 16", () => {
  const { width, height } = clampToValidEditSize(1000, 700);
  assert.equal(width % 16, 0);
  assert.equal(height % 16, 0);
});

test("clampToValidEditSize preserves aspect ratio direction for a moderately wide (non-extreme) source", () => {
  const { width, height } = clampToValidEditSize(1600, 900); // 16:9-ish, well within 1:3-3:1
  assert.ok(width > height);
});

test("Upscaler's size menu is entirely valid per validateEditSize and clamped to a 3840x2160 ceiling", () => {
  for (const size of UPSCALE_SIZES) {
    assert.equal(validateEditSize(size), null, size);
    const [, height] = size.split("x").map(Number);
    const width = Number(size.split("x")[0]);
    assert.ok(Math.max(width, height) <= 3840, `${size} must not exceed the 3840x2160 ceiling`);
  }
  assert.equal(UPSCALE_SIZES.at(-1), "3840x2160");
});

test("the long-run warning threshold (2048px) is at or below the largest offered upscale size's longest edge", () => {
  const longestEdges = UPSCALE_SIZES.map((size) => Math.max(...size.split("x").map(Number)));
  assert.ok(Math.max(...longestEdges) >= UPSCALE_LONG_RUN_THRESHOLD);
});
