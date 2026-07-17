"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  adaptCompletedCollages,
  normalizeLibraryCollageRecords,
  parseLibraryPayload,
  type LibraryCollageRecord,
} from "@/app/lib/scene-lab-assets";
import { useNativeScrollProgress } from "./useNativeScrollProgress";
import styles from "./scene-wheel-v2.module.css";

const SceneWheelCanvas = dynamic(() => import("./SceneWheelCanvas"), { ssr: false });

export default function SceneWheelV2() {
  const trackRef = useRef<HTMLElement>(null);
  const targetProgress = useNativeScrollProgress(trackRef);
  const [records, setRecords] = useState<LibraryCollageRecord[]>([]);
  const [libraryState, setLibraryState] = useState<"loading" | "ready" | "fallback">("loading");

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

  const catalog = useMemo(
    () => adaptCompletedCollages(records, { allowLabFixtures: true }),
    [records],
  );

  return (
    <main className={styles.page}>
      <section ref={trackRef} className={styles.track} aria-label="Experimental spatial material wheel">
        <div className={styles.sticky}>
          <div className={styles.canvas}>
            {catalog.items.length > 0 ? (
              <SceneWheelCanvas items={catalog.items} targetProgress={targetProgress} />
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
            <p>TRUE 3D RIBBON · NATIVE SCROLL</p>
            <p>{libraryState === "ready" ? "LIVE LIBRARY" : "LAB COLLAGES"}</p>
          </div>

          <div className={styles.scrollCue} aria-hidden="true">
            <span>SCROLL</span>
            <i />
          </div>

          <ol className={styles.semanticList}>
            {catalog.items.map((item) => <li key={item.id}>{item.accessibleName}</li>)}
          </ol>
        </div>
      </section>
    </main>
  );
}
