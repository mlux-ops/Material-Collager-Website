/**
 * compare-split
 * -------------
 * Pure geometry and timing for <CompareStage> (app/components/CompareStage.tsx):
 * a NEW render drawn over the PREVIOUS one, split by a vertical divider.
 *
 * The split is a percentage of the stage width, 0..100, measured from the
 * left edge. The NEW image is visible from the left edge up to the split; the
 * PREVIOUS image shows to the right of it. 100 is the rest position (NEW fully
 * shown, divider at the right edge).
 *
 * No React, no DOM types, no `@/` alias, so a test can import this file
 * directly under `node --experimental-strip-types`.
 */

/** Rest position: the NEW image fully shown, divider at the right edge. */
export const SPLIT_REST = 100;

/** Width of the divider's pointer grab area, in CSS px. */
export const HANDLE_GRAB_PX = 38;

/** The app's wipe duration (--wipe-dur in app/motion-tokens.css). */
export const WIPE_DEFAULT_MS = 700;

/**
 * Clamp a split to 0..100. NaN reads as the rest position (100), so a bad
 * value never hides the new image; -Infinity is 0 and +Infinity is 100.
 */
export function clampSplit(value: number): number {
  if (Number.isNaN(value)) return SPLIT_REST;
  if (value <= 0) return 0;
  if (value >= 100) return 100;
  return value;
}

/**
 * The split under a pointer at `clientX`, for a stage whose left edge is at
 * `left` and which is `width` px wide (both from getBoundingClientRect).
 * Left of the stage is 0, right of it is 100. A zero, negative or
 * non-finite width has no meaningful split and reads as the rest position.
 */
export function splitFromPointer(clientX: number, left: number, width: number): number {
  if (!Number.isFinite(width) || width <= 0) return SPLIT_REST;
  return clampSplit(((clientX - left) / width) * 100);
}

/** Round to 4 decimals so CSS strings stay short and stable. */
function tidy(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * The NEW image's clip-path for a split: visible from the left edge to the
 * split, clipped away to the right of it. At 0 this equals the `from` frame
 * of `mc-plotter-wipe` in app/effects.css (`inset(0 100% 0 0)`); at 100 it
 * clips nothing.
 */
export function clipPathForSplit(split: number): string {
  const s = clampSplit(split);
  return `inset(0 ${tidy(100 - s)}% 0 0)`;
}

/**
 * CSS `left` for the 1px divider line. Moves linearly from `0px` at split 0
 * to `calc(100% - 1px)` at split 100, so the line always sits inside the
 * frame (a parent with `overflow: hidden` would clip a line at `left: 100%`)
 * and stays within one pixel of the clip edge everywhere in between.
 */
export function dividerLeft(split: number): string {
  const s = clampSplit(split);
  return `calc(${tidy(s)}% - ${tidy(s / 100)}px)`;
}

/**
 * CSS `left` for the divider's grab area: centred on the split, but clamped
 * so the whole grab area stays inside the frame, at the edges included.
 */
export function handleLeft(split: number, grabPx: number = HANDLE_GRAB_PX): string {
  const s = clampSplit(split);
  const half = tidy(grabPx / 2);
  return `clamp(0px, calc(${tidy(s)}% - ${half}px), calc(100% - ${tidy(grabPx)}px))`;
}

/**
 * Parse a CSS time (`700ms`, `0.7s`, ` 450ms `) to milliseconds. Anything
 * unparseable, negative or non-finite returns `fallback`.
 */
export function parseDurationMs(value: string | null | undefined, fallback: number = WIPE_DEFAULT_MS): number {
  if (typeof value !== "string") return fallback;
  const match = value.trim().match(/^(-?\d*\.?\d+)(ms|s)$/i);
  if (!match) return fallback;
  const amount = Number(match[1]);
  const ms = match[2].toLowerCase() === "s" ? amount * 1000 : amount;
  if (!Number.isFinite(ms) || ms < 0) return fallback;
  return ms;
}

/**
 * A CSS cubic-bezier(x1, y1, x2, y2) timing function as a plain function of
 * time 0..1 -> progress. Solves x(t) = time for the curve parameter with
 * Newton's method, falling back to bisection where the slope is too flat,
 * then returns y(t). Input outside 0..1 is clamped.
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (time: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const slopeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;

  const solveT = (x: number): number => {
    let t = x;
    for (let i = 0; i < 8; i += 1) {
      const error = sampleX(t) - x;
      if (Math.abs(error) < 1e-7) return t;
      const slope = slopeX(t);
      if (Math.abs(slope) < 1e-6) break;
      t -= error / slope;
    }
    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < 40; i += 1) {
      const value = sampleX(t);
      if (Math.abs(value - x) < 1e-7) return t;
      if (value < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return t;
  };

  return (time: number): number => {
    if (Number.isNaN(time) || time <= 0) return 0;
    if (time >= 1) return 1;
    return sampleY(solveT(time));
  };
}

/** The app's wipe easing, --wipe-ease: cubic-bezier(0.22, 1, 0.36, 1). */
export const easeWipe = cubicBezier(0.22, 1, 0.36, 1);

/**
 * The split at `elapsedMs` into an arrival wipe of `durationMs`: eased from 0
 * to 100. A zero or invalid duration is already finished (100).
 */
export function wipeSplitAt(elapsedMs: number, durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return SPLIT_REST;
  return clampSplit(easeWipe(elapsedMs / durationMs) * 100);
}
