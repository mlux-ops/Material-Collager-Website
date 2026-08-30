// Pure logic for the local review server: building a per-room "library" of
// candidate images, and applying/resetting a user's manual slot override.
// Kept separate from the HTTP layer (review-server.mjs) so it's unit-testable
// without spinning up a server.

import { extractBrand } from "./match.mjs";
import { resolveTileCode } from "./tiles.mjs";

export const TILE_SLOT_IDS = new Set(["main_tile", "accent_tile"]);

export function roomKeyFor(unitType, roomLabel) {
  return `${unitType.toLowerCase()}::${roomLabel.toLowerCase()}`;
}

// Map<"<unit>::<room>", row[]> — every row in that room, matched or not.
export function buildRoomIndex(rows) {
  const index = new Map();
  for (const row of rows) {
    const key = roomKeyFor(row.unitType, row.roomLabel);
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(row);
  }
  return index;
}

export function slotKind(slotId) {
  return TILE_SLOT_IDS.has(slotId) ? "tile" : "row";
}

// The browsable candidates for one board's slot: every tile code for a tile
// slot, or every row in that board's room for a regular slot. Only options
// with a resolvable photo are offered — an option with no image can't be
// selected into a render anyway.
export function libraryOptionsForSlot({ board, slotId, roomIndex, tileIndex, resolveImages }) {
  if (slotKind(slotId) === "tile") {
    return [...tileIndex.values()].map((tile) => ({
      kind: "tile",
      code: tile.code,
      label: tile.materialName,
      imagePath: tile.filePath,
    }));
  }
  // Rows with no resolvable photo are still returned (imagePath: null) rather
  // than hidden — the review UI offers an upload affordance for exactly
  // these, since "no photo yet" is precisely the gap worth fixing here.
  const rows = roomIndex.get(roomKeyFor(board.unitType, board.roomLabel)) ?? [];
  return rows.map((row) => ({
    kind: "row",
    rowId: row.rowId,
    label: row.itemName,
    sku: row.sku,
    costCode: row.costCode,
    imagePath: resolveImages(row.rowId)[0] ?? null,
  }));
}

function snapshotAuto(item) {
  return { rowId: item.rowId, sku: item.sku, brand: item.brand, name: item.name, notes: item.notes, images: item.images };
}

// Mutates `item` in place to reflect the user's choice, preserving the
// original auto-pick (on first override only) so resetSelection can restore
// it later. Returns the same item for convenience.
export function applySelection({ board, slotId, choice, roomIndex, tileIndex, resolveImages }) {
  const item = board.items.find((entry) => entry.slotId === slotId);
  if (!item) throw Object.assign(new Error(`Board "${board.id}" has no slot "${slotId}".`), { status: 404 });
  if (!item._auto) item._auto = snapshotAuto(item);

  if (choice.kind === "tile") {
    const tile = resolveTileCode(tileIndex, choice.code);
    if (!tile) throw Object.assign(new Error(`Unknown tile code "${choice.code}".`), { status: 400 });
    item.rowId = null;
    item.sku = tile.code;
    item.brand = "Elm Surfaces";
    item.name = tile.materialName;
    item.notes = "Manually selected in the review UI — overrides the v4 Elm Surfaces schedule's auto-pick.";
    item.images = [tile.filePath];
  } else if (choice.kind === "row") {
    const rows = roomIndex.get(roomKeyFor(board.unitType, board.roomLabel)) ?? [];
    const row = rows.find((entry) => entry.rowId === choice.rowId);
    if (!row) throw Object.assign(new Error(`Row "${choice.rowId}" is not in this board's room.`), { status: 400 });
    const images = resolveImages(row.rowId);
    if (!images.length) throw Object.assign(new Error("That item has no photo on disk."), { status: 400 });
    item.rowId = row.rowId;
    item.sku = row.sku;
    item.brand = extractBrand(row.itemName);
    item.name = row.itemName.slice(0, 80);
    item.notes = row.qty > 1 ? `quantity ${row.qty}` : "";
    item.images = images;
  } else {
    throw Object.assign(new Error(`Unknown choice kind "${choice.kind}".`), { status: 400 });
  }
  item.overriddenAt = new Date().toISOString();
  return item;
}

// Restores the pre-override values if this slot was ever changed; a no-op on
// a slot that's still at its auto-pick.
export function resetSelection({ board, slotId }) {
  const item = board.items.find((entry) => entry.slotId === slotId);
  if (!item) throw Object.assign(new Error(`Board "${board.id}" has no slot "${slotId}".`), { status: 404 });
  if (item._auto) {
    Object.assign(item, item._auto);
    delete item._auto;
    delete item.overriddenAt;
  }
  return item;
}
