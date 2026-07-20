"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
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
import styles from "./scene-wheel-v2.module.css";

const SceneWheelCanvas = dynamic(() => import("./SceneWheelCanvas"), { ssr: false });

export default function SceneWheelV2() {
  const trackRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const targetProgress = useNativeScrollProgress(trackRef);
  const [records, setRecords] = useState<LibraryCollageRecord[]>([]);
  const [libraryState, setLibraryState] = useState<"loading" | "ready" | "fallback">("loading");
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
        setRecords(normalized);
        setLibraryState(normalized.length > 0 ? "ready" : "fallback");
      } catch (error) {
        if (controller.signal.aborted) return;
        console.warn("Scene Wheel V2 is using the lab collage fixtures.", error);
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

  return (
    <main className={styles.page}>
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

          <header className={styles.chrome} aria-label="Material Collager">
            <Link
              href="/"
              className={`${styles.chromeCell} ${styles.brand}`}
              aria-label="Material Collager"
              title="MATERIAL COLLAGER"
            >
              <span className={styles.brandFull}>MATERIAL COLLAGER</span>
              <span className={styles.brandShort} aria-hidden="true">MATERIAL COLL.</span>
            </Link>
            <nav aria-label="Primary navigation">
              <Link href="/" className={styles.chromeCell} aria-current="page">
                LIBRARY
              </Link>
              <Link href="/generator" className={styles.chromeCell}>
                GENERATOR
              </Link>
            </nav>
          </header>

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
