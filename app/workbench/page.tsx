"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { RouteReady } from "@/app/components/RouteReady";
import { SiteNavigation } from "@/app/components/SiteNavigation";

const WorkbenchApp = dynamic(() => import("@/app/components/workbench/WorkbenchApp"), {
  ssr: false,
  loading: () => <WorkbenchVeil />,
});

/**
 * The pre-app screen, shaped like the workbench rather than like a blank
 * page: the persistent nav bar (the owner's header-consistency rule — the
 * bar must never blink out) over the paper and its 22px dot grid, matching
 * the React Flow <Background> the real canvas draws. A bare white <main>
 * here is what read as a "full-screen white flash" whenever the readiness
 * hold ran out before the chunk landed.
 */
function WorkbenchVeil() {
  return (
    <div style={{ height: "100dvh", paddingTop: 58, background: "var(--mono-off-white, #fafafa)", overflow: "hidden" }}>
      <SiteNavigation active="workbench" className="generator-navigation" />
      <div
        aria-busy="true"
        style={{
          height: "100%",
          display: "grid",
          placeItems: "center",
          backgroundImage: "radial-gradient(#d0d0d0 1.4px, transparent 1.4px)",
          backgroundSize: "22px 22px",
        }}
      >
        <p style={{ fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "rgb(0 0 0 / 45%)" }}>
          Loading workbench…
        </p>
      </div>
    </div>
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
