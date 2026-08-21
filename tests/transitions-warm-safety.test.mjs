import test from "node:test";
import assert from "node:assert/strict";

// Spec FR-011: background preparation must be side-effect safe. Warming a
// route means importing its modules ahead of a visit — so importing them must
// fire no network calls, no analytics, and no shared-state writes at module
// top level. This file runs in its own process (node --test default
// isolation), so these are the first imports of each module.

test("importing the warm-path lib modules performs no fetches", async () => {
  let fetches = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (...args) => {
    fetches += 1;
    return realFetch(...args);
  };
  try {
    await import("../app/lib/scene-lab-assets.ts");
    await import("../app/lib/route-ready.ts");
    await import("../app/lib/nav-direction.ts");
    await import("../app/lib/transition-debug.ts");
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(fetches, 0, "module top-levels must not hit the network");
});

test("importing warm-path modules leaves no pending timers or handles", async () => {
  // A top-level setInterval/setTimeout in a warmed module would keep running
  // for pages the user never visits. getActiveResourcesInfo reflects live
  // handles; filter to timers.
  const before = process.getActiveResourcesInfo().filter((r) => r.includes("Timeout")).length;
  await import("../app/lib/scene-lab-assets.ts");
  await import("../app/lib/route-ready.ts");
  const after = process.getActiveResourcesInfo().filter((r) => r.includes("Timeout")).length;
  assert.equal(after, before, "module top-levels must not start timers");
});

test("logTransition never throws regardless of detail shape", async () => {
  const { logTransition } = await import("../app/lib/transition-debug.ts");
  const realInfo = console.info;
  console.info = () => {};
  try {
    assert.doesNotThrow(() => logTransition("finished"));
    assert.doesNotThrow(() => logTransition("timeout", { href: "/generator" }));
    assert.doesNotThrow(() => logTransition("transition-error", new Error("x")));
    assert.doesNotThrow(() => logTransition("ready", undefined));
  } finally {
    console.info = realInfo;
  }
});
