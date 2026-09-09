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
import { ensureRenders, recordConfirmed, recordDraft } from "../scripts/autoboard/lib/render.mjs";
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
      variants: [],
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

    server = await startReviewServer({
      runDir, planPath, port: 0, renderReviewPage: () => "<html></html>",
      resolveAccess: async () => ({ headers: {}, label: "test" }),
    });
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

const PNG_BYTES = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

// Scratch run for the render endpoints: temp run dir, one-board plan.json,
// offline manifest + empty _BUILD_LOG.csv so startReviewServer's library
// load succeeds without touching the real library.
async function startScratchServer(extra = {}) {
  const runDir = mkdtempSync(path.join(tmpdir(), "autoboard-review-render-"));
  const libraryRoot = path.join(runDir, "library");
  mkdirSync(path.join(libraryRoot, "Tile", "tiles"), { recursive: true });
  mkdirSync(path.join(libraryRoot, "Master_Library_Build"), { recursive: true });
  writeFileSync(path.join(libraryRoot, "Master_Library_Build", "_BUILD_LOG.csv"), "row_id,folder,matched_files\n");
  writeFileSync(path.join(libraryRoot, "build_manifest_v2.csv"), "row_id,unit_type,room_type,cost_code,item_name,sku,qty,reference\n1,Penthouse,Bath 2,11 45 Plumbing,Hansgrohe Croma,S1,1,\n");
  const photo = path.join(libraryRoot, "faucet.png");
  writeFileSync(photo, PNG_BYTES);
  const boardId = "penthouse-bath-2-fixture";
  const plan = {
    runId: "run-test", source: "offline-manifest", libraryRoot,
    variants: [{ key: "A", composition: "editorial", density: "balanced", styling: "materials_only", lighting: "soft_daylight" }],
    boards: [{
      id: boardId, title: "Penthouse Bath 2 Fixture Collage", unitType: "Penthouse", roomLabel: "Bath 2", collageType: "bathroom_fixture_collage",
      items: [{ slotId: "vanity_faucet", role: "vanity faucet", required: true, rowId: "1", sku: "S1", brand: "Hansgrohe", name: "Croma", notes: "", images: [photo], imageMeta: [] }],
    }],
  };
  const planPath = path.join(runDir, "plan.json");
  writeFileSync(planPath, JSON.stringify(plan, null, 2));
  if (extra.notesJson) {
    mkdirSync(path.join(runDir, "boards", boardId), { recursive: true });
    writeFileSync(path.join(runDir, "boards", boardId, "notes.json"), JSON.stringify(extra.notesJson));
  }
  if (extra.results) writeFileSync(path.join(runDir, "results.json"), JSON.stringify(extra.results));
  const server = await startReviewServer({
    runDir, planPath, port: 0, renderReviewPage: () => "<html></html>",
    baseUrl: "https://w.example",
    resolveAccess: extra.resolveAccess ?? (async () => ({ headers: { "cf-access-token": "t" }, label: "test" })),
    executeJob: extra.executeJob ?? (async () => {}),
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (route, body) => { const r = await fetch(base + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() }; };
  const get = async (route) => { const r = await fetch(base + route); const ct = r.headers.get("content-type") || ""; return { status: r.status, json: ct.includes("json") ? await r.json() : null, raw: r }; };
  const close = () => new Promise((resolve) => server.close(resolve));
  const results = () => JSON.parse(readFileSync(path.join(runDir, "results.json"), "utf8"));
  const planNow = () => JSON.parse(readFileSync(planPath, "utf8"));
  const cleanup = async () => { await close(); rmSync(runDir, { recursive: true, force: true }); };
  return { runDir, boardId, baseUrl: base, post, get, results, planNow, cleanup };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

test("server imports notes.json into item.note once and lets the UI clear it", async () => {
  const s = await startScratchServer({ notesJson: { items: [{ slotId: "vanity_faucet", note: "keep the handle" }] } });
  try {
    assert.equal(s.planNow().boards[0].items[0].note, "keep the handle");
    const r = await s.post("/api/item-note", { boardId: s.boardId, slotId: "vanity_faucet", note: "" });
    assert.equal(r.status, 200);
    assert.equal(s.planNow().boards[0].items[0].note, "");
  } finally { await s.cleanup(); }
});

test("POST /api/instruction and /api/item-note persist and validate", async () => {
  const s = await startScratchServer();
  try {
    let r = await s.post("/api/instruction", { boardId: s.boardId, instruction: "  more air  " });
    assert.equal(r.status, 200);
    assert.equal(s.results().renders[s.boardId].instruction, "more air");
    r = await s.post("/api/item-note", { boardId: s.boardId, slotId: "nope", note: "x" });
    assert.equal(r.status, 404);
    r = await s.post("/api/instruction", { boardId: s.boardId, instruction: "x".repeat(2001) });
    assert.equal(r.status, 400);
  } finally { await s.cleanup(); }
});

test("pick-draft, approve-confirmed and render-image work; path escapes are refused", async () => {
  const results = { candidates: {}, finals: {} };
  recordDraft(results, "penthouse-bath-2-fixture", { variant: "A", index: 1, path: "boards/penthouse-bath-2-fixture/drafts/d-0001.png", jobId: "j", durationMs: 1, selectionHash: "h", instruction: "", itemNotes: {} });
  const s = await startScratchServer({ results });
  try {
    mkdirSync(path.join(s.runDir, "boards", s.boardId, "drafts"), { recursive: true });
    writeFileSync(path.join(s.runDir, "boards", s.boardId, "drafts", "d-0001.png"), PNG_BYTES);
    let r = await s.post("/api/pick-draft", { boardId: s.boardId, draftId: "d-0001" });
    assert.equal(r.status, 200);
    assert.equal(s.results().renders[s.boardId].pickedDraftId, "d-0001");
    assert.equal(s.results().candidates[`${s.boardId}--A`].status, "ok");
    r = await s.post("/api/approve-confirmed", { boardId: s.boardId, confirmedId: "c-0009" });
    assert.equal(r.status, 404);
    r = await s.post("/api/approve-confirmed", { boardId: s.boardId, confirmedId: null });
    assert.equal(r.status, 200);
    const img = await s.get("/render-image?path=" + encodeURIComponent(`boards/${s.boardId}/drafts/d-0001.png`));
    assert.equal(img.status, 200);
    assert.equal(img.raw.headers.get("content-type"), "image/png");
    assert.equal((await s.get("/render-image?path=" + encodeURIComponent("../plan.json"))).status, 404);
  } finally { await s.cleanup(); }
});

test("POST /api/render-remove deletes one render and unpicks it if it was the current pick; POST /api/render-reset clears drafts+confirmed but not finals", async () => {
  const results = { candidates: {}, finals: {} };
  const boardId = "penthouse-bath-2-fixture";
  recordDraft(results, boardId, { variant: "A", index: 1, path: `boards/${boardId}/drafts/d-0001.png`, jobId: "j1", durationMs: 1, selectionHash: "h", instruction: "", itemNotes: {} });
  recordConfirmed(results, boardId, { variant: "A", fromDraftId: "d-0001", path: `boards/${boardId}/confirmed/c-0001.png`, jobId: "j2", durationMs: 1, selectionHash: "h", instruction: "", itemNotes: {} });
  const s = await startScratchServer({ results });
  try {
    mkdirSync(path.join(s.runDir, "boards", s.boardId, "drafts"), { recursive: true });
    mkdirSync(path.join(s.runDir, "boards", s.boardId, "confirmed"), { recursive: true });
    writeFileSync(path.join(s.runDir, "boards", s.boardId, "drafts", "d-0001.png"), PNG_BYTES);
    writeFileSync(path.join(s.runDir, "boards", s.boardId, "confirmed", "c-0001.png"), PNG_BYTES);
    let r = await s.post("/api/pick-draft", { boardId: s.boardId, draftId: "d-0001" });
    assert.equal(r.status, 200);

    r = await s.post("/api/render-remove", { boardId: s.boardId, kind: "draft", id: "d-0001" });
    assert.equal(r.status, 200);
    assert.equal(r.json.removed, "d-0001");
    assert.equal(s.results().renders[s.boardId].drafts.length, 0);
    assert.equal(s.results().renders[s.boardId].pickedDraftId, null);
    assert.equal(s.results().candidates[`${s.boardId}--A`], undefined);
    assert.equal((await s.get("/render-image?path=" + encodeURIComponent(`boards/${s.boardId}/drafts/d-0001.png`))).status, 404);

    r = await s.post("/api/render-remove", { boardId: s.boardId, kind: "draft", id: "d-9999" });
    assert.equal(r.status, 404);
    r = await s.post("/api/render-remove", { boardId: s.boardId, kind: "bogus", id: "c-0001" });
    assert.equal(r.status, 400);

    r = await s.post("/api/render-reset", { boardId: s.boardId });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.removed, { drafts: 0, confirmed: 1 });
    assert.equal(s.results().renders[s.boardId].confirmed.length, 0);
    assert.equal((await s.get("/render-image?path=" + encodeURIComponent(`boards/${s.boardId}/confirmed/c-0001.png`))).status, 404);
  } finally { await s.cleanup(); }
});

test("POST /api/render validates and enqueues; status exposes queue, stale flags, and unavailable costs", async () => {
  const calls = [];
  let release;
  const executeJob = (job, ctx) => new Promise((resolve) => { calls.push({ job, ctx }); release = resolve; ctx.onProgress("1/2"); });
  const s = await startScratchServer({ executeJob });
  try {
    assert.equal((await s.post("/api/render", { boardId: s.boardId, kind: "draft", variant: "Z", count: 2 })).status, 400);
    assert.equal((await s.post("/api/render", { boardId: s.boardId, kind: "draft", variant: "A", count: 11 })).status, 400);
    assert.equal((await s.post("/api/render", { boardId: s.boardId, kind: "confirm" })).status, 400);
    const r = await s.post("/api/render", { boardId: s.boardId, kind: "draft", variant: "A", count: 2 });
    assert.equal(r.status, 200);
    assert.equal(r.json.position, 1);
    await settle();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].job.kind, "draft");
    assert.equal(calls[0].ctx.baseUrl, "https://w.example");
    assert.deepEqual(calls[0].ctx.accessHeaders, { "cf-access-token": "t" });
    const status = (await s.get("/api/render-status")).json;
    assert.equal(status.accessError, null);
    assert.equal(status.queue[0].state, "running");
    assert.equal(status.queue[0].progress, "1/2");
    assert.equal(status.costs.draft, null);
    assert.match(status.selectionHashes[s.boardId], /^[0-9a-f]{40}$/);
    release();
    await settle();
    assert.equal((await s.get("/api/render-status")).json.queue[0].state, "done");
  } finally { await s.cleanup(); }
});

test("render-status marks drafts stale when the selection hash moved, and cancel works", async () => {
  const results = { candidates: {}, finals: {} };
  recordDraft(results, "penthouse-bath-2-fixture", { variant: "A", index: 1, path: "boards/penthouse-bath-2-fixture/drafts/d-0001.png", jobId: "j", durationMs: 1, selectionHash: "old", instruction: "", itemNotes: {} });
  let release;
  const s = await startScratchServer({ results, executeJob: () => new Promise((resolve) => { release = resolve; }) });
  try {
    const draft = (await s.get("/api/render-status")).json.renders[s.boardId].drafts[0];
    assert.equal(draft.stale, true);
    assert.equal(draft.url, "/render-image?path=" + encodeURIComponent(`boards/${s.boardId}/drafts/d-0001.png`));
    await s.post("/api/render", { boardId: s.boardId, kind: "draft", variant: "A", count: 1 });
    const b = await s.post("/api/render", { boardId: s.boardId, kind: "draft", variant: "A", count: 1, background: "transparent" });
    assert.equal(b.json.position, 2);
    assert.deepEqual((await s.post("/api/render-cancel", { jobId: b.json.jobId })).json, { cancelled: true });
    release();
    await settle();
    assert.deepEqual((await s.get("/api/render-status")).json.queue.map((job) => job.state), ["done", "cancelled"]);
  } finally { await s.cleanup(); }
});

test("saved Review options survive reload, reach the queue, and prevent duplicate submissions", async () => {
  const jobs = [];
  const releases = [];
  const s = await startScratchServer({ executeJob: (job) => new Promise((resolve) => { jobs.push(job); releases.push(resolve); }) });
  try {
    const before = s.planNow();
    assert.equal(Object.prototype.hasOwnProperty.call(before.boards[0], "renderOptions"), false);
    assert.equal((await s.get("/api/plan")).json.boards[0].renderOptions, null);

    let response = await s.post("/api/render-options", { boardId: s.boardId, quality: "xhigh", background: "transparent" });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json.renderOptions, { quality: "xhigh", background: "transparent" });
    assert.deepEqual(s.planNow().boards[0].renderOptions, { quality: "xhigh", background: "transparent" });
    assert.deepEqual((await s.get("/api/plan")).json.boards[0].renderOptions, { quality: "xhigh", background: "transparent" });

    response = await s.post("/api/render", { boardId: s.boardId, kind: "draft", variant: "A", count: 1 });
    assert.equal(response.status, 200);
    await settle();
    assert.deepEqual(jobs[0].renderOptionsSnapshot, { quality: "xhigh", background: "transparent" });
    const duplicate = await s.post("/api/render", { boardId: s.boardId, kind: "draft", variant: "A", count: 1 });
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.json.duplicate, true);
    assert.equal(duplicate.json.jobId, response.json.jobId);
    assert.equal(jobs.length, 1);
    releases.shift()();
    await settle();

    // Explicit CLI-equivalent overrides win over the saved board selection.
    response = await s.post("/api/render", { boardId: s.boardId, kind: "draft", variant: "A", count: 1, quality: "max", background: "opaque" });
    await settle();
    assert.deepEqual(jobs[1].renderOptionsSnapshot, { quality: "max", background: "opaque" });
    releases.shift()();
    await settle();
  } finally { await s.cleanup(); }
});

test("render dedupe includes the exact picked/approved source and final force", async () => {
  const boardId = "penthouse-bath-2-fixture";
  const results = { candidates: {}, finals: {} };
  recordDraft(results, boardId, { id: "d-0001", variant: "A", index: 1, path: `boards/${boardId}/drafts/d-0001.png`, jobId: "d1", durationMs: 1, selectionHash: "h", instruction: "", itemNotes: {} });
  recordDraft(results, boardId, { id: "d-0002", variant: "A", index: 2, path: `boards/${boardId}/drafts/d-0002.png`, jobId: "d2", durationMs: 1, selectionHash: "h", instruction: "", itemNotes: {} });
  recordConfirmed(results, boardId, { id: "c-0001", variant: "A", fromDraftId: "d-0001", path: `boards/${boardId}/confirmed/c-0001.png`, jobId: "c1", durationMs: 1, selectionHash: "h", instruction: "", itemNotes: {} });
  const jobs = [];
  const releases = [];
  const s = await startScratchServer({
    results,
    executeJob: (job) => new Promise((resolve) => { jobs.push(job); releases.push(resolve); }),
  });
  try {
    for (const file of ["d-0001.png", "d-0002.png"]) {
      mkdirSync(path.join(s.runDir, "boards", boardId, "drafts"), { recursive: true });
      writeFileSync(path.join(s.runDir, "boards", boardId, "drafts", file), ONE_BY_ONE_PNG);
    }
    await s.post("/api/pick-draft", { boardId, draftId: "d-0001" });
    const first = await s.post("/api/render", { boardId, kind: "final", force: true });
    await settle();
    const duplicate = await s.post("/api/render", { boardId, kind: "final", force: true });
    assert.equal(duplicate.json.duplicate, true);
    assert.equal(duplicate.json.jobId, first.json.jobId);

    await s.post("/api/pick-draft", { boardId, draftId: "d-0002" });
    const differentDraft = await s.post("/api/render", { boardId, kind: "final", force: true });
    assert.equal(differentDraft.json.duplicate, false);
    assert.notEqual(differentDraft.json.jobId, first.json.jobId);

    await s.post("/api/approve-confirmed", { boardId, confirmedId: "c-0001" });
    const differentApproved = await s.post("/api/render", { boardId, kind: "final", force: true });
    assert.equal(differentApproved.json.duplicate, false);
    assert.notEqual(differentApproved.json.jobId, differentDraft.json.jobId);
    assert.equal(jobs.length, 1);
    releases.shift()();
    await settle();
    releases.shift()();
    await settle();
    releases.shift()();
    await settle();
  } finally { await s.cleanup(); }
});

test("render rejects unsupported explicit quality/background before queueing", async () => {
  const jobs = [];
  const s = await startScratchServer({ executeJob: async (job) => { jobs.push(job); } });
  try {
    let response = await s.post("/api/render", { boardId: s.boardId, kind: "draft", variant: "A", count: 1, quality: "ultra" });
    assert.equal(response.status, 400);
    response = await s.post("/api/render", { boardId: s.boardId, kind: "draft", variant: "A", count: 1, background: "auto" });
    assert.equal(response.status, 400);
    await settle();
    assert.equal(jobs.length, 0);
  } finally { await s.cleanup(); }
});

test("POST /api/render final with a stale source is rejected without force, and accepted with force:true", async () => {
  const boardId = "penthouse-bath-2-fixture";
  const results = { candidates: {}, finals: {} };
  recordDraft(results, boardId, { variant: "A", index: 1, path: `boards/${boardId}/drafts/d-0001.png`, jobId: "j", durationMs: 1, selectionHash: "old", instruction: "", itemNotes: {} });
  ensureRenders(results, boardId).pickedDraftId = "d-0001";
  const jobs = [];
  const s = await startScratchServer({ results, executeJob: async (job) => { jobs.push(job); } });
  try {
    let r = await s.post("/api/render", { boardId, kind: "final" });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /stale/i);
    r = await s.post("/api/render", { boardId, kind: "final", force: true });
    assert.equal(r.status, 200);
    await settle();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].kind, "final");
    assert.equal(jobs[0].force, true);
  } finally { await s.cleanup(); }
});

test("POST /api/render without a JSON content type is rejected (cross-origin POST protection)", async () => {
  const s = await startScratchServer();
  try {
    const response = await fetch(s.baseUrl + "/api/render", { method: "POST", body: JSON.stringify({ boardId: s.boardId, kind: "draft", variant: "A", count: 1 }) });
    assert.equal(response.status, 400);
    const json = await response.json();
    assert.match(json.error, /Content-Type/);
  } finally { await s.cleanup(); }
});

test("an expired Access session is reported in status and re-resolved on the next render click", async () => {
  let attempts = 0;
  const resolveAccess = async () => {
    attempts++;
    if (attempts === 1) throw Object.assign(new Error("rejected — run cloudflared access login"), { code: "access-rejected", status: 302 });
    return { headers: { "cf-access-token": "fresh" }, label: "test" };
  };
  const seen = [];
  const s = await startScratchServer({ resolveAccess, executeJob: async (job, ctx) => { seen.push(ctx.accessHeaders); } });
  try {
    assert.match((await s.get("/api/render-status")).json.accessError, /rejected/);
    const r = await s.post("/api/render", { boardId: s.boardId, kind: "draft", variant: "A", count: 1 });
    assert.equal(r.status, 200);
    await settle();
    assert.equal((await s.get("/api/render-status")).json.accessError, null);
    assert.deepEqual(seen, [{ "cf-access-token": "fresh" }]);
    assert.equal(attempts, 2);
  } finally { await s.cleanup(); }
});
