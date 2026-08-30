import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applySelection,
  buildRoomIndex,
  libraryOptionsForSlot,
  resetSelection,
  roomKeyFor,
  slotKind,
} from "../scripts/autoboard/lib/review-core.mjs";

function row(overrides) {
  return {
    rowId: overrides.rowId,
    unitType: "Penthouse",
    roomLabel: "Bath 2",
    itemName: "Item",
    sku: "SKU-1",
    qty: 1,
    costCode: "11 45 Plumbing Fixtures M",
    ...overrides,
  };
}

function board(items) {
  return { id: "penthouse-bath-2-fixture", unitType: "Penthouse", roomLabel: "Bath 2", collageType: "bathroom_fixture_collage", items };
}

test("roomKeyFor / buildRoomIndex group rows case-insensitively", () => {
  const rows = [row({ rowId: "1" }), row({ rowId: "2", roomLabel: "Bath 3" }), row({ rowId: "3", unitType: "Triplex" })];
  const index = buildRoomIndex(rows);
  assert.equal(roomKeyFor("Penthouse", "Bath 2"), "penthouse::bath 2");
  assert.deepEqual(index.get("penthouse::bath 2").map((r) => r.rowId), ["1"]);
  assert.deepEqual(index.get("penthouse::bath 3").map((r) => r.rowId), ["2"]);
  assert.deepEqual(index.get("triplex::bath 2").map((r) => r.rowId), ["3"]);
});

test("slotKind identifies tile slots vs regular slots", () => {
  assert.equal(slotKind("main_tile"), "tile");
  assert.equal(slotKind("accent_tile"), "tile");
  assert.equal(slotKind("vanity_faucet"), "row");
});

test("libraryOptionsForSlot lists every tile code for a tile slot", () => {
  const tileIndex = new Map([
    ["WT1", { code: "WT1", materialName: "Cortar Bone", filePath: "/fake/WT1.jpg" }],
    ["AT1", { code: "AT1", materialName: "Clara Caviar", filePath: "/fake/AT1.jpg" }],
  ]);
  const options = libraryOptionsForSlot({
    board: board([]), slotId: "main_tile", roomIndex: new Map(), tileIndex, resolveImages: () => [],
  });
  assert.equal(options.length, 2);
  assert.ok(options.every((option) => option.kind === "tile"));
  assert.deepEqual(options.map((option) => option.code).sort(), ["AT1", "WT1"]);
});

test("libraryOptionsForSlot lists every room row for a regular slot, including ones with no photo yet", () => {
  const roomIndex = buildRoomIndex([
    row({ rowId: "1", itemName: "Brizo Faucet" }),
    row({ rowId: "2", itemName: "No Photo Item" }),
  ]);
  const options = libraryOptionsForSlot({
    board: board([]), slotId: "vanity_faucet", roomIndex, tileIndex: new Map(),
    resolveImages: (rowId) => (rowId === "1" ? ["/fake/1.png"] : []),
  });
  assert.equal(options.length, 2);
  assert.equal(options.find((o) => o.rowId === "1").imagePath, "/fake/1.png");
  assert.equal(options.find((o) => o.rowId === "2").imagePath, null);
});

test("applySelection swaps in a different room row, snapshotting the auto-pick once", () => {
  const roomIndex = buildRoomIndex([
    row({ rowId: "1", itemName: "Brizo Odin Faucet" }),
    row({ rowId: "2", itemName: "GROHE Atrio Faucet, Qty 3", qty: 3 }),
  ]);
  const b = board([{ slotId: "vanity_faucet", role: "vanity faucet", required: true, rowId: "1", sku: "SKU-1", brand: "Brizo", name: "Brizo Odin Faucet", notes: "", images: ["/fake/1.png"] }]);
  const item = applySelection({
    board: b, slotId: "vanity_faucet", choice: { kind: "row", rowId: "2" },
    roomIndex, tileIndex: new Map(), resolveImages: (rowId) => [`/fake/${rowId}.png`],
  });
  assert.equal(item.rowId, "2");
  assert.equal(item.brand, "GROHE");
  assert.equal(item.notes, "quantity 3");
  assert.deepEqual(item.images, ["/fake/2.png"]);
  assert.ok(item.overriddenAt);
  assert.deepEqual(item._auto, { rowId: "1", sku: "SKU-1", brand: "Brizo", name: "Brizo Odin Faucet", notes: "", images: ["/fake/1.png"] });

  // A second override does NOT overwrite the original auto-pick snapshot.
  applySelection({
    board: b, slotId: "vanity_faucet", choice: { kind: "row", rowId: "1" },
    roomIndex, tileIndex: new Map(), resolveImages: (rowId) => [`/fake/${rowId}.png`],
  });
  assert.equal(item._auto.rowId, "1");
});

test("applySelection sets Elm Surfaces provenance for a tile choice", () => {
  const tileIndex = new Map([["WT9", { code: "WT9", materialName: "Cortar Bone Ribbed", filePath: "/fake/WT9.jpg" }]]);
  const b = board([{ slotId: "main_tile", role: "main bathroom tile", required: true, rowId: null, sku: "WT2", brand: "Elm Surfaces", name: "Cortar Bone Reed", notes: "", images: ["/fake/WT2.jpg"] }]);
  const item = applySelection({
    board: b, slotId: "main_tile", choice: { kind: "tile", code: "WT9" },
    roomIndex: new Map(), tileIndex, resolveImages: () => [],
  });
  assert.equal(item.sku, "WT9");
  assert.equal(item.brand, "Elm Surfaces");
  assert.equal(item.name, "Cortar Bone Ribbed");
  assert.match(item.notes, /overrides the v4 Elm Surfaces schedule/);
});

test("applySelection throws with an actionable status for bad input", () => {
  const b = board([{ slotId: "vanity_faucet", role: "vanity faucet", required: true, rowId: "1", images: ["/fake/1.png"] }]);
  assert.throws(() => applySelection({ board: b, slotId: "no-such-slot", choice: { kind: "row", rowId: "1" }, roomIndex: new Map(), tileIndex: new Map(), resolveImages: () => [] }), (error) => error.status === 404);
  assert.throws(() => applySelection({ board: b, slotId: "vanity_faucet", choice: { kind: "row", rowId: "missing" }, roomIndex: buildRoomIndex([row({ rowId: "1" })]), tileIndex: new Map(), resolveImages: () => ["/fake/1.png"] }), (error) => error.status === 400);
  assert.throws(() => applySelection({ board: b, slotId: "vanity_faucet", choice: { kind: "row", rowId: "1" }, roomIndex: buildRoomIndex([row({ rowId: "1" })]), tileIndex: new Map(), resolveImages: () => [] }), (error) => error.status === 400 && /no photo/i.test(error.message));
});

test("resetSelection restores the snapshot and is a no-op if never overridden", () => {
  const roomIndex = buildRoomIndex([row({ rowId: "1" }), row({ rowId: "2" })]);
  const b = board([{ slotId: "vanity_faucet", role: "vanity faucet", required: true, rowId: "1", sku: "SKU-1", brand: "Brizo", name: "Original", notes: "", images: ["/fake/1.png"] }]);
  const untouched = resetSelection({ board: b, slotId: "vanity_faucet" });
  assert.equal(untouched.name, "Original");
  assert.ok(!untouched.overriddenAt);

  applySelection({ board: b, slotId: "vanity_faucet", choice: { kind: "row", rowId: "2" }, roomIndex, tileIndex: new Map(), resolveImages: (rowId) => [`/fake/${rowId}.png`] });
  assert.notEqual(b.items[0].name, "Original");

  const restored = resetSelection({ board: b, slotId: "vanity_faucet" });
  assert.equal(restored.name, "Original");
  assert.equal(restored.rowId, "1");
  assert.ok(!restored._auto);
  assert.ok(!restored.overriddenAt);
});
