import test from "node:test";
import assert from "node:assert/strict";

const {
  DEFAULT_SETTINGS,
  LANDING_ROUTES,
  WIPE_SPEEDS,
  cycleLanding,
  cycleWipeSpeed,
  landingLabel,
  normalizeSettings,
  wipeDurationMs,
} = await import("../app/lib/site-settings.ts");

test("defaults are the least surprising state", () => {
  assert.deepEqual(DEFAULT_SETTINGS, {
    reduceMotion: false,
    potato: false,
    wipeSpeed: "normal",
    landing: "/",
  });
});

test("normalize coerces anything into valid settings", () => {
  // Garbage in, defaults out — a corrupt or hand-edited localStorage entry
  // must never produce an undefined wipe duration or an unroutable landing.
  for (const input of [null, undefined, 42, "nope", [], { wipeSpeed: "ludicrous" }, { landing: "/etc/passwd" }]) {
    assert.deepEqual(normalizeSettings(input), DEFAULT_SETTINGS);
  }
});

test("normalize keeps valid values and hardens the booleans", () => {
  assert.deepEqual(
    normalizeSettings({ reduceMotion: true, potato: "yes", wipeSpeed: "fast", landing: "/archive" }),
    { reduceMotion: true, potato: false, wipeSpeed: "fast", landing: "/archive" },
  );
});

test("normalize drops unknown keys", () => {
  const result = normalizeSettings({ darkMode: true, wipeSpeed: "slow" });
  assert.deepEqual(Object.keys(result).sort(), ["landing", "potato", "reduceMotion", "wipeSpeed"]);
  assert.equal(result.wipeSpeed, "slow");
});

test("wipe durations are ordered slow > normal > fast", () => {
  assert.ok(wipeDurationMs("slow") > wipeDurationMs("normal"));
  assert.ok(wipeDurationMs("normal") > wipeDurationMs("fast"));
  for (const speed of WIPE_SPEEDS) assert.ok(Number.isFinite(wipeDurationMs(speed)));
});

test("cycling a control visits every value and returns to the start", () => {
  let speed = "normal";
  const speeds = new Set();
  for (let i = 0; i < WIPE_SPEEDS.length; i += 1) {
    speeds.add(speed);
    speed = cycleWipeSpeed(speed);
  }
  assert.deepEqual([...speeds].sort(), [...WIPE_SPEEDS].sort());
  assert.equal(speed, "normal");

  let landing = "/";
  const routes = new Set();
  for (let i = 0; i < LANDING_ROUTES.length; i += 1) {
    routes.add(landing);
    landing = cycleLanding(landing);
  }
  assert.deepEqual([...routes].sort(), [...LANDING_ROUTES].sort());
  assert.equal(landing, "/");
});

test("every landing route has a label", () => {
  for (const route of LANDING_ROUTES) {
    assert.match(landingLabel(route), /^[A-Z]+$/);
  }
});
