// What the sheet's rows map to, BEFORE any reference photo exists.
//
// buildBoards cannot run without images: an item whose resolver returns nothing
// is recorded as a gap and dropped, so a board built from a freshly-read sheet
// would come back empty. The web flow therefore has a step the CLI never
// needed — read the sheet, see what each slot matched, then go gather photos
// for exactly those rows. That is this module.
//
// It runs the SAME rules as buildBoards (groupRowsByRoom -> boardTypesForRoom ->
// assignSlots) and mints ids with the same boardIdFor, so a preview's board and
// the board finally built from it are the same board. Nothing here decides
// anything buildBoards would decide differently; it just stops before images.

import { ITEM_PRESETS } from "../collage.ts";
import {
  BOARD_KIND_LABELS,
  LIGHTING_SCOPE_LABEL,
  assignSlots,
  boardIdFor,
  boardTypesForRoom,
  extractBrand,
  extractTier,
  groupRowsByRoom,
  groupRowsByUnit,
  lightingFixtures,
} from "./match.ts";
import type { CollageType, LibraryRow, SlotConflict, SlotPin, SubstituteRecord } from "./types.ts";

export type PreviewSlot = {
  slotId: string;
  role: string;
  required: boolean;
  rowId: string;
  itemName: string;
  name: string;
  brand: string;
  sku: string;
  qty: number;
  reference: string;
  tier?: string;
  /** Set when a person pinned this row to this slot (see SlotPin). */
  pinned?: boolean;
};

export type PreviewOptions = { pins?: Map<string, SlotPin> };

export type PreviewBoard = {
  id: string;
  unitType: string;
  roomLabel: string;
  collageType: CollageType;
  kindLabel: string;
  title: string;
  slots: PreviewSlot[];
  unfilledSlots: { slotId: string; role: string; required: boolean }[];
};

export type RoomScope = { unitType: string; roomLabel: string };

export type BoardsPreview = {
  boards: PreviewBoard[];
  rooms: RoomScope[];
  substitutes: (SubstituteRecord & RoomScope)[];
  conflicts: (SlotConflict & RoomScope)[];
  unmapped: (RoomScope & { rowId: string; itemName: string; sku: string; costCode: string })[];
  skippedRooms: (RoomScope & { itemCount: number })[];
};

export function previewBoards(rows: LibraryRow[], options: PreviewOptions = {}): BoardsPreview {
  const { pins } = options;
  const preview: BoardsPreview = {
    boards: [],
    rooms: [],
    substitutes: [],
    conflicts: [],
    unmapped: [],
    skippedRooms: [],
  };

  // The unit-wide lighting boards, first, for the same reason buildBoards
  // builds them first: the room pass leaves the rows they account for out of
  // its unmapped and skipped-room reports. A lighting preview with no fixture
  // at all is omitted rather than shown empty — unlike a room board, whose
  // empty preview says something about that room, an empty lighting board
  // would repeat for every unit type in the sheet.
  const lightingRowIds = new Set<string>();
  for (const unit of groupRowsByUnit(rows).values()) {
    const { fixtures, substitutes } = lightingFixtures(unit.rows);
    preview.substitutes.push(
      ...substitutes.map((row) => ({
        slotId: "light_fixture",
        collageType: "lighting_collage" as CollageType,
        rowId: row.rowId,
        itemName: row.itemName,
        sku: row.sku,
        unitType: unit.unitType,
        roomLabel: row.roomLabel,
      })),
    );
    for (const row of substitutes) lightingRowIds.add(row.rowId);
    if (!fixtures.length) continue;

    const scope: RoomScope = { unitType: unit.unitType, roomLabel: LIGHTING_SCOPE_LABEL };
    preview.rooms.push(scope);
    const slots: PreviewSlot[] = fixtures.map((fixture) => {
      lightingRowIds.add(fixture.row.rowId);
      const { name, tier } = extractTier(fixture.row.itemName);
      const entry: PreviewSlot = {
        slotId: fixture.slotId,
        role: fixture.role,
        required: true,
        rowId: fixture.row.rowId,
        itemName: fixture.row.itemName,
        name,
        brand: extractBrand(name),
        sku: fixture.row.sku,
        qty: fixture.row.qty,
        reference: fixture.row.reference,
      };
      if (tier) entry.tier = tier;
      return entry;
    });
    preview.boards.push({
      id: boardIdFor(unit.unitType, LIGHTING_SCOPE_LABEL, "lighting_collage"),
      ...scope,
      collageType: "lighting_collage",
      kindLabel: BOARD_KIND_LABELS.lighting_collage,
      title: `${unit.unitType} ${BOARD_KIND_LABELS.lighting_collage}`,
      slots,
      // Every fixture found is on the board; there is no roster left unfilled.
      unfilledSlots: [],
    });
  }

  for (const group of groupRowsByRoom(rows).values()) {
    const scope: RoomScope = { unitType: group.unitType, roomLabel: group.roomLabel };
    const boardTypes = boardTypesForRoom(group.roomLabel);
    if (!boardTypes.length) {
      const stranded = group.rows.filter((row) => !lightingRowIds.has(row.rowId));
      if (stranded.length) preview.skippedRooms.push({ ...scope, itemCount: stranded.length });
      continue;
    }
    preview.rooms.push(scope);

    const mappedRowIds = new Set<string>();
    const heldBackRowIds = new Set<string>();

    for (const collageType of boardTypes) {
      const { filled, conflicts, substitutes } = assignSlots(group.rows, collageType, pins);
      preview.conflicts.push(...conflicts.map((conflict) => ({ ...conflict, ...scope })));
      preview.substitutes.push(...substitutes.map((substitute) => ({ ...substitute, ...scope })));
      for (const substitute of substitutes) heldBackRowIds.add(substitute.rowId);

      const slots: PreviewSlot[] = [];
      for (const slot of filled) {
        mappedRowIds.add(slot.row.rowId);
        const { name, tier } = extractTier(slot.row.itemName);
        const entry: PreviewSlot = {
          slotId: slot.preset.id,
          role: slot.preset.role,
          required: slot.preset.required!,
          rowId: slot.row.rowId,
          itemName: slot.row.itemName,
          name,
          brand: extractBrand(name),
          sku: slot.row.sku,
          qty: slot.row.qty,
          reference: slot.row.reference,
        };
        if (tier) entry.tier = tier;
        const pin = pins?.get(slot.row.rowId);
        if (pin && pin.collageType === collageType && pin.slotId === slot.preset.id) entry.pinned = true;
        slots.push(entry);
      }

      // Unlike buildBoards, an empty board is kept rather than dropped: the
      // point of a preview is to show that a room produced nothing, and the
      // minSlots / tile-gate decisions belong to the build, once photos exist.
      const filledIds = new Set(slots.map((entry) => entry.slotId));
      preview.boards.push({
        id: boardIdFor(group.unitType, group.roomLabel, collageType),
        ...scope,
        collageType,
        kindLabel: BOARD_KIND_LABELS[collageType],
        title: `${group.unitType} ${group.roomLabel} ${BOARD_KIND_LABELS[collageType]}`,
        slots,
        unfilledSlots: (ITEM_PRESETS[collageType] ?? [])
          .filter((preset) => !filledIds.has(preset.id))
          .map((preset) => ({ slotId: preset.id, role: preset.role, required: preset.required! })),
      });
    }

    for (const row of group.rows) {
      if (!mappedRowIds.has(row.rowId) && !heldBackRowIds.has(row.rowId) && !lightingRowIds.has(row.rowId)) {
        preview.unmapped.push({
          ...scope,
          rowId: row.rowId,
          itemName: row.itemName,
          sku: row.sku,
          costCode: row.costCode,
        });
      }
    }
  }

  preview.boards.sort((a, b) => a.id.localeCompare(b.id));
  return preview;
}

// The distinct values a person picks from when narrowing a sheet to the
// subsection they want a board for. Counted over the rows as read, so a unit
// type with no board-mapped room still shows up — with a count that explains
// why choosing it yields nothing.
export type SheetFacets = {
  unitTypes: { value: string; rowCount: number }[];
  rooms: { value: string; rowCount: number; unitTypes: string[] }[];
};

export function sheetFacets(rows: LibraryRow[]): SheetFacets {
  const unitTypes = new Map<string, number>();
  const rooms = new Map<string, { rowCount: number; unitTypes: Set<string> }>();
  for (const row of rows) {
    unitTypes.set(row.unitType, (unitTypes.get(row.unitType) ?? 0) + 1);
    const room = rooms.get(row.roomLabel) ?? { rowCount: 0, unitTypes: new Set<string>() };
    room.rowCount += 1;
    room.unitTypes.add(row.unitType);
    rooms.set(row.roomLabel, room);
  }
  const byValue = (a: { value: string }, b: { value: string }) => a.value.localeCompare(b.value);
  return {
    unitTypes: [...unitTypes].map(([value, rowCount]) => ({ value, rowCount })).sort(byValue),
    rooms: [...rooms]
      .map(([value, entry]) => ({
        value,
        rowCount: entry.rowCount,
        unitTypes: [...entry.unitTypes].sort(),
      }))
      .sort(byValue),
  };
}

export type SubsectionFilter = { unitTypes?: string[]; rooms?: string[] };

// Empty or absent means "everything", so a project built with no filter is the
// whole sheet rather than nothing.
export function filterRows(rows: LibraryRow[], filter: SubsectionFilter): LibraryRow[] {
  const unitTypes = new Set((filter.unitTypes ?? []).map((value) => value.toLowerCase()));
  const rooms = new Set((filter.rooms ?? []).map((value) => value.toLowerCase()));
  return rows.filter((row) => {
    if (unitTypes.size && !unitTypes.has(row.unitType.toLowerCase())) return false;
    if (rooms.size && !rooms.has(row.roomLabel.toLowerCase())) return false;
    return true;
  });
}
