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
    for (const key of ["left", "top", "width", "height", "a", "b", "c", "d"]) {
      assert.ok(Number.isFinite(card[key]), `${key} must be finite`);
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
    assert.ok(placed[i].left > placed[i - 1].left, `card ${i} should sit right of card ${i - 1}`);
    assert.ok(placed[i].top < placed[i - 1].top, `card ${i} should sit above card ${i - 1}`);
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

test("degenerate inputs return empty", () => {
  assert.deepEqual(projectCardRects(0, 0, W, H, false, []), []);
  assert.deepEqual(projectCardRects(16, 0, 0, 0, false, aspects), []);
});
