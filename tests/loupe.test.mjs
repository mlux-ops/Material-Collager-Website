import test from "node:test";
import assert from "node:assert/strict";

const {
  LOUPE_MARGIN,
  LOUPE_OFFSET,
  LOUPE_SIZE,
  LOUPE_ZOOM,
  containedImageRect,
  loupeMode,
  placeLoupe,
  sampleLoupe,
} = await import("../app/lib/loupe.ts");

const VIEWPORT = { width: 1440, height: 900 };

test("the loupe sits right of and below the pointer by default", () => {
  const at = placeLoupe({ clientX: 400, clientY: 300 }, VIEWPORT);
  assert.deepEqual(at, { x: 400 + LOUPE_OFFSET, y: 300 + LOUPE_OFFSET });
});

test("it flips left of the pointer when it would cross the right edge", () => {
  const clientX = VIEWPORT.width - 60;
  const at = placeLoupe({ clientX, clientY: 300 }, VIEWPORT);
  assert.equal(at.x, clientX - LOUPE_OFFSET - LOUPE_SIZE);
  assert.equal(at.y, 300 + LOUPE_OFFSET);
});

test("it flips above the pointer when it would cross the bottom edge", () => {
  const clientY = VIEWPORT.height - 40;
  const at = placeLoupe({ clientX: 400, clientY }, VIEWPORT);
  assert.equal(at.x, 400 + LOUPE_OFFSET);
  assert.equal(at.y, clientY - LOUPE_OFFSET - LOUPE_SIZE);
});

test("after flipping it is clamped inside the viewport margins", () => {
  // Near the top-right corner on a short viewport: flipped left, and the
  // vertical default is clamped down from the bottom edge.
  const at = placeLoupe({ clientX: 300, clientY: 150 }, { width: 320, height: 200 });
  assert.ok(at.x >= LOUPE_MARGIN && at.x <= 320 - LOUPE_MARGIN - LOUPE_SIZE);
  assert.ok(at.y >= LOUPE_MARGIN && at.y <= 200 - LOUPE_MARGIN - LOUPE_SIZE);
  // A pointer at the very left of a narrow viewport cannot flip off-screen.
  const left = placeLoupe({ clientX: 2, clientY: 10 }, { width: 170, height: 900 }, { offset: 18 });
  assert.equal(left.x, LOUPE_MARGIN);
});

test("a viewport smaller than the loupe pins it at the margin", () => {
  assert.deepEqual(placeLoupe({ clientX: 50, clientY: 50 }, { width: 100, height: 100 }), {
    x: LOUPE_MARGIN,
    y: LOUPE_MARGIN,
  });
  assert.deepEqual(placeLoupe({ clientX: 0, clientY: 0 }, { width: 0, height: 0 }), {
    x: LOUPE_MARGIN,
    y: LOUPE_MARGIN,
  });
});

test("placement never returns NaN", () => {
  const cases = [
    [{ clientX: Number.NaN, clientY: Number.NaN }, VIEWPORT],
    [{ clientX: 10, clientY: 10 }, { width: Number.NaN, height: Number.POSITIVE_INFINITY }],
    [{ clientX: Number.NEGATIVE_INFINITY, clientY: 5 }, { width: -50, height: 20 }],
  ];
  for (const [pointer, viewport] of cases) {
    const at = placeLoupe(pointer, viewport, { size: Number.NaN, offset: Number.NaN, margin: Number.NaN });
    assert.ok(Number.isFinite(at.x) && Number.isFinite(at.y), JSON.stringify({ pointer, viewport, at }));
    const plain = placeLoupe(pointer, viewport);
    assert.ok(Number.isFinite(plain.x) && Number.isFinite(plain.y));
  }
});

test("a landscape image is letterboxed: full width, centred vertically", () => {
  const rect = containedImageRect({ left: 10, top: 20, width: 100, height: 100 }, { naturalWidth: 400, naturalHeight: 200 });
  assert.deepEqual(rect, { left: 10, top: 45, width: 100, height: 50 });
});

test("a portrait image is pillarboxed: full height, centred horizontally", () => {
  const rect = containedImageRect({ left: 10, top: 20, width: 100, height: 100 }, { naturalWidth: 300, naturalHeight: 600 });
  assert.deepEqual(rect, { left: 35, top: 20, width: 50, height: 100 });
});

test("a square image fills a square frame exactly", () => {
  const frame = { left: 4, top: 8, width: 120, height: 120 };
  assert.deepEqual(containedImageRect(frame, { naturalWidth: 900, naturalHeight: 900 }), frame);
});

test("missing natural dimensions return the frame unchanged", () => {
  const frame = { left: 4, top: 8, width: 120, height: 90 };
  assert.deepEqual(containedImageRect(frame, { naturalWidth: 0, naturalHeight: 0 }), frame);
  assert.deepEqual(containedImageRect(frame, { naturalWidth: Number.NaN, naturalHeight: 50 }), frame);
  assert.deepEqual(containedImageRect(frame, { naturalWidth: 50, naturalHeight: 0 }), frame);
});

test("the pointer at the image centre puts the image centre in the loupe centre", () => {
  const rect = { left: 100, top: 200, width: 120, height: 80 };
  const sample = sampleLoupe({ clientX: 160, clientY: 240 }, rect);
  const bgW = 120 * LOUPE_ZOOM;
  const bgH = 80 * LOUPE_ZOOM;
  assert.equal(sample.backgroundSize, `${bgW}px ${bgH}px`);
  assert.equal(sample.backgroundPosition, `${LOUPE_SIZE / 2 - bgW / 2}px ${LOUPE_SIZE / 2 - bgH / 2}px`);
  assert.equal(sample.inside, true);
});

test("the pointer at the top-left corner puts the image corner in the loupe centre", () => {
  const sample = sampleLoupe({ clientX: 100, clientY: 200 }, { left: 100, top: 200, width: 120, height: 80 });
  assert.equal(sample.backgroundPosition, `${LOUPE_SIZE / 2}px ${LOUPE_SIZE / 2}px`);
  assert.equal(sample.inside, true);
});

test("values are rounded to two decimals and honour size/zoom overrides", () => {
  const sample = sampleLoupe({ clientX: 1, clientY: 1 }, { left: 0, top: 0, width: 3, height: 3 }, { size: 100, zoom: 1 / 3 });
  assert.equal(sample.backgroundSize, "1px 1px");
  assert.equal(sample.backgroundPosition, "49.67px 49.67px");
});

test("a pointer outside the image rect (letterbox padding) is not inside", () => {
  const rect = { left: 10, top: 45, width: 100, height: 50 };
  assert.equal(sampleLoupe({ clientX: 60, clientY: 30 }, rect).inside, false);
  assert.equal(sampleLoupe({ clientX: 5, clientY: 60 }, rect).inside, false);
  assert.equal(sampleLoupe({ clientX: 111, clientY: 60 }, rect).inside, false);
  assert.equal(sampleLoupe({ clientX: 60, clientY: 96 }, rect).inside, false);
});

test("a zero-size rect gives an empty, hidden sample", () => {
  const empty = { backgroundSize: "0px 0px", backgroundPosition: "0px 0px", inside: false };
  assert.deepEqual(sampleLoupe({ clientX: 0, clientY: 0 }, { left: 0, top: 0, width: 0, height: 0 }), empty);
  assert.deepEqual(sampleLoupe({ clientX: 5, clientY: 5 }, { left: 0, top: 0, width: 10, height: 0 }), empty);
  assert.deepEqual(sampleLoupe({ clientX: 5, clientY: 5 }, { left: 0, top: 0, width: Number.NaN, height: 10 }), empty);
});

test("loupeMode: potato and coarse pointers are off, reduced motion is instant, else fade", () => {
  assert.equal(loupeMode({ potato: true, reduced: false, coarsePointer: false }), "off");
  assert.equal(loupeMode({ potato: false, reduced: false, coarsePointer: true }), "off");
  assert.equal(loupeMode({ potato: true, reduced: true, coarsePointer: true }), "off");
  assert.equal(loupeMode({ potato: false, reduced: true, coarsePointer: false }), "instant");
  assert.equal(loupeMode({ potato: false, reduced: false, coarsePointer: false }), "fade");
});
