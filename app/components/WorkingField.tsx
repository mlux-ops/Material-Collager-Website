"use client";

/**
 * WorkingField — the generator's "working" state as a slow, dithered teal
 * Velaris field. Mounted only while a render is in flight: as the fill of
 * the progress track (clipped by the determinate width span) and as the
 * ground of the WORKING status pill.
 *
 * Rules (pure decisions in app/lib/working-field.ts):
 *  - potato machine: renders nothing; the existing flat CSS fill shows.
 *  - reduced motion: one static frame, never a loop.
 *  - otherwise the loop plays only while the tab is visible AND the field is
 *    on screen; both inputs feed one workingFieldPlaying() decision here,
 *    and Velaris itself only ever sees `paused`.
 *  - backing store capped at 1.5x devicePixelRatio.
 *
 * Each mount picks its own seed, and the field unmounts with the render, so
 * every job paints a different pattern.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Velaris from "./ui/velaris";
import { motionReduced, potatoMode, subscribeSettings } from "@/app/lib/site-settings";
import {
  WORKING_FIELD_DITHER_LEVELS,
  workingFieldMode,
  workingFieldPalette,
  workingFieldPlaying,
  workingFieldSeed,
  type WorkingFieldMode,
  type WorkingFieldVariant,
} from "@/app/lib/working-field";

// Module constants: Velaris rebuilds its GL context whenever colors or
// dither change identity, so these must never be fresh literals per render.
const PALETTES = {
  track: workingFieldPalette("track"),
  pill: workingFieldPalette("pill"),
} as const;
const DITHER = { cell: 1, levels: WORKING_FIELD_DITHER_LEVELS };
const SPEED = 0.6; // the wordmark rows run at 2.0; state should idle, not dance
const GRAIN = 0.2;
const MAX_DPR = 1.5;

function subscribeMode(onChange: () => void): () => void {
  const unsubscribe = subscribeSettings(onChange);
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  media.addEventListener("change", onChange);
  return () => {
    unsubscribe();
    media.removeEventListener("change", onChange);
  };
}

function readMode(): WorkingFieldMode {
  return workingFieldMode({ potato: potatoMode(), reduced: motionReduced() });
}

// Server render (and hydration) never has the settings: start off, then the
// client snapshot takes over.
function readServerMode(): WorkingFieldMode {
  return "off";
}

export interface WorkingFieldProps {
  variant?: WorkingFieldVariant;
  /** Optional explicit seed; by default each mount draws its own. */
  seed?: number;
}

export function WorkingField({ variant = "track", seed }: WorkingFieldProps) {
  const mode = useSyncExternalStore(subscribeMode, readMode, readServerMode);
  if (mode === "off") return null;
  return <WorkingFieldCanvas mode={mode} variant={variant} seed={seed} />;
}

function WorkingFieldCanvas({
  mode,
  variant,
  seed,
}: {
  mode: Exclude<WorkingFieldMode, "off">;
  variant: WorkingFieldVariant;
  seed?: number;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [mountSeed] = useState(() => workingFieldSeed(Math.random() * 1_000_000));
  const [view, setView] = useState({ documentHidden: false, onscreen: true });

  // One listener set per field, feeding one state object: tab visibility and
  // viewport intersection are combined by workingFieldPlaying() below.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let documentHidden = document.hidden;
    let onscreen = true;
    const publish = () =>
      setView((prev) =>
        prev.documentHidden === documentHidden && prev.onscreen === onscreen
          ? prev
          : { documentHidden, onscreen },
      );
    const onVisibility = () => {
      documentHidden = document.hidden;
      publish();
    };
    document.addEventListener("visibilitychange", onVisibility);
    // The observer's first callback arrives on its own (asynchronously) and
    // also publishes the current visibility, so nothing is set synchronously.
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) onscreen = entry.isIntersecting;
      publish();
    });
    observer.observe(root);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      observer.disconnect();
    };
  }, []);

  const playing = workingFieldPlaying(mode, view);
  const palette = PALETTES[variant];

  return (
    <div ref={rootRef} className={`working-field working-field-${variant}`} aria-hidden="true">
      <Velaris
        height="100%"
        bg={palette.bg}
        colors={palette.colors}
        seed={seed === undefined ? mountSeed : workingFieldSeed(seed)}
        speed={SPEED}
        grain={GRAIN}
        dither={DITHER}
        frozen={mode === "static"}
        paused={mode === "live" && !playing}
        maxDpr={MAX_DPR}
      />
    </div>
  );
}

export default WorkingField;
