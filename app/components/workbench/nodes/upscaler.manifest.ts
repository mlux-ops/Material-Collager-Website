import { smallestValidEditSize } from "../../../lib/image-edit.ts";
import type { CostEstimateInput, ImportParamRule, NodeManifest, WorkbenchParams } from "../types";
import { estimateGenerationCost, GENERATION_QUALITIES } from "./generation.ts";

// Valid gpt-image-2 target sizes for upscaling, clamped to a 3840x2160
// ceiling (all divisible by 16, aspect within 1:3-3:1, total pixels within
// 655,360-8,294,400 — the same bounds validateEditSize enforces server-side;
// this list is just the client's menu of options, not a reimplementation of
// that validation).
export const UPSCALE_SIZES = ["1536x1024", "2048x2048", "2560x1440", "3200x1792", "3840x2160"] as const;
const DEFAULT_UPSCALE_SIZE: (typeof UPSCALE_SIZES)[number] = "2560x1440";
// 2048px+ on the longest edge is the buffered-run risk zone (idle-gateway
// timeouts on a 200-250s+ call); the UI surfaces a visible warning for these.
export const UPSCALE_LONG_RUN_THRESHOLD = 2048;

export const UPSCALER_PARAM_RULES = {
  size: { type: "enum", optional: true, values: UPSCALE_SIZES },
  quality: { type: "enum", optional: true, values: GENERATION_QUALITIES },
} satisfies Record<string, ImportParamRule>;

// N-10: each menu option's own SMALL, aspect-preserving draft counterpart --
// precomputed once, from the fixed UPSCALE_SIZES list only, via the same
// smallestValidEditSize solve draft mode uses everywhere else. Two menu
// options that share an aspect ratio (2560x1440 and 3840x2160 are both
// 16:9) collapse to the same small size, so this is a small (<=5-entry) set,
// not a 1:1 map -- only the SET matters to resolveUpscaleSize below.
const UPSCALE_DRAFT_SIZE_SET = new Set(
  UPSCALE_SIZES.map((option) => {
    const [width, height] = option.split("x").map(Number);
    const small = smallestValidEditSize(width, height);
    return `${small.width}x${small.height}`;
  }),
);

// issue-7/AC10: the card's own <select> only ever writes a UPSCALE_SIZES
// member, and the import validator's "enum" rule already rejects anything
// else on import -- but the GENERIC inspector (Inspector.tsx's free-text
// param editor) can write params.size to ANY string. Resolves any requested
// value to the nearest supported menu target by total pixel count (an exact
// UPSCALE_SIZES member always resolves to itself unchanged); an unparseable
// value falls back to the node's own default. Used uniformly wherever
// params.size is read for this node -- estimating, signing (stableParams),
// warning display, and submitting -- so all four always agree on the SAME
// resolved size instead of a raw value reaching the server unclamped.
//
// N-10: also passes through any of UPSCALE_DRAFT_SIZE_SET's small sizes
// unchanged. Before this, ANY non-menu-member size -- including this node's
// OWN draft override's deliberately-shrunk output -- was unconditionally
// re-snapped back up to the nearest FULL menu option, silently undoing the
// shrink (every draft run collapsed to the smallest full option, ~2.4x more
// expensive than intended) and, for the square 2048x2048 target, drifting
// its aspect ratio from 1:1 to 3:2 on a node whose entire purpose is to
// preserve composition. A garbage/arbitrary generic-Inspector string that
// merely happens to be a well-formed WxH is NOT in this small, fixed set, so
// it still degrades via the ordinary nearest-menu snap below, unchanged.
export function resolveUpscaleSize(requested: string | undefined): string {
  if (requested && (UPSCALE_SIZES as readonly string[]).includes(requested)) return requested;
  if (requested && UPSCALE_DRAFT_SIZE_SET.has(requested)) return requested;
  const match = requested ? /^(\d+)x(\d+)$/.exec(requested) : null;
  if (!match) return DEFAULT_UPSCALE_SIZE;
  const requestedPixels = Number(match[1]) * Number(match[2]);
  let best: (typeof UPSCALE_SIZES)[number] = UPSCALE_SIZES[0];
  let bestDiff = Infinity;
  for (const option of UPSCALE_SIZES) {
    const [width, height] = option.split("x").map(Number);
    const diff = Math.abs(width * height - requestedPixels);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = option;
    }
  }
  return best;
}

function estimateUpscalerCost({ params, inputImages }: CostEstimateInput): number | null {
  return estimateGenerationCost({ params: { ...params, size: resolveUpscaleSize(params.size) }, inputImages });
}

function upscalerStableParams(params: WorkbenchParams): Partial<WorkbenchParams> {
  return { ...params, size: resolveUpscaleSize(params.size) };
}

// N-10: the Upscaler's OWN draft override (distinct from the generic
// generationDraftOverride every other draft-capable node uses, which parses
// params.size directly and would produce a size resolveUpscaleSize could
// re-snap). Resolves the CURRENT selection to its canonical menu size first
// (so a garbage/generic-Inspector value degrades exactly the way it always
// does), then shrinks THAT SPECIFIC option to the smallest valid size AT ITS
// OWN ASPECT RATIO. Because resolveUpscaleSize recognizes every one of these
// small sizes (UPSCALE_DRAFT_SIZE_SET, above) and passes it through
// unchanged, the four read sites (estimate/sign/display/submit) never
// re-snap this value back up to a full-size menu option.
function upscalerDraftOverride(params: WorkbenchParams): WorkbenchParams {
  const current = resolveUpscaleSize(params.size);
  const [width, height] = current.split("x").map(Number);
  const small = smallestValidEditSize(width, height);
  return { ...params, quality: "low", size: `${small.width}x${small.height}` };
}

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
  defaultParams: { size: DEFAULT_UPSCALE_SIZE, quality: "high" },
  importSchema: {
    paramKeys: { ...UPSCALER_PARAM_RULES },
    sourceBlobKeys: [],
  },
  estimateCost: estimateUpscalerCost,
  paid: true,
  stableParams: upscalerStableParams,
  draftOverride: upscalerDraftOverride,
};
