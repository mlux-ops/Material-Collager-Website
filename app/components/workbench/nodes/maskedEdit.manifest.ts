import type { ImportParamRule, NodeManifest } from "../types";
import { estimateGenerationCost, GENERATION_QUALITIES, GENERATION_SIZES, generationDraftOverride } from "./generation.ts";

// Backend engines: "gpt-image" posts to /api/workbench/edit (gpt-image-2,
// mask is guidance, paid per image); "workers-ai" posts to
// /api/workbench/inpaint (SD 1.5 mask-conditioned inpainting on the Workers
// AI free tier, mask is pixel-exact).
export const MASKED_EDIT_ENGINES = ["gpt-image", "workers-ai"] as const;

export const MASKED_EDIT_PARAM_RULES = {
  engine: { type: "enum", optional: true, values: MASKED_EDIT_ENGINES },
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
// selective-edit compositor (app/lib/selective-edit.ts). The gpt-image engine
// treats the mask as guidance; the workers-ai engine repaints exactly the
// masked pixels. PAID edit-shaped node (gpt-image engine; workers-ai runs
// free): engine + mask geometry + input image key + prompt + size/quality all
// feed the memoization signature. The DOM-touching execute wrapper (mask
// canvas, PNG <4MB upload, compositing) lives in maskedEdit.tsx.
export const maskedEditManifest: NodeManifest = {
  kind: "maskedEdit",
  spec: {
    kind: "maskedEdit",
    title: "Masked Edit",
    description: "Edit only a selected region; the rest is protected. Engines: gpt-image-2 (guidance) or Workers AI inpainting (pixel-exact, free).",
    inputs: [
      { id: "image", kind: "image", label: "Image", required: true },
      { id: "prompt", kind: "text", label: "Prompt", required: true },
    ],
    outputs: [{ id: "image", kind: "image", label: "Image" }],
    paid: true,
  },
  defaultParams: { engine: "gpt-image", size: "1536x1024", quality: "medium", candidates: 1, maskCacheKey: "" },
  importSchema: {
    paramKeys: { ...MASKED_EDIT_PARAM_RULES },
    sourceBlobKeys: ["maskCacheKey"],
  },
  // Workers AI inpainting runs on the free tier: $0, and shown as such in the
  // workflow cost estimate rather than hidden (null would mean "unknown").
  estimateCost: (input) => (input.params.engine === "workers-ai" ? 0 : estimateGenerationCost(input)),
  paid: true,
  // Draft mode's cheaper size/quality only applies to the paid engine —
  // rewriting size/quality for workers-ai (which ignores both) would change
  // the signature and force a spurious re-run when toggling draft mode.
  draftOverride: (params) => (params.engine === "workers-ai" ? params : generationDraftOverride(params)),
  // The region (maskRegionX/Y/Width/Height) drives the memoization signature
  // like every other param here — an unchanged region+prompt+size/quality is
  // a cache hit; moving the rectangle produces a different signature.
  persistBlobKeys: (_nodeId, params) => (params.maskCacheKey ? [params.maskCacheKey] : []),
};
