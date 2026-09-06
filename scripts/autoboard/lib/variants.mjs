// Autoboard variants: curated combinations of the generator's EXISTING art
// direction enums (composition / density / styling / lighting). No new prompt
// vocabulary is introduced — every value is one the app already validates.

import path from "node:path";

// Standing rule (user preference, 2026-08-29): always soft_daylight lighting,
// always materials_only styling. Only composition/density vary across A/B/C.
export const DEFAULT_VARIANTS = [
  { key: "A", composition: "editorial", density: "balanced", styling: "materials_only", lighting: "soft_daylight" },
  { key: "B", composition: "structured", density: "airy", styling: "materials_only", lighting: "soft_daylight" },
  { key: "C", composition: "catalog", density: "balanced", styling: "materials_only", lighting: "soft_daylight" },
];

// Which filled slot anchors the composition, ranked per board type by how
// visually substantial the product tends to be.
const HERO_RANKING = {
  kitchen_material_palette: ["faucet", "countertop", "light_fixture", "wood", "flooring", "hardware"],
  appliance_collage: ["refrigerator", "oven", "cooktop", "range_hood", "dishwasher"],
  bathroom_fixture_collage: [
    "vanity_faucet", "shower_head", "main_tile", "countertop", "light_fixture",
    "valve_trim", "vanity_wood", "cabinet_hardware",
  ],
  bathroom_tile_collage: ["wall_tile", "floor_tile", "accent_tile", "countertop", "vanity_wood", "metal_finish"],
};

export function heroFor(collageType, filledSlotIds) {
  const ranking = HERO_RANKING[collageType] ?? [];
  for (const slotId of ranking) {
    if (filledSlotIds.includes(slotId)) return slotId;
  }
  return filledSlotIds[0];
}

// board.heroItemId is a per-board override (set from the review UI) that wins
// over the ranking-based default, but only when it actually names a slot this
// board still has — an override pointing at a slot that got swapped out or
// removed silently falls back to heroFor's default rather than validating to
// nothing (validateCollageRequest requires heroItemId, when present, to name
// a real item).
function resolveHeroId(board) {
  if (typeof board.heroItemId === "string" && board.items.some((item) => item.slotId === board.heroItemId)) {
    return board.heroItemId;
  }
  return heroFor(board.collageType, board.items.map((item) => item.slotId));
}

// board.items with the hero item (see resolveHeroId) moved to the front;
// every other item keeps its relative order. boardPayload and
// boardReferenceFiles both build their (item / file) lists off of this so the
// two stay aligned position-for-position no matter which item is the hero.
export function orderedBoardItems(board) {
  const heroId = resolveHeroId(board);
  const heroIndex = board.items.findIndex((item) => item.slotId === heroId);
  if (heroIndex <= 0) return board.items;
  return [board.items[heroIndex], ...board.items.slice(0, heroIndex), ...board.items.slice(heroIndex + 1)];
}

// Legacy review-workflow bookkeeping sentences that, on old plan.json files
// predating item.provenance (see match.mjs / review-core.mjs), live inside
// item.notes itself instead of the separate provenance field. Notes reach the
// image model as "specific instruction" (buildGenerationPrompt), so these must
// never be sent — strip each one out sentence-and-all before the payload goes
// out. Matched on their distinctive phrases rather than the literal string so
// small copy edits to the sentences don't silently stop stripping old files.
const LEGACY_NOTE_PATTERNS = [
  // "Manually selected in the review UI — overrides the v4 Elm Surfaces schedule's auto-pick."
  /[^.]*\breview UI\b[^.]*\bauto-pick\b[^.]*\./gi,
  // "Wieland Selections Book v4 tile schedule — approved direction, quote-pending
  // (release status HOLD). See scripts/autoboard/tile-assignments.json."
  /[^.]*\btile schedule\b[\s\S]*?\btile-assignments\.json\b[^.]*\./gi,
];

// Strips legacy provenance sentences (see LEGACY_NOTE_PATTERNS) out of a raw
// notes string and returns the model-facing remainder, or undefined when
// nothing real is left — mirroring the `item.notes || undefined` shape the
// rest of boardPayload uses.
export function modelNotes(notes) {
  if (!notes) return undefined;
  let cleaned = String(notes);
  for (const pattern of LEGACY_NOTE_PATTERNS) {
    cleaned = cleaned.replace(pattern, " ");
  }
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  return cleaned || undefined;
}

// Build the exact CollageRequestInput the app's /api/generate endpoint
// expects. imageNames drives the server's reference count; the actual files
// are appended to the multipart form in this same item order.
//
// The economy (Batch API) endpoint takes the same payload shape but can't
// accept multipart bytes — it needs each item's images by OpenAI file id
// instead (imageFileIds) and an explicit layoutReferenceFileId string rather
// than implied multipart order. Pass `fileIdsBySlot` (Map<slotId, string[]>)
// and `layoutReferenceFileId` to get that shape instead of imageNames.
export function boardPayload(board, variant, options = {}) {
  const {
    quality = "medium",
    outputResolution = "studio",
    renderKind = "studio",
    layoutReference = false,
    layoutReferenceFileId,
    fileIdsBySlot,
    apiKey,
  } = options;

  const payload = {
    collageType: board.collageType,
    orientation: "default",
    quality,
    outputResolution,
    composition: variant.composition,
    density: variant.density,
    styling: variant.styling,
    lighting: variant.lighting,
    heroItemId: resolveHeroId(board),
    outputFilename: `${board.title} ${variant.key}.png`,
    renderKind,
    items: orderedBoardItems(board).map((item) => ({
      id: item.slotId,
      role: item.role,
      required: item.required,
      brand: item.brand || undefined,
      name: item.name || undefined,
      notes: modelNotes(item.notes),
      ...(fileIdsBySlot
        ? { imageFileIds: fileIdsBySlot.get(item.slotId) ?? [] }
        : { imageNames: item.images.map((imagePath) => `${item.slotId}--${path.basename(imagePath)}`) }),
    })),
  };
  if (layoutReference) {
    payload.layoutReference = true;
    payload.layoutReferenceMode = "approved-draft";
  }
  if (layoutReferenceFileId) payload.layoutReferenceFileId = layoutReferenceFileId;
  if (apiKey) payload.apiKey = apiKey;
  return payload;
}

// The multipart file list matching boardPayload's imageNames, in order.
export function boardReferenceFiles(board) {
  const files = [];
  for (const item of orderedBoardItems(board)) {
    for (const imagePath of item.images) {
      files.push({ path: imagePath, name: `${item.slotId}--${path.basename(imagePath)}` });
    }
  }
  return files;
}

export function variantsFromCount(count) {
  const total = Math.max(1, Math.min(DEFAULT_VARIANTS.length, Number(count) || DEFAULT_VARIANTS.length));
  return DEFAULT_VARIANTS.slice(0, total);
}
