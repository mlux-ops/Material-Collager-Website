import { estimateRunUsd } from "../cost.ts";
import type {
  CostEstimateInput,
  ImportParamRule,
  NodeManifest,
  NodeOutputValue,
  NodeRun,
  WorkbenchParams,
} from "../types";
import { GENERATION_QUALITIES, GENERATION_SIZES, generationDraftOverride } from "./generation.ts";

export const VARIATIONS_PARAM_RULES = {
  size: { type: "enum", optional: true, values: GENERATION_SIZES },
  quality: { type: "enum", optional: true, values: GENERATION_QUALITIES },
  n: { type: "number", optional: true, integer: true, min: 1, max: 10 },
  separateOutputs: { type: "boolean", optional: true },
} satisfies Record<string, ImportParamRule>;

export const VARIATION_OUTPUT_PORTS = Array.from({ length: 10 }, (_, index) => ({
  id: `variation-${index + 1}`,
  kind: "image" as const,
  label: `Variation ${index + 1}`,
}));

export function activeVariationOutputIds(params: WorkbenchParams): string[] {
  const ids = ["image"];
  if (!params.separateOutputs) return ids;
  const count = Math.min(10, Math.max(1, Math.round(params.n ?? 4)));
  for (let index = 1; index <= count; index += 1) ids.push(`variation-${index}`);
  return ids;
}

function originalCandidateIndex(value: NodeOutputValue): number {
  if (value.kind !== "image") return Number.MAX_SAFE_INTEGER;
  const raw = value.cacheKey.split(":").at(-1);
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : Number.MAX_SAFE_INTEGER;
}

// Compatibility adapter for persisted aggregate-only runs. Candidate
// selection reorders values[0], so sort by the stable cache-key suffix before
// resolving `variation-N`; each individual handle remains tied to the
// originally generated photo regardless of which aggregate candidate is
// currently selected.
export function resolveVariationOutput(run: NodeRun, portId: string): NodeOutputValue[] {
  const match = /^variation-(\d+)$/.exec(portId);
  if (!match) return [];
  const index = Number(match[1]) - 1;
  const ordered = [...(run.values[0] ?? [])]
    .filter((value) => value.kind === "image")
    .sort((a, b) => originalCandidateIndex(a) - originalCandidateIndex(b));
  const value = ordered[index];
  return value ? [value] : [];
}

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
    outputs: [{ id: "image", kind: "image", label: "Selected image" }, ...VARIATION_OUTPUT_PORTS],
    paid: true,
  },
  defaultParams: { size: "1536x1024", quality: "medium", n: 4, separateOutputs: false },
  importSchema: {
    paramKeys: { ...VARIATIONS_PARAM_RULES },
    sourceBlobKeys: [],
  },
  estimateCost: estimateVariationsCost,
  paid: true,
  draftOverride: generationDraftOverride,
  // Handle visibility is presentation-only. Every individual port is derived
  // from the already-generated aggregate run, so toggling it never re-bills.
  stableParams: (params) => {
    const stable = { ...params };
    delete stable.separateOutputs;
    return stable;
  },
  resolveOutputValues: resolveVariationOutput,
  activeOutputIds: activeVariationOutputIds,
};
