import assert from "node:assert/strict";
import test from "node:test";

import {
  dropLabel,
  isDragOver,
  isFileDrag,
  nextDragDepth,
  slotNumber,
} from "../app/lib/slot-drop.ts";

// Replays a sequence of enter/leave/drop/reset events from depth 0 and
// returns the depth after each one.
function replay(events) {
  const depths = [];
  let depth = 0;
  for (const event of events) {
    depth = nextDragDepth(depth, event);
    depths.push(depth);
  }
  return depths;
}

test("isFileDrag is true when the drag carries Files", () => {
  assert.equal(isFileDrag(["Files"]), true);
});

test("isFileDrag is true when Files is mixed with text types", () => {
  assert.equal(isFileDrag(["text/plain", "Files"]), true);
  assert.equal(isFileDrag(["Files", "text/uri-list", "text/html"]), true);
});

test("isFileDrag is false when no Files type is present", () => {
  assert.equal(isFileDrag(["text/plain"]), false);
  assert.equal(isFileDrag(["text/uri-list", "text/html"]), false);
  // The match is exact: a lookalike type is not a file drag.
  assert.equal(isFileDrag(["files"]), false);
  assert.equal(isFileDrag(["application/x-moz-file"]), false);
});

test("isFileDrag is false for null, undefined and empty types", () => {
  assert.equal(isFileDrag(null), false);
  assert.equal(isFileDrag(undefined), false);
  assert.equal(isFileDrag([]), false);
});

test("dropLabel numbers the slot with two digits, 1-based", () => {
  assert.equal(dropLabel(1), "DROP TO SET 01");
  assert.equal(dropLabel(3), "DROP TO SET 03");
  assert.equal(dropLabel(9), "DROP TO SET 09");
  assert.equal(dropLabel(10), "DROP TO SET 10");
  assert.equal(dropLabel(16), "DROP TO SET 16");
});

test("dropLabel keeps every digit past 99, like the card's padStart badge", () => {
  assert.equal(dropLabel(100), "DROP TO SET 100");
});

test("dropLabel leaves the number off when the position is not a slot", () => {
  assert.equal(dropLabel(0), "DROP TO SET");
  assert.equal(dropLabel(-1), "DROP TO SET");
  assert.equal(dropLabel(Number.NaN), "DROP TO SET");
  assert.equal(dropLabel(Number.POSITIVE_INFINITY), "DROP TO SET");
});

test("slotNumber truncates fractions and matches String(n).padStart(2, '0')", () => {
  assert.equal(slotNumber(3.9), "03");
  for (const position of [1, 2, 9, 10, 15, 16, 99, 100]) {
    assert.equal(slotNumber(position), String(position).padStart(2, "0"));
  }
  assert.equal(slotNumber(0), "");
  assert.equal(slotNumber(0.5), "");
});

test("nested enter/leave on child elements never drops the depth to 0", () => {
  // Card -> child -> grandchild and back out. A child's dragenter arrives
  // before the parent's dragleave, so the depth dips to 1, never 0, until
  // the pointer leaves the card itself.
  const depths = replay([
    "enter", // card
    "enter", // child
    "leave", // card (the browser's leave for the parent)
    "enter", // grandchild
    "leave", // child
    "enter", // back onto child
    "leave", // grandchild
    "enter", // back onto card
    "leave", // child
    "leave", // card -> outside
  ]);
  assert.deepEqual(depths, [1, 2, 1, 2, 1, 2, 1, 2, 1, 0]);
  assert.equal(depths.slice(0, -1).every((depth) => isDragOver(depth)), true);
  assert.equal(isDragOver(depths.at(-1)), false);
});

test("unbalanced leaves are absorbed at 0 and the next enter starts over", () => {
  assert.deepEqual(replay(["leave", "leave", "enter", "leave"]), [0, 0, 1, 0]);
  assert.deepEqual(replay(["enter", "leave", "leave", "leave", "enter"]), [1, 0, 0, 0, 1]);
});

test("a drop resets the depth to 0 from any nesting level", () => {
  assert.deepEqual(replay(["enter", "enter", "enter", "drop"]), [1, 2, 3, 0]);
  assert.deepEqual(replay(["enter", "enter", "drop", "enter", "leave"]), [1, 2, 0, 1, 0]);
});

test("reset clears the depth like a drop", () => {
  assert.equal(nextDragDepth(5, "reset"), 0);
  assert.equal(nextDragDepth(0, "reset"), 0);
});

test("a non-finite or negative depth is read as 0", () => {
  assert.equal(nextDragDepth(Number.NaN, "enter"), 1);
  assert.equal(nextDragDepth(-3, "enter"), 1);
  assert.equal(nextDragDepth(-3, "leave"), 0);
  assert.equal(nextDragDepth(Number.POSITIVE_INFINITY, "leave"), 0);
});

test("isDragOver is true only for a positive finite depth", () => {
  assert.equal(isDragOver(1), true);
  assert.equal(isDragOver(4), true);
  assert.equal(isDragOver(0), false);
  assert.equal(isDragOver(-1), false);
  assert.equal(isDragOver(Number.NaN), false);
});
