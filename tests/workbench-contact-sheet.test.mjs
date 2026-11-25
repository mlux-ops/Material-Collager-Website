import assert from "node:assert/strict";
import test from "node:test";
import {
  columnsFor,
  previewSplit,
  stepIndex,
  stepLarge,
} from "../app/components/workbench/nodes/contact-sheet.ts";

test("columnsFor fits cells plus gaps and never returns less than one", () => {
  assert.equal(columnsFor(1000, 112), 8); // (1000+4)/(116) = 8.6
  assert.equal(columnsFor(100, 256), 1);
  assert.equal(columnsFor(0, 112), 1);
  assert.equal(columnsFor(Number.NaN, 112), 1);
});

test("stepIndex moves within the grid and clamps at the edges", () => {
  assert.equal(stepIndex(0, "ArrowLeft", 5, 12), 0);
  assert.equal(stepIndex(11, "ArrowRight", 5, 12), 11);
  assert.equal(stepIndex(7, "ArrowUp", 5, 12), 2);
  assert.equal(stepIndex(2, "ArrowUp", 5, 12), 2);
  assert.equal(stepIndex(2, "ArrowDown", 5, 12), 7);
  assert.equal(stepIndex(3, "Home", 5, 12), 0);
  assert.equal(stepIndex(3, "End", 5, 12), 11);
});

test("stepIndex Down from a full row into a short last row lands on the last cell", () => {
  // 12 items, 5 columns: rows 0-4, 5-9, 10-11. From 9 Down would be 14.
  assert.equal(stepIndex(9, "ArrowDown", 5, 12), 11);
  // Already on the last row: stays put.
  assert.equal(stepIndex(10, "ArrowDown", 5, 12), 10);
  assert.equal(stepIndex(11, "ArrowDown", 5, 12), 11);
});

test("stepIndex tolerates an empty list and a bad column count", () => {
  assert.equal(stepIndex(0, "ArrowRight", 5, 0), 0);
  assert.equal(stepIndex(3, "ArrowDown", 0, 10), 4);
});

test("stepLarge steps one image and does not wrap", () => {
  assert.equal(stepLarge(0, -1, 5), 0);
  assert.equal(stepLarge(4, 1, 5), 4);
  assert.equal(stepLarge(2, 1, 5), 3);
  assert.equal(stepLarge(0, 1, 0), 0);
});

test("previewSplit shows a fixed head and counts the rest", () => {
  const items = Array.from({ length: 60 }, (_, i) => i);
  const { shown, hidden } = previewSplit(items);
  assert.equal(shown.length, 12);
  assert.equal(hidden, 48);
  assert.deepEqual(previewSplit([1, 2, 3]), { shown: [1, 2, 3], hidden: 0 });
});
