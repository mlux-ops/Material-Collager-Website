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

test("the nav frost freeze stands down during a wheel morph", async () => {
  // Re-enabling the bar's backdrop-filter over the WebGL canvas as a morph
  // ends re-surfaced the whole deck for a frame; the freeze is for the wipe.
  const { readFile } = await import("node:fs/promises");
  const css = await readFile(new URL("../app/effects.css", import.meta.url), "utf8");
  assert.ok(
    css.includes("html:active-view-transition:not([data-wheel-viewer]) .site-navigation"),
    "nav freeze rule must exclude html[data-wheel-viewer]",
  );
  assert.ok(
    !/html:active-view-transition\s+\.site-navigation/.test(css),
    "an unscoped nav freeze rule is still present",
  );
});

test("a morph keeps the root captured but leaves the nav out", async () => {
  // An uncaptured root left the live frost, caption, close button and nav
  // text unpainted until the morph ended (they popped in as the card
  // landed); the captured root renders their fades frame by frame. A
  // captured nav, by contrast, rides above the root image and pops under
  // the frost at the end, so the nav alone is unnamed during a morph. The
  // comment above the wheel-card rules in effects.css has the measurement.
  const { readFile } = await import("node:fs/promises");
  const css = await readFile(new URL("../app/effects.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /html\[data-wheel-viewer\]\s*\{\s*view-transition-name:\s*none;?\s*\}/);
  assert.match(
    css,
    /html\[data-wheel-viewer\]\s+\.site-navigation\s*\{\s*view-transition-name:\s*none;?\s*\}/,
  );
});
