import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  addSlot,
  applySelection,
  boardOverriddenAt,
  buildRoomIndex,
  isStaleCandidate,
  libraryOptionsForSlot,
  removeSlot,
  replaceItemImage,
  resetSelection,
  roomKeyFor,
  slotKind,
} from "../scripts/autoboard/lib/review-core.mjs";
import { startReviewServer } from "../scripts/autoboard/lib/review-server.mjs";

// A tiny real 1x1 PNG (valid header) — readImageSize needs actual bytes to
// parse, unlike the other tests here which get away with fake "/fake/..."
// paths since they never touch image dimensions.
const ONE_BY_ONE_PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415408d763f8cfc0c0c0c40000000704fe07b3ee7e0000000049454e44ae426082",
  "hex",
);

function withTempPng(name, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "autoboard-review-test-"));
  try {
    const filePath = path.join(dir, name);
    writeFileSync(filePath, ONE_BY_ONE_PNG);
    return fn(filePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

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

test("libraryOptionsForSlot appends custom (not-in-the-manifest) items alongside real room rows", () => {
  const roomIndex = buildRoomIndex([row({ rowId: "1", itemName: "Brizo Faucet" })]);
  const customItems = [{ id: "custom-1", name: "Hand-picked Sconce", brand: "Acme", imagePath: "/fake/custom-1.jpg" }];
  const options = libraryOptionsForSlot({
    board: board([]), slotId: "light_fixture", roomIndex, tileIndex: new Map(),
    resolveImages: (rowId) => [`/fake/${rowId}.png`], customItems,
  });
  assert.equal(options.length, 2);
  const custom = options.find((o) => o.rowId === "custom:custom-1");
  assert.equal(custom.label, "Hand-picked Sconce");
  assert.equal(custom.imagePath, "/fake/custom-1.jpg");
});

test("applySelection selects a custom item by its custom: rowId prefix", () => {
  const b = board([{ slotId: "light_fixture", role: "vanity or wall light fixture", required: false, rowId: "1", sku: "", brand: "", name: "Original", notes: "", images: ["/fake/1.png"] }]);
  const customItems = [{ id: "custom-1", name: "Hand-picked Sconce", brand: "Acme", notes: "matte black", imagePath: "/fake/custom-1.jpg" }];
  const item = applySelection({
    board: b, slotId: "light_fixture", choice: { kind: "row", rowId: "custom:custom-1" },
    roomIndex: new Map(), tileIndex: new Map(), resolveImages: () => [], customItems,
  });
  assert.equal(item.rowId, "custom:custom-1");
  assert.equal(item.brand, "Acme");
  assert.equal(item.name, "Hand-picked Sconce");
  assert.equal(item.notes, "matte black");
  assert.deepEqual(item.images, ["/fake/custom-1.jpg"]);
  assert.ok(item.overriddenAt);
  // reset restores the original, non-custom pick
  const restored = resetSelection({ board: b, slotId: "light_fixture" });
  assert.equal(restored.rowId, "1");
  assert.equal(restored.name, "Original");
});

test("applySelection rejects an unknown custom item id", () => {
  const b = board([{ slotId: "light_fixture", images: ["/fake/1.png"] }]);
  assert.throws(
    () => applySelection({
      board: b, slotId: "light_fixture", choice: { kind: "row", rowId: "custom:missing" },
      roomIndex: new Map(), tileIndex: new Map(), resolveImages: () => [], customItems: [],
    }),
    (error) => error.status === 400,
  );
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
  assert.deepEqual(item._auto, { rowId: "1", sku: "SKU-1", brand: "Brizo", name: "Brizo Odin Faucet", tier: undefined, notes: "", provenance: undefined, images: ["/fake/1.png"] });

  // A second override does NOT overwrite the original auto-pick snapshot.
  applySelection({
    board: b, slotId: "vanity_faucet", choice: { kind: "row", rowId: "1" },
    roomIndex, tileIndex: new Map(), resolveImages: (rowId) => [`/fake/${rowId}.png`],
  });
  assert.equal(item._auto.rowId, "1");
});

test("applySelection sets Elm Surfaces provenance for a tile choice, leaving notes untouched", () => {
  const tileIndex = new Map([["WT9", { code: "WT9", materialName: "Cortar Bone Ribbed", filePath: "/fake/WT9.jpg" }]]);
  const b = board([{
    slotId: "main_tile", role: "main bathroom tile", required: true, rowId: null, sku: "WT2", brand: "Elm Surfaces",
    name: "Cortar Bone Reed", notes: "keep grout lines crisp", provenance: "original auto-pick provenance", images: ["/fake/WT2.jpg"],
  }]);
  const item = applySelection({
    board: b, slotId: "main_tile", choice: { kind: "tile", code: "WT9" },
    roomIndex: new Map(), tileIndex, resolveImages: () => [],
  });
  assert.equal(item.sku, "WT9");
  assert.equal(item.brand, "Elm Surfaces");
  assert.equal(item.name, "Cortar Bone Ribbed");
  assert.match(item.provenance, /overrides the v4 Elm Surfaces schedule/);
  // notes is model-facing (buildGenerationPrompt reads it as "specific
  // instruction") — a tile swap must not touch a pre-existing user note.
  assert.equal(item.notes, "keep grout lines crisp");

  // resetSelection restores the prior provenance along with everything else.
  const restored = resetSelection({ board: b, slotId: "main_tile" });
  assert.equal(restored.provenance, "original auto-pick provenance");
  assert.equal(restored.notes, "keep grout lines crisp");
});

test("applySelection throws with an actionable status for bad input", () => {
  const b = board([{ slotId: "vanity_faucet", role: "vanity faucet", required: true, rowId: "1", images: ["/fake/1.png"] }]);
  assert.throws(() => applySelection({ board: b, slotId: "no-such-slot", choice: { kind: "row", rowId: "1" }, roomIndex: new Map(), tileIndex: new Map(), resolveImages: () => [] }), (error) => error.status === 404);
  assert.throws(() => applySelection({ board: b, slotId: "vanity_faucet", choice: { kind: "row", rowId: "missing" }, roomIndex: buildRoomIndex([row({ rowId: "1" })]), tileIndex: new Map(), resolveImages: () => ["/fake/1.png"] }), (error) => error.status === 400);
  assert.throws(() => applySelection({ board: b, slotId: "vanity_faucet", choice: { kind: "row", rowId: "1" }, roomIndex: buildRoomIndex([row({ rowId: "1" })]), tileIndex: new Map(), resolveImages: () => [] }), (error) => error.status === 400 && /no photo/i.test(error.message));
});

test("applySelection stores a real row's full item name, never truncating at 80 chars", () => {
  const longName = `${"A".repeat(90)} Faucet`;
  const roomIndex = buildRoomIndex([row({ rowId: "1", itemName: longName })]);
  const b = board([{ slotId: "vanity_faucet", role: "vanity faucet", required: true, rowId: "0", sku: "", brand: "", name: "Original", notes: "", images: ["/fake/0.png"] }]);
  const item = applySelection({
    board: b, slotId: "vanity_faucet", choice: { kind: "row", rowId: "1" },
    roomIndex, tileIndex: new Map(), resolveImages: (rowId) => [`/fake/${rowId}.png`],
  });
  assert.ok(item.name.length > 80);
  assert.equal(item.name, longName);
});

test("applySelection strips a good/better/best prefix into item.tier, and deletes it when a later swap has no prefix", () => {
  const roomIndex = buildRoomIndex([
    row({ rowId: "1", itemName: "-Better- option - Duo Pendant" }),
    row({ rowId: "2", itemName: "Rejuvenation Duo Pendant" }),
  ]);
  const b = board([{ slotId: "light_fixture", role: "light fixture", required: false, rowId: "0", sku: "", brand: "", name: "Original", notes: "", images: ["/fake/0.png"] }]);
  const tiered = applySelection({
    board: b, slotId: "light_fixture", choice: { kind: "row", rowId: "1" },
    roomIndex, tileIndex: new Map(), resolveImages: (rowId) => [`/fake/${rowId}.png`],
  });
  assert.equal(tiered.name, "Duo Pendant");
  assert.equal(tiered.tier, "better");

  const untiered = applySelection({
    board: b, slotId: "light_fixture", choice: { kind: "row", rowId: "2" },
    roomIndex, tileIndex: new Map(), resolveImages: (rowId) => [`/fake/${rowId}.png`],
  });
  assert.equal(untiered.name, "Rejuvenation Duo Pendant");
  assert.ok(!("tier" in untiered));
});

test("resetSelection restores tier after an override, and deletes it again when the auto-pick had none", () => {
  const roomIndex = buildRoomIndex([
    row({ rowId: "1", itemName: "-Better- option - Duo Pendant" }),
    row({ rowId: "2", itemName: "Rejuvenation Duo Pendant" }),
  ]);
  const b = board([{
    slotId: "light_fixture", role: "light fixture", required: false, rowId: "1", sku: "SKU-1",
    brand: "Rejuvenation", name: "Duo Pendant", tier: "better", notes: "", images: ["/fake/1.png"],
  }]);
  applySelection({
    board: b, slotId: "light_fixture", choice: { kind: "row", rowId: "2" },
    roomIndex, tileIndex: new Map(), resolveImages: (rowId) => [`/fake/${rowId}.png`],
  });
  assert.ok(!("tier" in b.items[0])); // the swapped-in row has no good/better/best prefix

  const restored = resetSelection({ board: b, slotId: "light_fixture" });
  assert.equal(restored.tier, "better");
});

test("applySelection replaces provenance across branches, leaving no trace of a previous branch's sentence", () => {
  const tileIndex = new Map([["WT9", { code: "WT9", materialName: "Cortar Bone Ribbed", filePath: "/fake/WT9.jpg" }]]);
  const roomIndex = buildRoomIndex([row({ rowId: "1", itemName: "Brizo Odin Faucet" })]);
  const b = board([{
    slotId: "main_tile", role: "main bathroom tile", required: true, rowId: null, sku: "WT2", brand: "Elm Surfaces",
    name: "Cortar Bone Reed", notes: "", images: ["/fake/WT2.jpg"],
  }]);

  const asTile = applySelection({
    board: b, slotId: "main_tile", choice: { kind: "tile", code: "WT9" },
    roomIndex: new Map(), tileIndex, resolveImages: () => [],
  });
  assert.match(asTile.provenance, /overrides the v4 Elm Surfaces schedule/);

  const asRow = applySelection({
    board: b, slotId: "main_tile", choice: { kind: "row", rowId: "1" },
    roomIndex, tileIndex, resolveImages: (rowId) => [`/fake/${rowId}.png`],
  });
  assert.equal(asRow.provenance, "Manually selected in the review UI from the room's library rows.");
  assert.doesNotMatch(asRow.provenance, /Elm Surfaces schedule/);

  const backToTile = applySelection({
    board: b, slotId: "main_tile", choice: { kind: "tile", code: "WT9" },
    roomIndex: new Map(), tileIndex, resolveImages: () => [],
  });
  assert.match(backToTile.provenance, /overrides the v4 Elm Surfaces schedule/);
  assert.doesNotMatch(backToTile.provenance, /room's library rows/);
});

test("item.notes is untouched by the tile branch, and no provenance sentence ever lands in item.notes", () => {
  const tileIndex = new Map([["WT9", { code: "WT9", materialName: "Cortar Bone Ribbed", filePath: "/fake/WT9.jpg" }]]);
  const roomIndex = buildRoomIndex([row({ rowId: "1", itemName: "Brizo Odin Faucet, Qty 2", qty: 2 })]);
  const customItems = [{ id: "custom-1", name: "Hand-picked Sconce", brand: "Acme", notes: "matte black", imagePath: "/fake/custom-1.jpg" }];
  const b = board([{
    slotId: "main_tile", role: "main bathroom tile", required: true, rowId: null, sku: "WT2", brand: "Elm Surfaces",
    name: "Cortar Bone Reed", notes: "keep grout lines crisp", images: ["/fake/WT2.jpg"],
  }]);

  const asTile = applySelection({
    board: b, slotId: "main_tile", choice: { kind: "tile", code: "WT9" },
    roomIndex: new Map(), tileIndex, resolveImages: () => [],
  });
  assert.equal(asTile.notes, "keep grout lines crisp"); // untouched by the tile branch
  assert.doesNotMatch(asTile.notes, /overrides the v4 Elm Surfaces schedule/);

  const asRow = applySelection({
    board: b, slotId: "main_tile", choice: { kind: "row", rowId: "1" },
    roomIndex, tileIndex, resolveImages: (rowId) => [`/fake/${rowId}.png`],
  });
  assert.equal(asRow.notes, "quantity 2");
  assert.doesNotMatch(asRow.notes, /room's library rows/);

  const asCustom = applySelection({
    board: b, slotId: "main_tile", choice: { kind: "row", rowId: "custom:custom-1" },
    roomIndex, tileIndex, resolveImages: () => [], customItems,
  });
  assert.equal(asCustom.notes, "matte black");
  assert.doesNotMatch(asCustom.notes, /not in the library manifest/);
});

test("boardOverriddenAt reports the latest override timestamp, or null if untouched", () => {
  const untouched = board([{ slotId: "main_tile", images: ["/fake/1.jpg"] }]);
  assert.equal(boardOverriddenAt(untouched), null);

  const touched = board([
    { slotId: "main_tile", images: ["/fake/1.jpg"], overriddenAt: "2026-01-01T00:00:00.000Z" },
    { slotId: "accent_tile", images: ["/fake/2.jpg"], overriddenAt: "2026-06-01T00:00:00.000Z" },
  ]);
  assert.equal(boardOverriddenAt(touched), "2026-06-01T00:00:00.000Z");

  // A board-level timestamp (set by addSlot/removeSlot, which touch no
  // single item's own timestamp) counts too, and wins if it's the latest.
  const b = board([{ slotId: "main_tile", images: ["/fake/1.jpg"], overriddenAt: "2026-01-01T00:00:00.000Z" }]);
  b.overriddenAt = "2026-09-01T00:00:00.000Z";
  assert.equal(boardOverriddenAt(b), "2026-09-01T00:00:00.000Z");
});

test("addSlot appends a brand-new item, validates the slot id, and marks the board changed", () => {
  const b = board([{ slotId: "vanity_faucet", images: ["/fake/1.jpg"] }]);
  const item = addSlot(b, {
    slotId: "wall_art", role: "decorative wall art", required: false,
    name: "Framed Print", brand: "Acme", notes: "34x40", imagePath: "/fake/art.jpg",
  });
  assert.equal(b.items.length, 2);
  assert.equal(item.slotId, "wall_art");
  assert.equal(item.role, "decorative wall art");
  assert.equal(item.required, false);
  assert.equal(item.name, "Framed Print");
  assert.deepEqual(item.images, ["/fake/art.jpg"]);
  assert.ok(item.overriddenAt);
  assert.equal(b.overriddenAt, item.overriddenAt);

  // rejects a duplicate slot id
  assert.throws(
    () => addSlot(b, { slotId: "wall_art", name: "Other", imagePath: "/fake/2.jpg" }),
    (error) => error.status === 400 && /already has a slot/.test(error.message),
  );
  // rejects an invalid slot id
  assert.throws(
    () => addSlot(b, { slotId: "not valid!", name: "X", imagePath: "/fake/3.jpg" }),
    (error) => error.status === 400,
  );
  // requires an image
  assert.throws(
    () => addSlot(b, { slotId: "new_slot", name: "X", imagePath: null }),
    (error) => error.status === 400 && /image is required/.test(error.message),
  );
});

test("addSlot defaults role/name from the slot id when not given", () => {
  const b = board([]);
  const item = addSlot(b, { slotId: "wall_art", imagePath: "/fake/art.jpg" });
  assert.equal(item.role, "wall art");
  assert.equal(item.name, "wall_art");
  assert.equal(item.required, false);
});

test("removeSlot deletes the item outright and marks the board changed", () => {
  const b = board([
    { slotId: "vanity_faucet", images: ["/fake/1.jpg"] },
    { slotId: "wall_art", images: ["/fake/2.jpg"] },
  ]);
  const removed = removeSlot(b, "wall_art");
  assert.equal(removed.slotId, "wall_art");
  assert.equal(b.items.length, 1);
  assert.equal(b.items[0].slotId, "vanity_faucet");
  assert.ok(b.overriddenAt);
});

test("removeSlot throws for an unknown slot", () => {
  const b = board([{ slotId: "vanity_faucet", images: ["/fake/1.jpg"] }]);
  assert.throws(() => removeSlot(b, "no-such-slot"), (error) => error.status === 404);
});

test("isStaleCandidate reacts to addSlot/removeSlot via the board-level timestamp", () => {
  const b = board([{ slotId: "vanity_faucet", images: ["/fake/1.jpg"] }]);
  // A fixed, guaranteed-in-the-past timestamp — avoids any race against
  // addSlot's own `new Date()` call landing in the same millisecond.
  const renderedLongAgo = { completedAt: "2020-01-01T00:00:00.000Z" };
  assert.equal(isStaleCandidate(b, renderedLongAgo), false);
  addSlot(b, { slotId: "wall_art", imagePath: "/fake/2.jpg" });
  assert.equal(isStaleCandidate(b, renderedLongAgo), true);
});

test("isStaleCandidate: a slot changed after the candidate rendered makes it stale; otherwise it isn't", () => {
  const b = board([{ slotId: "main_tile", images: ["/fake/1.jpg"], overriddenAt: "2026-06-01T00:00:00.000Z" }]);
  const renderedBefore = { completedAt: "2026-05-01T00:00:00.000Z" };
  const renderedAfter = { completedAt: "2026-07-01T00:00:00.000Z" };
  assert.equal(isStaleCandidate(b, renderedBefore), true);
  assert.equal(isStaleCandidate(b, renderedAfter), false);
  assert.equal(isStaleCandidate(b, undefined), false); // no candidate at all isn't "stale", just missing
  const untouched = board([{ slotId: "main_tile", images: ["/fake/1.jpg"] }]);
  assert.equal(isStaleCandidate(untouched, renderedBefore), false);
});

test("replaceItemImage swaps only the image/imageMeta, leaving everything else about the item untouched", () => {
  withTempPng("new-photo.png", (newPath) => {
    const b = board([{
      slotId: "vanity_faucet", role: "vanity faucet", required: true, rowId: "1", sku: "SKU-1",
      brand: "Brizo", name: "Brizo Odin Faucet", notes: "keep it shiny",
      provenance: "Manually selected in the review UI from the room's library rows.",
      tier: "better", images: ["/fake/1.png"], imageMeta: [{ path: "/fake/1.png", width: 900, height: 900 }],
    }]);
    const item = replaceItemImage({ board: b, slotId: "vanity_faucet", imagePath: newPath });

    assert.deepEqual(item.images, [newPath]);
    assert.deepEqual(item.imageMeta, [{ path: newPath, width: 1, height: 1 }]);
    // untouched
    assert.equal(item.rowId, "1");
    assert.equal(item.sku, "SKU-1");
    assert.equal(item.brand, "Brizo");
    assert.equal(item.name, "Brizo Odin Faucet");
    assert.equal(item.notes, "keep it shiny");
    assert.equal(item.provenance, "Manually selected in the review UI from the room's library rows.");
    assert.equal(item.tier, "better");
    // staleness stamped, same as every other mutation in this file
    assert.ok(item.overriddenAt);
    assert.equal(b.overriddenAt, item.overriddenAt);
  });
});

test("replaceItemImage snapshots _auto on first call and preserves it across a later swap", () => {
  withTempPng("first.png", (firstPath) => {
    const b = board([{ slotId: "vanity_faucet", role: "vanity faucet", required: true, rowId: "1", sku: "SKU-1", brand: "Brizo", name: "Original", notes: "", images: ["/fake/1.png"] }]);
    replaceItemImage({ board: b, slotId: "vanity_faucet", imagePath: firstPath });
    assert.deepEqual(b.items[0]._auto, { rowId: "1", sku: "SKU-1", brand: "Brizo", name: "Original", tier: undefined, notes: "", provenance: undefined, images: ["/fake/1.png"] });

    withTempPng("second.png", (secondPath) => {
      replaceItemImage({ board: b, slotId: "vanity_faucet", imagePath: secondPath });
      // the second call must not re-snapshot over the first auto-pick
      assert.deepEqual(b.items[0]._auto.images, ["/fake/1.png"]);
      assert.equal(b.items[0].images[0], secondPath);
    });

    // Reset to auto-pick still works correctly after an image-only swap.
    const restored = resetSelection({ board: b, slotId: "vanity_faucet" });
    assert.equal(restored.name, "Original");
    assert.deepEqual(restored.images, ["/fake/1.png"]);
    assert.ok(!restored._auto);
  });
});

test("replaceItemImage throws with .status 404 for an unknown slot", () => {
  withTempPng("x.png", (imagePath) => {
    const b = board([{ slotId: "vanity_faucet", images: ["/fake/1.png"] }]);
    assert.throws(
      () => replaceItemImage({ board: b, slotId: "no-such-slot", imagePath }),
      (error) => error.status === 404,
    );
  });
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

test("POST /api/replace-image swaps a real row's photo and returns the updated item with unchanged name/brand", async () => {
  const runDir = mkdtempSync(path.join(tmpdir(), "autoboard-review-server-run-"));
  const libraryRoot = mkdtempSync(path.join(tmpdir(), "autoboard-review-server-lib-"));
  // saveUploadedRowImage (called by the real /api/replace-image handler, no
  // `root` override) always writes into the repo's own real
  // scripts/autoboard/uploaded-images/<rowId>/ overlay — that's the intended
  // production behavior (see uploads.mjs's header note), not a fixture path.
  // Use a rowId that can't collide with real data, and clean up just that
  // one subfolder afterward.
  const testRowId = "test-server-row-9001";
  const uploadedImagesRoot = path.join(import.meta.dirname, "..", "scripts", "autoboard", "uploaded-images");
  let server;
  try {
    mkdirSync(path.join(libraryRoot, "Tile", "tiles"), { recursive: true });
    mkdirSync(path.join(libraryRoot, "Master_Library_Build"), { recursive: true });
    writeFileSync(path.join(libraryRoot, "Master_Library_Build", "_BUILD_LOG.csv"), "row_id,folder,matched_files\n");
    writeFileSync(
      path.join(libraryRoot, "build_manifest_v2.csv"),
      "row_id,unit_type,room_type,cost_code,item_name,sku,qty,reference\n"
      + `${testRowId},Penthouse,Bath 2,11 45 Plumbing Fixtures M,Test Faucet,SKU-1,1,\n`,
    );
    const planPath = path.join(runDir, "plan.json");
    const plan = {
      runId: "test-run",
      source: "offline-manifest",
      libraryRoot,
      variants: {},
      boards: [{
        id: "test-board", unitType: "Penthouse", roomLabel: "Bath 2", collageType: "bathroom_fixture_collage",
        kindLabel: "Fixture Collage", title: "Test Board",
        items: [{
          slotId: "vanity_faucet", role: "vanity faucet", required: true, rowId: testRowId, sku: "SKU-1",
          brand: "Test Brand", name: "Test Faucet", notes: "", images: ["/fake/nonexistent.jpg"],
        }],
      }],
    };
    writeFileSync(planPath, JSON.stringify(plan, null, 2));

    server = await startReviewServer({ runDir, planPath, port: 0, renderReviewPage: () => "<html></html>" });
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    const response = await fetch(`${baseUrl}/api/replace-image`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        boardId: "test-board", slotId: "vanity_faucet",
        mimeType: "image/png", dataBase64: ONE_BY_ONE_PNG.toString("base64"),
      }),
    });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.notEqual(data.item.images[0], "/fake/nonexistent.jpg");
    assert.equal(data.item.name, "Test Faucet");
    assert.equal(data.item.brand, "Test Brand");
    assert.ok(data.item.overriddenAt);

    // Persisted to plan.json, same as every other mutating endpoint.
    const persisted = JSON.parse(readFileSync(planPath, "utf8"));
    assert.equal(persisted.boards[0].items[0].images[0], data.item.images[0]);
  } finally {
    if (server) await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    rmSync(runDir, { recursive: true, force: true });
    rmSync(libraryRoot, { recursive: true, force: true });
    rmSync(path.join(uploadedImagesRoot, testRowId), { recursive: true, force: true });
  }
});
