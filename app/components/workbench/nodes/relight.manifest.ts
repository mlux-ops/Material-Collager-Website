import type { NodeManifest } from "../types";
import { estimateSunburstCost, GENERATION_PARAM_RULES, generationDraftOverride } from "./generation.ts";
import { SUNBURST_MODEL } from "../../../lib/sunburst.ts";

// Edit-shaped PAID node over /api/workbench/edit (same request shape as
// imageEdit — a relighting-specific prompt/preset). The DOM-touching execute
// wrapper lives in relight.tsx, composing generation.ts's pure core.
export const relightManifest: NodeManifest = {
  kind: "relight",
  spec: {
    kind: "relight",
    title: "Relight",
    description: "Change the lighting mood of an image while preserving geometry.",
    inputs: [
      { id: "image", kind: "image", label: "Image", required: true },
      { id: "prompt", kind: "text", label: "Prompt", required: true },
    ],
    outputs: [{ id: "image", kind: "image", label: "Image" }],
    paid: true,
  },
  defaultParams: { model: SUNBURST_MODEL, size: "1536x1024", quality: "medium", candidates: 1, background: "opaque", outputFormat: "png" },
  importSchema: {
    paramKeys: { ...GENERATION_PARAM_RULES },
    sourceBlobKeys: [],
  },
  estimateCost: estimateSunburstCost,
  paid: true,
  draftOverride: generationDraftOverride,
};
