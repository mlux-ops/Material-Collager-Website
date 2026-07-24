import type { CostEstimateInput, NodeManifest } from "../types";

// Flat per-call estimate for a single vision-analysis call — NOT the
// generation-image estimator (no output image is produced).
const ANALYZER_CALL_USD = 0.01;

export function estimateAnalyzerCost(_input: CostEstimateInput): number | null {
  return ANALYZER_CALL_USD;
}

// Structured shape POST /api/references/analyze returns (unchanged route).
export type AnalysisField = { value: string; confidence: number };
export type ReferenceAnalysis = {
  itemType: AnalysisField;
  brand: AnalysisField;
  product: AnalysisField;
  finish: AnalysisField;
  notes: AnalysisField;
  searchQuery: string;
};

// Wraps POST /api/references/analyze (multipart image + itemType, unchanged).
// Surfaces itemType/brand/product/finish/notes each with confidence +
// searchQuery so a Reference Finder node downstream can consume the query.
// NO draftOverride (W5): analysis has no cheaper draft variant. The
// DOM-touching execute wrapper (blob-cache image transport) lives in
// referenceAnalyzer.tsx.
export const referenceAnalyzerManifest: NodeManifest = {
  kind: "referenceAnalyzer",
  spec: {
    kind: "referenceAnalyzer",
    title: "Reference Analyzer",
    description: "Identify brand/product/finish from a reference photo.",
    inputs: [{ id: "image", kind: "image", label: "Image", required: true }],
    outputs: [{ id: "query", kind: "text", label: "Search Query" }],
    paid: true,
  },
  defaultParams: { itemType: "" },
  importSchema: {
    paramKeys: {
      itemType: { type: "string", optional: true, maxLength: 200 },
    },
    sourceBlobKeys: [],
  },
  estimateCost: estimateAnalyzerCost,
  paid: true,
};
