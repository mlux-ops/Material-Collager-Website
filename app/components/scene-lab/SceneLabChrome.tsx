"use client";

import Link from "next/link";
import styles from "@/app/scene-lab/scene-lab.module.css";

export type SceneLabView = "scene" | "index";

export function SceneLabChrome({ active, homeHref = "/scene-lab", onViewChange, view }: { active?: "library" | "generator"; homeHref?: string; onViewChange: (view: SceneLabView) => void; view: SceneLabView }) {
  return (
    <>
      <header className={styles.header} aria-label="Material Collager">
        <Link className={`${styles.headerCell} ${styles.brandCell}`} href={homeHref} aria-label="Material Collager" title="MATERIAL COLLAGER">
          <span className={styles.brandFull}>MATERIAL COLLAGER</span>
          <span className={styles.brandShort} aria-hidden="true">MATERIAL COLL.</span>
        </Link>
        <Link className={`${styles.headerCell} ${styles.libraryCell}`} aria-current={active === "library" ? "page" : undefined} href="/">LIBRARY</Link>
        <Link className={`${styles.headerCell} ${styles.generatorCell}`} aria-current={active === "generator" ? "page" : undefined} href="/generator">GENERATOR</Link>
      </header>
      <div className={styles.viewControl} role="group" aria-label="Finish collage view">
        <button type="button" aria-pressed={view === "scene"} onClick={() => onViewChange("scene")}>SCENE</button>
        <button type="button" aria-pressed={view === "index"} onClick={() => onViewChange("index")}>INDEX</button>
      </div>
    </>
  );
}
