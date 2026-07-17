"use client";

import dynamic from "next/dynamic";
import styles from "./scene-lab.module.css";

const SceneLabExperience = dynamic(
  () => import("../components/scene-lab/SceneLabExperience"),
  {
    ssr: false,
    loading: () => (
      <main className={styles.shell} aria-busy="true">
        <p className={styles.loading}>Loading material field...</p>
      </main>
    ),
  },
);

export default function SceneLabPage() {
  return <SceneLabExperience />;
}
