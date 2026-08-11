import type { ImportParamRule, NodeManifest } from "../types";
import { estimateGenerationCost, GENERATION_QUALITIES, GENERATION_SIZES, generationDraftOverride } from "./generation.ts";

// Backend engines: "gpt-image" posts to /api/workbench/edit (gpt-image-2,
// mask is guidance, paid per image); "workers-ai" and "flux-fill" post to
// /api/workbench/inpaint (mask-conditioned, pixel-exact) — SD 1.5 on the
// Workers AI free tier vs FLUX.1 Fill [pro] via the BFL API (~$0.05/image,
// far better prompt adherence).
export const MASKED_EDIT_ENGINES = ["gpt-image", "workers-ai", "flux-fill"] as const;

export function maskedReferenceSupported(engine: unknown): boolean {
  return (engine || "gpt-image") === "gpt-image";
}

export function buildMaskedReferencePrompt(basePrompt: string, instruction: string | undefined, hasReference: boolean): string {
  if (!hasReference) return basePrompt;
  const direction = instruction?.trim() || "Use the reference's relevant visual qualities to guide only the masked replacement.";
  return `${basePrompt}

Reference image guidance:
The first input image is the base image being edited and the mask applies to it. The second input image is visual reference only.
${direction}`;
}

// flux-pro-1.0-fill is flat-priced per generated image on the BFL API.
const FLUX_FILL_USD_PER_IMAGE = 0.05;

// FLUX Fill prompt-adherence range, per the BFL API schema. BFL's own default
// is 60, tuned for "put this specific object here" fills: at that strength the
// model renders the prompt's most concept-dense noun literally, so a
// material/texture patch prompt tends to come back as a newly invented object
// instead of a surface that disappears into its surroundings. 30 is the useful
// default for the material work this node is mostly used for; raise it toward
// 60 when the masked region really should become a specific new object.
export const FLUX_FILL_GUIDANCE_MIN = 1.5;
export const FLUX_FILL_GUIDANCE_MAX = 100;
export const FLUX_FILL_GUIDANCE_DEFAULT = 30;
// BFL accepts any 32-bit seed; an unset seed means "random every run".
export const FLUX_FILL_SEED_MAX = 4_294_967_295;

// A cleared input field ("") must fall back to the default, not to Number("")
// = 0 -> the minimum, which would silently drop prompt adherence to nothing.
export function clampFluxGuidance(value: unknown): number {
  if (value === undefined || value === null || value === "") return FLUX_FILL_GUIDANCE_DEFAULT;
  const guidance = Number(value);
  if (!Number.isFinite(guidance)) return FLUX_FILL_GUIDANCE_DEFAULT;
  return Math.min(FLUX_FILL_GUIDANCE_MAX, Math.max(FLUX_FILL_GUIDANCE_MIN, guidance));
}

// Undefined (not 0) for "no seed" — 0 is a legitimate seed BFL will honour, so
// an empty field must not collapse into it.
export function normalizeFluxSeed(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const seed = Math.floor(Number(value));
  if (!Number.isFinite(seed) || seed < 0) return undefined;
  return Math.min(FLUX_FILL_SEED_MAX, seed);
}

export const MASKED_EDIT_PARAM_RULES = {
  engine: { type: "enum", optional: true, values: MASKED_EDIT_ENGINES },
  size: { type: "enum", optional: true, values: GENERATION_SIZES },
  quality: { type: "enum", optional: true, values: GENERATION_QUALITIES },
  referenceInstruction: { type: "string", optional: true, maxLength: 4000 },
  fluxGuidance: { type: "number", optional: true, min: FLUX_FILL_GUIDANCE_MIN, max: FLUX_FILL_GUIDANCE_MAX },
  fluxSeed: { type: "number", optional: true, min: 0, max: FLUX_FILL_SEED_MAX, integer: true },
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
// the drawn shape mask (feathered inward, bit-identical outside). The
// gpt-image engine treats the mask as guidance; the inpaint engines repaint
// exactly the masked pixels. PAID edit-shaped node (gpt-image/flux engines;
// workers-ai runs free): engine + mask shapes + input image key + prompt +
// size/quality all feed the memoization signature. The DOM-touching execute
// wrapper (mask rendering, PNG <4MB upload, compositing) lives in
// maskedEdit.tsx.
export const maskedEditManifest: NodeManifest = {
  kind: "maskedEdit",
  spec: {
    kind: "maskedEdit",
    title: "Masked Edit",
    description: "Edit only a selected region; the rest is protected. Engines: gpt-image-2 (guidance), Workers AI inpainting (pixel-exact, free), or FLUX Fill (pixel-exact, best prompt-following).",
    inputs: [
      { id: "image", kind: "image", label: "Image", required: true },
      { id: "reference", kind: "image", label: "Reference image" },
      { id: "prompt", kind: "text", label: "Prompt", required: true },
    ],
    outputs: [{ id: "image", kind: "image", label: "Image" }],
    paid: true,
  },
  defaultParams: {
    engine: "gpt-image",
    size: "1536x1024",
    quality: "medium",
    candidates: 1,
    maskCacheKey: "",
    referenceInstruction: "",
    fluxGuidance: FLUX_FILL_GUIDANCE_DEFAULT,
  },
  importSchema: {
    paramKeys: { ...MASKED_EDIT_PARAM_RULES },
    sourceBlobKeys: ["maskCacheKey"],
  },
  // Workers AI inpainting runs on the free tier: $0, and shown as such in the
  // workflow cost estimate rather than hidden (null would mean "unknown").
  // FLUX Fill is flat-priced per image; gpt-image-2 uses the token estimator.
  estimateCost: (input) => {
    if (input.params.engine === "workers-ai") return 0;
    if (input.params.engine === "flux-fill") return FLUX_FILL_USD_PER_IMAGE;
    return estimateGenerationCost(input);
  },
  paid: true,
  // Draft mode's cheaper size/quality only applies to the gpt-image engine —
  // rewriting size/quality for the inpaint engines (which ignore both) would
  // change the signature and force a spurious re-run when toggling draft mode.
  draftOverride: (params) =>
    params.engine === "workers-ai" || params.engine === "flux-fill" ? params : generationDraftOverride(params),
  // The region (maskRegionX/Y/Width/Height) drives the memoization signature
  // like every other param here — an unchanged region+prompt+size/quality is
  // a cache hit; moving the rectangle produces a different signature. The FLUX
  // tuning knobs (fluxGuidance/fluxSeed) are signature-relevant for the same
  // reason: retuning guidance must produce a fresh render, not a cache hit.
  persistBlobKeys: (_nodeId, params) => (params.maskCacheKey ? [params.maskCacheKey] : []),
};
