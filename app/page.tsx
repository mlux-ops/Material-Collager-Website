"use client";

import dynamic from "next/dynamic";
import styles from "./scene-lab/scene-lab.module.css";

const LibraryScene = dynamic(
  () => import("./components/scene-lab/SceneLabExperience"),
  {
    ssr: false,
    loading: () => <main className={styles.shell} aria-busy="true"><p className={styles.loading}>Loading completed finish collages</p></main>,
  },
);

export default function LibraryPage() {
  return <LibraryScene surface="library" />;
}
