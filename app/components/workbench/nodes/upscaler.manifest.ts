import type { ImportParamRule, NodeManifest } from "../types";
import { estimateGenerationCost, GENERATION_QUALITIES, generationDraftOverride } from "./generation.ts";

// Valid gpt-image-2 target sizes for upscaling, clamped to a 3840x2160
// ceiling (all divisible by 16, aspect within 1:3-3:1, total pixels within
// 655,360-8,294,400 — the same bounds validateEditSize enforces server-side;
// this list is just the client's menu of options, not a reimplementation of
// that validation).
export const UPSCALE_SIZES = ["1536x1024", "2048x2048", "2560x1440", "3200x1792", "3840x2160"] as const;
// 2048px+ on the longest edge is the buffered-run risk zone (idle-gateway
// timeouts on a 200-250s+ call); the UI surfaces a visible warning for these.
export const UPSCALE_LONG_RUN_THRESHOLD = 2048;

export const UPSCALER_PARAM_RULES = {
  size: { type: "enum", optional: true, values: UPSCALE_SIZES },
  quality: { type: "enum", optional: true, values: GENERATION_QUALITIES },
} satisfies Record<string, ImportParamRule>;

// Buffered-only (no SSE) upscale over /api/workbench/edit. Target sizes clamp
// to valid gpt-image-2 dimensions (validateEditSize rules, reused not
// reinvented) with a 3840x2160 ceiling; the UI warns 2K+ buffered runs may
// fail on idle-gateway timeouts. Cancellation threads the client AbortSignal
// through the route into the upstream OpenAI fetch (see image-edit.ts /
// api/workbench/edit/route.ts). PAID edit-shaped node; high-res upscales are
// the ~$0.40 case the high-cost confirm guard targets. The DOM-touching
// execute wrapper lives in upscaler.tsx.
export const upscalerManifest: NodeManifest = {
  kind: "upscaler",
  spec: {
    kind: "upscaler",
    title: "Upscaler",
    description: "Upscale an image to a larger target size (buffered; long runs may time out).",
    inputs: [{ id: "image", kind: "image", label: "Image", required: true }],
    outputs: [{ id: "image", kind: "image", label: "Image" }],
    paid: true,
  },
  defaultParams: { size: "2560x1440", quality: "high" },
  importSchema: {
    paramKeys: { ...UPSCALER_PARAM_RULES },
    sourceBlobKeys: [],
  },
  estimateCost: estimateGenerationCost,
  paid: true,
  draftOverride: generationDraftOverride,
};
