/**
 * Reference loupe — where the magnifier sits and what it shows when the
 * pointer hovers a generator reference-tray thumbnail
 * (app/components/ReferenceLoupe.tsx, effects.css `.reference-loupe`).
 *
 * The loupe is one fixed-position box for the whole tray, moved with a
 * transform and painted with the thumbnail's own already-loaded image as a
 * CSS background. Everything it needs to decide per frame lives here, as
 * plain numbers in and plain numbers (or CSS strings) out, so the rules can
 * be tested without a DOM:
 *
 *  - placement: beside the pointer, never under it (the designer is looking
 *    at the spot the pointer covers), flipped away from an edge it would
 *    cross, and clamped so it never leaves the viewport;
 *  - the image rect: thumbnails are `object-fit: contain` in a square wrap,
 *    so the pixels occupy a centred, letterboxed rect inside the element's
 *    box, and the sample has to be taken against that rect, not the box;
 *  - the sample: a background scaled `zoom`x relative to the thumbnail as
 *    displayed, positioned so the point under the pointer sits at the
 *    loupe's centre.
 *
 * Import-free so node --test can load it directly (tests/loupe.test.mjs).
 */

/** Loupe edge, px. The box is square; effects.css carries the same 148px. */
export const LOUPE_SIZE = 148;
/** Magnification relative to the thumbnail as it is drawn on screen. */
export const LOUPE_ZOOM = 2.5;
/** Gap between the pointer and the loupe's nearest corner, px. */
export const LOUPE_OFFSET = 18;
/** Distance the loupe always keeps from the viewport edges, px. */
export const LOUPE_MARGIN = 8;

export interface LoupeRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface LoupePointer {
  clientX: number;
  clientY: number;
}

export interface LoupeViewport {
  width: number;
  height: number;
}

/** Viewport position of the loupe box's top-left corner. */
export interface LoupePlacement {
  x: number;
  y: number;
}

export interface LoupeImageFit {
  naturalWidth: number;
  naturalHeight: number;
}

export interface LoupeSample {
  backgroundSize: string;
  backgroundPosition: string;
  /** False over letterbox padding or off the image: the caller hides the loupe. */
  inside: boolean;
}

/**
 * "off": render nothing. "instant": show and hide with no fade.
 * "fade": show and hide on the motion tokens.
 */
export type LoupeMode = "off" | "instant" | "fade";

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function round2(value: number): number {
  // Adding 0 folds -0 into 0 so "-0px" never reaches a style string.
  return Math.round(value * 100) / 100 + 0;
}

/**
 * One axis of the placement: after the pointer by default, before it when
 * that would cross the far edge, then clamped into [margin, extent - margin
 * - size]. A viewport too small to hold the loupe pins it at the margin
 * rather than letting the clamp's bounds invert.
 */
function placeAxis(pointer: number, extent: number, size: number, offset: number, margin: number): number {
  let position = pointer + offset;
  if (position + size > extent - margin) position = pointer - offset - size;
  const max = extent - margin - size;
  if (max < margin) return margin;
  return Math.min(Math.max(position, margin), max);
}

/**
 * Where the loupe box goes for a pointer position: right of and below the
 * pointer, flipping left / above at the right / bottom edge, and always
 * fully inside the viewport (less the margin). Never returns NaN: any
 * non-finite input is read as 0.
 */
export function placeLoupe(
  pointer: LoupePointer,
  viewport: LoupeViewport,
  opts: { size?: number; offset?: number; margin?: number } = {},
): LoupePlacement {
  const size = Math.max(0, finite(opts.size ?? LOUPE_SIZE));
  const offset = finite(opts.offset ?? LOUPE_OFFSET);
  const margin = Math.max(0, finite(opts.margin ?? LOUPE_MARGIN));
  return {
    x: placeAxis(finite(pointer.clientX), finite(viewport.width), size, offset, margin),
    y: placeAxis(finite(pointer.clientY), finite(viewport.height), size, offset, margin),
  };
}

/**
 * The rect the image's pixels actually cover inside `frame` under
 * `object-fit: contain`: scaled to fit whole, centred, with the leftover
 * width (pillarbox) or height (letterbox) split evenly either side. Without
 * usable natural dimensions (not decoded, broken) the frame itself is
 * returned, which is what the element shows in that case anyway.
 */
export function containedImageRect(frame: LoupeRect, image: LoupeImageFit): LoupeRect {
  const naturalWidth = image.naturalWidth;
  const naturalHeight = image.naturalHeight;
  if (!(naturalWidth > 0) || !(naturalHeight > 0) || !Number.isFinite(naturalWidth) || !Number.isFinite(naturalHeight)) {
    return { left: frame.left, top: frame.top, width: frame.width, height: frame.height };
  }
  const scale = Math.min(frame.width / naturalWidth, frame.height / naturalHeight);
  if (!(scale > 0) || !Number.isFinite(scale)) {
    return { left: frame.left, top: frame.top, width: frame.width, height: frame.height };
  }
  const width = naturalWidth * scale;
  const height = naturalHeight * scale;
  return {
    left: frame.left + (frame.width - width) / 2,
    top: frame.top + (frame.height - height) / 2,
    width,
    height,
  };
}

/**
 * The loupe's background for a pointer over `imageRect`: the image drawn
 * `zoom`x its on-screen size, offset so the point under the pointer lands
 * at the loupe's centre. Sampling the displayed image (not the file's
 * natural size) keeps the magnification constant whatever the upload's
 * resolution, and the background is the thumbnail's own loaded URL, so it
 * costs no fetch.
 *
 * Values are rounded to 2 decimals so the style strings are stable. A
 * zero-size (or non-finite) rect yields an empty, hidden sample.
 */
export function sampleLoupe(
  pointer: LoupePointer,
  imageRect: LoupeRect,
  opts: { size?: number; zoom?: number } = {},
): LoupeSample {
  const size = finite(opts.size ?? LOUPE_SIZE);
  const zoom = finite(opts.zoom ?? LOUPE_ZOOM);
  const { left, top, width, height } = imageRect;
  if (
    !(width > 0) ||
    !(height > 0) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    !Number.isFinite(left) ||
    !Number.isFinite(top) ||
    !Number.isFinite(pointer.clientX) ||
    !Number.isFinite(pointer.clientY)
  ) {
    return { backgroundSize: "0px 0px", backgroundPosition: "0px 0px", inside: false };
  }
  const bgW = width * zoom;
  const bgH = height * zoom;
  const u = (pointer.clientX - left) / width;
  const v = (pointer.clientY - top) / height;
  const bgX = size / 2 - u * bgW;
  const bgY = size / 2 - v * bgH;
  const inside = u >= 0 && u <= 1 && v >= 0 && v <= 1;
  return {
    backgroundSize: `${round2(bgW)}px ${round2(bgH)}px`,
    backgroundPosition: `${round2(bgX)}px ${round2(bgY)}px`,
    inside,
  };
}

/**
 * Whether, and how, the loupe runs:
 *  - potato machine: "off" — it is decorative per-frame work, and the
 *    setting promises none.
 *  - coarse pointer (touch): "off" — there is no hover to follow; a finger
 *    would cover the spot anyway, and a tap must stay a tap.
 *  - reduced motion: "instant" — the loupe still follows the pointer (that
 *    motion is the user's own), but it appears and disappears without a fade.
 *  - otherwise: "fade" — opacity on --duration-quick / --ease-smooth-out.
 */
export function loupeMode(input: { potato: boolean; reduced: boolean; coarsePointer: boolean }): LoupeMode {
  if (input.potato || input.coarsePointer) return "off";
  if (input.reduced) return "instant";
  return "fade";
}
