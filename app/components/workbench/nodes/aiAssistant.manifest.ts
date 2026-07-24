import type { CostEstimateInput, NodeManifest } from "../types";

// Server allowlist mirrored client-side for the model selector only — the
// route (/api/workbench/assist) is the sole enforcement point; an unknown
// model string is always rejected server-side regardless of this list.
export const AI_ASSISTANT_MODELS = ["gpt-5.4-mini", "gpt-5.6"] as const;
export const AI_ASSISTANT_DEFAULT_MODEL = "gpt-5.4-mini";

// Flat per-call Responses-API token estimate — NOT the generation-image
// estimator; the assistant produces text only.
const ASSISTANT_CALL_USD = 0.01;

export function estimateAssistantCost(_input: CostEstimateInput): number | null {
  return ASSISTANT_CALL_USD;
}

// Thin client for POST /api/workbench/assist. Produces a PURE text-kind
// output (rendered via React, never dangerouslySetInnerHTML). CANNOT add or
// remove nodes/edges or mutate params/runs — its output is consumed like any
// other Text value. NO draftOverride (W5): the draft flag is not folded into
// its signature.
export const aiAssistantManifest: NodeManifest = {
  kind: "aiAssistant",
  spec: {
    kind: "aiAssistant",
    title: "AI Assistant",
    description: "Ask a question about an image or text; get a plain-text answer.",
    inputs: [
      { id: "image", kind: "image", label: "Image" },
      { id: "text", kind: "text", label: "Context" },
    ],
    outputs: [{ id: "text", kind: "text", label: "Answer" }],
    paid: true,
  },
  defaultParams: { instruction: "", model: AI_ASSISTANT_DEFAULT_MODEL },
  importSchema: {
    paramKeys: {
      instruction: { type: "string", optional: true, maxLength: 4_000 },
      model: { type: "enum", optional: true, values: AI_ASSISTANT_MODELS },
    },
    sourceBlobKeys: [],
  },
  estimateCost: estimateAssistantCost,
  paid: true,
};
