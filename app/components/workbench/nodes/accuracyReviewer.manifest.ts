import type { CostEstimateInput, NodeManifest } from "../types";

// Flat per-call estimate for a single text/vision review call (POST
// /api/workbench/review) — NOT the generation-image estimator; no output
// image is produced.
const REVIEWER_CALL_USD = 0.02;

export function estimateReviewerCost(_input: CostEstimateInput): number | null {
  return REVIEWER_CALL_USD;
}

// Emits a report-kind output; downscales its input images before sending
// (layout/box-oriented review, not pixel-detail) to respect the 32MB JSON
// body cap. Calls POST /api/workbench/review with an ordered items list
// carrying per-item reference-group metadata derived from the upstream
// References bundle. NO draftOverride (W5): review has no cheaper draft
// variant. The DOM-touching execute wrapper (downscaling via
// app/lib/image-transport.ts) lives in accuracyReviewer.tsx.
export const accuracyReviewerManifest: NodeManifest = {
  kind: "accuracyReviewer",
  spec: {
    kind: "accuracyReviewer",
    title: "Accuracy Reviewer",
    description: "Check a generated image against its reference items and report findings.",
    inputs: [
      { id: "image", kind: "image", label: "Image", required: true },
      // C3: execute() unconditionally throws without a connected References
      // node -- required:true surfaces that pre-run too.
      { id: "references", kind: "references", label: "References", required: true },
    ],
    outputs: [{ id: "report", kind: "report", label: "Report" }],
    paid: true,
  },
  defaultParams: { domain: "interior" },
  importSchema: {
    paramKeys: {
      domain: { type: "enum", optional: true, values: ["interior", "exterior", "collage"] },
      // S-5: without this, export/import silently dropped the masked-repair
      // item selection -- a reviewer configured to "score only these items"
      // came back scoring everything on round-trip.
      selectedItemIds: { type: "stringList", optional: true, maxItems: 32, maxLength: 128 },
    },
    sourceBlobKeys: [],
  },
  estimateCost: estimateReviewerCost,
  paid: true,
};
