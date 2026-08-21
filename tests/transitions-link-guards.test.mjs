import test from "node:test";
import assert from "node:assert/strict";

const { shouldStartViewTransition } = await import("../app/lib/nav-direction.ts");

// The guard decides between the plain-navigation path and the transition path.
// It must be pure so the fallthrough matrix is testable without a DOM.
const base = {
  modifierPressed: false,
  button: 0,
  samePath: false,
  hasViewTransitionAPI: true,
  prefersReducedMotion: false,
  defaultPrevented: false,
};

test("happy path starts a view transition", () => {
  assert.equal(shouldStartViewTransition(base), true);
});

test("modified clicks (new tab, download) stay with the browser", () => {
  assert.equal(shouldStartViewTransition({ ...base, modifierPressed: true }), false);
});

test("non-primary buttons stay with the browser", () => {
  assert.equal(shouldStartViewTransition({ ...base, button: 1 }), false);
});

test("navigating to the current route does nothing special", () => {
  assert.equal(shouldStartViewTransition({ ...base, samePath: true }), false);
});

test("missing View Transitions API falls through to plain navigation", () => {
  assert.equal(shouldStartViewTransition({ ...base, hasViewTransitionAPI: false }), false);
});

test("prefers-reduced-motion falls through to plain navigation", () => {
  assert.equal(shouldStartViewTransition({ ...base, prefersReducedMotion: true }), false);
});

test("a handler that already prevented default is respected", () => {
  assert.equal(shouldStartViewTransition({ ...base, defaultPrevented: true }), false);
});
