"use client";

import dynamic from "next/dynamic";

const LibrarySceneV2 = dynamic(
  () => import("./components/scene-wheel-v2/SceneWheelV2"),
  {
    ssr: false,
    loading: () => (
      <main
        aria-busy="true"
        style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "#fafafa" }}
      >
        <p style={{ fontSize: 11, letterSpacing: "0.1em" }}>LOADING SPATIAL MATERIAL WHEEL...</p>
      </main>
    ),
  },
);

export default function LibraryPage() {
  return <LibrarySceneV2 />;
}
