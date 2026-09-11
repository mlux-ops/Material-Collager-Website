// Pure geometry for the Crop node and its fullscreen editor. No DOM, so the
// whole file is testable under node --experimental-strip-types.
//
// Two coordinate spaces matter here:
//   - image space: pixels of the source bitmap (0..width, 0..height)
//   - fraction space: 0..1 of the source, which is what the node persists so
//     the same crop survives a differently sized upstream image.
// The editor works in image space (so zoom never costs precision) and converts
// to fractions on apply.

export type FractionRect = { x: number; y: number; width: number; height: number };
export type PixelRect = { x: number; y: number; width: number; height: number };
export type Point = { x: number; y: number };

// Viewport transform for the editor: image pixel p maps to screen pixel
// p * scale + offset (screen coords relative to the editor surface).
export type ViewTransform = { scale: number; offsetX: number; offsetY: number };

export type RectHandle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export const MIN_FRACTION = 0.02;
export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 8;
export const MAX_POLYGON_POINTS = 200;

export function clampRect(rect: FractionRect): FractionRect {
  const x = Math.min(Math.max(rect.x, 0), 1 - MIN_FRACTION);
  const y = Math.min(Math.max(rect.y, 0), 1 - MIN_FRACTION);
  const width = Math.min(Math.max(rect.width, MIN_FRACTION), 1 - x);
  const height = Math.min(Math.max(rect.height, MIN_FRACTION), 1 - y);
  return { x, y, width, height };
}

export function fractionRectToPixels(rect: FractionRect, width: number, height: number): PixelRect {
  return {
    x: Math.round(rect.x * width),
    y: Math.round(rect.y * height),
    width: Math.max(1, Math.round(rect.width * width)),
    height: Math.max(1, Math.round(rect.height * height)),
  };
}

export function pixelRectToFraction(rect: PixelRect, width: number, height: number): FractionRect {
  if (!width || !height) return { x: 0, y: 0, width: 1, height: 1 };
  return clampRect({ x: rect.x / width, y: rect.y / height, width: rect.width / width, height: rect.height / height });
}

// Normalise a rect drawn from any two corners into positive width/height,
// clamped to the image bounds. Min size is one pixel so a click never yields
// an empty crop.
export function normalizePixelRect(a: Point, b: Point, width: number, height: number): PixelRect {
  const x0 = Math.min(Math.max(Math.min(a.x, b.x), 0), width);
  const y0 = Math.min(Math.max(Math.min(a.y, b.y), 0), height);
  const x1 = Math.min(Math.max(Math.max(a.x, b.x), 0), width);
  const y1 = Math.min(Math.max(Math.max(a.y, b.y), 0), height);
  return { x: x0, y: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) };
}

// Move one edge/corner of a pixel rect to follow the pointer. Edges the
// handle does not own stay put; the result is clamped to the image and kept
// at least one pixel in each dimension.
export function resizePixelRect(rect: PixelRect, handle: RectHandle, point: Point, width: number, height: number): PixelRect {
  let left = rect.x;
  let top = rect.y;
  let right = rect.x + rect.width;
  let bottom = rect.y + rect.height;
  const px = Math.min(Math.max(point.x, 0), width);
  const py = Math.min(Math.max(point.y, 0), height);
  if (handle.includes("w")) left = Math.min(px, right - 1);
  if (handle.includes("e")) right = Math.max(px, left + 1);
  if (handle.includes("n")) top = Math.min(py, bottom - 1);
  if (handle.includes("s")) bottom = Math.max(py, top + 1);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

// Translate a rect by a delta, sliding it back inside the image if it would
// leave the bounds (size is preserved).
export function movePixelRect(rect: PixelRect, dx: number, dy: number, width: number, height: number): PixelRect {
  const x = Math.min(Math.max(rect.x + dx, 0), Math.max(0, width - rect.width));
  const y = Math.min(Math.max(rect.y + dy, 0), Math.max(0, height - rect.height));
  return { ...rect, x, y };
}

export function screenToImage(point: Point, view: ViewTransform): Point {
  return { x: (point.x - view.offsetX) / view.scale, y: (point.y - view.offsetY) / view.scale };
}

export function imageToScreen(point: Point, view: ViewTransform): Point {
  return { x: point.x * view.scale + view.offsetX, y: point.y * view.scale + view.offsetY };
}

// Fit-to-surface transform: the largest scale that shows the whole image,
// centred. Never upscales beyond 1:1 by default so small images stay crisp.
export function fitTransform(imageWidth: number, imageHeight: number, surfaceWidth: number, surfaceHeight: number): ViewTransform {
  if (!imageWidth || !imageHeight || !surfaceWidth || !surfaceHeight) return { scale: 1, offsetX: 0, offsetY: 0 };
  const scale = Math.min(surfaceWidth / imageWidth, surfaceHeight / imageHeight, 1);
  return {
    scale,
    offsetX: (surfaceWidth - imageWidth * scale) / 2,
    offsetY: (surfaceHeight - imageHeight * scale) / 2,
  };
}

// Zoom by a factor while keeping the image point under `anchor` (screen
// coords) fixed on screen -- the "zoom around the cursor" behaviour.
export function zoomAround(view: ViewTransform, factor: number, anchor: Point, minScale = MIN_ZOOM, maxScale = MAX_ZOOM): ViewTransform {
  const scale = Math.min(Math.max(view.scale * factor, minScale), maxScale);
  const ratio = scale / view.scale;
  return {
    scale,
    offsetX: anchor.x - (anchor.x - view.offsetX) * ratio,
    offsetY: anchor.y - (anchor.y - view.offsetY) * ratio,
  };
}

export function panBy(view: ViewTransform, dx: number, dy: number): ViewTransform {
  return { ...view, offsetX: view.offsetX + dx, offsetY: view.offsetY + dy };
}

// ---- Polygon crops -------------------------------------------------------
// Stored as a single comma-separated string of alternating x,y fractions
// ("0.1,0.2,0.9,0.2,0.5,0.9") because the import validator only knows
// primitives. Three or more points make a polygon; anything else means
// "no polygon" and the node falls back to the rectangle params.

export function parsePolygon(value: unknown): Point[] | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const numbers = value.split(",").map((part) => Number(part.trim()));
  if (numbers.length < 6 || numbers.length % 2 !== 0) return null;
  if (numbers.some((n) => !Number.isFinite(n) || n < 0 || n > 1)) return null;
  const points: Point[] = [];
  for (let index = 0; index < numbers.length && points.length < MAX_POLYGON_POINTS; index += 2) {
    points.push({ x: numbers[index], y: numbers[index + 1] });
  }
  return points.length >= 3 ? points : null;
}

export function serializePolygon(points: Point[]): string {
  return points
    .map((p) => `${clamp01(p.x).toFixed(5)},${clamp01(p.y).toFixed(5)}`)
    .join(",");
}

export function polygonBounds(points: Point[]): FractionRect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 1, height: 1 };
  return { x: minX, y: minY, width: Math.max(maxX - minX, 0), height: Math.max(maxY - minY, 0) };
}

export function fractionPointsToPixels(points: Point[], width: number, height: number): Point[] {
  return points.map((p) => ({ x: p.x * width, y: p.y * height }));
}

export function pixelPointsToFraction(points: Point[], width: number, height: number): Point[] {
  if (!width || !height) return [];
  return points.map((p) => ({ x: clamp01(p.x / width), y: clamp01(p.y / height) }));
}

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

// Which crop the node will actually apply given its params: a polygon wins
// when present and valid, otherwise the rectangle.
export type CropSelection =
  | { kind: "rect"; rect: FractionRect }
  | { kind: "polygon"; points: Point[]; rect: FractionRect };

export function selectionFromParams(params: {
  cropX?: unknown;
  cropY?: unknown;
  cropWidth?: unknown;
  cropHeight?: unknown;
  cropPolygon?: unknown;
}): CropSelection {
  const polygon = parsePolygon(params.cropPolygon);
  if (polygon) {
    const rect = clampRect(polygonBounds(polygon));
    return { kind: "polygon", points: polygon, rect };
  }
  return {
    kind: "rect",
    rect: clampRect({
      x: Number(params.cropX) || 0,
      y: Number(params.cropY) || 0,
      width: Number(params.cropWidth) || 1,
      height: Number(params.cropHeight) || 1,
    }),
  };
}
