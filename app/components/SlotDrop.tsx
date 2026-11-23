"use client";

/**
 * SlotDrop — arm-and-develop for the Generator's reference cards.
 *
 * - useFileDragActive: true while a FILE drag is anywhere over the window.
 *   Every card that can take a photo shows it (the armed state).
 * - useSlotDropTargets / useSlotDropTarget: the whole card is the drop
 *   target. A drop fills only the card it lands on (slots are typed), and
 *   the card under the pointer is "over" (its upload label reads
 *   dropLabel(n), e.g. "DROP TO SET 03").
 * - markDeveloping / developClassName: a photo that was just added resolves
 *   in once with the site's Bayer dissolve (effects.css
 *   `.archive-image-dither`: mc-bayer-dissolve, 620ms, steps(17, end)).
 *   Tracked by File identity, so a photo restored from a saved draft (a new
 *   File read back from IndexedDB) is never marked.
 *
 * Window listeners: the armed state is driven from the CAPTURE phase so a
 * handler that stops propagation further down cannot leave every card
 * armed. The stray-drop guard runs in the BUBBLE phase and only touches an
 * event no target has already claimed (`defaultPrevented`): a file dropped
 * outside every card is refused (dropEffect "none") instead of making the
 * browser navigate away to the file.
 *
 * Only files dragged in from OUTSIDE the page count. Chrome puts "Files" on
 * a drag of any <img> on the page (a tray thumbnail, the render on the
 * stage), so without this a thumbnail picked up and dropped on another card
 * would add a copy of itself there. A drag that starts on this page fires
 * dragstart in this document and one from outside never does, so
 * trackPageDrags flags the former and acceptsFileDrag ignores it.
 */

import { useCallback, useEffect, useRef, useState, type DragEvent as ReactDragEvent } from "react";
import { type DragDepthEvent, isDragOver, isExternalFileDrag, nextDragDepth } from "@/app/lib/slot-drop";
import { motionReduced, potatoMode } from "@/app/lib/site-settings";
import styles from "./SlotDrop.module.css";

export { dropLabel } from "@/app/lib/slot-drop";

/**
 * A browser fires dragover at least every ~350ms while a drag is over the
 * page, even with the pointer still. A second without one means the drag
 * ended somewhere no event reached us (released outside the window, Escape
 * in some browsers), so the armed state is dropped.
 */
const DRAG_WATCHDOG_MS = 1000;

function dragTypes(transfer: DataTransfer | null | undefined): string[] {
  return transfer ? Array.from(transfer.types) : [];
}

/* ---------------------------------------------------------------------------
 * Page-drag tracking, shared by every drop target on the page.
 *
 * Set on dragstart (it only fires for a drag that starts in this document).
 * Cleared on dragend, which the source fires however the drag ends. If the
 * source left the DOM mid-drag its dragend never reaches window, so the next
 * pointerdown or pointermove clears it too: browsers send no pointer events
 * while a drag is in progress, so the first one means the drag is over.
 * Reference-counted so the listeners live exactly as long as some hook needs
 * them.
 * ------------------------------------------------------------------------- */

let pageDragActive = false;
let pageDragUsers = 0;

const onPageDragStart = () => {
  pageDragActive = true;
};
const clearPageDrag = () => {
  pageDragActive = false;
};

function trackPageDrags(): () => void {
  if (typeof window === "undefined") return () => undefined;
  pageDragUsers += 1;
  if (pageDragUsers === 1) {
    window.addEventListener("dragstart", onPageDragStart, true);
    window.addEventListener("dragend", clearPageDrag, true);
    window.addEventListener("pointerdown", clearPageDrag, true);
    window.addEventListener("pointermove", clearPageDrag, true);
  }
  return () => {
    pageDragUsers -= 1;
    if (pageDragUsers > 0) return;
    window.removeEventListener("dragstart", onPageDragStart, true);
    window.removeEventListener("dragend", clearPageDrag, true);
    window.removeEventListener("pointerdown", clearPageDrag, true);
    window.removeEventListener("pointermove", clearPageDrag, true);
    pageDragActive = false;
  };
}

/**
 * Whether a drag should count as photos coming in: it carries files and did
 * not start on this page. Every drop target on the Generator uses this, the
 * reference cards and the layout-reference box alike; it relies on
 * useFileDragActive (mounted by useSlotDropTargets) to keep the page-drag
 * flag current.
 */
export function acceptsFileDrag(transfer: DataTransfer | null | undefined): boolean {
  return isExternalFileDrag(dragTypes(transfer), pageDragActive);
}

export type FileDragActiveOptions = {
  /** Called once each time an active file drag ends (drop, dragend, leaving the window, watchdog). */
  onDragEnd?: () => void;
  /**
   * Refuse a file dropped where no target claimed it, so the browser does not
   * open the file in place of the page. Default true.
   */
  preventStrayDrop?: boolean;
};

/**
 * True while a file drag from outside the page is over the window. Ignores
 * every non-file drag, and every drag that started on the page.
 */
export function useFileDragActive(options: FileDragActiveOptions = {}): boolean {
  const { onDragEnd, preventStrayDrop = true } = options;
  const [active, setActive] = useState(false);
  const onDragEndRef = useRef(onDragEnd);

  useEffect(() => {
    onDragEndRef.current = onDragEnd;
  }, [onDragEnd]);

  useEffect(() => {
    const untrackPageDrags = trackPageDrags();
    let depth = 0;
    let on = false;
    let watchdog: ReturnType<typeof setTimeout> | null = null;

    const clearWatchdog = () => {
      if (watchdog !== null) {
        clearTimeout(watchdog);
        watchdog = null;
      }
    };
    const end = () => {
      depth = nextDragDepth(depth, "reset");
      clearWatchdog();
      if (!on) return;
      on = false;
      setActive(false);
      onDragEndRef.current?.();
    };
    const start = () => {
      clearWatchdog();
      watchdog = setTimeout(end, DRAG_WATCHDOG_MS);
      if (on) return;
      on = true;
      setActive(true);
    };
    const step = (event: DragDepthEvent) => {
      depth = nextDragDepth(depth, event);
    };

    // Capture phase: state only, never preventDefault.
    const onEnterCapture = (event: DragEvent) => {
      if (!acceptsFileDrag(event.dataTransfer)) return;
      step("enter");
      start();
    };
    const onOverCapture = (event: DragEvent) => {
      if (!acceptsFileDrag(event.dataTransfer)) return;
      // Also heals a missed dragenter (depth undercount): any dragover with
      // files means a file drag is in progress.
      start();
    };
    const onLeaveCapture = (event: DragEvent) => {
      if (!acceptsFileDrag(event.dataTransfer)) return;
      step("leave");
      if (!isDragOver(depth)) end();
    };
    const onDropCapture = (event: DragEvent) => {
      if (!acceptsFileDrag(event.dataTransfer)) return;
      end();
    };
    const onDragEndCapture = () => {
      end();
    };

    // Bubble phase: the stray-drop guard. A card (or the dashed box) that
    // accepts the drop has already called preventDefault by the time the
    // event reaches window, so it is left alone.
    const onOverBubble = (event: DragEvent) => {
      if (!preventStrayDrop || event.defaultPrevented) return;
      if (!acceptsFileDrag(event.dataTransfer)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
    };
    const onDropBubble = (event: DragEvent) => {
      if (!preventStrayDrop || event.defaultPrevented) return;
      if (!acceptsFileDrag(event.dataTransfer)) return;
      event.preventDefault();
    };

    window.addEventListener("dragenter", onEnterCapture, true);
    window.addEventListener("dragover", onOverCapture, true);
    window.addEventListener("dragleave", onLeaveCapture, true);
    window.addEventListener("drop", onDropCapture, true);
    window.addEventListener("dragend", onDragEndCapture, true);
    window.addEventListener("dragover", onOverBubble);
    window.addEventListener("drop", onDropBubble);
    return () => {
      window.removeEventListener("dragenter", onEnterCapture, true);
      window.removeEventListener("dragover", onOverCapture, true);
      window.removeEventListener("dragleave", onLeaveCapture, true);
      window.removeEventListener("drop", onDropCapture, true);
      window.removeEventListener("dragend", onDragEndCapture, true);
      window.removeEventListener("dragover", onOverBubble);
      window.removeEventListener("drop", onDropBubble);
      clearWatchdog();
      untrackPageDrags();
    };
  }, [preventStrayDrop]);

  return active;
}

export type SlotDropOptions = {
  /** Receives the dropped files, once per drop. */
  onFiles: (files: File[]) => void;
  /** A card that cannot take a photo: never armed, never over, drops pass through untouched. */
  disabled?: boolean;
};

export type SlotDropTargetProps = {
  onDragEnter: (event: ReactDragEvent<HTMLElement>) => void;
  onDragOver: (event: ReactDragEvent<HTMLElement>) => void;
  onDragLeave: (event: ReactDragEvent<HTMLElement>) => void;
  onDrop: (event: ReactDragEvent<HTMLElement>) => void;
};

export type SlotDropTargets = {
  /** A file drag is over the window. */
  armed: boolean;
  /** Key of the card under the pointer, or null. */
  overKey: string | null;
  /** Handlers to spread onto the card element for `key`. */
  targetProps: (key: string, options: SlotDropOptions) => SlotDropTargetProps;
};

/**
 * Drop targets for a list of cards rendered inline in one component (the
 * Generator's `items.map`), where a hook per card is not possible. One set of
 * window listeners serves every card; each card's enter/leave depth is kept
 * by key.
 */
export function useSlotDropTargets(): SlotDropTargets {
  const depths = useRef(new Map<string, number>());
  const [overKey, setOverKey] = useState<string | null>(null);

  const handleDragEnd = useCallback(() => {
    depths.current.clear();
    setOverKey(null);
  }, []);
  const armed = useFileDragActive({ onDragEnd: handleDragEnd });

  const targetProps = useCallback((key: string, options: SlotDropOptions): SlotDropTargetProps => {
    const { onFiles, disabled = false } = options;
    const step = (event: DragDepthEvent) => {
      const map = depths.current;
      const next = nextDragDepth(map.get(key) ?? 0, event);
      if (isDragOver(next)) map.set(key, next);
      else map.delete(key);
      return next;
    };
    const clearOver = () => setOverKey((current) => (current === key ? null : current));
    const accepts = (event: ReactDragEvent<HTMLElement>) => !disabled && acceptsFileDrag(event.dataTransfer);

    return {
      onDragEnter: (event) => {
        if (!accepts(event)) return;
        event.preventDefault();
        step("enter");
        setOverKey(key);
      },
      onDragOver: (event) => {
        if (!accepts(event)) return;
        // Required for the drop to fire here; "copy" shows the add cursor.
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        // Heals a missed dragenter. React skips the render when unchanged.
        setOverKey(key);
      },
      onDragLeave: (event) => {
        if (!accepts(event)) return;
        if (!isDragOver(step("leave"))) clearOver();
      },
      onDrop: (event) => {
        if (!acceptsFileDrag(event.dataTransfer)) return;
        step("drop");
        clearOver();
        if (disabled) return;
        // Something inside the card (the dashed box's own onDrop, if it was
        // left in place) already took this drop: do not add the files twice.
        if (event.defaultPrevented) return;
        event.preventDefault();
        const files = Array.from(event.dataTransfer.files);
        if (files.length > 0) onFiles(files);
      },
    };
  }, []);

  return { armed, overKey: armed ? overKey : null, targetProps };
}

const SINGLE_TARGET_KEY = "slot";

/** One drop target, for a card that is its own component. */
export function useSlotDropTarget(options: SlotDropOptions): {
  armed: boolean;
  over: boolean;
  targetProps: SlotDropTargetProps;
} {
  const { armed, overKey, targetProps } = useSlotDropTargets();
  const disabled = options.disabled ?? false;
  return {
    armed: armed && !disabled,
    over: !disabled && overKey === SINGLE_TARGET_KEY,
    targetProps: targetProps(SINGLE_TARGET_KEY, options),
  };
}

/**
 * Class names for the card element. `slot` is always present (it carries the
 * border transition, so leaving the armed state eases back too); `armed`
 * turns the dashed box solid black; `over` additionally whitens it.
 * Pass `armed` already AND-ed with "this card can take a photo".
 */
export function slotDropClassName(state: { armed: boolean; over: boolean }): string {
  let name = styles.slot;
  if (state.armed || state.over) name += ` ${styles.armed}`;
  if (state.over) name += ` ${styles.over}`;
  return name;
}

export const slotDropClasses = {
  slot: styles.slot,
  armed: styles.armed,
  over: styles.over,
} as const;

/* ---------------------------------------------------------------------------
 * Develop: the one-time Bayer dissolve for a newly added photo.
 *
 * The global `.archive-image-dither` class (effects.css) IS the site's
 * dissolve: mask-size 6px, mc-bayer-dissolve 620ms steps(17, end) both, and
 * it already turns itself off under prefers-reduced-motion and the site's
 * own reduce-motion setting. It is applied as a plain string so CSS Modules
 * never rewrites the global keyframe name. Potato mode is not covered by that
 * CSS, so markDeveloping skips it here, as it skips reduced motion.
 *
 * State is keyed by object identity (the reference's File) in WeakSets, so
 * it needs no React state, survives re-renders, and is collected with the
 * File:
 *   unmarked  -> the caller's fallback classes (unchanged behaviour)
 *   developing -> DEVELOP_CLASS
 *   developed -> "" (inert; the dissolve's end state is "no mask", so the
 *                class dropping off on a later render changes nothing, and a
 *                reorder that moves the node cannot replay it)
 * ------------------------------------------------------------------------- */

export const DEVELOP_CLASS = "archive-image-dither";

/**
 * After this long a marked photo counts as developed even if no animationend
 * arrived (the class never matched, the image never mounted). Comfortably
 * longer than the 620ms dissolve plus the render that mounts the image.
 */
const DEVELOP_SETTLE_MS = 1500;

const developing = new WeakSet<object>();
const developed = new WeakSet<object>();

/**
 * Mark freshly added photos (pass the same File objects that end up on the
 * references). Call it with the files of a user drop or pick, before or right
 * after adding them. Does nothing under reduced motion or potato mode, so
 * those photos simply appear.
 */
export function markDeveloping(items: Iterable<object>): void {
  if (typeof window === "undefined") return;
  if (motionReduced() || potatoMode()) return;
  for (const item of items) {
    if (developing.has(item) || developed.has(item)) continue;
    developing.add(item);
    window.setTimeout(() => finishDeveloping(item), DEVELOP_SETTLE_MS);
  }
}

/** The dissolve for `item` has played (or will not): stop applying it. */
export function finishDeveloping(item: object): void {
  if (!developing.has(item)) return;
  developing.delete(item);
  developed.add(item);
}

/**
 * Class for a photo's <img>: DEVELOP_CLASS while it develops, "" once it has,
 * and `fallback` (the classes it had before this feature, e.g. the print-in
 * classes) for every photo that was never marked — restored ones included.
 */
export function developClassName(item: object, fallback = ""): string {
  if (developing.has(item)) return DEVELOP_CLASS;
  if (developed.has(item)) return "";
  return fallback;
}

/** Spread onto the same <img>: ends the develop state when the dissolve finishes. */
export function developHandlers(item: object): { onAnimationEnd: () => void } {
  return { onAnimationEnd: () => finishDeveloping(item) };
}
