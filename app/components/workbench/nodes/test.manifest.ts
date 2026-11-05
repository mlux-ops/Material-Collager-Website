import type { NodeManifest } from "../types";
import { estimateSunburstCost, GENERATION_PARAM_RULES, generationDraftOverride } from "./generation.ts";
import { TEST_MODEL_2_5 } from "../../../lib/sunburst.ts";

// The shared rules without `complexity`: it is a 2.6 setting the 2.5 snapshot
// does not document, so an imported Test node can never carry one.
const TEST_PARAM_RULES = Object.fromEntries(
  Object.entries(GENERATION_PARAM_RULES).filter(([key]) => key !== "complexity"),
) as Omit<typeof GENERATION_PARAM_RULES, "complexity">;

// "Test": Image Generation on the previous Sunburst (TEST_MODEL_2_5, the dated
// 2.5 snapshot), for comparing 2.5 against the current 2.6 side by side. It is
// the only node that renders on 2.5. The model is fixed by this kind
// (test.tsx passes it to executeGeneration), not chosen from params; the
// `model` param exists only so cost learning and the run signature are keyed
// on 2.5, separate from 2.6 runs. Same rates as 2.6 per OpenAI's pricing page.
export const testManifest: NodeManifest = {
  kind: "test",
  spec: {
    kind: "test",
    title: "Test",
    description: "Image Generation on the previous model (GPT Image 2.5 Sunburst), to compare against 2.6.",
    inputs: [
      // Size-only input, as on Image Generation: never sent to the model.
      { id: "size", kind: "image", label: "Size" },
      { id: "prompt", kind: "text", label: "Prompt", required: true },
      { id: "references", kind: "image", label: "Image Reference", multi: true, acceptedKinds: ["image", "references"] },
    ],
    outputs: [{ id: "image", kind: "image", label: "Image" }],
    paid: true,
  },
  defaultParams: { model: TEST_MODEL_2_5, size: "1536x1024", quality: "medium", candidates: 1, background: "opaque", outputFormat: "png" },
  importSchema: {
    paramKeys: { ...TEST_PARAM_RULES, model: { type: "enum", optional: true, values: [TEST_MODEL_2_5] } },
    sourceBlobKeys: [],
  },
  estimateCost: estimateSunburstCost,
  paid: true,
  draftOverride: generationDraftOverride,
};
