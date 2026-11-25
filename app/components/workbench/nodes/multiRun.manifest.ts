import type { CostEstimateInput, ImportParamRule, NodeManifest } from "../types";
import { GENERATION_PARAM_RULES, generationDraftOverride } from "./generation.ts";
import {
  MULTI_RUN_FORMATS,
  MULTI_RUN_IPM_DEFAULT,
  MULTI_RUN_IPM_MAX,
  MULTI_RUN_PER_CALL_DEFAULT,
  MULTI_RUN_PER_CALL_MAX,
  MULTI_RUN_TOTAL_DEFAULT,
  MULTI_RUN_TOTAL_MAX,
} from "./multiRun.core.ts";
import { SUNBURST_MODEL } from "../../../lib/sunburst.ts";

// The shared generation rules without `candidates` (n here comes from
// perCall), PNG/WebP output only, plus the three burst settings.
const { candidates: _candidates, ...GENERATION_RULES_WITHOUT_CANDIDATES } = GENERATION_PARAM_RULES;
void _candidates;

export const MULTI_RUN_PARAM_RULES = {
  ...GENERATION_RULES_WITHOUT_CANDIDATES,
  outputFormat: { type: "enum", optional: true, values: MULTI_RUN_FORMATS },
  total: { type: "number", optional: true, integer: true, min: 1, max: MULTI_RUN_TOTAL_MAX },
  perCall: { type: "number", optional: true, integer: true, min: 1, max: MULTI_RUN_PER_CALL_MAX },
  ipm: { type: "number", optional: true, integer: true, min: 1, max: MULTI_RUN_IPM_MAX },
} satisfies Record<string, ImportParamRule>;

// A burst's exact usage is only known after the provider responds, and its
// size makes a guess dangerous; the card states the image count and warns
// instead. Declared (returning null) so the paid-node audit holds.
export function estimateMultiRunCost({ params, inputImages }: CostEstimateInput): number | null {
  void params;
  void inputImages;
  return null;
}

// Image Generation-shaped PAID node that renders `total` images per press as
// ceil(total / perCall) concurrent calls of n images each, admitted by the
// shared images-per-minute limiter (ipm-limiter.ts). The fan-out happens inside
// its own execute (multiRun.tsx); the executor still runs one node at a time.
// A press that stops part-way keeps what it paid for as a PARTIAL run (its
// `target` says how many it is meant to hold), and the next press renders only
// the remainder. Candidate picking reorders the run like Variations.
export const multiRunManifest: NodeManifest = {
  kind: "multiRun",
  spec: {
    kind: "multiRun",
    title: "Multi-Run",
    description: "Render many images from one prompt at once, up to your images-per-minute limit, and pick one.",
    inputs: [
      { id: "prompt", kind: "text", label: "Prompt", required: true },
      // Images that guide the render; these ARE sent (and billed as input,
      // once per call).
      { id: "references", kind: "image", label: "Image Reference", multi: true, acceptedKinds: ["image", "references"] },
    ],
    outputs: [{ id: "image", kind: "image", label: "Selected image" }],
    paid: true,
  },
  defaultParams: {
    model: SUNBURST_MODEL,
    size: "1536x1024",
    quality: "medium",
    background: "opaque",
    outputFormat: "png",
    total: MULTI_RUN_TOTAL_DEFAULT,
    perCall: MULTI_RUN_PER_CALL_DEFAULT,
    ipm: MULTI_RUN_IPM_DEFAULT,
  },
  importSchema: {
    paramKeys: { ...MULTI_RUN_PARAM_RULES },
    sourceBlobKeys: [],
  },
  estimateCost: estimateMultiRunCost,
  paid: true,
  draftOverride: generationDraftOverride,
  // The cap only paces the calls; it never changes what is rendered, so
  // changing it never re-bills. total and perCall stay in the signature.
  stableParams: (params) => {
    const stable = { ...params };
    delete stable.ipm;
    return stable;
  },
};
