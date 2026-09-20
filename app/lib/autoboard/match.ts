// Autoboard analysis: turns normalized library rows into per-unit, per-room
// collage board definitions targeting the app's own ITEM_PRESETS slots.
// Every ambiguity (slot conflict, unmapped item, missing image) is recorded
// as a gap instead of being silently resolved.
//
// This is the shared core: the CLI (scripts/autoboard/lib/match.mjs, which
// re-exports everything here) and the web review board run the SAME rules, so
// a board built in the browser and a board built on the operator's machine
// agree by construction rather than by two implementations staying in sync.
//
// Image resolution is NOT here. buildBoards takes a `resolveImages` function
// injected by its caller: the CLI passes a filesystem reader, and the web side
// passes a lookup over images it has already fetched. The contract is
// SYNCHRONOUS — buildBoards consumes the returned array immediately and has no
// await anywhere — so an async caller must pre-resolve into a Map first and
// pass `(rowId) => map.get(rowId) ?? []`.

import { ITEM_PRESETS } from "../collage.ts";
import { emptyGaps, normalizeRoomLabel, roomKey } from "./source.ts";
import { resolveTileCode } from "./tiles.ts";
import type {
  Board,
  BoardItem,
  BuildBoardsOptions,
  CollageType,
  Gaps,
  LibraryRow,
  SlotAssignment,
  SlotConflict,
  SubstituteRecord,
} from "./types.ts";

export const BOARD_KIND_LABELS: Record<CollageType, string> = {
  kitchen_material_palette: "Material Palette",
  appliance_collage: "Appliance Collage",
  bathroom_fixture_collage: "Fixture Collage",
  bathroom_tile_collage: "Tile Collage",
};

const BOARD_KIND_SLUGS: Record<CollageType, string> = {
  kitchen_material_palette: "material",
  appliance_collage: "appliance",
  bathroom_fixture_collage: "fixture",
  bathroom_tile_collage: "tile",
};

// Canonical on-brand display casing. Smartsheet item names mix ALL CAPS, all
// lower, and Title Case for the same manufacturer, so matching below is
// case-insensitive — but the string returned always uses the brand's own
// styling (e.g. "Hansgrohe", not the sheet's literal casing) so prompts don't
// read like "hansgrohe" sitting next to "Elm Surfaces".
const KNOWN_BRANDS = [
  "LG", "Miele", "Brizo", "BLANCO", "InSinkErator", "Kohler", "AXOR", "Hansgrohe",
  "GROHE", "TOTO", "Duravit", "Delta", "Westbrass", "Thermador", "Zephyr",
  "Panasonic", "Victoria + Albert", "V+A", "Rohl", "House of Rohl", "Newport Brass",
  "Emtek",
];

// Rows matching any of these never belong on a presentation board, regardless
// of slot (concealed/rough parts and sanitaryware were also removed from the
// human-built deck per the handoff doc §7).
const GLOBAL_EXCLUSIONS = [
  /\brough[\s-]?in\b/i,
  /\btoilet\b/i,
  /\bwater closet\b/i,
  /\bflush lever\b/i,
  /\bdrain\b/i,
  /\bwaste\b/i,
  /\bsupply\b/i,
  /\bexhaust fan\b/i,
];

// Slot rules: each preset slot id maps to an array of alternative rules; a row
// matches a slot when ANY rule matches. A rule matches when the cost code
// starts with `cost` (if given), at least one `any` pattern hits the item
// name, and no `none` pattern hits it.
const SLOT_RULES: Record<CollageType, Record<string, SlotRule[]>> = {
  kitchen_material_palette: {
    wood: [{ any: [/\bcabinet\b/i, /wood (?:sample|panel)/i] }],
    countertop: [{ any: [/countertop/i, /counter top/i, /quartz/i, /\bslab\b/i] }],
    faucet: [{ cost: "11 45", any: [/faucet/i, /pot filler/i], none: [/shower/i, /\btub\b/i, /valve/i] }],
    hardware: [{ cost: "09 00", any: [/\bpull\b/i, /\bknob\b/i, /handle/i] }],
    light_fixture: [
      { cost: "26 51", any: [/./] },
      { any: [/pendant/i, /chandelier/i, /sconce/i, /\blight\b/i] },
    ],
    flooring: [{ any: [/floor/i] }],
  },
  appliance_collage: {
    refrigerator: [{ any: [/refrigerator/i, /\bfridge\b/i] }],
    // A pro range is the kitchen's cooking appliance, so it takes the cooktop
    // slot. `none` keeps the range HOOD out of it: "Zephyr Monsoon II 48 Hood
    // Insert" and "range hood" both contain "range" for a regex, and the hood
    // has its own slot two lines down.
    cooktop: [
      { any: [/cooktop/i, /cook top/i, /range top/i, /induction/i] },
      { any: [/\brange\b/i], none: [/hood/i, /microwave/i] },
    ],
    range_hood: [{ any: [/\bhood\b/i] }],
    oven: [{ any: [/\boven\b/i] }],
    dishwasher: [{ any: [/dishwasher/i] }],
  },
  bathroom_fixture_collage: {
    vanity_faucet: [{ cost: "11 45", any: [/faucet/i, /lavatory/i], none: [/\btub\b/i, /shower/i, /kitchen/i] }],
    shower_head: [{ any: [/shower\s?head/i, /showerhead/i, /rain\s?head/i, /raincan/i] }],
    valve_trim: [{ any: [/valve trim/i, /shower trim/i, /trim kit/i, /thermostatic/i, /pressure balance/i, /diverter trim/i] }],
    cabinet_hardware: [{ cost: "09 00", any: [/\bpull\b/i, /\bknob\b/i] }],
    light_fixture: [
      { cost: "26 51", any: [/./] },
      { any: [/sconce/i, /vanity light/i, /pendant/i, /\blight\b/i] },
    ],
    vanity_wood: [{ any: [/vanity/i], none: [/faucet/i, /light/i, /top/i] }],
    main_tile: [{ any: [/tile/i], none: [/accent/i, /mosaic/i] }],
    // Deliberately narrower than the tile board's accent rule (/accent/i,
    // /mosaic/i): on a FIXTURE board this competes with the tile-assignment
    // path below, so it only claims a row that names itself a tile. A
    // library whose tiles are photos rather than rows (Wieland) still gets
    // its accent from tile-assignments.json exactly as before.
    accent_tile: [{ any: [/accent tile/i, /mosaic tile/i] }],
    countertop: [{ any: [/countertop/i, /counter top/i, /quartz/i, /marble/i, /granite/i] }],
  },
  bathroom_tile_collage: {
    wall_tile: [{ any: [/wall tile/i, /\bWT\d/] }],
    floor_tile: [{ any: [/floor tile/i, /\bFT\d/] }],
    accent_tile: [{ any: [/accent/i, /mosaic/i, /\bAT\d/] }],
    vanity_wood: [{ any: [/vanity/i], none: [/faucet/i, /light/i, /top/i] }],
    countertop: [{ any: [/countertop/i, /counter top/i, /quartz/i, /marble/i, /granite/i] }],
    metal_finish: [{ any: [/metal finish/i, /finish sample/i] }],
  },
};

// Tile boards only exist when the room actually specifies a tile scheme.
const TILE_GATE_SLOTS = ["wall_tile", "floor_tile", "accent_tile"];

export function boardTypesForRoom(roomLabel: unknown): CollageType[] {
  const lower = normalizeRoomLabel(roomLabel).toLowerCase();
  if (/^kitchen$/.test(lower)) return ["kitchen_material_palette", "appliance_collage"];
  if (/^(bath\b|primary bath|secondary bath|powder)/.test(lower)) return ["bathroom_fixture_collage", "bathroom_tile_collage"];
  return [];
}

type SlotRule = { cost?: string; any: RegExp[]; none?: RegExp[] };

function ruleMatches(rule: SlotRule, row: LibraryRow): boolean {
  if (rule.cost && !row.costCode.toLowerCase().startsWith(rule.cost.toLowerCase())) return false;
  if (!rule.any.some((pattern) => pattern.test(row.itemName))) return false;
  if (rule.none?.some((pattern) => pattern.test(row.itemName))) return false;
  return true;
}

function slotMatches(collageType: CollageType, slotId: string, row: LibraryRow): boolean {
  // Exclusions describe what the item IS, not what it ships with or without —
  // so strip trailing "with ..." accessory clauses ("Faucet with Pop-Up
  // Drain" is a faucet) and "Less ..." omission clauses ("Faucet - Less
  // Drain Assembly" is still a faucet, sold without one; "Linear Shower
  // Drain" with neither clause is a real drain).
  const coreName = row.itemName.replace(/\bwith\b.*$/i, "").replace(/\bless\b.*$/i, "");
  if (GLOBAL_EXCLUSIONS.some((pattern) => pattern.test(coreName))) return false;
  const rules = SLOT_RULES[collageType]?.[slotId] ?? [];
  return rules.some((rule) => ruleMatches(rule, row));
}

export function extractBrand(itemName: string): string {
  const lowerName = itemName.toLowerCase();
  for (const brand of KNOWN_BRANDS) {
    if (lowerName.startsWith(brand.toLowerCase())) return brand;
  }
  return "";
}

// Smartsheet's good/better/best alternates are typed as a prefix on the item
// name itself, e.g. "-Better- option - Duo Pendant". That prefix is bookkeeping
// for the sheet, not part of the product's name, so split it off: the tier
// (lowercased) goes on item.tier and the rest becomes the actual name.
const TIER_PREFIX_PATTERN = /^\s*-\s*(Good|Better|Best)\s*-\s*option\s*-\s*/i;

export function extractTier(itemName: string): { name: string; tier: string | undefined } {
  const match = TIER_PREFIX_PATTERN.exec(itemName);
  if (!match) return { name: itemName, tier: undefined };
  return { name: itemName.slice(match[0].length), tier: match[1].toLowerCase() };
}

// A row a project marked as a substitute for another row (source.mjs's
// normalizedStatus). It may never win a slot automatically: an alternative
// replaces the preferred product only when a person decides it does, and a
// substitute that slips into a slot silently renders a material nobody chose.
// Measured on 651 Belmont: with the rows named as the recommendations document
// names them the regexes fill 28 of 30 slots correctly, but reword each row the
// way another person would write the same schedule line and 7 of the 13 lost
// slots go to an alternative rather than going empty — a wrong board with a
// clean gaps.md (artifacts/typesafe-experiments/RESULTS.md, arm 3). The review
// UI still lists these rows for manual selection; only auto-assignment skips
// them.
const SUBSTITUTE_STATUS = "alternative";

export function isSubstitute(row: LibraryRow): boolean {
  return row.status === SUBSTITUTE_STATUS;
}

// Assign a room's rows to a board type's preset slots, in preset order.
// The first matching row (by source order) wins a slot; other matches are
// recorded as alternates but stay available for later slots. Substitutes are
// held back and returned separately, so a caller can report which slot each one
// was kept out of.
export function assignSlots(
  rows: LibraryRow[],
  collageType: CollageType,
): { filled: SlotAssignment[]; unmapped: LibraryRow[]; conflicts: SlotConflict[]; substitutes: SubstituteRecord[] } {
  const presets = ITEM_PRESETS[collageType] ?? [];
  const assignedRowIds = new Set<string>();
  const filled: SlotAssignment[] = [];
  const conflicts: SlotConflict[] = [];
  const substitutes: SubstituteRecord[] = [];
  const heldBack = new Set<string>();
  for (const preset of presets) {
    const candidates: LibraryRow[] = [];
    for (const row of rows) {
      if (assignedRowIds.has(row.rowId) || !slotMatches(collageType, preset.id, row)) continue;
      if (isSubstitute(row)) {
        substitutes.push({ slotId: preset.id, collageType, rowId: row.rowId, itemName: row.itemName, sku: row.sku });
        heldBack.add(row.rowId);
        continue;
      }
      candidates.push(row);
    }
    if (!candidates.length) continue;
    const [winner, ...alternates] = candidates;
    assignedRowIds.add(winner.rowId);
    filled.push({ preset, row: winner, alternates });
    if (alternates.length) {
      conflicts.push({
        slotId: preset.id,
        collageType,
        picked: { rowId: winner.rowId, itemName: winner.itemName },
        alternates: alternates.map((row) => ({ rowId: row.rowId, itemName: row.itemName })),
      });
    }
  }
  // A held-back substitute is reported as a substitute, not as an unmapped
  // row, so each row shows up in exactly one section of gaps.md. One that
  // matched no slot at all stays unmapped like any other row.
  const unmapped = rows.filter((row) => !assignedRowIds.has(row.rowId) && !heldBack.has(row.rowId));
  return { filled, unmapped, conflicts, substitutes };
}

// ---------------------------------------------------------------------------
// Board building
// ---------------------------------------------------------------------------

// The board's stable identity. Shared so the preview the web review board
// stores and the board the pipeline later builds carry the same id — a preview
// whose id drifted from its board would orphan every note and selection made
// against it.
export function boardIdFor(unitType: string, roomLabel: string, collageType: CollageType): string {
  return `${slugify(unitType)}-${slugify(roomLabel)}-${BOARD_KIND_SLUGS[collageType]}`;
}

export function slugify(value: unknown): string {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// Reserve one of the model's 16 reference slots for the finalize pass's
// layout-reference draft, so a candidate board can always be finalized.
export const MAX_PRODUCT_REFERENCES = 15;

export type RoomGroup = { unitType: string; roomLabel: string; rows: LibraryRow[] };

// Groups rows into the (unit type, room) buckets a board is built for.
//
// The key is the raw lowercased pair, NOT roomKey() — roomKey normalizes the
// room label a second time, and the two disagree for any label the aliases
// touch. Rows arrive already normalized by source.ts, so this preserves the
// grouping buildBoards has always done; swapping in roomKey here would merge
// rooms that are currently separate.
export function groupRowsByRoom(rows: LibraryRow[]): Map<string, RoomGroup> {
  const roomGroups = new Map<string, RoomGroup>();
  for (const row of rows) {
    const key = `${row.unitType.toLowerCase()}::${row.roomLabel.toLowerCase()}`;
    if (!roomGroups.has(key)) {
      roomGroups.set(key, { unitType: row.unitType, roomLabel: row.roomLabel, rows: [] });
    }
    roomGroups.get(key)!.rows.push(row);
  }
  return roomGroups;
}

export function buildBoards(rows: LibraryRow[], options: BuildBoardsOptions): { boards: Board[]; gaps: Gaps } {
  const {
    resolveImages,
    imagesPerItem = 1,
    minSlots = 2,
    gaps = emptyGaps(),
    // Tiles have no Smartsheet rows at all (no "tile" cost code exists in this
    // library), so main_tile/accent_tile can never come from assignSlots.
    // These two options are the only source for them: a hand-editable
    // room -> tile-code map (see scripts/autoboard/tile-assignments.json,
    // PROVISIONAL picks only) and the real photo index built by tiles.mjs.
    // Both default to empty so callers that omit them (including existing
    // tests) get identical behavior to before tiles existed: an unfilled-slot
    // gap, never a guess.
    tileAssignments = new Map(),
    tileIndex = new Map(),
  } = options;

  const roomGroups = groupRowsByRoom(rows);

  const boards: Board[] = [];
  for (const group of roomGroups.values()) {
    const boardTypes = boardTypesForRoom(group.roomLabel);
    if (!boardTypes.length) {
      gaps.skippedRooms.push({
        unitType: group.unitType,
        roomLabel: group.roomLabel,
        itemCount: group.rows.length,
        reason: "no board type maps to this room",
      });
      continue;
    }

    const mappedRowIds = new Set<string>();
    // Held back from a slot on at least one of this room's boards. Reported as
    // a substitute below, so the unmapped sweep at the end of this loop leaves
    // it alone and no row appears in two sections of gaps.md.
    const heldBackRowIds = new Set<string>();
    for (const collageType of boardTypes) {
      const { filled, conflicts, substitutes } = assignSlots(group.rows, collageType);
      gaps.slotConflicts.push(
        ...conflicts.map((conflict) => ({ ...conflict, unitType: group.unitType, roomLabel: group.roomLabel })),
      );
      gaps.substituteCandidates?.push(
        ...substitutes.map((substitute) => ({ ...substitute, unitType: group.unitType, roomLabel: group.roomLabel })),
      );
      for (const substitute of substitutes) heldBackRowIds.add(substitute.rowId);

      if (collageType === "bathroom_tile_collage") {
        const tileSlots = filled.filter((slot) => TILE_GATE_SLOTS.includes(slot.preset.id)).length;
        if (tileSlots < TILE_GATE_SLOTS.length) {
          if (filled.length) {
            gaps.skippedBoards.push({
              unitType: group.unitType,
              roomLabel: group.roomLabel,
              collageType,
              reason: `tile board needs all of [${TILE_GATE_SLOTS.join(", ")}]; found ${tileSlots}`,
            });
          }
          continue;
        }
      }

      const items: BoardItem[] = [];
      for (const slot of filled) {
        mappedRowIds.add(slot.row.rowId);
        const images = resolveImages(slot.row.rowId, slot.row.sku).slice(0, Math.max(1, imagesPerItem));
        if (!images.length) {
          gaps.imagelessItems.push({
            unitType: group.unitType,
            roomLabel: group.roomLabel,
            collageType,
            slotId: slot.preset.id,
            rowId: slot.row.rowId,
            itemName: slot.row.itemName,
            sku: slot.row.sku,
          });
          continue;
        }
        const { name, tier } = extractTier(slot.row.itemName);
        const item: BoardItem = {
          slotId: slot.preset.id,
          role: slot.preset.role,
          // CollageItemInput types `required` as optional; every ITEM_PRESETS
          // entry sets it. The assertion is erased at runtime, so this writes
          // the preset's own value unchanged — `?? false` would not.
          required: slot.preset.required!,
          rowId: slot.row.rowId,
          sku: slot.row.sku,
          brand: extractBrand(name),
          name,
          notes: slot.row.qty > 1 ? `quantity ${slot.row.qty}` : "",
          images,
        };
        if (tier) item.tier = tier;
        items.push(item);
      }

      if (collageType === "bathroom_fixture_collage") {
        const assignment = tileAssignments.get(roomKey(group.unitType, group.roomLabel));
        for (const [slotId, codeField] of [["main_tile", "mainTile"], ["accent_tile", "accentTile"]] as const) {
          const preset = (ITEM_PRESETS[collageType] ?? []).find((entry) => entry.id === slotId);
          if (!preset) continue;
          // A library that carries its tiles as real rows (see
          // scripts/autoboard/projects/) has already filled this slot through
          // assignSlots; adding the assignment's tile on top would put two
          // items on the same slot id and the app's validator rejects that.
          if (items.some((item) => item.slotId === slotId)) continue;
          const code = assignment?.[codeField];
          // No push here for a missing assignment — the generic unfilled-slot
          // loop below already reports every preset absent from `items`,
          // required or not (see e.g. light_fixture), so adding one here
          // would just duplicate that line with different wording.
          if (!code) continue;
          const tile = resolveTileCode(tileIndex, code);
          if (!tile) {
            gaps.imagelessItems.push({
              unitType: group.unitType,
              roomLabel: group.roomLabel,
              collageType,
              slotId,
              rowId: null,
              itemName: `tile code "${code}"`,
              sku: code,
            });
            continue;
          }
          items.push({
            slotId,
            role: preset.role,
            required: preset.required!,
            rowId: null,
            sku: tile.code,
            brand: "Elm Surfaces",
            name: tile.materialName,
            notes: "",
            // Bookkeeping for the human reviewer, not a model-facing instruction —
            // kept off item.notes so it never reaches buildGenerationPrompt (see
            // variants.mjs boardPayload, which sends only notes).
            provenance:
              "Wieland Selections Book v4 tile schedule — approved direction, quote-pending (release status HOLD). See scripts/autoboard/tile-assignments.json.",
            images: [tile.filePath],
          });
        }
      }

      // Enforce the shared reference cap by trimming extra supporting views
      // first, then dropping trailing optional-slot items if still over.
      let totalImages = items.reduce((sum, item) => sum + item.images.length, 0);
      for (const item of items) {
        while (totalImages > MAX_PRODUCT_REFERENCES && item.images.length > 1) {
          item.images.pop();
          totalImages--;
        }
      }
      while (totalImages > MAX_PRODUCT_REFERENCES && items.length) {
        const dropped = items.pop()!;
        totalImages -= dropped.images.length;
        gaps.unfilledSlots.push({
          unitType: group.unitType,
          roomLabel: group.roomLabel,
          collageType,
          slotId: dropped.slotId,
          reason: "dropped to stay under the 16-reference cap",
        });
      }

      const presets = ITEM_PRESETS[collageType] ?? [];
      const filledIds = new Set(items.map((item) => item.slotId));
      for (const preset of presets) {
        if (!filledIds.has(preset.id)) {
          gaps.unfilledSlots.push({
            unitType: group.unitType,
            roomLabel: group.roomLabel,
            collageType,
            slotId: preset.id,
            reason: "no library item matched this slot",
          });
        }
      }

      if (items.length < minSlots) {
        if (items.length) {
          gaps.skippedBoards.push({
            unitType: group.unitType,
            roomLabel: group.roomLabel,
            collageType,
            reason: `only ${items.length} slot(s) filled; minimum is ${minSlots}`,
          });
        }
        continue;
      }

      boards.push({
        id: boardIdFor(group.unitType, group.roomLabel, collageType),
        unitType: group.unitType,
        roomLabel: group.roomLabel,
        collageType,
        kindLabel: BOARD_KIND_LABELS[collageType],
        title: `${group.unitType} ${group.roomLabel} ${BOARD_KIND_LABELS[collageType]}`,
        items,
      });
    }

    for (const row of group.rows) {
      if (!mappedRowIds.has(row.rowId) && !heldBackRowIds.has(row.rowId)) {
        gaps.unmappedItems.push({
          unitType: group.unitType,
          roomLabel: group.roomLabel,
          rowId: row.rowId,
          itemName: row.itemName,
          sku: row.sku,
          costCode: row.costCode,
        });
      }
    }
  }

  boards.sort((a, b) => a.id.localeCompare(b.id));
  return { boards, gaps };
}

// Twin-unit room merging: some rooms in one unit type have selections
// identical to a room in another unit type, and the client wants a single
// board (labeled with both rooms) instead of two near-duplicate boards.
// Pure function — no I/O, no mutation of gaps beyond the passed-in object.
export type MergeRule = { keep: string; merge: string[] };

export function applyBoardMerges(boards: Board[], gaps: Gaps, merges?: MergeRule[]): Board[] {
  if (!merges || !merges.length) return boards;

  const boardsByKey = new Map<string, Board[]>();
  for (const board of boards) {
    const key = roomKey(board.unitType, board.roomLabel);
    if (!boardsByKey.has(key)) boardsByKey.set(key, []);
    boardsByKey.get(key)!.push(board);
  }

  const capitalize = (word: string) => (word ? word[0].toUpperCase() + word.slice(1) : word);

  function displayLabel(mergeKey: string, mergeBoard: Board | undefined): string {
    if (mergeBoard) return `${mergeBoard.unitType} ${mergeBoard.roomLabel}`;
    const [unit, room] = mergeKey.split("::");
    return `${unit.split(" ").map(capitalize).join(" ")} ${room.split(" ").map(capitalize).join(" ")}`;
  }

  const toRemove = new Set<string>();

  for (const rule of merges) {
    const keepBoards = boardsByKey.get(rule.keep) ?? [];
    const keepByType = new Map(keepBoards.map((board) => [board.collageType, board]));

    for (const mergeKey of rule.merge) {
      const mergeBoardsForKey = boardsByKey.get(mergeKey) ?? [];
      const mergeByType = new Map(mergeBoardsForKey.map((board) => [board.collageType, board]));

      for (const [collageType, keptBoard] of keepByType) {
        const mergeBoard = mergeByType.get(collageType);
        const alias = displayLabel(mergeKey, mergeBoard);
        keptBoard.aliases = keptBoard.aliases ? [...keptBoard.aliases, alias] : [alias];
        if (mergeBoard) {
          toRemove.add(mergeBoard.id);
          gaps.mergedBoards.push({
            unitType: mergeBoard.unitType,
            roomLabel: mergeBoard.roomLabel,
            collageType,
            mergedInto: keptBoard.id,
          });
        }
      }

      for (const [collageType, mergeBoard] of mergeByType) {
        if (!keepByType.has(collageType)) {
          gaps.mergedBoards.push({
            unitType: mergeBoard.unitType,
            roomLabel: mergeBoard.roomLabel,
            collageType,
            mergedInto: null,
            reason: `kept room has no ${collageType} board`,
          });
        }
      }
    }
  }

  for (const board of boards) {
    if (board.aliases && board.aliases.length) {
      const aliasPart = board.aliases.map((alias) => `/ ${alias}`).join(" ");
      board.title = `${board.unitType} ${board.roomLabel} ${aliasPart} ${board.kindLabel}`;
    }
  }

  return boards.filter((board) => !toRemove.has(board.id));
}
