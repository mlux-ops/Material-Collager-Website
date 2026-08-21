import test from "node:test";
import assert from "node:assert/strict";

const { markRouteReady, awaitRouteReady, _resetRouteReadyForTests } = await import(
  "../app/lib/route-ready.ts"
);

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
