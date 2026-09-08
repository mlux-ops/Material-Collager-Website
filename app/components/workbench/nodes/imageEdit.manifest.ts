import type { NodeManifest } from "../types";
import { estimateSunburstCost, GENERATION_PARAM_RULES, generationDraftOverride } from "./generation.ts";
import { SUNBURST_MODEL } from "../../../lib/sunburst.ts";

// The execute wrapper lives in imageEdit.tsx (blob-cache object URLs and
// reference transport are DOM work); it composes generation.ts's pure
// request-building + response-mapping core.
export const imageEditManifest: NodeManifest = {
  kind: "imageEdit",
  spec: {
    kind: "imageEdit",
    title: "Edit / Material Swap",
    description: "Edit an image with a prompt — swap materials, restyle, relight.",
    inputs: [
      { id: "image", kind: "image", label: "Image", required: true },
      { id: "prompt", kind: "text", label: "Prompt", required: true },
      { id: "references", kind: "image", label: "References", multi: true, acceptedKinds: ["image", "references"] },
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
