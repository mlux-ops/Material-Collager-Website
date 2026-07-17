"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  adaptCompletedCollages,
  normalizeLibraryCollageRecords,
  parseLibraryPayload,
  type LibraryCollageRecord,
  type SceneLabCollageItem,
} from "@/app/lib/scene-lab-assets";
import { useNativeScrollProgress } from "./useNativeScrollProgress";
import styles from "./scene-wheel-v2.module.css";

const SceneWheelCanvas = dynamic(() => import("./SceneWheelCanvas"), { ssr: false });

export default function SceneWheelV2() {
  const trackRef = useRef<HTMLElement>(null);
  const targetProgress = useNativeScrollProgress(trackRef);
  const [records, setRecords] = useState<LibraryCollageRecord[]>([]);
  const [libraryState, setLibraryState] = useState<"loading" | "ready" | "fallback">("loading");
  const [selectedItem, setSelectedItem] = useState<SceneLabCollageItem | null>(null);

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
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedItem(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedItem]);

  const catalog = useMemo(
    () => adaptCompletedCollages(records, { allowLabFixtures: true }),
    [records],
  );

  return (
    <main className={styles.page}>
      <section ref={trackRef} className={styles.track} aria-label="Experimental linear material rail">
        <div className={styles.sticky}>
          <div className={styles.canvas}>
            {catalog.items.length > 0 ? (
              <SceneWheelCanvas
                items={catalog.items}
                onOpen={setSelectedItem}
                targetProgress={targetProgress}
              />
            ) : null}
          </div>

          <header className={styles.chrome}>
            <Link href="/" className={styles.brand}>MATERIAL COLLAGER</Link>
            <nav aria-label="Scene comparison">
              <Link href="/scene-lab">V1</Link>
              <span aria-current="page">V2</span>
            </nav>
          </header>

          <div className={styles.caption}>
            <p>LINEAR GLASS MATERIAL RAIL · CONTINUOUS NATIVE SCROLL</p>
            <p>{libraryState === "ready" ? "LIVE LIBRARY" : "LAB COLLAGES"}</p>
          </div>

          <div className={styles.scrollCue} aria-hidden="true">
            <span>SCROLL BOTH DIRECTIONS</span>
            <i />
          </div>

          <ol className={styles.semanticList}>
            {catalog.items.map((item) => <li key={item.id}>{item.accessibleName}</li>)}
          </ol>
        </div>
      </section>

      {selectedItem ? (
        <div
          className={styles.viewerBackdrop}
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setSelectedItem(null);
          }}
        >
          <section className={styles.viewer} role="dialog" aria-modal="true" aria-labelledby="scene-wheel-viewer-title">
            <div className={styles.viewerToolbar}>
              <div>
                <p>Material rail</p>
                <h2 id="scene-wheel-viewer-title">{selectedItem.title}</h2>
              </div>
              <button type="button" onClick={() => setSelectedItem(null)}>Close</button>
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
