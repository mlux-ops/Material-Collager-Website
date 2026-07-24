import type { NodeManifest } from "../types";
import { estimateGenerationCost, GENERATION_PARAM_RULES, generationDraftOverride } from "./generation.ts";

// The execute wrapper lives in imageGenerate.tsx (blob-cache object URLs and
// reference transport are DOM work); it composes generation.ts's pure
// request-building + response-mapping core.
export const imageGenerateManifest: NodeManifest = {
  kind: "imageGenerate",
  spec: {
    kind: "imageGenerate",
    title: "Image Generation",
    description: "Generate an image from a prompt, optionally guided by reference images.",
    inputs: [
      { id: "prompt", kind: "text", label: "Prompt", required: true },
      { id: "references", kind: "image", label: "References", multi: true, acceptedKinds: ["image", "references"] },
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
