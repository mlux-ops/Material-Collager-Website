import type { ImportParamRule, NodeManifest } from "../types";

// Zero-token client node: grafts an edited image back into an original through
// a drawn region, feathered so the seam disappears and bit-identical outside
// the region. It generalizes the compositor Masked Edit already runs on its own
// output (maskedEdit.tsx compositeShapesEdit) into a standalone step, so an
// edit produced ANYWHERE in the graph -- a gpt-image edit that took reference
// images, a Crop fed through its own branch, a hand-retouched upload -- can be
// patched back with the same protection guarantee.
//
// This exists because the pixel-exact engines and the reference-capable engines
// are disjoint: FLUX.1 Fill takes a mask but has no reference input, while
// gpt-image-2 and the FLUX.2 family take references but treat a mask as
// guidance at best. Separating "edit" from "patch" means the edit step can use
// whichever model has the right inputs, and this node supplies the precision.

export const PATCH_FIT_MODES = ["auto", "aligned", "region"] as const;
export type PatchFit = (typeof PATCH_FIT_MODES)[number];

// Feather is a percentage of the base image's short edge rather than a pixel
// count, so the same graph produces the same seam at any resolution. 0.9%
// matches the band Masked Edit's own compositor uses.
export const PATCH_FEATHER_MIN = 0;
export const PATCH_FEATHER_MAX = 10;
export const PATCH_FEATHER_DEFAULT = 0.9;
// An absolute ceiling on the derived pixel radius: a huge feather on a huge
// image would blur the patch into a smear rather than a seam.
export const PATCH_FEATHER_MAX_PX = 200;

export function clampPatchFeather(value: unknown): number {
  if (value === undefined || value === null || value === "") return PATCH_FEATHER_DEFAULT;
  const feather = Number(value);
  if (!Number.isFinite(feather)) return PATCH_FEATHER_DEFAULT;
  return Math.min(PATCH_FEATHER_MAX, Math.max(PATCH_FEATHER_MIN, feather));
}

export function featherRadiusPx(featherPercent: number, width: number, height: number): number {
  const shortEdge = Math.max(1, Math.min(width, height));
  return Math.min(PATCH_FEATHER_MAX_PX, Math.round((featherPercent / 100) * shortEdge));
}

// Two ways a patch image can relate to the base:
//
// - "aligned": the patch is the same framing as the base (a full-frame model
//   edit). Masked pixels are sampled from it 1:1 after scaling to the base's
//   dimensions.
// - "region": the patch is a crop of just the marked area, so it is drawn into
//   the region's bounding box.
//
// "auto" picks whichever the patch's aspect ratio is closer to, compared in log
// space so the comparison is symmetric -- a 2:1 patch is equally far from 1:1
// and 4:1. Ties go to "aligned", which is the safer failure: a mis-detected
// aligned patch shows the wrong content inside the region, while a mis-detected
// region patch stretches the whole frame into it.
export function resolvePatchFit(
  mode: PatchFit | undefined,
  patchAspect: number,
  baseAspect: number,
  regionAspect: number,
): "aligned" | "region" {
  if (mode === "aligned" || mode === "region") return mode;
  if (!Number.isFinite(patchAspect) || patchAspect <= 0) return "aligned";
  const distance = (a: number, b: number) =>
    Number.isFinite(a) && Number.isFinite(b) && a > 0 && b > 0 ? Math.abs(Math.log(a / b)) : Number.POSITIVE_INFINITY;
  return distance(patchAspect, regionAspect) < distance(patchAspect, baseAspect) ? "region" : "aligned";
}

// Colour matching needs enough same-content pixels just outside the region to
// measure drift against; below this the statistics are noise and the correction
// is skipped rather than guessed.
export const PATCH_COLOR_MATCH_MIN_SAMPLES = 200;
// Gain bounds keep a bad sample from blowing out the patch: beyond roughly 2x
// the correction is no longer fixing exposure drift, it is inventing contrast.
export const PATCH_COLOR_GAIN_MIN = 0.5;
export const PATCH_COLOR_GAIN_MAX = 2;

export type ChannelCorrection = { gain: number; offset: number };

// Match one channel's mean and spread to the base's. Returns the identity
// correction when the patch channel is flat (std ~ 0), where a gain is
// meaningless and only the offset carries information.
export function channelCorrection(
  baseMean: number,
  baseStd: number,
  patchMean: number,
  patchStd: number,
): ChannelCorrection {
  const gain = patchStd > 1e-6
    ? Math.min(PATCH_COLOR_GAIN_MAX, Math.max(PATCH_COLOR_GAIN_MIN, baseStd / patchStd))
    : 1;
  return { gain, offset: baseMean - gain * patchMean };
}

export const PATCH_PARAM_RULES = {
  // Same normalized 0-1000 MaskShape[] convention as Masked Edit, whose modal
  // and geometry helpers this node reuses.
  maskShapes: { type: "string", optional: true, maxLength: 40000 },
  maskRegionX: { type: "number", optional: true, min: 0, max: 1000 },
  maskRegionY: { type: "number", optional: true, min: 0, max: 1000 },
  maskRegionWidth: { type: "number", optional: true, min: 0, max: 1000 },
  maskRegionHeight: { type: "number", optional: true, min: 0, max: 1000 },
  patchFit: { type: "enum", optional: true, values: PATCH_FIT_MODES },
  patchFeather: { type: "number", optional: true, min: PATCH_FEATHER_MIN, max: PATCH_FEATHER_MAX },
  patchColorMatch: { type: "boolean", optional: true },
} satisfies Record<string, ImportParamRule>;

export const patchManifest: NodeManifest = {
  kind: "patch",
  spec: {
    kind: "patch",
    title: "Patch",
    description:
      "Graft an edited image back into the original through a drawn region — feathered seam, colour-matched, bit-identical outside the region (zero API cost).",
    inputs: [
      { id: "base", kind: "image", label: "Original", required: true },
      { id: "patch", kind: "image", label: "Edited", required: true },
    ],
    outputs: [{ id: "image", kind: "image", label: "Image" }],
  },
  defaultParams: {
    patchFit: "auto",
    patchFeather: PATCH_FEATHER_DEFAULT,
    patchColorMatch: true,
  },
  importSchema: {
    paramKeys: { ...PATCH_PARAM_RULES },
    // The region is re-rendered from maskShapes at execute time, so unlike
    // Masked Edit this node caches no mask blob and owns no uploaded bytes.
    sourceBlobKeys: [],
  },
};
