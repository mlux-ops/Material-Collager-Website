// What a /api/generate collage render will be billed on, worked out in the
// browser before the click: the canvas the server will resolve, the quality
// tier it will run at, and how many images go up with it. The Generator and
// Review Boards paid buttons estimate from this, and record calibration
// against the same three values after a render succeeds, so the estimate and
// the learning always talk about the same bucket.
//
// Size and quality come from app/lib/collage.ts's resolvedSize and
// resolvedQuality -- the functions the generate route itself calls -- so the
// estimate can never price a canvas the server would not render.

import { resolvedQuality, resolvedSize, type CollageRequestInput } from "./collage.ts";
import { estimateRunBreakdownUsd, isEstimableQuality, type RunCostBreakdown } from "./image-cost.ts";

export type CollageRenderCostBasis = {
  /** The canvas the server resolves for this payload, e.g. "2048x1360". */
  size: string;
  /** The quality tier the server will actually run (Finals never below high). */
  quality: string;
  /** Every image the request uploads: references, plus a layout image when one rides along. */
  inputImages: number;
};

export function collageRenderCostBasis(payload: CollageRequestInput, inputImages: number): CollageRenderCostBasis {
  return { size: resolvedSize(payload), quality: resolvedQuality(payload), inputImages };
}

/**
 * The estimate for one single-image collage render, or null when the
 * estimator has no honest figure: a tier it has no factor for (xhigh, max,
 * auto) or a size that is not `WxH`. Callers show "usage-based" for null.
 */
export function estimateCollageRenderCost(basis: CollageRenderCostBasis): RunCostBreakdown | null {
  if (!isEstimableQuality(basis.quality)) return null;
  return estimateRunBreakdownUsd({ size: basis.size, quality: basis.quality, candidates: 1, inputImages: basis.inputImages });
}
