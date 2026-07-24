import { estimateRunUsd } from "../cost.ts";
import type { CostEstimateInput, ImportParamRule, NodeManifest } from "../types";
import { GENERATION_QUALITIES, GENERATION_SIZES, generationDraftOverride } from "./generation.ts";

export const VARIATIONS_PARAM_RULES = {
  size: { type: "enum", optional: true, values: GENERATION_SIZES },
  quality: { type: "enum", optional: true, values: GENERATION_QUALITIES },
  n: { type: "number", optional: true, integer: true, min: 1, max: 10 },
  activeCandidate: { type: "number", optional: true, integer: true, min: 0 },
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
// nodeId:runId:index), browsed via an active-candidate index so the
// SELECTED variant (not always index 0) propagates downstream. n is part of
// the memoization signature (stableParams passes params through unchanged;
// n IS a signature-relevant setting). The DOM-touching execute wrapper lives
// in variations.tsx.
export const variationsManifest: NodeManifest = {
  kind: "variations",
  spec: {
    kind: "variations",
    title: "Variations",
    description: "Generate several candidate variants from one call and pick your favorite.",
    inputs: [
      { id: "image", kind: "image", label: "Image", required: true },
      { id: "prompt", kind: "text", label: "Prompt" },
    ],
    outputs: [{ id: "image", kind: "image", label: "Image" }],
    paid: true,
  },
  defaultParams: { size: "1536x1024", quality: "medium", n: 4, activeCandidate: 0 },
  importSchema: {
    paramKeys: { ...VARIATIONS_PARAM_RULES },
    sourceBlobKeys: [],
  },
  estimateCost: estimateVariationsCost,
  paid: true,
  // activeCandidate is presentation state (which browsed candidate is shown),
  // not a request-affecting setting: it must not invalidate the memoized run.
  stableParams: ({ activeCandidate: _activeCandidate, ...rest }) => rest,
  draftOverride: generationDraftOverride,
};
