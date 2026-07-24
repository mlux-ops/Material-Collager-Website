import type { ImportParamRule, NodeManifest } from "../types";
import { estimateGenerationCost, GENERATION_QUALITIES, GENERATION_SIZES, generationDraftOverride } from "./generation.ts";

export const MASKED_EDIT_PARAM_RULES = {
  size: { type: "enum", optional: true, values: GENERATION_SIZES },
  quality: { type: "enum", optional: true, values: GENERATION_QUALITIES },
  maskCacheKey: { type: "string", optional: true, maxLength: 256 },
  maskRegionX: { type: "number", optional: true, min: 0, max: 1000 },
  maskRegionY: { type: "number", optional: true, min: 0, max: 1000 },
  maskRegionWidth: { type: "number", optional: true, min: 0, max: 1000 },
  maskRegionHeight: { type: "number", optional: true, min: 0, max: 1000 },
} satisfies Record<string, ImportParamRule>;

// Rectangle/region-selection mask modal (freehand deferred), touch/stylus
// capable. Composites protected pixels back client-side using the extracted
// selective-edit compositor (app/lib/selective-edit.ts). Masking is guidance,
// not pixel-exact. PAID edit-shaped node: mask geometry + input image key +
// prompt + size/quality all feed the memoization signature. The DOM-touching
// execute wrapper (mask canvas, PNG <4MB upload, compositing) lives in
// maskedEdit.tsx.
export const maskedEditManifest: NodeManifest = {
  kind: "maskedEdit",
  spec: {
    kind: "maskedEdit",
    title: "Masked Edit",
    description: "Edit only a selected region; the rest is protected (guidance, not pixel-exact).",
    inputs: [
      { id: "image", kind: "image", label: "Image", required: true },
      { id: "prompt", kind: "text", label: "Prompt", required: true },
    ],
    outputs: [{ id: "image", kind: "image", label: "Image" }],
    paid: true,
  },
  defaultParams: { size: "1536x1024", quality: "medium", candidates: 1, maskCacheKey: "" },
  importSchema: {
    paramKeys: { ...MASKED_EDIT_PARAM_RULES },
    sourceBlobKeys: ["maskCacheKey"],
  },
  estimateCost: estimateGenerationCost,
  paid: true,
  draftOverride: generationDraftOverride,
  // The region (maskRegionX/Y/Width/Height) drives the memoization signature
  // like every other param here — an unchanged region+prompt+size/quality is
  // a cache hit; moving the rectangle produces a different signature.
  persistBlobKeys: (_nodeId, params) => (params.maskCacheKey ? [params.maskCacheKey] : []),
};
