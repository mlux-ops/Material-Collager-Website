"use client";

import dynamic from "next/dynamic";
import { RouteReady } from "@/app/components/RouteReady";

const WorkbenchApp = dynamic(() => import("@/app/components/workbench/WorkbenchApp"), {
  ssr: false,
  loading: () => (
    <main style={{ display: "grid", placeItems: "center", height: "100dvh" }}>
      <p style={{ fontSize: 11, letterSpacing: "0.1575px", textTransform: "uppercase" }}>Loading workbench…</p>
    </main>
  ),
});

export default function WorkbenchPage() {
  return (
    <>
      {/* The workbench's own loading veil is designed content, so shell paint
          counts as ready — the wipe never reveals a blank page (FR-008). */}
      <RouteReady path="/workbench" />
      <WorkbenchApp />
    </>
  );
}
