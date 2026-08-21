import test from "node:test";
import assert from "node:assert/strict";

const { projectCardRects } = await import(
  "../app/components/scene-wheel-v2/project-card-rects.ts"
);

const W = 1440;
const H = 900;
const aspects = Array.from({ length: 16 }, () => 4 / 3);

test("projects a visible cascade at progress 0", () => {
  const placed = projectCardRects(16, 0, W, H, false, aspects);
  assert.ok(placed.length >= 5, `expected several visible cards, got ${placed.length}`);
  for (const card of placed) {
    assert.ok(Number.isFinite(card.width) && Number.isFinite(card.height));
    assert.match(card.transform, /^matrix3d\(/);
    for (const corner of Object.values(card.corners)) {
      assert.ok(Number.isFinite(corner.x) && Number.isFinite(corner.y));
    }
    assert.ok(card.width > 2 && card.height > 2);
    assert.ok(card.opacity > 0 && card.opacity <= 1);
  }
});

test("cards march lower-left to upper-right, shrinking with distance", () => {
  // The wrap-around card (relative < 0) legitimately re-enters at the
  // bottom-left; monotonicity holds along the forward rail only.
  const placed = projectCardRects(16, 0, W, H, false, aspects).filter((c) => c.relative >= 0);
  for (let i = 1; i < placed.length; i += 1) {
    assert.ok(placed[i].corners.tl.x > placed[i - 1].corners.tl.x, `card ${i} should sit right of card ${i - 1}`);
    assert.ok(placed[i].corners.tl.y < placed[i - 1].corners.tl.y, `card ${i} should sit above card ${i - 1}`);
    assert.ok(placed[i].width < placed[i - 1].width, `card ${i} should be smaller (farther)`);
  }
});

test("nearer cards stack above farther ones", () => {
  const placed = projectCardRects(16, 0, W, H, false, aspects).filter((c) => c.relative >= 0);
  for (let i = 1; i < placed.length; i += 1) {
    assert.ok(placed[i].z < placed[i - 1].z);
  }
});

test("mobile framing shifts the cascade without breaking it", () => {
  const desktop = projectCardRects(16, 0, 390, 844, false, aspects);
  const mobile = projectCardRects(16, 0, 390, 844, true, aspects);
  assert.ok(mobile.length > 0);
  assert.notDeepEqual(mobile[0], desktop[0]);
});

test("homography maps the box corners exactly onto the quad", async () => {
  const { quadTransform } = await import("../app/components/scene-wheel-v2/project-card-rects.ts");
  const tl = { x: 100, y: 200 }, tr = { x: 380, y: 170 }, br = { x: 400, y: 420 }, bl = { x: 90, y: 380 };
  const w = 300, h = 220;
  const m = quadTransform(tl, tr, br, bl, w, h);
  assert.match(m, /^matrix3d\(/);
  const v = m.slice(9, -1).split(",").map(Number);
  // Apply the 4x4 (column-major) to (x, y, 0, 1) with perspective divide.
  const apply = (x, y) => {
    const X = v[0] * x + v[4] * y + v[12];
    const Y = v[1] * x + v[5] * y + v[13];
    const W = v[3] * x + v[7] * y + v[15];
    return { x: X / W, y: Y / W };
  };
  for (const [pt, expected] of [[[0, 0], tl], [[w, 0], tr], [[w, h], br], [[0, h], bl]]) {
    const got = apply(pt[0], pt[1]);
    assert.ok(Math.abs(got.x - expected.x) < 0.01 && Math.abs(got.y - expected.y) < 0.01,
      `corner (${pt}) -> (${got.x.toFixed(2)},${got.y.toFixed(2)}), wanted (${expected.x},${expected.y})`);
  }
});

test("degenerate inputs return empty", () => {
  assert.deepEqual(projectCardRects(0, 0, W, H, false, []), []);
  assert.deepEqual(projectCardRects(16, 0, 0, 0, false, aspects), []);
});
