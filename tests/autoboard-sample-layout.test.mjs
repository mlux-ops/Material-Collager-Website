import assert from "node:assert/strict";
import { test } from "node:test";
import { samplePose, sampleSpread } from "../app/components/review-boards/sample-layout.ts";

test("the selected slot stays in its spread and a short final spread uses only real slots", () => {
  const slots = ["stone", "oak", "brass", "linen", "tile"];
  assert.deepEqual(sampleSpread(slots, 3), slots.slice(0, 4));
  assert.deepEqual(sampleSpread(slots, 4), ["tile"]);
  assert.deepEqual(slots, ["stone", "oak", "brass", "linen", "tile"]);
});

test("a partially unpacked spread interpolates between distinct parallel planes", () => {
  const stack = Array.from({ length: 4 }, (_, i) => samplePose(i, 4, 1));
  assert.ok(stack.every((pose) => pose.tilt === stack[0].tilt && pose.turn === stack[0].turn));
  assert.ok(stack.every((pose, i) => i === 0 || pose.y < stack[i - 1].y));
  const flat = samplePose(2, 4, 0);
  assert.equal(flat.tilt, 0);
  assert.equal(samplePose(2, 4, 0.5).y, (flat.y + stack[2].y) / 2);
  assert.equal(samplePose(2, 3, 0).x, 0);
  assert.deepEqual(samplePose(2, 4, 8), stack[2]);
});
