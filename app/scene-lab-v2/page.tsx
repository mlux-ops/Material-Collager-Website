"use client";

import dynamic from "next/dynamic";

const SceneWheelV2 = dynamic(
  () => import("../components/scene-wheel-v2/SceneWheelV2"),
  {
    ssr: false,
    loading: () => (
      <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "#fafafa" }}>
        <p style={{ fontSize: 11, letterSpacing: "0.1em" }}>LOADING SPATIAL MATERIAL WHEEL…</p>
      </main>
    ),
  },
);

export default function SceneLabV2Page() {
  return <SceneWheelV2 />;
}
