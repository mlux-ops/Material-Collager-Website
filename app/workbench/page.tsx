"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { RouteReady } from "@/app/components/RouteReady";

const WorkbenchApp = dynamic(() => import("@/app/components/workbench/WorkbenchApp"), {
  ssr: false,
  loading: () => <WorkbenchVeil />,
});

function WorkbenchVeil() {
  return (
    <main style={{ display: "grid", placeItems: "center", height: "100dvh" }}>
      <p style={{ fontSize: 11, letterSpacing: "0.1575px", textTransform: "uppercase" }}>Loading workbench…</p>
    </main>
  );
}

export default function WorkbenchPage() {
  // Readiness is deliberately NOT signalled until the real app's chunk has
  // loaded and committed: the wipe holds on the outgoing page (readiness
  // wait in TransitionLink, bounded by READY_BUDGET_MS) while the chunk
  // fetches and evaluates — the update callback suspends rendering, so that
  // work never competes with animation frames — and then one normal-speed
  // wipe reveals the finished workbench. If the chunk outlives the budget,
  // the wipe proceeds onto the designed veil instead (FR-007/FR-008), which
  // is also what a direct page load shows. Hover warming (SiteNavigation)
  // makes the hold imperceptible in the common case.
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    void import("@/app/components/workbench/WorkbenchApp")
      .then(() => {
        if (alive) setLoaded(true);
      })
      .catch(() => {
        // Chunk failure: leave the veil; the budget releases the wipe.
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!loaded) return <WorkbenchVeil />;
  return (
    <>
      <RouteReady path="/workbench" />
      <WorkbenchApp />
    </>
  );
}
