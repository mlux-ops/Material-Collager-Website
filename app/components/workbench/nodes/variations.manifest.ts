import { estimateRunUsd } from "../cost.ts";
import type { CostEstimateInput, ImportParamRule, NodeManifest } from "../types";
import { GENERATION_QUALITIES, GENERATION_SIZES, generationDraftOverride } from "./generation.ts";

export const VARIATIONS_PARAM_RULES = {
  size: { type: "enum", optional: true, values: GENERATION_SIZES },
  quality: { type: "enum", optional: true, values: GENERATION_QUALITIES },
  n: { type: "number", optional: true, integer: true, min: 1, max: 10 },
} satisfies Record<string, ImportParamRule>;

// A single /api/workbench/edit call producing n (clamped 1-10) candidates:
// input tokens are billed once, output scaled by n.
export function estimateVariationsCost({ params, inputImages }: CostEstimateInput): number | null {
  const n = Math.min(10, Math.max(1, params.n ?? 4));
  return estimateRunUsd({
    size: params.size || "1536x1024",
    quality: params.quality || "medium",
    candidates: n,
    inputImages,
  });
}

// Edit-shaped PAID node: one call fans out to n candidates (cacheKeys
// nodeId:runId:index). Rather than the originally-planned index-based
// design (storing an activeCandidate index and having inputValues() resolve
// candidates[activeCandidate]), the shipped design has variations.tsx's
// selectCandidate REORDER the run's own values under a fresh runId so the
// picked candidate always sits at candidates[0] -- which is what
// inputValues() resolves for every node, so no dedicated index param is
// needed (S-1). n IS part of the memoization signature (no stableParams
// override: every param here is signature-relevant). The DOM-touching
// execute wrapper lives in variations.tsx.
export const variationsManifest: NodeManifest = {
  kind: "variations",
  spec: {
    kind: "variations",
    title: "Variations",
    description: "Generate several candidate variants from one call and pick your favorite.",
    inputs: [
      { id: "image", kind: "image", label: "Image", required: true },
      // C2: execute() unconditionally throws without a prompt (via
      // buildGenerationPayload) -- required:true surfaces that pre-run too,
      // matching every sibling edit-shaped node (imageEdit/imageGenerate/
      // relight/maskedEdit).
      { id: "prompt", kind: "text", label: "Prompt", required: true },
    ],
    outputs: [{ id: "image", kind: "image", label: "Image" }],
    paid: true,
  },
  defaultParams: { size: "1536x1024", quality: "medium", n: 4 },
  importSchema: {
    paramKeys: { ...VARIATIONS_PARAM_RULES },
    sourceBlobKeys: [],
  },
  estimateCost: estimateVariationsCost,
  paid: true,
  draftOverride: generationDraftOverride,
};
