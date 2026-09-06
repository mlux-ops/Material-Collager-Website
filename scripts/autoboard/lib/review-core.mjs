// Pure logic for the local review server: building a per-room "library" of
// candidate images, and applying/resetting a user's manual slot override.
// Kept separate from the HTTP layer (review-server.mjs) so it's unit-testable
// without spinning up a server.

import { extractBrand, extractTier } from "./match.mjs";
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

// The prefix marking a custom (not-in-the-manifest) item's synthetic rowId,
// so applySelection can tell it apart from a real Smartsheet row id.
const CUSTOM_ID_PREFIX = "custom:";

// The browsable candidates for one board's slot: every tile code for a tile
// slot, or every row in that board's room (plus any custom items added for
// that room) for a regular slot. Rows/custom items with no resolvable photo
// are still returned (imagePath: null) rather than hidden — the review UI
// offers an upload affordance for exactly these.
export function libraryOptionsForSlot({ board, slotId, roomIndex, tileIndex, resolveImages, customItems = [] }) {
  if (slotKind(slotId) === "tile") {
    return [...tileIndex.values()].map((tile) => ({
      kind: "tile",
      code: tile.code,
      label: tile.materialName,
      imagePath: tile.filePath,
    }));
  }
  const rows = roomIndex.get(roomKeyFor(board.unitType, board.roomLabel)) ?? [];
  const rowOptions = rows.map((row) => ({
    kind: "row",
    rowId: row.rowId,
    label: row.itemName,
    sku: row.sku,
    costCode: row.costCode,
    imagePath: resolveImages(row.rowId)[0] ?? null,
  }));
  const customOptions = customItems.map((item) => ({
    kind: "row",
    rowId: `${CUSTOM_ID_PREFIX}${item.id}`,
    label: item.name,
    sku: item.brand,
    costCode: "Custom item",
    imagePath: item.imagePath,
  }));
  return [...rowOptions, ...customOptions];
}

function snapshotAuto(item) {
  return {
    rowId: item.rowId,
    sku: item.sku,
    brand: item.brand,
    name: item.name,
    tier: item.tier,
    notes: item.notes,
    provenance: item.provenance,
    images: item.images,
  };
}

// Mutates `item` in place to reflect the user's choice, preserving the
// original auto-pick (on first override only) so resetSelection can restore
// it later. Returns the same item for convenience.
export function applySelection({ board, slotId, choice, roomIndex, tileIndex, resolveImages, customItems = [] }) {
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
    delete item.tier; // tiers only ever come from Smartsheet good/better/best rows
    // Bookkeeping, not a model-facing instruction — leave item.notes alone
    // (see match.mjs's tile injection and variants.mjs's boardPayload, which
    // only ever sends item.notes to the model).
    item.provenance = "Manually selected in the review UI — overrides the v4 Elm Surfaces schedule's auto-pick.";
    item.images = [tile.filePath];
  } else if (choice.kind === "row" && String(choice.rowId ?? "").startsWith(CUSTOM_ID_PREFIX)) {
    const customId = choice.rowId.slice(CUSTOM_ID_PREFIX.length);
    const custom = customItems.find((entry) => entry.id === customId);
    if (!custom) throw Object.assign(new Error(`Unknown custom item "${customId}".`), { status: 400 });
    if (!custom.imagePath) throw Object.assign(new Error("That item has no photo on disk."), { status: 400 });
    item.rowId = choice.rowId;
    item.sku = "";
    item.brand = custom.brand || "";
    item.name = custom.name; // stored whole — no truncation
    delete item.tier; // custom items carry no Smartsheet good/better/best prefix
    item.notes = custom.notes || "";
    item.provenance = "Custom item added in the review UI (not in the library manifest).";
    item.images = [custom.imagePath];
  } else if (choice.kind === "row") {
    const rows = roomIndex.get(roomKeyFor(board.unitType, board.roomLabel)) ?? [];
    const row = rows.find((entry) => entry.rowId === choice.rowId);
    if (!row) throw Object.assign(new Error(`Row "${choice.rowId}" is not in this board's room.`), { status: 400 });
    const images = resolveImages(row.rowId);
    if (!images.length) throw Object.assign(new Error("That item has no photo on disk."), { status: 400 });
    // Same good/better/best prefix handling as match.mjs's buildBoards: strip
    // it off into item.tier and derive the brand from the stripped name.
    const { name, tier } = extractTier(row.itemName);
    item.rowId = row.rowId;
    item.sku = row.sku;
    item.brand = extractBrand(name);
    item.name = name; // stored whole — no truncation
    if (tier) item.tier = tier;
    else delete item.tier;
    item.notes = row.qty > 1 ? `quantity ${row.qty}` : "";
    item.provenance = "Manually selected in the review UI from the room's library rows.";
    item.images = images;
  } else {
    throw Object.assign(new Error(`Unknown choice kind "${choice.kind}".`), { status: 400 });
  }
  const now = new Date().toISOString();
  item.overriddenAt = now;
  board.overriddenAt = now; // board-level marker — see boardOverriddenAt
  return item;
}

// The most recent slot-override timestamp on a board, or null if it's never
// been touched since it was planned. A board's items can change after a
// candidate was already rendered (most often via the review UI swapping a
// slot's image directly in plan.json), which is exactly what this detects.
// board.overriddenAt covers slot additions/removals, which touch no single
// item's own timestamp; per-item timestamps cover ordinary swaps.
export function boardOverriddenAt(board) {
  const timestamps = [board.overriddenAt, ...board.items.map((item) => item.overriddenAt)].filter(Boolean);
  return timestamps.length ? timestamps.sort().at(-1) : null;
}

const SLOT_ID_PATTERN = /^[a-z][a-z0-9_]*$/i;

// Appends a brand-new slot to a board — not one of the board type's preset
// slots, just an extra item the user wants rendered. Always counts as a
// change (there's no "auto-pick" to snapshot for something that never
// existed at plan time), so any current candidate becomes stale.
export function addSlot(board, { slotId, role, required, name, brand, notes, imagePath }) {
  const cleanSlotId = String(slotId ?? "").trim();
  if (!SLOT_ID_PATTERN.test(cleanSlotId)) {
    throw Object.assign(new Error("Slot ID must start with a letter and contain only letters, numbers, and underscores."), { status: 400 });
  }
  if (board.items.some((item) => item.slotId === cleanSlotId)) {
    throw Object.assign(new Error(`This board already has a slot named "${cleanSlotId}".`), { status: 400 });
  }
  if (!imagePath) throw Object.assign(new Error("An image is required to add a slot."), { status: 400 });
  const now = new Date().toISOString();
  const item = {
    slotId: cleanSlotId,
    role: String(role ?? "").trim() || cleanSlotId.replaceAll("_", " "),
    required: Boolean(required),
    rowId: null,
    sku: "",
    brand: brand || "",
    name: String(name ?? "").slice(0, 80) || cleanSlotId,
    notes: notes || "",
    images: [imagePath],
    overriddenAt: now,
  };
  board.items.push(item);
  board.overriddenAt = now;
  return item;
}

// Removes a slot entirely — real deletion, not a hide/disable flag, so it
// takes zero changes elsewhere (generate/finalize just iterate board.items).
// There's no undo captured here; re-adding via addSlot is the way back.
export function removeSlot(board, slotId) {
  const index = board.items.findIndex((item) => item.slotId === slotId);
  if (index === -1) throw Object.assign(new Error(`Board "${board.id}" has no slot "${slotId}".`), { status: 404 });
  const [removed] = board.items.splice(index, 1);
  board.overriddenAt = new Date().toISOString();
  return removed;
}

// True when a rendered candidate no longer reflects the board's current
// selections — its slots changed more recently than it was rendered, so the
// existing PNG is out of date even though it "succeeded."
export function isStaleCandidate(board, candidate) {
  const staleSince = boardOverriddenAt(board);
  return Boolean(candidate?.completedAt && staleSince && staleSince > candidate.completedAt);
}

// Restores the pre-override values if this slot was ever changed; a no-op on
// a slot that's still at its auto-pick.
export function resetSelection({ board, slotId }) {
  const item = board.items.find((entry) => entry.slotId === slotId);
  if (!item) throw Object.assign(new Error(`Board "${board.id}" has no slot "${slotId}".`), { status: 404 });
  if (item._auto) {
    const { tier, ...rest } = item._auto;
    Object.assign(item, rest);
    // Unlike the rest of the snapshot, `tier` restores as an absent key
    // rather than an explicit `undefined` — matches how applySelection itself
    // always deletes item.tier for an untiered pick instead of setting it.
    if (tier === undefined) delete item.tier;
    else item.tier = tier;
    delete item._auto;
    delete item.overriddenAt;
  }
  return item;
}
