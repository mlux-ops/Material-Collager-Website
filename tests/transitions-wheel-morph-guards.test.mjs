import test from "node:test";
import assert from "node:assert/strict";

const { shouldMorphViewer, WHEEL_VIEWER_OPEN_TYPE, WHEEL_VIEWER_CLOSE_TYPE } = await import(
  "../app/lib/wheel-viewer-morph.ts"
);

// The guard decides between the card morph and the viewer's plain paths.
// It must be pure so the fallthrough matrix is testable without a DOM.
const base = {
  hasViewTransitionAPI: true,
  prefersReducedMotion: false,
  hasPlacement: true,
};

test("happy path morphs the card into the viewer", () => {
  assert.equal(shouldMorphViewer(base), true);
});

test("missing View Transitions API keeps the slide/frost viewer", () => {
  assert.equal(shouldMorphViewer({ ...base, hasViewTransitionAPI: false }), false);
});

test("reduced motion keeps the immediate viewer", () => {
  assert.equal(shouldMorphViewer({ ...base, prefersReducedMotion: true }), false);
});

test("a card that cannot be placed on screen opens without a morph", () => {
  assert.equal(shouldMorphViewer({ ...base, hasPlacement: false }), false);
});

test("transition types match the names effects.css selects on", async () => {
  const { readFile } = await import("node:fs/promises");
  const css = await readFile(new URL("../app/effects.css", import.meta.url), "utf8");
  for (const type of [WHEEL_VIEWER_OPEN_TYPE, WHEEL_VIEWER_CLOSE_TYPE]) {
    assert.ok(css.includes(`:active-view-transition-type(${type})`), `effects.css has no rule for ${type}`);
  }
});
