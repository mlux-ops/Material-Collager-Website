import test from "node:test";
import assert from "node:assert/strict";

const { PRINT_LATER_CLASS, mergePrintLater, partitionPrintIn, printInClass } = await import("../app/lib/print-in.ts");

test("photos off screen at mount print later; on-screen ones dissolve on load", () => {
  const later = partitionPrintIn([
    { id: "a", isIntersecting: true },
    { id: "b", isIntersecting: false },
    { id: "c", isIntersecting: false },
    { id: "d", isIntersecting: true },
  ]);
  assert.deepEqual([...later].sort(), ["b", "c"]);
});

test("the first observation of a photo decides it; later entries never flip it", () => {
  // An IntersectionObserver batch can carry several entries for one target
  // (e.g. a scroll between delivery frames). Only the first one counts.
  const later = partitionPrintIn([
    { id: "a", isIntersecting: true },
    { id: "a", isIntersecting: false },
    { id: "b", isIntersecting: false },
    { id: "b", isIntersecting: true },
  ]);
  assert.deepEqual([...later], ["b"]);
});

test("entries without an id are ignored; an empty batch prints nothing later", () => {
  assert.equal(partitionPrintIn([]).size, 0);
  assert.equal(partitionPrintIn([{ id: "", isIntersecting: false }]).size, 0);
});

test("merging keeps the same set when nothing is new (no re-render)", () => {
  const prev = new Set(["a", "b"]);
  assert.equal(mergePrintLater(prev, new Set()), prev);
  assert.equal(mergePrintLater(prev, new Set(["a"])), prev);
  const next = mergePrintLater(prev, new Set(["b", "c"]));
  assert.notEqual(next, prev);
  assert.deepEqual([...next].sort(), ["a", "b", "c"]);
  // The previous set is never mutated.
  assert.deepEqual([...prev].sort(), ["a", "b"]);
});

test("class lookup", () => {
  const later = new Set(["b"]);
  assert.equal(printInClass(later, "b"), PRINT_LATER_CLASS);
  assert.equal(printInClass(later, "a"), "");
  assert.equal(PRINT_LATER_CLASS, "mc-print-later");
});
