"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  adaptCompletedCollages,
  normalizeLibraryCollageRecords,
  parseLibraryPayload,
  type LibraryCollageRecord,
  type SceneLabCollageItem,
} from "@/app/lib/scene-lab-assets";
import type { SceneWheelHoverState } from "./SceneCard";
import { useNativeScrollProgress } from "./useNativeScrollProgress";
import { SiteNavigation } from "../SiteNavigation";
import styles from "./scene-wheel-v2.module.css";

const SceneWheelCanvas = dynamic(() => import("./SceneWheelCanvas"), { ssr: false });

// Progress is split so the counter starts moving on the library response and
// spends the rest of its travel on the card images, which dominate the wait.
const FETCH_SHARE = 12;
// A slow or hung image must never trap the visitor on the loading screen.
const PRELOAD_TIMEOUT_MS = 12000;

export default function SceneWheelV2() {
  const trackRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const targetProgress = useNativeScrollProgress(trackRef);
  const [records, setRecords] = useState<LibraryCollageRecord[]>([]);
  const [libraryState, setLibraryState] = useState<"loading" | "ready" | "fallback">("loading");
  const [revealed, setRevealed] = useState(false);
  const countRef = useRef<HTMLParagraphElement>(null);
  // Written by the fetch + image-preload passes, read by the rAF counter so
  // progress eases toward the real figure instead of snapping between images.
  const loadTargetRef = useRef(0);
  const [hoveredItem, setHoveredItem] = useState<SceneLabCollageItem | null>(null);
  const [selectedItem, setSelectedItem] = useState<SceneLabCollageItem | null>(null);
  const cursorLabelRef = useRef<HTMLParagraphElement>(null);
  const hoverPointRef = useRef({ x: 0, y: 0 });

  const positionCursorLabel = useCallback(() => {
    const label = cursorLabelRef.current;
    if (!label) return;
    label.style.left = `${hoverPointRef.current.x + 14}px`;
    label.style.top = `${hoverPointRef.current.y}px`;
  }, []);

  // Pointer moves position the label imperatively; state only tracks which
  // item is hovered, so per-move re-renders never touch the canvas tree.
  const handleHover = useCallback((state: SceneWheelHoverState) => {
    if (state) {
      hoverPointRef.current = { x: state.clientX, y: state.clientY };
      positionCursorLabel();
    }
    setHoveredItem((current: SceneLabCollageItem | null) => {
      const next = state?.item ?? null;
      return current?.id === next?.id ? current : next;
    });
  }, [positionCursorLabel]);

  const handleOpen = useCallback((item: SceneLabCollageItem) => {
    setHoveredItem(null);
    setSelectedItem(item);
  }, []);

  useLayoutEffect(() => {
    if (hoveredItem) positionCursorLabel();
  }, [hoveredItem, positionCursorLabel]);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await fetch("/api/library", { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const parsed = parseLibraryPayload(await response.json());
        if (!parsed.valid) throw new Error(parsed.message);
        const normalized = normalizeLibraryCollageRecords(parsed.records);
        loadTargetRef.current = Math.max(loadTargetRef.current, FETCH_SHARE);
        setRecords(normalized);
        setLibraryState(normalized.length > 0 ? "ready" : "fallback");
      } catch (error) {
        if (controller.signal.aborted) return;
        console.warn("Scene Wheel V2 is using the lab collage fixtures.", error);
        loadTargetRef.current = Math.max(loadTargetRef.current, FETCH_SHARE);
        setRecords([]);
        setLibraryState("fallback");
      }
    };
    void load();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!selectedItem) return;

    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const focusFrame = window.requestAnimationFrame(() => {
      closeButtonRef.current?.focus({ preventScroll: true });
    });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedItem(null);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousBodyOverflow;
      if (previouslyFocused && previouslyFocused !== document.body) {
        previouslyFocused.focus({ preventScroll: true });
      }
    };
  }, [selectedItem]);

  useEffect(() => {
    const clearHover = () => setHoveredItem(null);
    window.addEventListener("blur", clearHover);
    return () => window.removeEventListener("blur", clearHover);
  }, []);

  const catalog = useMemo(
    () => adaptCompletedCollages(records, { allowLabFixtures: true }),
    [records],
  );

  // Preload the card images the canvas is about to turn into textures. Both
  // share the HTTP cache, so counting these to 100% means the reveal shows
  // finished cards rather than empty planes still waiting on bytes.
  useEffect(() => {
    if (libraryState === "loading") return;

    const urls = catalog.items.map((item) => item.url);
    if (urls.length === 0) {
      loadTargetRef.current = 100;
      return;
    }

    let settled = 0;
    let cancelled = false;
    const images: HTMLImageElement[] = [];

    // Failures still advance the counter: a broken card is the canvas's
    // problem to render, not a reason to hold the whole page hostage.
    const settle = () => {
      if (cancelled) return;
      settled += 1;
      const share = FETCH_SHARE + (100 - FETCH_SHARE) * (settled / urls.length);
      loadTargetRef.current = Math.max(loadTargetRef.current, share);
    };

    for (const url of urls) {
      const image = new Image();
      image.decoding = "async";
      image.onload = settle;
      image.onerror = settle;
      image.src = url;
      images.push(image);
    }

    const timeout = window.setTimeout(() => {
      if (!cancelled) loadTargetRef.current = 100;
    }, PRELOAD_TIMEOUT_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      for (const image of images) {
        image.onload = null;
        image.onerror = null;
      }
    };
  }, [catalog, libraryState]);

  // Ease the shown number toward the measured target, then hand over to the
  // fade once it actually reads 100%. The text is written imperatively so a
  // 60fps counter never re-renders the canvas tree underneath the veil.
  useEffect(() => {
    if (revealed) return;

    let frame = 0;
    let shown = 0;
    const step = () => {
      const target = loadTargetRef.current;
      shown += Math.max((target - shown) * 0.12, target > shown ? 0.25 : 0);
      if (target >= 100 && shown > 99.4) {
        if (countRef.current) countRef.current.textContent = "100%";
        setRevealed(true);
        return;
      }
      if (countRef.current) countRef.current.textContent = `${Math.round(shown)}%`;
      frame = window.requestAnimationFrame(step);
    };

    frame = window.requestAnimationFrame(step);
    return () => window.cancelAnimationFrame(frame);
  }, [revealed]);

  // The rail is 900vh tall; keep it unscrollable until the cards are visible.
  useEffect(() => {
    if (revealed) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [revealed]);

  return (
    <main className={`${styles.page} ${revealed ? styles.pageRevealed : ""}`} aria-busy={!revealed}>
      {revealed ? null : (
        <div className={styles.loadingVeil} role="status" aria-label="Loading library">
          <p ref={countRef} className={styles.loadingCount}>0%</p>
        </div>
      )}

      <section
        ref={trackRef}
        className={styles.track}
        aria-label="Experimental linear material rail"
        aria-hidden={selectedItem ? true : undefined}
        inert={selectedItem ? true : undefined}
      >
        <div className={styles.sticky}>
          <div className={styles.canvas} onPointerLeave={() => setHoveredItem(null)}>
            {libraryState !== "loading" && catalog.items.length > 0 ? (
              <SceneWheelCanvas
                items={catalog.items}
                onHover={handleHover}
                onOpen={handleOpen}
                targetProgress={targetProgress}
              />
            ) : null}
          </div>

          <SiteNavigation active="library" className={styles.chrome} />

          <div className={styles.caption}>
            <p>
              <span className={styles.captionFull}>LINEAR GLASS MATERIAL RAIL · CONTINUOUS NATIVE SCROLL</span>
              <span className={styles.captionShort}>LINEAR GLASS RAIL</span>
            </p>
            <p>{libraryState === "ready" ? "LIVE LIBRARY" : "LAB COLLAGES"}</p>
          </div>

          <div className={styles.scrollCue} aria-hidden="true">
            <span>SCROLL BOTH DIRECTIONS</span>
            <i />
          </div>

          {hoveredItem ? (
            <p ref={cursorLabelRef} className={styles.cursorLabel}>
              {hoveredItem.title}
            </p>
          ) : null}

          <ol className={styles.semanticList}>
            {catalog.items.map((item) => <li key={item.id}>{item.accessibleName}</li>)}
          </ol>
        </div>
      </section>

      {selectedItem ? (
        <div
          className={styles.viewerBackdrop}
          role="presentation"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) setSelectedItem(null);
          }}
        >
          <section className={styles.viewer} role="dialog" aria-modal="true" aria-labelledby="scene-wheel-viewer-title">
            <div className={styles.viewerToolbar}>
              <div>
                <p>Material rail</p>
                <h2 id="scene-wheel-viewer-title">{selectedItem.title}</h2>
              </div>
              <button ref={closeButtonRef} type="button" onClick={() => setSelectedItem(null)}>Close</button>
            </div>
            <div className={styles.viewerImage}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={selectedItem.url} alt={selectedItem.title} />
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}
