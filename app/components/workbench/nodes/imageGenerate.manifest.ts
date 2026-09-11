import type { NodeManifest } from "../types";
import { estimateSunburstCost, GENERATION_PARAM_RULES, generationDraftOverride } from "./generation.ts";
import { SUNBURST_MODEL } from "../../../lib/sunburst.ts";

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
      // Size-only input: "Match input image" reads this image's exact pixel
      // dimensions (e.g. a Crop's output). It is never sent to the model.
      { id: "size", kind: "image", label: "Size" },
      { id: "prompt", kind: "text", label: "Prompt", required: true },
      // Images that guide the render; these ARE sent (and billed as input).
      { id: "references", kind: "image", label: "Image Reference", multi: true, acceptedKinds: ["image", "references"] },
    ],
    outputs: [{ id: "image", kind: "image", label: "Image" }],
    paid: true,
  },
  defaultParams: { model: SUNBURST_MODEL, size: "1536x1024", quality: "medium", candidates: 1, background: "opaque", outputFormat: "png" },
  importSchema: {
    paramKeys: { ...GENERATION_PARAM_RULES },
    sourceBlobKeys: [],
  },
  estimateCost: estimateSunburstCost,
  paid: true,
  draftOverride: generationDraftOverride,
};
