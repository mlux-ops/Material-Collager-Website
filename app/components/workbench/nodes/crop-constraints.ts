// Aspect-ratio and exact-size locks for the Crop editor. Pure, DOM-free.
//
// Sunburst renders only sizes whose edges are multiples of 16 with an aspect
// between 1:3 and 3:1 (and within pixel bounds). A rectangle drawn on that
// grid is emitted pixel-for-pixel; anything else gets resampled to the
// nearest valid size, which subtly changes its aspect. These helpers let the
// editor hold a chosen ratio while dragging, snap to the 16px grid, and
// report how a shape measures up against those limits.

import { resizePixelRect, type PixelRect, type Point, type RectHandle } from "./crop-geometry.ts";

export const EDIT_GRID = 16;
export const ASPECT_MIN = 1 / 3;
export const ASPECT_MAX = 3;
export const PIXEL_FLOOR = 655_360;
export const PIXEL_CEILING = 8_294_400;
export const MAX_EDGE = 3840;

export type AspectLock = { w: number; h: number } | null; // null = free

export const ASPECT_PRESETS: Array<{ label: string; value: string }> = [
  { label: "Free", value: "" },
  { label: "1:1", value: "1:1" },
  { label: "4:3", value: "4:3" },
  { label: "3:2", value: "3:2" },
  { label: "16:9", value: "16:9" },
  { label: "3:4", value: "3:4" },
  { label: "2:3", value: "2:3" },
  { label: "9:16", value: "9:16" },
];

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

export function parseAspect(value: unknown): AspectLock {
  if (typeof value !== "string") return null;
  const match = /^(\d{1,4})\s*[:x]\s*(\d{1,4})$/.exec(value.trim());
  if (!match) return null;
  const w = Number(match[1]);
  const h = Number(match[2]);
  if (!w || !h) return null;
  const g = gcd(w, h);
  return { w: w / g, h: h / g };
}

export function serializeAspect(lock: AspectLock): string {
  return lock ? `${lock.w}:${lock.h}` : "";
}

// The smallest (w,h) step that keeps BOTH edges on the 16px grid AND the
// ratio exact: 16*w' x 16*h' for the reduced ratio. When that step is too
// coarse to be useful (a ratio like 1113:1062) return null and callers fall
// back to snapping each edge independently.
export function exactStepFor(lock: AspectLock, grid = EDIT_GRID): { w: number; h: number } | null {
  if (!lock) return null;
  const step = { w: lock.w * grid, h: lock.h * grid };
  return Math.max(step.w, step.h) > 512 ? null : step;
}

export type RectConstraint = { lock: AspectLock; grid: boolean };

// Fit a free-form size to the constraint. Ratio wins over the raw drag: the
// result is the largest constrained rect that fits inside (w,h). With grid,
// edges land on multiples of 16 (or of the exact step when the ratio allows).
export function constrainSize(width: number, height: number, constraint: RectConstraint): { width: number; height: number } {
  let w = Math.max(1, width);
  let h = Math.max(1, height);
  if (constraint.lock) {
    const ratio = constraint.lock.w / constraint.lock.h;
    if (w / h > ratio) w = h * ratio;
    else h = w / ratio;
  }
  if (constraint.grid) {
    const step = exactStepFor(constraint.lock);
    if (step) {
      const n = Math.max(1, Math.floor(Math.min(w / step.w, h / step.h)));
      w = n * step.w;
      h = n * step.h;
    } else {
      w = Math.max(EDIT_GRID, Math.floor(w / EDIT_GRID) * EDIT_GRID);
      h = Math.max(EDIT_GRID, Math.floor(h / EDIT_GRID) * EDIT_GRID);
      if (constraint.lock) {
        // Keep the ratio as close as the grid allows, driven by the width.
        const ratio = constraint.lock.w / constraint.lock.h;
        h = Math.max(EDIT_GRID, Math.round(w / ratio / EDIT_GRID) * EDIT_GRID);
      }
    }
  }
  return { width: w, height: h };
}

// Constrained draw from an anchor corner toward the pointer: size is fitted
// to the constraint, then the rect grows from the anchor in the pointer's
// direction and is kept inside the image (shrinking if it would overflow).
export function constrainedDraw(anchor: Point, pointer: Point, imageWidth: number, imageHeight: number, constraint: RectConstraint): PixelRect {
  const px = Math.min(Math.max(pointer.x, 0), imageWidth);
  const py = Math.min(Math.max(pointer.y, 0), imageHeight);
  const right = px >= anchor.x;
  const down = py >= anchor.y;
  const availW = right ? imageWidth - anchor.x : anchor.x;
  const availH = down ? imageHeight - anchor.y : anchor.y;
  const rawW = Math.min(Math.abs(px - anchor.x), availW);
  const rawH = Math.min(Math.abs(py - anchor.y), availH);
  let { width, height } = constrainSize(rawW, rawH, constraint);
  // A ratio can push one edge past what is available; shrink to fit.
  if (width > availW || height > availH) {
    ({ width, height } = constrainSize(Math.min(width, availW), Math.min(height, availH), constraint));
  }
  return {
    x: right ? anchor.x : anchor.x - width,
    y: down ? anchor.y : anchor.y - height,
    width: Math.max(1, width),
    height: Math.max(1, height),
  };
}

// Constrained resize: corner handles behave as a draw anchored at the
// opposite corner; edge handles change one dimension and derive the other
// (when ratio-locked) around the rect's centre line.
export function constrainedResize(rect: PixelRect, handle: RectHandle, pointer: Point, imageWidth: number, imageHeight: number, constraint: RectConstraint): PixelRect {
  const free = resizePixelRect(rect, handle, pointer, imageWidth, imageHeight);
  if (!constraint.lock && !constraint.grid) return free;
  const isCorner = handle.length === 2;
  if (isCorner) {
    const anchor = {
      x: handle.includes("w") ? rect.x + rect.width : rect.x,
      y: handle.includes("n") ? rect.y + rect.height : rect.y,
    };
    return constrainedDraw(anchor, pointer, imageWidth, imageHeight, constraint);
  }
  const horizontal = handle === "e" || handle === "w";
  let { width, height } = free;
  if (constraint.lock) {
    const ratio = constraint.lock.w / constraint.lock.h;
    if (horizontal) height = width / ratio;
    else width = height * ratio;
  }
  ({ width, height } = constrainSize(width, height, constraint));
  width = Math.min(width, imageWidth);
  height = Math.min(height, imageHeight);
  // Anchor the untouched edge; centre the derived dimension.
  let x = handle === "w" ? rect.x + rect.width - width : rect.x;
  let y = handle === "n" ? rect.y + rect.height - height : rect.y;
  if (constraint.lock) {
    if (horizontal) y = rect.y + rect.height / 2 - height / 2;
    else x = rect.x + rect.width / 2 - width / 2;
  }
  x = Math.min(Math.max(x, 0), imageWidth - width);
  y = Math.min(Math.max(y, 0), imageHeight - height);
  return { x, y, width, height };
}

// Snap an existing rect in place (keeping its top-left) to the constraint.
export function snapRect(rect: PixelRect, imageWidth: number, imageHeight: number, constraint: RectConstraint): PixelRect {
  return constrainedDraw({ x: rect.x, y: rect.y }, { x: rect.x + rect.width, y: rect.y + rect.height }, imageWidth, imageHeight, constraint);
}

// Fitness of a crop against Sunburst's limits, for the editor's indicator.
export type CropFitness = {
  aspect: number;
  aspectOk: boolean; // within 1:3 .. 3:1
  onGrid: boolean; // both edges multiples of 16
  pixelsOk: boolean; // within floor..ceiling and edge limit
  exact: boolean; // output equals the crop pixel-for-pixel
};

export function cropFitness(width: number, height: number): CropFitness {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const aspect = w / h;
  const aspectOk = aspect >= ASPECT_MIN - 1e-9 && aspect <= ASPECT_MAX + 1e-9;
  const onGrid = w % EDIT_GRID === 0 && h % EDIT_GRID === 0;
  const pixels = w * h;
  const pixelsOk = pixels >= PIXEL_FLOOR && pixels <= PIXEL_CEILING && Math.max(w, h) <= MAX_EDGE;
  return { aspect, aspectOk, onGrid, pixelsOk, exact: aspectOk && onGrid && pixelsOk };
}

// Human-readable aspect like "16:9" when it reduces neatly, else "1.39:1".
export function formatAspect(width: number, height: number): string {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const g = gcd(w, h);
  if (w / g <= 32 && h / g <= 32) return `${w / g}:${h / g}`;
  return w >= h ? `${(w / h).toFixed(2)}:1` : `1:${(h / w).toFixed(2)}`;
}
