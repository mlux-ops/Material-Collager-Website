import assert from "node:assert/strict";
import test from "node:test";

import {
  clampSplit,
  clipPathForSplit,
  cubicBezier,
  dividerLeft,
  easeWipe,
  HANDLE_GRAB_PX,
  handleLeft,
  parseDurationMs,
  SPLIT_REST,
  splitFromPointer,
  WIPE_DEFAULT_MS,
  wipeSplitAt,
} from "../app/lib/compare-split.ts";

// --- constants -------------------------------------------------------------------

test("rest is 100, the grab area is 38px and the wipe defaults to 700ms", () => {
  assert.equal(SPLIT_REST, 100);
  assert.equal(HANDLE_GRAB_PX, 38);
  assert.equal(WIPE_DEFAULT_MS, 700);
});

// --- clampSplit --------------------------------------------------------------------

test("clampSplit passes values inside 0..100 through unchanged", () => {
  assert.equal(clampSplit(0), 0);
  assert.equal(clampSplit(37.5), 37.5);
  assert.equal(clampSplit(50), 50);
  assert.equal(clampSplit(100), 100);
});

test("clampSplit clamps below 0 to 0 and above 100 to 100", () => {
  assert.equal(clampSplit(-0.01), 0);
  assert.equal(clampSplit(-250), 0);
  assert.equal(clampSplit(100.01), 100);
  assert.equal(clampSplit(1e9), 100);
});

test("clampSplit reads NaN as the rest position", () => {
  assert.equal(clampSplit(Number.NaN), 100);
});

test("clampSplit maps -Infinity to 0 and +Infinity to 100", () => {
  assert.equal(clampSplit(Number.NEGATIVE_INFINITY), 0);
  assert.equal(clampSplit(Number.POSITIVE_INFINITY), 100);
});

// --- splitFromPointer ----------------------------------------------------------------

test("splitFromPointer is 0 left of the box and 100 right of it", () => {
  assert.equal(splitFromPointer(10, 100, 400), 0);
  assert.equal(splitFromPointer(100, 100, 400), 0);
  assert.equal(splitFromPointer(500, 100, 400), 100);
  assert.equal(splitFromPointer(9000, 100, 400), 100);
});

test("splitFromPointer is proportional inside the box", () => {
  assert.equal(splitFromPointer(300, 100, 400), 50);
  assert.equal(splitFromPointer(200, 100, 400), 25);
  assert.equal(splitFromPointer(400, 100, 400), 75);
});

test("splitFromPointer reads a zero, negative or non-finite width as rest", () => {
  assert.equal(splitFromPointer(300, 100, 0), 100);
  assert.equal(splitFromPointer(300, 100, -20), 100);
  assert.equal(splitFromPointer(300, 100, Number.NaN), 100);
  assert.equal(splitFromPointer(300, 100, Number.POSITIVE_INFINITY), 100);
});

test("splitFromPointer reads a NaN pointer as rest", () => {
  assert.equal(splitFromPointer(Number.NaN, 100, 400), 100);
});

// --- clip-path -----------------------------------------------------------------------

test("clipPathForSplit shows the new image from the left edge to the split", () => {
  // 0 is mc-plotter-wipe's `from` frame: nothing of the new image shown.
  assert.equal(clipPathForSplit(0), "inset(0 100% 0 0)");
  assert.equal(clipPathForSplit(50), "inset(0 50% 0 0)");
  // 100 clips nothing.
  assert.equal(clipPathForSplit(100), "inset(0 0% 0 0)");
});

test("clipPathForSplit clamps its input", () => {
  assert.equal(clipPathForSplit(-10), "inset(0 100% 0 0)");
  assert.equal(clipPathForSplit(140), "inset(0 0% 0 0)");
  assert.equal(clipPathForSplit(Number.NaN), "inset(0 0% 0 0)");
});

// --- divider and grab area -----------------------------------------------------------

test("dividerLeft keeps the 1px line inside the frame at 0, 50 and 100", () => {
  assert.equal(dividerLeft(0), "calc(0% - 0px)");
  assert.equal(dividerLeft(50), "calc(50% - 0.5px)");
  assert.equal(dividerLeft(100), "calc(100% - 1px)");
});

test("dividerLeft clamps its input", () => {
  assert.equal(dividerLeft(-5), "calc(0% - 0px)");
  assert.equal(dividerLeft(Number.NaN), "calc(100% - 1px)");
});

test("handleLeft centres the 38px grab area on the split, clamped inside the frame", () => {
  assert.equal(handleLeft(0), "clamp(0px, calc(0% - 19px), calc(100% - 38px))");
  assert.equal(handleLeft(50), "clamp(0px, calc(50% - 19px), calc(100% - 38px))");
  assert.equal(handleLeft(100), "clamp(0px, calc(100% - 19px), calc(100% - 38px))");
});

test("handleLeft honours a custom grab width", () => {
  assert.equal(handleLeft(50, 20), "clamp(0px, calc(50% - 10px), calc(100% - 20px))");
});

// --- duration ------------------------------------------------------------------------

test("parseDurationMs reads ms and s values", () => {
  assert.equal(parseDurationMs("700ms"), 700);
  assert.equal(parseDurationMs(" 450ms "), 450);
  assert.equal(parseDurationMs("0.7s"), 700);
  assert.equal(parseDurationMs("1S"), 1000);
  assert.equal(parseDurationMs("0ms"), 0);
});

test("parseDurationMs falls back on blank, garbage or negative input", () => {
  assert.equal(parseDurationMs(""), 700);
  assert.equal(parseDurationMs("fast"), 700);
  assert.equal(parseDurationMs("700"), 700);
  assert.equal(parseDurationMs("-200ms"), 700);
  assert.equal(parseDurationMs(undefined), 700);
  assert.equal(parseDurationMs(null, 300), 300);
});

// --- easing --------------------------------------------------------------------------

test("easeWipe runs 0 -> 1 and clamps outside the unit interval", () => {
  assert.equal(easeWipe(0), 0);
  assert.equal(easeWipe(1), 1);
  assert.equal(easeWipe(-1), 0);
  assert.equal(easeWipe(2), 1);
  assert.equal(easeWipe(Number.NaN), 0);
});

test("easeWipe is monotone and front-loaded, like cubic-bezier(0.22, 1, 0.36, 1)", () => {
  let last = 0;
  for (let i = 1; i <= 100; i += 1) {
    const value = easeWipe(i / 100);
    assert.ok(value >= last - 1e-9, `not monotone at ${i / 100}: ${value} < ${last}`);
    assert.ok(value <= 1 + 1e-9, `overshoots at ${i / 100}: ${value}`);
    last = value;
  }
  // A strong ease-out: well past the halfway mark at half time.
  assert.ok(easeWipe(0.5) > 0.85, `easeWipe(0.5) = ${easeWipe(0.5)}`);
});

test("cubicBezier(0, 0, 1, 1) is linear", () => {
  const linear = cubicBezier(0, 0, 1, 1);
  for (const t of [0.1, 0.25, 0.5, 0.75, 0.9]) {
    assert.ok(Math.abs(linear(t) - t) < 1e-5, `linear(${t}) = ${linear(t)}`);
  }
});

test("cubicBezier matches CSS `ease` at its well-known midpoint", () => {
  // CSS `ease` is cubic-bezier(0.25, 0.1, 0.25, 1); at t = 0.5 it is ~0.8024.
  const ease = cubicBezier(0.25, 0.1, 0.25, 1);
  assert.ok(Math.abs(ease(0.5) - 0.8024) < 1e-3, `ease(0.5) = ${ease(0.5)}`);
});

// --- wipe progress -------------------------------------------------------------------

test("wipeSplitAt runs from 0 to 100 over the duration", () => {
  assert.equal(wipeSplitAt(0, 700), 0);
  assert.equal(wipeSplitAt(700, 700), 100);
  assert.equal(wipeSplitAt(5000, 700), 100);
  const mid = wipeSplitAt(350, 700);
  assert.ok(mid > 50 && mid < 100, `mid = ${mid}`);
});

test("wipeSplitAt treats a zero or invalid duration as finished", () => {
  assert.equal(wipeSplitAt(0, 0), 100);
  assert.equal(wipeSplitAt(100, -5), 100);
  assert.equal(wipeSplitAt(100, Number.NaN), 100);
});
