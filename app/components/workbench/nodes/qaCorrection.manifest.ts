import type { ImportParamRule, NodeManifest } from "../types";
import { estimateGenerationCost, GENERATION_QUALITIES, GENERATION_SIZES, generationDraftOverride } from "./generation.ts";

export const QA_CORRECTION_PARAM_RULES = {
  size: { type: "enum", optional: true, values: GENERATION_SIZES },
  quality: { type: "enum", optional: true, values: GENERATION_QUALITIES },
} satisfies Record<string, ImportParamRule>;

// Consumes report + image + references, builds a mask from the report boxes
// via app/lib/selective-edit.ts (createSelectiveEditAssets/
// compositeSelectiveEdit), posts to /api/workbench/edit, and composites
// protected pixels back client-side. Reviewer -> QA Correction is an
// unrolled linear acyclic chain (connectionIsValid rejects cycles). PAID
// edit-shaped node. The DOM-touching execute wrapper lives in
// qaCorrection.tsx.
export const qaCorrectionManifest: NodeManifest = {
  kind: "qaCorrection",
  spec: {
    kind: "qaCorrection",
    title: "QA Correction",
    description: "Apply a targeted correction from an Accuracy Reviewer report.",
    inputs: [
      { id: "report", kind: "report", label: "Report", required: true },
      { id: "image", kind: "image", label: "Image", required: true },
      { id: "references", kind: "references", label: "References", acceptedKinds: ["image", "references"] },
    ],
    outputs: [{ id: "image", kind: "image", label: "Image" }],
    paid: true,
  },
  defaultParams: { size: "1536x1024", quality: "medium", candidates: 1 },
  importSchema: {
    paramKeys: { ...QA_CORRECTION_PARAM_RULES },
    sourceBlobKeys: [],
  },
  estimateCost: estimateGenerationCost,
  paid: true,
  draftOverride: generationDraftOverride,
};
