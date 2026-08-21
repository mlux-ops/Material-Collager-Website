import test from "node:test";
import assert from "node:assert/strict";

const {
  markRouteReady,
  awaitRouteReady,
  _resetRouteReadyForTests,
  setActiveTransition,
  awaitTransitionSettled,
} = await import("../app/lib/route-ready.ts");

test.beforeEach(() => _resetRouteReadyForTests());

test("resolves 'ready' when the route signals readiness", async () => {
  const wait = awaitRouteReady("/generator", 500);
  markRouteReady("/generator");
  assert.equal(await wait, "ready");
});

test("resolves 'timeout' when the budget expires unsignalled", async () => {
  assert.equal(await awaitRouteReady("/workbench", 20), "timeout");
});

test("a mark for a different path does not resolve the wait", async () => {
  const wait = awaitRouteReady("/generator", 30);
  markRouteReady("/workbench");
  assert.equal(await wait, "timeout");
});

test("stale marks do not satisfy a later wait (no stickiness)", async () => {
  // A route marked ready during a PREVIOUS navigation must not short-circuit
  // the next navigation's wait — readiness is per-navigation, not per-route.
  markRouteReady("/generator");
  assert.equal(await awaitRouteReady("/generator", 20), "timeout");
});

test("a late mark after timeout is a harmless no-op", async () => {
  assert.equal(await awaitRouteReady("/generator", 10), "timeout");
  assert.doesNotThrow(() => markRouteReady("/generator"));
});

test("latest navigation wins: a new wait supersedes the pending one", async () => {
  const first = awaitRouteReady("/generator", 5000);
  const second = awaitRouteReady("/workbench", 500);
  markRouteReady("/workbench");
  assert.equal(await second, "ready");
  assert.equal(await first, "superseded");
});

test("paths normalize the same way as direction mapping", async () => {
  const wait = awaitRouteReady("/generator/", 500);
  markRouteReady("/generator?from=mount");
  assert.equal(await wait, "ready");
});

test("transition-idle resolves immediately when nothing is animating", async () => {
  let settled = false;
  await awaitTransitionSettled().then(() => { settled = true; });
  assert.equal(settled, true);
});

test("transition-idle waits for the active transition to finish", async () => {
  let release;
  setActiveTransition(new Promise((r) => { release = r; }));
  let settled = false;
  const wait = awaitTransitionSettled().then(() => { settled = true; });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(settled, false, "must not settle while the transition runs");
  release();
  await wait;
  assert.equal(settled, true);
});

test("transition-idle treats a rejected finished promise as settled", async () => {
  setActiveTransition(Promise.reject(new Error("skipped")));
  await assert.doesNotReject(() => awaitTransitionSettled());
});

test("a newer transition replaces the previous one", async () => {
  let releaseOld;
  setActiveTransition(new Promise((r) => { releaseOld = r; }));
  setActiveTransition(Promise.resolve());
  // The new (already-finished) transition governs: settles without releaseOld.
  await awaitTransitionSettled();
  releaseOld();
  assert.ok(true);
});
