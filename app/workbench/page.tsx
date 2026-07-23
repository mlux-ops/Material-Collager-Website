"use client";

import dynamic from "next/dynamic";

const WorkbenchApp = dynamic(() => import("@/app/components/workbench/WorkbenchApp"), {
  ssr: false,
  loading: () => (
    <main style={{ display: "grid", placeItems: "center", height: "100dvh" }}>
      <p style={{ fontSize: 11, letterSpacing: "0.1575px", textTransform: "uppercase" }}>Loading workbench…</p>
    </main>
  ),
});

export default function WorkbenchPage() {
  return <WorkbenchApp />;
}
