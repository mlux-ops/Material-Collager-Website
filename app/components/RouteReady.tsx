"use client";

/**
 * Declares a route's content committed for the plotter-wipe transition.
 *
 * Deliberately NOT requestAnimationFrame-based: the signal fires while the
 * navigation runs inside a ViewTransition update callback, and rendering is
 * suspended there — rAF callbacks never run until the callback resolves
 * (verified in specs/20260821-page-transitions-upgrade/research.md, T016).
 * Passive effects are task-scheduled, so a plain effect fires fine, and
 * commit-level readiness is correct: the browser captures the new snapshot at
 * the first real render opportunity after the callback resolves, which paints
 * this committed DOM.
 */

import { useEffect } from "react";
import { markRouteReady } from "@/app/lib/route-ready.ts";

export function RouteReady({ path }: { path: string }) {
  useEffect(() => {
    markRouteReady(path);
  }, [path]);
  return null;
}

export default RouteReady;
