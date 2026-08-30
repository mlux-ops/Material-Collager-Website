// Autoboard analysis: turns normalized library rows into per-unit, per-room
// collage board definitions targeting the app's own ITEM_PRESETS slots.
// Every ambiguity (slot conflict, unmapped item, missing image) is recorded
// as a gap instead of being silently resolved.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";

import { ITEM_PRESETS } from "../../../app/lib/collage.ts";
import { csvObjects, emptyGaps, normalizeRoomLabel, roomKey } from "./source.mjs";
import { resolveTileCode } from "./tiles.mjs";

export const BOARD_KIND_LABELS = {
  kitchen_material_palette: "Material Palette",
  appliance_collage: "Appliance Collage",
  bathroom_fixture_collage: "Fixture Collage",
  bathroom_tile_collage: "Tile Collage",
};

const BOARD_KIND_SLUGS = {
  kitchen_material_palette: "material",
  appliance_collage: "appliance",
  bathroom_fixture_collage: "fixture",
  bathroom_tile_collage: "tile",
};

const KNOWN_BRANDS = [
  "LG", "Miele", "Brizo", "BLANCO", "InSinkErator", "Kohler", "AXOR", "hansgrohe",
  "GROHE", "TOTO", "Duravit", "Delta", "Westbrass", "Thermador", "Zephyr",
  "Panasonic", "Victoria + Albert", "V+A", "Rohl", "House of Rohl", "Newport Brass",
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
const SLOT_RULES = {
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
    cooktop: [{ any: [/cooktop/i, /cook top/i, /range top/i, /induction/i] }],
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

export function boardTypesForRoom(roomLabel) {
  const lower = normalizeRoomLabel(roomLabel).toLowerCase();
  if (/^kitchen$/.test(lower)) return ["kitchen_material_palette", "appliance_collage"];
  if (/^(bath\b|primary bath|powder)/.test(lower)) return ["bathroom_fixture_collage", "bathroom_tile_collage"];
  return [];
}

function ruleMatches(rule, row) {
  if (rule.cost && !row.costCode.toLowerCase().startsWith(rule.cost.toLowerCase())) return false;
  if (!rule.any.some((pattern) => pattern.test(row.itemName))) return false;
  if (rule.none?.some((pattern) => pattern.test(row.itemName))) return false;
  return true;
}

function slotMatches(collageType, slotId, row) {
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

export function extractBrand(itemName) {
  for (const brand of KNOWN_BRANDS) {
    if (itemName.toLowerCase().startsWith(brand.toLowerCase())) return brand;
  }
  return "";
}

// Assign a room's rows to a board type's preset slots, in preset order.
// The first matching row (by source order) wins a slot; other matches are
// recorded as alternates but stay available for later slots.
export function assignSlots(rows, collageType) {
  const presets = ITEM_PRESETS[collageType] ?? [];
  const assignedRowIds = new Set();
  const filled = [];
  const conflicts = [];
  for (const preset of presets) {
    const candidates = rows.filter(
      (row) => !assignedRowIds.has(row.rowId) && slotMatches(collageType, preset.id, row),
    );
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
  const unmapped = rows.filter((row) => !assignedRowIds.has(row.rowId));
  return { filled, unmapped, conflicts };
}

// ---------------------------------------------------------------------------
// Image resolution from the already-built library on disk. _BUILD_LOG.csv is
// the authoritative row_id -> folder join (the manifest's own folder_path
// column predates the actual build layout and does not match it).
// ---------------------------------------------------------------------------

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tif", ".tiff"]);

function normalizedName(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function loadBuildLog(libraryRoot) {
  const logPath = path.join(libraryRoot, "Master_Library_Build", "_BUILD_LOG.csv");
  if (!existsSync(logPath)) {
    throw new Error(`Build log not found at ${logPath}. Run build_library.py in the Master Library first.`);
  }
  const records = csvObjects(readFileSync(logPath, "utf8"));
  const byRowId = new Map();
  for (const record of records) {
    byRowId.set(String(record.row_id), {
      folder: record.folder ?? "",
      matchedFiles: (record.matched_files ?? "").split(";").map((name) => name.trim()).filter(Boolean),
    });
  }
  return byRowId;
}

export function makeDiskImageResolver(libraryRoot, buildLog = loadBuildLog(libraryRoot)) {
  return function resolveImages(rowId) {
    const entry = buildLog.get(String(rowId));
    if (!entry?.folder) return [];
    const folder = path.join(libraryRoot, ...entry.folder.split(/[\\/]/));
    if (!existsSync(folder)) return [];
    const files = readdirSync(folder).filter((name) => IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase()));
    const preferredOrder = entry.matchedFiles.map(normalizedName);
    files.sort((a, b) => {
      const aIndex = preferredOrder.indexOf(normalizedName(a));
      const bIndex = preferredOrder.indexOf(normalizedName(b));
      const aRank = aIndex === -1 ? preferredOrder.length : aIndex;
      const bRank = bIndex === -1 ? preferredOrder.length : bIndex;
      return aRank - bRank || a.localeCompare(b);
    });
    return files.map((name) => path.join(folder, name));
  };
}

// ---------------------------------------------------------------------------
// Board building
// ---------------------------------------------------------------------------

export function slugify(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// Reserve one of the model's 16 reference slots for the finalize pass's
// layout-reference draft, so a candidate board can always be finalized.
export const MAX_PRODUCT_REFERENCES = 15;

export function buildBoards(rows, options) {
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

  const roomGroups = new Map();
  for (const row of rows) {
    const key = `${row.unitType.toLowerCase()}::${row.roomLabel.toLowerCase()}`;
    if (!roomGroups.has(key)) {
      roomGroups.set(key, { unitType: row.unitType, roomLabel: row.roomLabel, rows: [] });
    }
    roomGroups.get(key).rows.push(row);
  }

  const boards = [];
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

    const mappedRowIds = new Set();
    for (const collageType of boardTypes) {
      const { filled, conflicts } = assignSlots(group.rows, collageType);
      gaps.slotConflicts.push(
        ...conflicts.map((conflict) => ({ ...conflict, unitType: group.unitType, roomLabel: group.roomLabel })),
      );

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

      const items = [];
      for (const slot of filled) {
        mappedRowIds.add(slot.row.rowId);
        const images = resolveImages(slot.row.rowId).slice(0, Math.max(1, imagesPerItem));
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
        items.push({
          slotId: slot.preset.id,
          role: slot.preset.role,
          required: slot.preset.required,
          rowId: slot.row.rowId,
          sku: slot.row.sku,
          brand: extractBrand(slot.row.itemName),
          name: slot.row.itemName.slice(0, 80),
          notes: slot.row.qty > 1 ? `quantity ${slot.row.qty}` : "",
          images,
        });
      }

      if (collageType === "bathroom_fixture_collage") {
        const assignment = tileAssignments.get(roomKey(group.unitType, group.roomLabel));
        for (const [slotId, codeField] of [["main_tile", "mainTile"], ["accent_tile", "accentTile"]]) {
          const preset = (ITEM_PRESETS[collageType] ?? []).find((entry) => entry.id === slotId);
          if (!preset) continue;
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
            required: preset.required,
            rowId: null,
            sku: tile.code,
            brand: "Elm Surfaces",
            name: tile.materialName,
            notes: "Wieland Selections Book v4 tile schedule — approved direction, quote-pending (release status HOLD). See scripts/autoboard/tile-assignments.json.",
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
        const dropped = items.pop();
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

      const kindSlug = BOARD_KIND_SLUGS[collageType];
      boards.push({
        id: `${slugify(group.unitType)}-${slugify(group.roomLabel)}-${kindSlug}`,
        unitType: group.unitType,
        roomLabel: group.roomLabel,
        collageType,
        kindLabel: BOARD_KIND_LABELS[collageType],
        title: `${group.unitType} ${group.roomLabel} ${BOARD_KIND_LABELS[collageType]}`,
        items,
      });
    }

    for (const row of group.rows) {
      if (!mappedRowIds.has(row.rowId)) {
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
