"use client";

/**
 * Render clock -- elapsed time for an image render in flight, shared by the
 * Generator, the Review Boards workflow and the Workbench status badge.
 *
 * Two layers, so a once-a-second tick never re-renders a whole page:
 *
 *  - useRenderClock() holds only the stable run state (when it started, the
 *    typical duration read at start, the last finished duration) and the
 *    start / finish / stop actions. Nothing in it changes while a render runs.
 *  - The leaf components (RenderClockTime, RenderClockNote, RenderClock,
 *    RenderClockRule) are the only things that tick. They read one shared
 *    module-level ticker through useSyncExternalStore, so every clock on the
 *    page shows the same second and the interval exists only while at least
 *    one leaf is mounted (it is cleared when the last one unmounts).
 *
 * Elapsed is always `now - startedAt`, never a counter, so a throttled
 * background tab shows the right time the moment it is visible again (the
 * ticker also re-reads the clock on visibilitychange instead of waiting for
 * the next throttled tick).
 *
 * Accessibility: every time readout is role="timer" with aria-live="off" --
 * screen readers can query it but are not told about each tick. Callers must
 * not place these inside an aria-live region.
 *
 * Pure logic (formatting, the median, storage) is in app/lib/render-clock.ts.
 */

import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import {
  formatElapsed,
  recordRenderDuration,
  renderClockFraction,
  renderClockNote,
  typicalRenderMs,
} from "@/app/lib/render-clock";
import styles from "./RenderClock.module.css";

// --- Shared ticker -----------------------------------------------------------

const TICK_MS = 1000;
const tickListeners = new Set<() => void>();
let tickNow = 0;
let tickInterval: ReturnType<typeof setInterval> | null = null;

function emitTick(): void {
  tickNow = Date.now();
  for (const listener of tickListeners) listener();
}

function onVisibilityChange(): void {
  if (document.visibilityState === "visible") emitTick();
}

function subscribeTick(listener: () => void): () => void {
  tickListeners.add(listener);
  if (tickInterval === null) {
    tickNow = Date.now();
    tickInterval = setInterval(emitTick, TICK_MS);
    document.addEventListener("visibilitychange", onVisibilityChange);
  }
  return () => {
    tickListeners.delete(listener);
    if (tickListeners.size === 0 && tickInterval !== null) {
      clearInterval(tickInterval);
      tickInterval = null;
      document.removeEventListener("visibilitychange", onVisibilityChange);
    }
  };
}

function getTickSnapshot(): number {
  return tickNow;
}

// The server never has a running render; 0 makes every elapsed read as 0:00.
function getTickServerSnapshot(): number {
  return 0;
}

// `frozenMs` (a finished run's elapsed, see RenderClockControls.finished)
// pins the readout still; the leaf stays subscribed so hooks run in a fixed
// order, but what it shows no longer moves.
function useElapsedMs(startedAt: number, frozenMs?: number): number {
  const now = useSyncExternalStore(subscribeTick, getTickSnapshot, getTickServerSnapshot);
  if (typeof frozenMs === "number") return Math.max(0, frozenMs);
  return Math.max(0, now - startedAt);
}

// --- Run state -----------------------------------------------------------------

export type RenderClockControls = {
  /** True between start() and finish()/stop(). */
  running: boolean;
  /** Date.now() at start(), or null when no render is running. */
  startedAt: number | null;
  /** Median of this browser's recent durations for the running key, read once at start(). */
  typicalMs: number | null;
  /**
   * Elapsed ms of the render that most recently finished successfully, or
   * null when none has (or the latest attempt was cancelled / failed --
   * start() clears it). This is what a receipt line reads after a render.
   */
  lastElapsedMs: number | null;
  /**
   * The run finish() just ended, held still for the caller's post-render
   * bookkeeping (saving, refreshing lists) so a readout can keep showing the
   * final time -- not ticking -- until the work is over. Set by finish(),
   * cleared by start() and stop(). Optional to use: callers that never read
   * it behave exactly as before.
   */
  finished: { startedAt: number; elapsedMs: number; typicalMs: number | null } | null;
  /** Begins timing a render under `key` (see renderClockKey). */
  start: (key: string) => void;
  /**
   * The render succeeded: records its duration under the started key, stops
   * the clock, and returns the elapsed ms (null when nothing was running).
   */
  finish: () => number | null;
  /**
   * Cancel or error: stops the clock without recording. Safe to call twice.
   * Also releases `finished`, so calling it after finish() (in a finally
   * block) ends the held readout; lastElapsedMs is kept.
   */
  stop: () => void;
};

type ActiveRun = { key: string; startedAt: number };

export function useRenderClock(): RenderClockControls {
  const activeRef = useRef<ActiveRun | null>(null);
  const [run, setRun] = useState<{ startedAt: number; typicalMs: number | null } | null>(null);
  const [lastElapsedMs, setLastElapsedMs] = useState<number | null>(null);
  const [finished, setFinished] = useState<RenderClockControls["finished"]>(null);
  // typicalMs of the active run, for `finished` (finish() reads refs, never
  // render-time state).
  const typicalRef = useRef<number | null>(null);

  // start/finish/stop are called from event handlers, async render functions
  // and effects; they read the ref, never render-time state, so a closure
  // captured before the render began still acts on the current run.
  const start = useCallback((key: string) => {
    const startedAt = Date.now();
    activeRef.current = { key, startedAt };
    // Read here (client, at the moment of the click), never during render,
    // so server and client markup can't disagree.
    const typicalMs = typicalRenderMs(key);
    typicalRef.current = typicalMs;
    setRun({ startedAt, typicalMs });
    setLastElapsedMs(null);
    setFinished(null);
  }, []);

  const finish = useCallback((): number | null => {
    const active = activeRef.current;
    if (!active) return null;
    activeRef.current = null;
    const elapsed = Math.max(0, Date.now() - active.startedAt);
    recordRenderDuration(active.key, elapsed);
    setRun(null);
    setLastElapsedMs(elapsed);
    setFinished({ startedAt: active.startedAt, elapsedMs: elapsed, typicalMs: typicalRef.current });
    return elapsed;
  }, []);

  const stop = useCallback(() => {
    setFinished(null);
    if (!activeRef.current) return;
    activeRef.current = null;
    setRun(null);
  }, []);

  return {
    running: run !== null,
    startedAt: run?.startedAt ?? null,
    typicalMs: run?.typicalMs ?? null,
    lastElapsedMs,
    finished,
    start,
    finish,
    stop,
  };
}

// --- Leaf components -----------------------------------------------------------

/**
 * The m:ss readout alone, in tabular figures. Inherits the surrounding type.
 * With `frozenMs` it shows that elapsed, still, instead of ticking.
 */
export function RenderClockTime({
  startedAt,
  frozenMs,
  className,
}: {
  startedAt: number;
  frozenMs?: number;
  className?: string;
}) {
  const elapsed = useElapsedMs(startedAt, frozenMs);
  return (
    <span role="timer" aria-live="off" className={`${styles.time}${className ? ` ${className}` : ""}`}>
      {formatElapsed(elapsed)}
    </span>
  );
}

/**
 * The sub text: "usually 1:10", then "longer than usual" once elapsed passes
 * typical. Renders nothing when no typical duration is known.
 */
export function RenderClockNote({
  startedAt,
  typicalMs,
  frozenMs,
  className,
}: {
  startedAt: number;
  typicalMs: number | null;
  frozenMs?: number;
  className?: string;
}) {
  const elapsed = useElapsedMs(startedAt, frozenMs);
  const note = renderClockNote(elapsed, typicalMs);
  if (!note) return null;
  return <span className={`${styles.note}${className ? ` ${className}` : ""}`}>{note}</span>;
}

/** Elapsed time with its sub text beside it -- the full clock. */
export function RenderClock({
  startedAt,
  typicalMs,
  frozenMs,
  className,
}: {
  startedAt: number;
  typicalMs: number | null;
  frozenMs?: number;
  className?: string;
}) {
  return (
    <span className={`${styles.clock}${className ? ` ${className}` : ""}`}>
      <RenderClockTime startedAt={startedAt} frozenMs={frozenMs} />
      <RenderClockNote startedAt={startedAt} typicalMs={typicalMs} frozenMs={frozenMs} />
    </span>
  );
}

/**
 * A 1px black rule along the top edge of a positioned stage, growing left to
 * right as elapsed / typical (capped at full width). Not rendered at all when
 * no typical duration is known. The parent must be position: relative.
 * With `frozenMs` it holds at that elapsed's position.
 */
export function RenderClockRule({
  startedAt,
  typicalMs,
  frozenMs,
}: {
  startedAt: number;
  typicalMs: number | null;
  frozenMs?: number;
}) {
  const elapsed = useElapsedMs(startedAt, frozenMs);
  const fraction = renderClockFraction(elapsed, typicalMs);
  if (fraction === null) return null;
  return <span className={styles.rule} style={{ transform: `scaleX(${fraction})` }} aria-hidden="true" />;
}
