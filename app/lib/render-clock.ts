// Render clock: how long an image render has been in flight, and how long one
// like it usually takes in this browser.
//
// Pure logic only -- no React, no `node:` builtins, no imports -- so the
// type-stripping test runner exercises it directly (tests/render-clock.test.mjs).
// The React side lives in app/components/RenderClock.tsx.
//
// "Usually" is the median of this browser's last RENDER_HISTORY_LIMIT
// successful durations for the same key, where a key is
// `${surface}:${kind}:${quality}` (renderClockKey). Durations persist in
// localStorage under RENDER_DURATIONS_STORAGE_KEY through an injectable
// get/set/remove adapter -- the same pattern as the Workbench cost
// calibration (app/components/workbench/cost.ts) -- so tests run the real
// read/write path without a browser.

export const RENDER_DURATIONS_STORAGE_KEY = "mc.renderDurations.v1";
export const RENDER_HISTORY_LIMIT = 20;

// A single render longer than this is not a duration worth learning from (a
// laptop slept mid-render, say); it is dropped on write and on read so one
// outlier record can never turn into an absurd "usually".
const MAX_SANE_DURATION_MS = 6 * 60 * 60 * 1000;

export type RenderDurationStorageAdapter = {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
};

type RenderDurationRecord = Record<string, number[]>;

const noopStorageAdapter: RenderDurationStorageAdapter = {
  get: () => null,
  set: () => {},
  remove: () => {},
};

// Every property access on window.localStorage can itself throw (a
// SecurityError when site data is blocked), so each call is guarded here, not
// only the JSON work around it.
const windowLocalStorageAdapter: RenderDurationStorageAdapter = {
  get: (key) => {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set: (key, value) => {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // A full or blocked store costs a learned duration, never a render.
    }
  },
  remove: (key) => {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Same as set: best-effort.
    }
  },
};

let injectedAdapter: RenderDurationStorageAdapter | null = null;

// Resolved on every call rather than once at module load, so a module first
// evaluated during server rendering (no window) still reaches localStorage
// once it runs in the browser.
function storage(): RenderDurationStorageAdapter {
  if (injectedAdapter) return injectedAdapter;
  return typeof window !== "undefined" ? windowLocalStorageAdapter : noopStorageAdapter;
}

/**
 * Injects a custom storage adapter (an in-memory Map-backed one in tests).
 * Passing null/undefined restores the default: window.localStorage when
 * present, a no-op otherwise.
 */
export function setRenderDurationStorageAdapter(adapter?: RenderDurationStorageAdapter | null): void {
  injectedAdapter = adapter ?? null;
}

/** Clears every recorded duration (a fresh install, as far as the clock knows). */
export function resetRenderDurationsForTests(): void {
  try {
    storage().remove(RENDER_DURATIONS_STORAGE_KEY);
  } catch {
    // Nothing to reset when storage is unavailable.
  }
}

function isSaneDuration(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX_SANE_DURATION_MS;
}

function loadRecord(): RenderDurationRecord {
  try {
    const raw = storage().get(RENDER_DURATIONS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    // Sanitize on read: a hand-edited or corrupted entry must never reach the
    // "usually" label as NaN or a negative time.
    const record: RenderDurationRecord = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue;
      const durations = value.filter(isSaneDuration).slice(-RENDER_HISTORY_LIMIT);
      if (durations.length) record[key] = durations;
    }
    return record;
  } catch {
    return {};
  }
}

function saveRecord(record: RenderDurationRecord): void {
  try {
    storage().set(RENDER_DURATIONS_STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Best-effort, as above.
  }
}

/**
 * `${surface}:${kind}:${quality}`, e.g. "generator:draft:low". An empty or
 * missing part becomes "default" so a surface without a quality still keys
 * consistently.
 */
export function renderClockKey(surface: string, kind: string, quality?: string | null): string {
  const part = (value: string | null | undefined) => (value && value.trim() ? value.trim() : "default");
  return `${part(surface)}:${part(kind)}:${part(quality)}`;
}

/**
 * Records one successful render's duration under `key`, keeping only the
 * newest RENDER_HISTORY_LIMIT. Call it on success only -- never on a cancel or
 * an error, which would teach the clock how long failures take.
 */
export function recordRenderDuration(key: string, ms: number): void {
  if (!key || !isSaneDuration(ms)) return;
  const record = loadRecord();
  const next = [...(record[key] ?? []), Math.round(ms)];
  record[key] = next.slice(-RENDER_HISTORY_LIMIT);
  saveRecord(record);
}

/** The median of a list of numbers; null for an empty list. */
export function medianMs(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** The typical duration for `key` in this browser, or null with no history. */
export function typicalRenderMs(key: string): number | null {
  if (!key) return null;
  return medianMs(loadRecord()[key] ?? []);
}

/**
 * Elapsed time as m:ss -- "0:00", "0:42", "1:07", "12:03". Whole seconds,
 * rounded down, so the display never claims a second that has not passed.
 * Negative or non-finite input reads as "0:00".
 */
export function formatElapsed(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const totalSeconds = Math.floor(safe / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds < 10 ? "0" : ""}${seconds}`;
}

/**
 * The sub text beside the clock: "usually 1:10" while a typical duration is
 * known and not yet exceeded, "longer than usual" once it is, and null with no
 * history (the clock then shows elapsed time alone).
 */
export function renderClockNote(elapsedMs: number, typicalMs: number | null): string | null {
  if (typicalMs === null || !Number.isFinite(typicalMs) || typicalMs <= 0) return null;
  return elapsedMs > typicalMs ? "longer than usual" : `usually ${formatElapsed(typicalMs)}`;
}

/**
 * How far along the stage-top rule is: elapsed / typical, clamped to 0..1.
 * Null with no typical duration, meaning the rule is not shown at all.
 */
export function renderClockFraction(elapsedMs: number, typicalMs: number | null): number | null {
  if (typicalMs === null || !Number.isFinite(typicalMs) || typicalMs <= 0) return null;
  const ratio = (Number.isFinite(elapsedMs) ? elapsedMs : 0) / typicalMs;
  return Math.min(1, Math.max(0, ratio));
}
