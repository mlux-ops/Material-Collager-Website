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
    heroItemId: heroFor(board.collageType, board.items.map((item) => item.slotId)),
    outputFilename: `${board.title} ${variant.key}.png`,
    renderKind,
    items: board.items.map((item) => ({
      id: item.slotId,
      role: item.role,
      required: item.required,
      brand: item.brand || undefined,
      name: item.name || undefined,
      notes: item.notes || undefined,
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
  for (const item of board.items) {
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
