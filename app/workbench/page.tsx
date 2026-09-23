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
function WorkbenchVeil({ failed = false }: { failed?: boolean }) {
  return (
    <div style={{ height: "100dvh", paddingTop: 58, background: "var(--mono-off-white, #fafafa)", overflow: "hidden" }}>
      <SiteNavigation active="workbench" className="generator-navigation" />
      <div
        aria-busy={failed ? undefined : "true"}
        style={{
          height: "100%",
          display: "grid",
          placeItems: "center",
          backgroundImage: "radial-gradient(#d0d0d0 1.4px, transparent 1.4px)",
          backgroundSize: "22px 22px",
        }}
      >
        {failed ? (
          <div role="alert" style={{ display: "grid", gap: 10, justifyItems: "center", textAlign: "center" }}>
            <p style={{ fontSize: 11, color: "#000000", margin: 0 }}>
              The workbench could not load. Your saved workbenches are safe on this device.
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                fontSize: 8.4,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                color: "#000000",
                background: "transparent",
                border: "1px solid #000000",
                borderRadius: 0,
                padding: "6px 12px",
                cursor: "pointer",
              }}
            >
              Reload
            </button>
          </div>
        ) : (
          <p style={{ fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "rgb(0 0 0 / 45%)" }}>
            Loading workbench…
          </p>
        )}
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
  const [chunk, setChunk] = useState<"loading" | "loaded" | "failed">("loading");
  useEffect(() => {
    let alive = true;
    void import("@/app/components/workbench/WorkbenchApp")
      .then(() => {
        if (alive) setChunk("loaded");
      })
      .catch(() => {
        // Chunk failure (offline, or a deploy replaced the chunk): say so and
        // offer a reload instead of a veil that never lifts. The readiness
        // budget still releases the wipe onto this screen.
        if (alive) setChunk("failed");
      });
    return () => {
      alive = false;
    };
  }, []);

  if (chunk === "failed") return <WorkbenchVeil failed />;
  if (chunk !== "loaded") return <WorkbenchVeil />;
  return (
    <>
      <RouteReady path="/workbench" />
      <WorkbenchApp />
    </>
  );
}
