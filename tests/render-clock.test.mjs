import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import {
  formatElapsed,
  medianMs,
  recordRenderDuration,
  RENDER_DURATIONS_STORAGE_KEY,
  RENDER_HISTORY_LIMIT,
  renderClockFraction,
  renderClockKey,
  renderClockNote,
  resetRenderDurationsForTests,
  setRenderDurationStorageAdapter,
  typicalRenderMs,
} from "../app/lib/render-clock.ts";

// render-clock.ts persists through an injected get/set/remove adapter,
// defaulting to window.localStorage when present and a no-op otherwise (Node
// has no window). Restore the default after every test in this file so no
// test leaks a custom in-memory adapter into another.
afterEach(() => {
  setRenderDurationStorageAdapter(null);
});

// A minimal in-memory get/set/remove adapter -- the same shape the real
// window.localStorage-backed adapter exposes -- so these tests exercise the
// REAL read/write path (JSON encode/decode, sanitizing, the history cap).
function createMemoryAdapter(seed) {
  const store = new Map(seed ? Object.entries(seed) : []);
  return {
    get: (key) => (store.has(key) ? store.get(key) : null),
    set: (key, value) => {
      store.set(key, value);
    },
    remove: (key) => {
      store.delete(key);
    },
    store,
  };
}

function readRecord(adapter) {
  const raw = adapter.store.get(RENDER_DURATIONS_STORAGE_KEY);
  return raw ? JSON.parse(raw) : undefined;
}

// --- formatElapsed -----------------------------------------------------------

test("formatElapsed renders m:ss, rounding down to whole seconds", () => {
  assert.equal(formatElapsed(0), "0:00");
  assert.equal(formatElapsed(999), "0:00");
  assert.equal(formatElapsed(1000), "0:01");
  assert.equal(formatElapsed(59_999), "0:59");
  assert.equal(formatElapsed(60_000), "1:00");
  assert.equal(formatElapsed(67_000), "1:07");
  assert.equal(formatElapsed(723_000), "12:03");
  assert.equal(formatElapsed(3_599_000), "59:59");
});

test("formatElapsed reads negative and non-finite input as 0:00", () => {
  assert.equal(formatElapsed(-1), "0:00");
  assert.equal(formatElapsed(-60_000), "0:00");
  assert.equal(formatElapsed(Number.NaN), "0:00");
  assert.equal(formatElapsed(Number.POSITIVE_INFINITY), "0:00");
});

// --- renderClockKey ------------------------------------------------------------

test("renderClockKey joins surface, kind and quality, defaulting blanks", () => {
  assert.equal(renderClockKey("generator", "draft", "low"), "generator:draft:low");
  assert.equal(renderClockKey("workbench", "imageEdit", undefined), "workbench:imageEdit:default");
  assert.equal(renderClockKey("review", "draft", null), "review:draft:default");
  assert.equal(renderClockKey("review", "draft", "  "), "review:draft:default");
});

// --- median --------------------------------------------------------------------

test("medianMs takes the middle value of an odd count, unsorted input", () => {
  assert.equal(medianMs([30_000, 10_000, 20_000]), 20_000);
  assert.equal(medianMs([5]), 5);
});

test("medianMs averages the two middle values of an even count", () => {
  assert.equal(medianMs([40_000, 10_000, 30_000, 20_000]), 25_000);
  assert.equal(medianMs([1000, 2000]), 1500);
});

test("medianMs is null for an empty list", () => {
  assert.equal(medianMs([]), null);
});

test("typicalRenderMs is the median of the recorded durations for its key", () => {
  const adapter = createMemoryAdapter();
  setRenderDurationStorageAdapter(adapter);
  const key = renderClockKey("generator", "draft", "low");
  recordRenderDuration(key, 70_000);
  recordRenderDuration(key, 50_000);
  recordRenderDuration(key, 90_000);
  assert.equal(typicalRenderMs(key), 70_000);
  recordRenderDuration(key, 60_000);
  assert.equal(typicalRenderMs(key), 65_000);
});

test("typicalRenderMs is null with no history", () => {
  setRenderDurationStorageAdapter(createMemoryAdapter());
  assert.equal(typicalRenderMs("generator:final:high"), null);
});

// --- history cap ---------------------------------------------------------------

test("only the newest RENDER_HISTORY_LIMIT (20) durations are kept per key", () => {
  assert.equal(RENDER_HISTORY_LIMIT, 20);
  const adapter = createMemoryAdapter();
  setRenderDurationStorageAdapter(adapter);
  const key = "generator:studio:high";
  // 1..25 seconds: the oldest five (1..5 s) must fall off.
  for (let seconds = 1; seconds <= 25; seconds += 1) recordRenderDuration(key, seconds * 1000);
  const stored = readRecord(adapter)[key];
  assert.equal(stored.length, 20);
  assert.equal(stored[0], 6000);
  assert.equal(stored[19], 25_000);
  // Median of 6..25 s is the mean of 15 s and 16 s.
  assert.equal(typicalRenderMs(key), 15_500);
});

// --- per-key isolation ---------------------------------------------------------

test("durations recorded under one key never affect another", () => {
  const adapter = createMemoryAdapter();
  setRenderDurationStorageAdapter(adapter);
  recordRenderDuration("generator:draft:low", 40_000);
  recordRenderDuration("generator:final:high", 200_000);
  recordRenderDuration("review:draft:low", 80_000);
  assert.equal(typicalRenderMs("generator:draft:low"), 40_000);
  assert.equal(typicalRenderMs("generator:final:high"), 200_000);
  assert.equal(typicalRenderMs("review:draft:low"), 80_000);
  assert.equal(typicalRenderMs("generator:studio:low"), null);
});

test("invalid durations are ignored on write", () => {
  const adapter = createMemoryAdapter();
  setRenderDurationStorageAdapter(adapter);
  const key = "generator:draft:low";
  recordRenderDuration(key, 0);
  recordRenderDuration(key, -5000);
  recordRenderDuration(key, Number.NaN);
  recordRenderDuration(key, Number.POSITIVE_INFINITY);
  assert.equal(typicalRenderMs(key), null);
  assert.equal(adapter.store.has(RENDER_DURATIONS_STORAGE_KEY), false);
});

test("a simulated reload reads back what was recorded", () => {
  const adapter = createMemoryAdapter();
  setRenderDurationStorageAdapter(adapter);
  recordRenderDuration("generator:draft:low", 42_000);
  const persisted = adapter.store.get(RENDER_DURATIONS_STORAGE_KEY);
  setRenderDurationStorageAdapter(createMemoryAdapter({ [RENDER_DURATIONS_STORAGE_KEY]: persisted }));
  assert.equal(typicalRenderMs("generator:draft:low"), 42_000);
});

test("resetRenderDurationsForTests clears every key", () => {
  const adapter = createMemoryAdapter();
  setRenderDurationStorageAdapter(adapter);
  recordRenderDuration("generator:draft:low", 42_000);
  resetRenderDurationsForTests();
  assert.equal(typicalRenderMs("generator:draft:low"), null);
});

// --- corrupt storage -----------------------------------------------------------

test("unparseable storage reads as no history and is replaced on the next write", () => {
  const adapter = createMemoryAdapter({ [RENDER_DURATIONS_STORAGE_KEY]: "{not json" });
  setRenderDurationStorageAdapter(adapter);
  assert.equal(typicalRenderMs("generator:draft:low"), null);
  recordRenderDuration("generator:draft:low", 30_000);
  assert.deepEqual(readRecord(adapter), { "generator:draft:low": [30_000] });
});

test("a non-object record (array, number, null) reads as no history", () => {
  for (const raw of ["[1,2,3]", "42", "null", "\"text\""]) {
    setRenderDurationStorageAdapter(createMemoryAdapter({ [RENDER_DURATIONS_STORAGE_KEY]: raw }));
    assert.equal(typicalRenderMs("generator:draft:low"), null, raw);
  }
});

test("corrupt entries inside a record are dropped, sane ones kept", () => {
  const corrupt = JSON.stringify({
    "generator:draft:low": [30_000, "40000", null, -1, 0, 50_000, { ms: 1 }, 1e12],
    "generator:final:high": "not an array",
    "review:draft:low": ["x", null],
  });
  setRenderDurationStorageAdapter(createMemoryAdapter({ [RENDER_DURATIONS_STORAGE_KEY]: corrupt }));
  // Only 30 s and 50 s survive (1e12 ms is past the sanity ceiling).
  assert.equal(typicalRenderMs("generator:draft:low"), 40_000);
  assert.equal(typicalRenderMs("generator:final:high"), null);
  assert.equal(typicalRenderMs("review:draft:low"), null);
});

// --- storage that throws -------------------------------------------------------

test("storage whose every call throws never throws out of the module", () => {
  const throwing = {
    get: () => {
      throw new Error("SecurityError");
    },
    set: () => {
      throw new Error("QuotaExceededError");
    },
    remove: () => {
      throw new Error("SecurityError");
    },
  };
  setRenderDurationStorageAdapter(throwing);
  assert.doesNotThrow(() => recordRenderDuration("generator:draft:low", 30_000));
  assert.equal(typicalRenderMs("generator:draft:low"), null);
  assert.doesNotThrow(() => resetRenderDurationsForTests());
});

test("with no window and no injected adapter, everything is a quiet no-op", () => {
  setRenderDurationStorageAdapter(null);
  assert.doesNotThrow(() => recordRenderDuration("generator:draft:low", 30_000));
  assert.equal(typicalRenderMs("generator:draft:low"), null);
});

// --- note and rule -------------------------------------------------------------

test("renderClockNote reads 'usually m:ss' until elapsed passes typical", () => {
  assert.equal(renderClockNote(10_000, 70_000), "usually 1:10");
  assert.equal(renderClockNote(70_000, 70_000), "usually 1:10");
  assert.equal(renderClockNote(70_001, 70_000), "longer than usual");
});

test("renderClockNote is null with no typical duration", () => {
  assert.equal(renderClockNote(10_000, null), null);
  assert.equal(renderClockNote(10_000, 0), null);
  assert.equal(renderClockNote(10_000, Number.NaN), null);
});

test("renderClockFraction is elapsed / typical, clamped to 0..1, null without typical", () => {
  assert.equal(renderClockFraction(35_000, 70_000), 0.5);
  assert.equal(renderClockFraction(140_000, 70_000), 1);
  assert.equal(renderClockFraction(-5000, 70_000), 0);
  assert.equal(renderClockFraction(Number.NaN, 70_000), 0);
  assert.equal(renderClockFraction(35_000, null), null);
  assert.equal(renderClockFraction(35_000, 0), null);
});
