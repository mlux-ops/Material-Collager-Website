import assert from "node:assert/strict";
import test from "node:test";
import { fanOpening, fanPull, isFanFlick } from "../app/components/scene-wheel-v2/swatch-fan-gesture.ts";

test("swatches open left or upward and stay inside the physical stop at each end", () => {
  assert.equal(fanOpening(0, fanPull(-50, 0), 100), 0.5);
  assert.equal(fanOpening(0, fanPull(0, -100), 100), 0.45);
  assert.equal(fanOpening(0.5, -10, 100), 0.4);
  assert.equal(fanOpening(0, -10, 100), 0);
  assert.equal(fanOpening(0.5, 150, 100), 1);
});

test("only a fast outward stroke extends the fan on release", () => {
  assert.equal(isFanFlick(12, 10), true);
  assert.equal(isFanFlick(12, 100), false);
  assert.equal(isFanFlick(-12, 10), false);
  assert.equal(isFanFlick(2, 1), false);
  assert.equal(isFanFlick(20, 0), false);
});
