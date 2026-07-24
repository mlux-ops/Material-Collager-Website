"use client";

import dynamic from "next/dynamic";

const LibrarySceneV2 = dynamic(
  () => import("./components/scene-wheel-v2/SceneWheelV2"),
  {
    ssr: false,
    // Matches the scene's own loading veil so the handoff from chunk fetch to
    // the live percent counter is invisible.
    loading: () => (
      <main
        aria-busy="true"
        style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "#fff" }}
      >
        <p style={{ color: "#111", fontSize: 11, letterSpacing: "0.1em" }}>0%</p>
      </main>
    ),
  },
);

export default function LibraryPage() {
  return <LibrarySceneV2 />;
}
