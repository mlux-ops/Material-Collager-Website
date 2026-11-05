import type { ImportParamRule, NodeManifest, WorkbenchParams } from "../types";
import { estimateSunburstCost, GENERATION_BACKGROUNDS, GENERATION_COMPLEXITIES, GENERATION_FORMATS, GENERATION_QUALITIES, GENERATION_SIZES, generationDraftOverride } from "./generation.ts";
import { SUNBURST_MODEL } from "../../../lib/sunburst.ts";

// Masked Edit runs on one backend only: /api/workbench/edit (Sunburst, the
// only image model this site uses). The mask is guidance, not pixel-exact;
// protection is made exact client-side by compositing the result back over
// the full-resolution original (maskedEdit.tsx compositeShapesEdit).
//
// Retired params: saved graphs may still carry `engine` ("gpt-image",
// "workers-ai", "flux-fill"), `fluxGuidance` and `fluxSeed` from when SD 1.5
// (Workers AI) and FLUX.1 Fill (BFL) were selectable. Import drops them (they
// are not in MASKED_EDIT_PARAM_RULES and the import validator is an
// allowlist); an IndexedDB-restored graph keeps them in params, so nothing in
// this node reads them -- every node runs on the OpenAI path.
export const RETIRED_MASKED_EDIT_ENGINES = ["workers-ai", "flux-fill"] as const;

export function usesRetiredEngine(params: { engine?: unknown }): boolean {
  return (RETIRED_MASKED_EDIT_ENGINES as readonly unknown[]).includes(params.engine);
}

// A node saved on a retired engine has a cached run whose signature includes
// that engine. Dropping the dead keys from ONLY those nodes' signatures makes
// that SD/FLUX output stale, so the next run renders through Sunburst instead
// of the old result passing as current. Every other node's params are
// returned untouched: retired-engine nodes are the only ones this function
// itself invalidates (a model-id normalization on load can still move any
// node's signature, independently of this).
export function maskedEditStableParams(params: WorkbenchParams): Partial<WorkbenchParams> {
  if (!usesRetiredEngine(params)) return params;
  const stable = { ...params };
  delete stable.engine;
  delete stable.fluxGuidance;
  delete stable.fluxSeed;
  return stable;
}

export function buildMaskedReferencePrompt(basePrompt: string, instruction: string | undefined, hasReference: boolean): string {
  if (!hasReference) return basePrompt;
  const direction = instruction?.trim() || "Use the reference's relevant visual qualities to guide only the masked replacement.";
  return `${basePrompt}

Reference image guidance:
The first input image is the base image being edited and the mask applies to it. The second input image is visual reference only.
${direction}`;
}

export const MASKED_EDIT_PARAM_RULES = {
  size: { type: "enum", optional: true, values: GENERATION_SIZES },
  quality: { type: "enum", optional: true, values: GENERATION_QUALITIES },
  model: { type: "enum", optional: true, values: [SUNBURST_MODEL] },
  background: { type: "enum", optional: true, values: GENERATION_BACKGROUNDS },
  outputFormat: { type: "enum", optional: true, values: GENERATION_FORMATS },
  complexity: { type: "enum", optional: true, values: GENERATION_COMPLEXITIES },
  referenceInstruction: { type: "string", optional: true, maxLength: 4000 },
  // JSON-serialized MaskShape[] (rect/polygon/brush, normalized 0-1000).
  // Opaque to import validation beyond the size cap; execute() parses it
  // defensively and falls back to the maskRegion* bounding box.
  maskShapes: { type: "string", optional: true, maxLength: 40000 },
  maskCacheKey: { type: "string", optional: true, maxLength: 256 },
  maskRegionX: { type: "number", optional: true, min: 0, max: 1000 },
  maskRegionY: { type: "number", optional: true, min: 0, max: 1000 },
  maskRegionWidth: { type: "number", optional: true, min: 0, max: 1000 },
  maskRegionHeight: { type: "number", optional: true, min: 0, max: 1000 },
} satisfies Record<string, ImportParamRule>;

// Mask-editor modal (rectangle drag, freehand brush, click-vertex polygon),
// touch/stylus capable. Composites protected pixels back client-side through
// the drawn shape mask (feathered inward, bit-identical outside). PAID
// edit-shaped node: mask shapes + input image key + prompt + size/quality all
// feed the memoization signature. The DOM-touching execute wrapper (mask
// rendering, PNG <4MB upload, compositing) lives in maskedEdit.tsx.
export const maskedEditManifest: NodeManifest = {
  kind: "maskedEdit",
  spec: {
    kind: "maskedEdit",
    title: "Masked Edit",
    description: `Edit only a selected region with ${SUNBURST_MODEL}; the mask is guidance and everything outside it is restored pixel-for-pixel.`,
    inputs: [
      { id: "image", kind: "image", label: "Image", required: true },
      { id: "reference", kind: "image", label: "Reference image" },
      { id: "prompt", kind: "text", label: "Prompt", required: true },
    ],
    outputs: [{ id: "image", kind: "image", label: "Image" }],
    paid: true,
  },
  defaultParams: {
    model: SUNBURST_MODEL,
    size: "1536x1024",
    quality: "medium",
    candidates: 1,
    background: "opaque",
    outputFormat: "png",
    maskCacheKey: "",
    referenceInstruction: "",
  },
  importSchema: {
    paramKeys: { ...MASKED_EDIT_PARAM_RULES },
    sourceBlobKeys: ["maskCacheKey"],
  },
  // Sunburst usage is only known after a completed provider response. A
  // retired engine value never changes the estimate: the node bills Sunburst.
  estimateCost: estimateSunburstCost,
  paid: true,
  draftOverride: generationDraftOverride,
  stableParams: maskedEditStableParams,
  // The region (maskRegionX/Y/Width/Height) drives the memoization signature
  // like every other param here -- an unchanged region+prompt+size/quality is
  // a cache hit; moving the rectangle produces a different signature.
  persistBlobKeys: (_nodeId, params) => (params.maskCacheKey ? [params.maskCacheKey] : []),
};
