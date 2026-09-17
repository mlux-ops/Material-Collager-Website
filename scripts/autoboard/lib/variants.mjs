// Autoboard variants: building the exact CollageRequestInput the app's
// /api/generate endpoint expects.
//
// The variant table, hero ranking and note handling moved to
// app/lib/autoboard/variants.ts so the web review board runs the same rules;
// they are re-exported below, so every existing import is unchanged. What stays
// here needs node:path's basename, whose win32 vs posix behaviour differs on
// the operator's Windows library paths (docs/autoboard-shared-core.md).

import path from "node:path";

import {
  DEFAULT_VARIANTS,
  modelNotes,
  orderedBoardItems,
  resolveHeroId,
} from "../../../app/lib/autoboard/variants.ts";

export {
  DEFAULT_VARIANTS,
  heroFor,
  modelNotes,
  orderedBoardItems,
  resolveHeroId,
} from "../../../app/lib/autoboard/variants.ts";

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
    background = "opaque",
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
    background,
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
