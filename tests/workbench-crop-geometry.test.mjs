import assert from "node:assert/strict";
import test from "node:test";

import {
  fitTransform,
  movePixelRect,
  normalizePixelRect,
  parsePolygon,
  pixelRectToFraction,
  polygonBounds,
  resizePixelRect,
  screenToImage,
  imageToScreen,
  selectionFromParams,
  serializePolygon,
  zoomAround,
} from "../app/components/workbench/nodes/crop-geometry.ts";

test("screen/image conversion round-trips under zoom and pan", () => {
  const view = { scale: 3.5, offsetX: -120.25, offsetY: 44 };
  const image = { x: 812.4, y: 301.9 };
  const back = screenToImage(imageToScreen(image, view), view);
  assert.ok(Math.abs(back.x - image.x) < 1e-9);
  assert.ok(Math.abs(back.y - image.y) < 1e-9);
});

test("zoomAround keeps the image point under the cursor fixed and clamps the scale", () => {
  const view = fitTransform(4000, 3000, 1200, 800);
  const anchor = { x: 300, y: 200 };
  const before = screenToImage(anchor, view);
  const zoomed = zoomAround(view, 2, anchor);
  const after = screenToImage(anchor, zoomed);
  assert.ok(Math.abs(before.x - after.x) < 1e-9);
  assert.ok(Math.abs(before.y - after.y) < 1e-9);
  assert.equal(zoomAround(view, 1000, anchor).scale, 8);
  assert.equal(zoomAround(view, 0.0001, anchor).scale, 0.05);
});

test("fitTransform never upscales past 1:1 and centres the image", () => {
  const view = fitTransform(400, 300, 1200, 800);
  assert.equal(view.scale, 1);
  assert.equal(view.offsetX, 400);
  assert.equal(view.offsetY, 250);
});

test("resizePixelRect moves only the owned edges and keeps a 1px minimum", () => {
  const rect = { x: 100, y: 100, width: 200, height: 100 };
  const east = resizePixelRect(rect, "e", { x: 450, y: 999 }, 1000, 1000);
  assert.deepEqual(east, { x: 100, y: 100, width: 350, height: 100 });
  const collapsed = resizePixelRect(rect, "w", { x: 900, y: 0 }, 1000, 1000);
  assert.equal(collapsed.width, 1);
  assert.equal(collapsed.x, 299);
  const nw = resizePixelRect(rect, "nw", { x: -50, y: -50 }, 1000, 1000);
  assert.deepEqual(nw, { x: 0, y: 0, width: 300, height: 200 });
});

test("movePixelRect slides back inside the image without changing size", () => {
  const moved = movePixelRect({ x: 900, y: 10, width: 200, height: 50 }, 500, -100, 1000, 800);
  assert.deepEqual(moved, { x: 800, y: 0, width: 200, height: 50 });
});

test("normalizePixelRect accepts any two corners and clamps to the image", () => {
  const rect = normalizePixelRect({ x: 700, y: 900 }, { x: -20, y: 100 }, 640, 480);
  assert.deepEqual(rect, { x: 0, y: 100, width: 640, height: 380 });
});

test("pixel rect converts to fractions and back within rounding", () => {
  const fraction = pixelRectToFraction({ x: 123, y: 456, width: 789, height: 321 }, 3000, 2000);
  assert.ok(Math.abs(fraction.x - 0.041) < 1e-9);
  assert.ok(Math.abs(fraction.width - 0.263) < 1e-9);
});

test("polygon serialization round-trips and rejects malformed input", () => {
  const points = [{ x: 0.1, y: 0.2 }, { x: 0.9, y: 0.2 }, { x: 0.5, y: 0.95 }];
  const parsed = parsePolygon(serializePolygon(points));
  assert.equal(parsed.length, 3);
  assert.ok(Math.abs(parsed[2].y - 0.95) < 1e-5);
  assert.equal(parsePolygon(""), null);
  assert.equal(parsePolygon("0.1,0.2,0.3,0.4"), null); // two points is not a polygon
  assert.equal(parsePolygon("0.1,0.2,0.3,0.4,1.5,0.1"), null); // out of range
  assert.equal(parsePolygon("0.1,0.2,0.3,0.4,0.5"), null); // odd count
  assert.equal(parsePolygon(42), null);
});

test("selectionFromParams prefers a valid polygon and derives its bounding rect", () => {
  const selection = selectionFromParams({ cropX: 0, cropY: 0, cropWidth: 1, cropHeight: 1, cropPolygon: "0.2,0.1,0.8,0.1,0.5,0.7" });
  assert.equal(selection.kind, "polygon");
  assert.ok(Math.abs(selection.rect.x - 0.2) < 1e-9);
  assert.ok(Math.abs(selection.rect.width - 0.6) < 1e-9);
  assert.ok(Math.abs(selection.rect.height - 0.6) < 1e-9);
  const rect = selectionFromParams({ cropX: 0.25, cropY: 0.25, cropWidth: 0.5, cropHeight: 0.5, cropPolygon: "" });
  assert.equal(rect.kind, "rect");
  assert.deepEqual(rect.rect, { x: 0.25, y: 0.25, width: 0.5, height: 0.5 });
  assert.deepEqual(polygonBounds([]), { x: 0, y: 0, width: 1, height: 1 });
});
