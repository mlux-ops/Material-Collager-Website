import assert from "node:assert/strict";
import test from "node:test";

import { clampToValidEditSize, validateEditSize } from "../app/lib/image-edit.ts";
import { resolveUpscaleSize, UPSCALE_LONG_RUN_THRESHOLD, UPSCALE_SIZES } from "../app/components/workbench/nodes/upscaler.manifest.ts";

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

// clampToValidEditSize is now a deterministic constraint solve (issue-2): it
// clamps the target aspect ratio into [1/3,3] and picks a target pixel count
// FIRST, then derives the size, rather than iteratively rescaling — so it
// always converges on a valid size even for the realistic range AND for
// arbitrarily extreme raw aspect ratios (e.g. a Crop node's user-drawn 1:50
// sliver), which the previous iterative rescale-based clamp could return
// invalid for (e.g. 20x1000 used to clamp to 464x1408, still failing the
// 1:3 aspect bound).
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

test("clampToValidEditSize converges on a valid size for extreme aspect ratios a Crop node can produce (issue-2: the previous iterative clamp returned an invalid size for these)", () => {
  const cases = [
    [20, 1000], // the exact regression case: used to clamp to 464x1408 (aspect 3.03, invalid)
    [1000, 20], // the mirrored 50:1 case
    [1, 50],
    [50, 1],
    [1, 1000],
    [1000, 1],
  ];
  for (const [w, h] of cases) {
    const { width, height } = clampToValidEditSize(w, h);
    assert.equal(validateEditSize(`${width}x${height}`), null, `clamp of ${w}x${h} -> ${width}x${height} must be valid`);
  }
});

test("clampToValidEditSize converges on a valid size for tiny and huge raw inputs", () => {
  const cases = [
    [1, 1],
    [2, 3],
    [5, 5],
    [100_000, 100_000],
    [100_000, 1],
    [1, 100_000],
    [500_000, 3_700],
    [3_700, 500_000],
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

// issue-7/AC10: the generic Inspector can write params.size to ANY string
// for an Upscaler node (bypassing the card's own <select>, which only ever
// offers UPSCALE_SIZES members) -- resolveUpscaleSize must snap anything
// else to a supported menu target instead of letting it reach the server
// unclamped.
test("resolveUpscaleSize passes an exact UPSCALE_SIZES member through unchanged", () => {
  for (const size of UPSCALE_SIZES) {
    assert.equal(resolveUpscaleSize(size), size);
  }
});

test("resolveUpscaleSize snaps a parseable-but-unlisted size to the nearest menu option by total pixel count", () => {
  // N-10: "1300x900" (1,170,000 px) is closest to 1536x1024 (1,572,864 px)
  // among the menu's pixel counts -- the smallest option, well below every
  // other one. (Not "1072x624": that value is now a RECOGNIZED Upscaler
  // draft-mode size -- see UPSCALE_DRAFT_SIZE_SET -- and must legitimately
  // pass through unchanged rather than snap to a full menu option; that
  // behavior has its own dedicated N-10 tests in workbench-cost.test.mjs and
  // workbench-draft-signature.test.mjs.)
  assert.equal(resolveUpscaleSize("1300x900"), "1536x1024");
  // A value very close to an existing large option should resolve to it.
  assert.equal(resolveUpscaleSize("3840x2100"), "3840x2160");
});

test("resolveUpscaleSize falls back to the node's own default for unparseable/garbage input", () => {
  assert.equal(resolveUpscaleSize(undefined), "2560x1440");
  assert.equal(resolveUpscaleSize(""), "2560x1440");
  assert.equal(resolveUpscaleSize("not-a-size"), "2560x1440");
});

test("resolveUpscaleSize always returns a value validateEditSize accepts, for any input", () => {
  for (const requested of [undefined, "", "0x0", "99999x1", "1x99999", "1072x624", "3840x2100", ...UPSCALE_SIZES]) {
    assert.equal(validateEditSize(resolveUpscaleSize(requested)), null, `resolveUpscaleSize(${requested}) must be valid`);
  }
});
