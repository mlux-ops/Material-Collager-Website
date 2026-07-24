import type { ImportParamRule, NodeManifest } from "../types";
import { COLLAGE_TYPES, ORIENTATIONS, OUTPUT_RESOLUTIONS } from "../../../lib/collage.ts";
import { estimateGenerationCost, GENERATION_QUALITIES, generationDraftOverride } from "./generation.ts";

export const COLLAGE_BOARD_PARAM_RULES = {
  collageType: { type: "enum", optional: true, values: COLLAGE_TYPES },
  orientation: { type: "enum", optional: true, values: ORIENTATIONS },
  outputResolution: { type: "enum", optional: true, values: OUTPUT_RESOLUTIONS },
  quality: { type: "enum", optional: true, values: GENERATION_QUALITIES },
} satisfies Record<string, ImportParamRule>;

// Builds a collage prompt CLIENT-side via the exported buildGenerationPrompt
// (app/lib/collage.ts) and posts to /api/workbench/edit — never
// /api/generate. QA is a separate Accuracy Reviewer node, not server-side.
// The DOM-touching execute wrapper (item image transport, buildGenerationPrompt
// composition) lives in collageBoard.tsx.
export const collageBoardManifest: NodeManifest = {
  kind: "collageBoard",
  spec: {
    kind: "collageBoard",
    title: "Collage Board",
    description: "Arrange reference items into an editorial material collage.",
    inputs: [{ id: "items", kind: "references", label: "Items", multi: true, required: true }],
    outputs: [{ id: "image", kind: "image", label: "Image" }],
    paid: true,
  },
  defaultParams: { collageType: "kitchen_material_palette", orientation: "default", quality: "medium" },
  importSchema: {
    paramKeys: { ...COLLAGE_BOARD_PARAM_RULES },
    sourceBlobKeys: [],
  },
  estimateCost: estimateGenerationCost,
  paid: true,
  draftOverride: generationDraftOverride,
};
