import assert from "node:assert/strict";
import test from "node:test";

import { nextItemId, resolveItemId, withUniqueItemIds } from "../app/lib/item-ids.ts";

// The generator named a new row `item_${items.length + 1}`. Length is not a
// high-water mark, so deleting a row let the counter walk back onto a live name,
// and validateCollageRequest rejected the board with 'Item ID "item_8" is used
// more than once.' On an 8-row board holding two item_8s the clash was a fixed
// point: delete one, 7 rows remain, the next add recomputes item_8.
const board = (...ids) => ids.map((id) => ({ id, role: "wall tile" }));

test("a new ID skips every name already in use instead of counting the rows", () => {
  const sevenRowsWithItem8 = [...board("a", "b", "c", "d", "e", "f"), { id: "item_8", role: "wall tile" }];

  assert.equal(sevenRowsWithItem8.length, 7);
  assert.equal(nextItemId(sevenRowsWithItem8), "item_9");
});

test("remove-and-re-add escapes the fixed point that used to reproduce the same ID", () => {
  const broken = [...board("a", "b", "c", "d", "e", "f"), { id: "item_8", role: "wall tile" }, { id: "item_8", role: "wall tile" }];
  const afterDelete = broken.slice(0, -1);
  const readded = [...afterDelete, { id: nextItemId(afterDelete), role: "" }];
  const ids = readded.map(resolveItemId);

  assert.equal(new Set(ids).size, ids.length, ids.join(", "));
});

test("consecutive adds still read in sequence on an ordinary board", () => {
  let items = board("wall_tile", "floor_tile", "accent_tile", "vanity_wood", "countertop", "metal_finish");
  const assigned = [];
  for (let n = 0; n < 3; n += 1) {
    const id = nextItemId(items);
    assigned.push(id);
    items = [...items, { id, role: "" }];
  }

  assert.deepEqual(assigned, ["item_7", "item_8", "item_9"]);
});

test("a restored board with a duplicate ID heals, keeping the first claim", () => {
  const restored = withUniqueItemIds([
    { id: "wall_tile", role: "wall tile" },
    { id: "item_8", role: "shower valve" },
    { id: "item_8", role: "cabinet pull" },
  ]);

  assert.deepEqual(restored.map((item) => item.id), ["wall_tile", "item_8", "item_4"]);
  // The surviving item_8 keeps its role, so the renamed row is the later one.
  assert.equal(restored[1].role, "shower valve");
});

test("healing also resolves rows that carried no ID of their own", () => {
  // Legacy drafts stored rows without an explicit ID, which resolved to the role
  // slug -- so two rows with the same role collapsed onto one ID.
  const restored = withUniqueItemIds([
    { role: "wall tile" },
    { role: "wall tile" },
    { role: "" },
  ]);
  const ids = restored.map((item) => item.id);

  assert.equal(ids[0], "wall_tile");
  assert.equal(new Set(ids).size, 3, ids.join(", "));
  assert.ok(ids.every(Boolean), ids.join(", "));
});

test("an untouched board is returned with its rows unchanged", () => {
  const items = board("wall_tile", "floor_tile");
  const result = withUniqueItemIds(items);

  assert.deepEqual(result, items);
  assert.equal(result[0], items[0]);
});
