import type { CostEstimateInput, ImportParamRule, NodeManifest, WorkbenchParams } from "../types";
import { COLLAGE_TYPES, ORIENTATIONS, OUTPUT_RESOLUTIONS, resolvedSize, type CollageRequestInput } from "../../../lib/collage.ts";
import { estimateRunUsd } from "../cost.ts";
import { GENERATION_QUALITIES } from "./generation.ts";

export const COLLAGE_BOARD_PARAM_RULES = {
  collageType: { type: "enum", optional: true, values: COLLAGE_TYPES },
  orientation: { type: "enum", optional: true, values: ORIENTATIONS },
  outputResolution: { type: "enum", optional: true, values: OUTPUT_RESOLUTIONS },
  quality: { type: "enum", optional: true, values: GENERATION_QUALITIES },
} satisfies Record<string, ImportParamRule>;

// W-3: Collage Board has no size param of its own -- the real request size
// is derived at execute time by resolvedSize({collageType, orientation,
// outputResolution}) (collageBoard.tsx, app/lib/collage.ts), NOT
// estimateGenerationCost's params.size (which falls back to a flat
// "1536x1024" this node never actually has). Using the generic estimator
// here under-estimated by ~1.8-3x, bypassing the $0.40 confirmHighCost
// guardrail on exactly the large collage runs it exists to catch. `items` is
// irrelevant to resolvedSize (only orientation/outputResolution/collageType
// feed it), so an empty array is a safe stand-in for the estimate.
export function estimateCollageBoardCost({ params, inputImages }: CostEstimateInput): number | null {
  const request: CollageRequestInput = {
    collageType: (params.collageType as CollageRequestInput["collageType"]) || "kitchen_material_palette",
    orientation: (params.orientation as CollageRequestInput["orientation"]) || "default",
    quality: (params.quality as CollageRequestInput["quality"]) || "medium",
    outputResolution: params.outputResolution as CollageRequestInput["outputResolution"],
    items: [],
  };
  return estimateRunUsd({
    size: resolvedSize(request),
    quality: request.quality,
    candidates: 1,
    inputImages,
  });
}

// Draft mode's small-size half (AC22/issue-3): Collage Board has no `size`
// param at all (see estimateCollageBoardCost above), so injecting the
// generic generationDraftOverride's computed `size` field would be inert --
// execute() and estimateCollageBoardCost both derive the real request size
// from resolvedSize({collageType, orientation, outputResolution}), never
// from params.size. Its own draft override therefore forces
// outputResolution to "standard", the smallest resolvedSize option, so the
// SAME resolvedSize code path both execute() and the cost estimator already
// use naturally picks the smaller size in draft mode.
function collageBoardDraftOverride(params: WorkbenchParams): WorkbenchParams {
  return { ...params, quality: "low", outputResolution: "standard" };
}

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
  estimateCost: estimateCollageBoardCost,
  paid: true,
  draftOverride: collageBoardDraftOverride,
};
