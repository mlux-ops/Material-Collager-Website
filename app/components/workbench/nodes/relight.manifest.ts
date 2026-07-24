import type { NodeManifest } from "../types";
import { estimateGenerationCost, GENERATION_PARAM_RULES, generationDraftOverride } from "./generation.ts";

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
  defaultParams: { size: "1536x1024", quality: "medium", candidates: 1 },
  importSchema: {
    paramKeys: { ...GENERATION_PARAM_RULES },
    sourceBlobKeys: [],
  },
  estimateCost: estimateGenerationCost,
  paid: true,
  draftOverride: generationDraftOverride,
};
