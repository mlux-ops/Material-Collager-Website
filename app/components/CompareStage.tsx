"use client";

/**
 * CompareStage
 * ------------
 * A NEW render drawn over the PREVIOUS one, split by a 1px black divider.
 *
 * Arrival: whenever `arrivalKey` changes (and on mount), once the new image
 * has loaded it is drawn over the previous one from the left, over the app's
 * wipe duration (--wipe-dur, 700ms by default) on its wipe easing
 * cubic-bezier(0.22, 1, 0.36, 1) -- the same motion as the page wipe in
 * app/effects.css, with the divider riding the leading edge. The divider then
 * rests at the right edge as a handle: drag it left to uncover the previous
 * image on the right. Under reduced motion (OS or the site setting), or with
 * playArrival={false} (a comparison on display rather than arriving), there
 * is no wipe: the new image is shown at once with the divider at rest.
 *
 * One source of truth: every visual position (the new image's clip-path,
 * the divider line, the grab area, the range input's value) is written by a
 * single applySplit() from one number, imperatively through refs, so the clip
 * and the divider can never drift apart and a drag or a wipe frame costs no
 * React render.
 *
 * Keyboard: a native <input type="range"> stretched over the stage, invisible
 * and pointer-transparent; arrows, Home and End work natively. Its focus ring
 * is drawn on a sibling overlay inset into the frame (the stages around this
 * component clip anything outside them with overflow: hidden).
 *
 * Holds exactly two <img> elements. Both share one box and object-fit:
 * contain on a white fill, so the split lines up even when the two renders
 * have different aspect ratios; the new image's fill is opaque, so the
 * previous image never shows through the new one's letterbox bands.
 */

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { motionReduced, subscribeSettings } from "@/app/lib/site-settings";
import {
  clampSplit,
  clipPathForSplit,
  dividerLeft,
  handleLeft,
  parseDurationMs,
  splitFromPointer,
  SPLIT_REST,
  WIPE_DEFAULT_MS,
  wipeSplitAt,
} from "@/app/lib/compare-split";
import styles from "./CompareStage.module.css";

export type CompareImage = {
  src: string;
  alt: string;
};

export type CompareStageProps = {
  /** The render being replaced; shown to the right of the divider. */
  previous: CompareImage;
  /** The render that just landed; shown to the left of the divider. */
  current: CompareImage;
  /** Identity of the arrival. Each new value replays the wipe. */
  arrivalKey: string | number;
  /**
   * Whether an arrival plays the wipe. Default true. False mounts (and meets
   * each new arrivalKey) already settled, divider at rest, exactly as under
   * reduced motion -- for a comparison that is on display rather than
   * arriving, such as saved renders shown when a drawer opens. onSettled
   * still fires once per arrival.
   */
  playArrival?: boolean;
  /** Fired once per arrival when the wipe ends (at once under reduced motion
   * or with playArrival false, or when a drag or key press interrupts the
   * wipe). */
  onSettled?: () => void;
  className?: string;
};

// Slack on top of the wipe duration before a timer forces the end. rAF does
// not run in a hidden tab or a frozen preview pane; without this the wipe
// (and onSettled) would wait for the page to become visible again.
const WIPE_FALLBACK_SLACK_MS = 200;

// What a screen reader hears for the range: the share of the stage showing the
// new render, never a bare number.
function splitValueText(split: number): string {
  return `${Math.round(split)}% new render shown`;
}

function readWipeDurationMs(): number {
  if (typeof document === "undefined") return WIPE_DEFAULT_MS;
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--wipe-dur");
  return parseDurationMs(raw, WIPE_DEFAULT_MS);
}

export function CompareStage({
  previous,
  current,
  arrivalKey,
  playArrival = true,
  onSettled,
  className,
}: CompareStageProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const currentImgRef = useRef<HTMLImageElement | null>(null);
  const lineRef = useRef<HTMLSpanElement | null>(null);
  const handleRef = useRef<HTMLSpanElement | null>(null);
  const rangeRef = useRef<HTMLInputElement | null>(null);

  const splitRef = useRef<number>(SPLIT_REST);
  const rafRef = useRef<number | null>(null);
  const fallbackTimerRef = useRef<number | null>(null);
  const wipingRef = useRef(false);
  // Which arrival is on screen, and which one onSettled last fired for.
  // Keyed rather than a boolean, so a re-run of the arrival effect for the
  // same arrival (React StrictMode's dev double-invoke) never fires twice.
  const arrivalTokenRef = useRef<string>("");
  const settledForRef = useRef<string | null>(null);
  const dragRef = useRef<{ pointerId: number; offset: number } | null>(null);

  // Mirrored in an effect (never during render) so a caller's inline arrow
  // neither re-runs the arrival nor fires a stale callback.
  const onSettledRef = useRef(onSettled);
  useEffect(() => {
    onSettledRef.current = onSettled;
  }, [onSettled]);

  const applySplit = useCallback((value: number) => {
    const split = clampSplit(value);
    splitRef.current = split;
    const img = currentImgRef.current;
    if (img) img.style.clipPath = clipPathForSplit(split);
    const line = lineRef.current;
    if (line) line.style.left = dividerLeft(split);
    const handle = handleRef.current;
    if (handle) handle.style.left = handleLeft(split);
    const range = rangeRef.current;
    if (range) {
      range.value = String(Math.round(split));
      range.setAttribute("aria-valuetext", splitValueText(split));
    }
  }, []);

  const stopWipeTimers = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    if (fallbackTimerRef.current !== null) window.clearTimeout(fallbackTimerRef.current);
    fallbackTimerRef.current = null;
  }, []);

  const fireSettled = useCallback(() => {
    if (settledForRef.current === arrivalTokenRef.current) return;
    settledForRef.current = arrivalTokenRef.current;
    onSettledRef.current?.();
  }, []);

  // End the wipe where it should land: at rest, unless a drag or key press
  // interrupted it (`at` is then that interaction's split).
  const finishWipe = useCallback(
    (at: number = SPLIT_REST) => {
      stopWipeTimers();
      wipingRef.current = false;
      applySplit(at);
      fireSettled();
    },
    [applySplit, fireSettled, stopWipeTimers],
  );

  // Arrival. A layout effect, so the new image is clipped to nothing before
  // the first paint and never flashes in full ahead of its wipe.
  useLayoutEffect(() => {
    arrivalTokenRef.current = `${String(arrivalKey)}\u0000${current.src}`;
    dragRef.current = null;
    stopWipeTimers();

    // Not an arrival (playArrival false) or reduced motion: no wipe, the
    // comparison is simply there at rest.
    if (!playArrival || motionReduced()) {
      wipingRef.current = false;
      applySplit(SPLIT_REST);
      fireSettled();
      return;
    }

    wipingRef.current = true;
    applySplit(0);

    const img = currentImgRef.current;
    let started = false;

    const start = () => {
      if (started || !wipingRef.current) return;
      started = true;
      const duration = readWipeDurationMs();
      let startTs: number | null = null;
      const tick = (ts: number) => {
        if (!wipingRef.current) return;
        if (startTs === null) startTs = ts;
        const elapsed = ts - startTs;
        if (elapsed >= duration) {
          finishWipe(SPLIT_REST);
          return;
        }
        applySplit(wipeSplitAt(elapsed, duration));
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
      fallbackTimerRef.current = window.setTimeout(() => {
        if (wipingRef.current) finishWipe(SPLIT_REST);
      }, duration + WIPE_FALLBACK_SLACK_MS);
    };

    // A broken image has nothing to wipe in: show the frame at rest.
    const fail = () => {
      if (wipingRef.current) finishWipe(SPLIT_REST);
    };

    if (!img) {
      fail();
      return;
    }
    if (img.complete) {
      if (img.naturalWidth > 0) start();
      else fail();
      return;
    }
    img.addEventListener("load", start);
    img.addEventListener("error", fail);
    return () => {
      img.removeEventListener("load", start);
      img.removeEventListener("error", fail);
      stopWipeTimers();
      wipingRef.current = false;
    };
    // A new arrivalKey replays the wipe; so does a new `current.src` under
    // the same key, since that is a different new image to wait for and
    // draw in. playArrival turning false mid-wipe ends the wipe at rest.
  }, [arrivalKey, current.src, playArrival, applySplit, fireSettled, finishWipe, stopWipeTimers]);

  // Stop everything on unmount.
  useEffect(() => {
    return () => {
      stopWipeTimers();
      wipingRef.current = false;
    };
  }, [stopWipeTimers]);

  // Reduced motion switched on mid-wipe (OS preference or the site setting):
  // jump to rest instead of finishing the motion.
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      if (wipingRef.current && motionReduced()) finishWipe(SPLIT_REST);
    };
    mq.addEventListener("change", update);
    const unsubscribe = subscribeSettings(update);
    return () => {
      mq.removeEventListener("change", update);
      unsubscribe();
    };
  }, [finishWipe]);

  const onHandlePointerDown = (event: React.PointerEvent<HTMLSpanElement>) => {
    if (event.button !== 0) return;
    const root = rootRef.current;
    if (!root) return;
    event.preventDefault();
    const rect = root.getBoundingClientRect();
    const pointerSplit = splitFromPointer(event.clientX, rect.left, rect.width);
    if (wipingRef.current) finishWipe(splitRef.current);
    // Keep the grab offset, so grabbing the 38px area a few px off the line
    // does not jump the divider; from here the line tracks the pointer 1:1.
    dragRef.current = { pointerId: event.pointerId, offset: pointerSplit - splitRef.current };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onHandlePointerMove = (event: React.PointerEvent<HTMLSpanElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const root = rootRef.current;
    if (!root) return;
    const rect = root.getBoundingClientRect();
    applySplit(splitFromPointer(event.clientX, rect.left, rect.width) - drag.offset);
  };

  const endDrag = (event: React.PointerEvent<HTMLSpanElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const onRangeInput = (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = Number(event.currentTarget.value);
    if (wipingRef.current) finishWipe(value);
    else applySplit(value);
  };

  return (
    <div ref={rootRef} className={className ? `${styles.root} ${className}` : styles.root}>
      {/* eslint-disable-next-line @next/next/no-img-element -- data/object/authenticated URLs, sized by the stage */}
      <img className={styles.image} src={previous.src} alt={previous.alt} draggable={false} />
      {/* eslint-disable-next-line @next/next/no-img-element -- see above */}
      <img
        ref={currentImgRef}
        className={`${styles.image} ${styles.current}`}
        src={current.src}
        alt={current.alt}
        draggable={false}
      />
      <span ref={lineRef} className={styles.line} aria-hidden="true" />
      <span
        ref={handleRef}
        className={styles.handle}
        aria-hidden="true"
        onPointerDown={onHandlePointerDown}
        onPointerMove={onHandlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={() => {
          dragRef.current = null;
        }}
      />
      <input
        ref={rangeRef}
        className={styles.range}
        type="range"
        min={0}
        max={100}
        step={1}
        defaultValue={SPLIT_REST}
        aria-valuetext={splitValueText(SPLIT_REST)}
        aria-label="Compare previous and new render"
        onChange={onRangeInput}
      />
      <span className={styles.focusRing} aria-hidden="true" />
      <span className={`${styles.label} ${styles.labelNew}`} aria-hidden="true">
        New
      </span>
      <span className={`${styles.label} ${styles.labelPrevious}`} aria-hidden="true">
        Previous
      </span>
    </div>
  );
}

export default CompareStage;
