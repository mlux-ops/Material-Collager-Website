// A person's edits to a project's rows, applied on top of what the sheet said.
//
// The stored rows stay a reading of the sheet, replaced wholesale by a refresh.
// These edits are the reviewer's work and live beside them, keyed by row id, so
// a refresh keeps them:
//
// - a MANUAL row is one added by hand, for a project with no sheet behind it
//   (a blank project, or one seeded from a tracked definition). A project with
//   a sheet gets new rows written into the sheet instead (sheet-write.ts), so
//   the sheet stays the single record.
// - an EXCLUDED row is removed from every board and every gap list. The
//   snapshot taken at removal is what the Removed list shows, and Restore is
//   just forgetting the exclusion.
// - a PIN places a row on one slot of one board type (see SlotPin in types.ts).
//
// Pure: no storage here. app/lib/autoboard-row-edits.ts persists these in D1.

import { COLLAGE_TYPES, ITEM_PRESETS } from "../collage.ts";
import { normalizedRow } from "./source.ts";
import type { CollageType, LibraryRow, SlotPin } from "./types.ts";

export type RowEdits = {
  manual: LibraryRow[];
  excluded: Map<string, LibraryRow>;
  pins: Map<string, SlotPin>;
};

export function emptyRowEdits(): RowEdits {
  return { manual: [], excluded: new Map(), pins: new Map() };
}

export const MANUAL_ROW_PREFIX = "manual-";

export function isManualRowId(rowId: string): boolean {
  return rowId.startsWith(MANUAL_ROW_PREFIX);
}

// The rows a project's boards are built from: the stored rows, then the manual
// ones in the order they were added, minus anything excluded. Manual rows come
// last so a hand-added row never displaces a sheet row that matched the same
// slot first — a person who wants it there pins it.
export function applyRowEdits(rows: LibraryRow[], edits: RowEdits): LibraryRow[] {
  const seen = new Set<string>();
  const result: LibraryRow[] = [];
  for (const row of [...rows, ...edits.manual]) {
    if (edits.excluded.has(row.rowId) || seen.has(row.rowId)) continue;
    seen.add(row.rowId);
    result.push(row);
  }
  return result;
}

// A hand-entered row, normalized by the same function the sheet reader uses,
// so it cannot enter in a shape the sheet path would have rejected. The three
// fields the reader requires are required here too, with a message that names
// the missing one instead of the row silently building no board.
export function manualRow(input: Record<string, unknown>, id = `${MANUAL_ROW_PREFIX}${crypto.randomUUID()}`): LibraryRow {
  const row = normalizedRow({ ...input, rowId: id });
  if (!row.itemName) throw new Error("Give the item a name.");
  if (!row.unitType) throw new Error("Give the item a unit type; boards are built per unit type.");
  if (!row.roomLabel) throw new Error("Give the item a room; the room decides which boards it can be on.");
  return row;
}

// Pins name a board type and one of its preset slots. The lighting board has
// no preset slots to pin to — every fixture it finds is already on it — and a
// misspelt slot would silently do nothing, so both are refused here rather than
// stored.
export function validatePin(value: unknown): SlotPin {
  if (!value || typeof value !== "object") throw new Error("A pin is { collageType, slotId }.");
  const { collageType, slotId } = value as { collageType?: unknown; slotId?: unknown };
  const type = String(collageType ?? "");
  if (!(COLLAGE_TYPES as readonly string[]).includes(type)) throw new Error(`"${type}" is not a board type.`);
  if (type === "lighting_collage") {
    throw new Error("The lighting board takes every light fixture on its own; there is no slot to pin to.");
  }
  const slot = String(slotId ?? "");
  const presets = ITEM_PRESETS[type as CollageType] ?? [];
  if (!presets.some((preset) => preset.id === slot)) {
    throw new Error(`"${slot}" is not a slot on the ${type} board. Its slots are: ${presets.map((preset) => preset.id).join(", ")}.`);
  }
  return { collageType: type as CollageType, slotId: slot };
}

// The slots a row in a given room could be pinned to, for a picker: every
// preset slot of every board type the room maps to, minus the lighting board.
export function pinChoices(boardTypes: CollageType[]): { collageType: CollageType; slotId: string; role: string }[] {
  const choices: { collageType: CollageType; slotId: string; role: string }[] = [];
  for (const collageType of boardTypes) {
    if (collageType === "lighting_collage") continue;
    for (const preset of ITEM_PRESETS[collageType] ?? []) {
      choices.push({ collageType, slotId: preset.id, role: preset.role });
    }
  }
  return choices;
}
