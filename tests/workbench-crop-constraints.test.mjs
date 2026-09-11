import assert from "node:assert/strict";
import test from "node:test";

import {
  constrainSize,
  constrainedDraw,
  constrainedResize,
  cropFitness,
  exactStepFor,
  formatAspect,
  parseAspect,
  serializeAspect,
} from "../app/components/workbench/nodes/crop-constraints.ts";

test("parseAspect reduces ratios and rejects junk; serializeAspect round-trips", () => {
  assert.deepEqual(parseAspect("32:18"), { w: 16, h: 9 });
  assert.deepEqual(parseAspect("4x3"), { w: 4, h: 3 });
  assert.equal(parseAspect(""), null);
  assert.equal(parseAspect("0:5"), null);
  assert.equal(parseAspect(7), null);
  assert.equal(serializeAspect(parseAspect("16:9")), "16:9");
  assert.equal(serializeAspect(null), "");
});

test("constrainSize honours a ratio lock and the 16px grid exactly when the ratio allows", () => {
  const sixteenNine = parseAspect("16:9");
  assert.deepEqual(exactStepFor(sixteenNine), { w: 256, h: 144 });
  const s = constrainSize(1000, 1000, { lock: sixteenNine, grid: true });
  assert.deepEqual(s, { width: 768, height: 432 }); // 3 steps of 256x144 fit in 1000x1000
  assert.equal(s.width / s.height, 16 / 9);
  assert.deepEqual(constrainSize(1113, 1062, { lock: null, grid: true }), { width: 1104, height: 1056 });
  assert.equal(exactStepFor(parseAspect("1113:1062")), null); // too coarse -> independent snap
  // Ratio without grid: exact ratio, no rounding.
  const r = constrainSize(1000, 400, { lock: parseAspect("1:1"), grid: false });
  assert.deepEqual(r, { width: 400, height: 400 });
});

test("constrainedDraw grows from the anchor toward the pointer and stays inside the image", () => {
  const r = constrainedDraw({ x: 100, y: 100 }, { x: 40, y: 900 }, 1600, 1200, { lock: parseAspect("1:1"), grid: true });
  assert.deepEqual(r, { x: 52, y: 100, width: 48, height: 48 }); // 60px dragged left -> 48 on the 16 grid, square
  const big = constrainedDraw({ x: 0, y: 0 }, { x: 5000, y: 5000 }, 1600, 1200, { lock: parseAspect("3:2"), grid: true });
  assert.deepEqual(big, { x: 0, y: 0, width: 1584, height: 1056 });
});

test("constrainedResize keeps the opposite corner fixed and edge handles derive the other dimension", () => {
  const rect = { x: 200, y: 200, width: 400, height: 400 };
  const se = constrainedResize(rect, "se", { x: 900, y: 700 }, 1600, 1200, { lock: parseAspect("1:1"), grid: true });
  assert.equal(se.x, 200);
  assert.equal(se.y, 200);
  assert.equal(se.width, se.height);
  assert.equal(se.width % 16, 0);
  const e = constrainedResize(rect, "e", { x: 1000, y: 0 }, 1600, 1200, { lock: parseAspect("2:1"), grid: true });
  assert.equal(e.x, 200);
  assert.equal(e.width, 800);
  assert.equal(e.height, 400);
  assert.equal(e.y, 200); // centred on the original centre line (400 tall either way)
  const free = constrainedResize(rect, "e", { x: 1000, y: 0 }, 1600, 1200, { lock: null, grid: false });
  assert.deepEqual(free, { x: 200, y: 200, width: 800, height: 400 });
});

test("cropFitness flags aspect, grid and pixel-floor problems and reports exactness", () => {
  assert.equal(cropFitness(960, 688).exact, true);
  assert.equal(cropFitness(4000, 1000).aspectOk, false);
  assert.equal(cropFitness(700, 505).onGrid, false);
  assert.equal(cropFitness(320, 320).pixelsOk, false);
  assert.equal(cropFitness(1584, 1056).exact, true);
  assert.equal(formatAspect(1600, 900), "16:9");
  assert.equal(formatAspect(1113, 1062), "1.05:1");
});
