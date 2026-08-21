"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { RouteReady } from "@/app/components/RouteReady";
import { awaitTransitionSettled } from "@/app/lib/route-ready.ts";

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
  // First visits pay the workbench chunk's parse/eval and the node editor's
  // mount on the main thread; doing that mid-wipe starves the transition of
  // frames (the incoming side is live) and reads as a white freeze. Hold the
  // app until the wipe settles — the designed veil carries the gap, and with
  // hover warming (SiteNavigation) the post-settle mount is quick.
  const [mountApp, setMountApp] = useState(false);
  useEffect(() => {
    let alive = true;
    void awaitTransitionSettled().then(() => {
      if (alive) setMountApp(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <>
      {/* The workbench's own loading veil is designed content, so shell paint
          counts as ready — the wipe never reveals a blank page (FR-008). */}
      <RouteReady path="/workbench" />
      {mountApp ? <WorkbenchApp /> : <WorkbenchVeil />}
    </>
  );
}
