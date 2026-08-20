"use client";

/**
 * DitherReveal
 * ------------
 * An image that starts life as a 1-bit ordered-dither (Bayer or halftone)
 * and resolves cell-by-cell into the real image as `progress` advances.
 *
 * Backend reality this is built for: progress is NOT a smooth stream. The
 * render pipeline emits at most four discrete states (queued -> up to three
 * partial images -> final). This component tweens smoothly between whatever
 * discrete values it is handed, and `src` itself may change mid-run (each
 * partial is a strictly-better image at the same pixel size) without
 * restarting the reveal or flashing.
 *
 * Canvas 2D only. No WebGL. No new dependencies.
 */

import { useEffect, useMemo, useRef, useState } from "react";

// 4x4 Bayer ordered-dither matrix, values 0..15 (divide by 16 for threshold).
const BAYER4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

export type DitherRevealMode = "bayer" | "halftone";

export type DitherRevealProps = {
  src: string;
  alt?: string;
  /** Controlled progress 0..1. Omit (or pass undefined) for the indeterminate/hold state. */
  progress?: number;
  mode?: DitherRevealMode;
  /** Cell size in CSS px at the image's intrinsic resolution. */
  cell?: number;
  ink?: string;
  paper?: string;
  width?: number;
  height?: number;
  className?: string;
  style?: React.CSSProperties;
};

type CellSample = {
  cols: number;
  rows: number;
  lum: Float32Array; // 0..1 per cell
  r: Uint8ClampedArray;
  g: Uint8ClampedArray;
  b: Uint8ClampedArray;
};

function sampleImageToCells(img: HTMLImageElement, cols: number, rows: number): CellSample | null {
  const off = document.createElement("canvas");
  off.width = cols;
  off.height = rows;
  const ctx = off.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(img, 0, 0, cols, rows);
  const { data } = ctx.getImageData(0, 0, cols, rows);
  const n = cols * rows;
  const lum = new Float32Array(n);
  const r = new Uint8ClampedArray(n);
  const g = new Uint8ClampedArray(n);
  const b = new Uint8ClampedArray(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const rr = data[o];
    const gg = data[o + 1];
    const bb = data[o + 2];
    r[i] = rr;
    g[i] = gg;
    b[i] = bb;
    lum[i] = (0.2126 * rr + 0.7152 * gg + 0.0722 * bb) / 255;
  }
  return { cols, rows, lum, r, g, b };
}

let sharedColorCtx: CanvasRenderingContext2D | null | undefined;

// Canvas fillStyle cannot resolve CSS custom properties on its own (it isn't
// attached to any element), so var(--token, fallback) strings are resolved
// against the document's computed style first.
function resolveCssColor(color: string): string {
  const trimmed = color.trim();
  const varMatch = trimmed.match(/^var\((--[\w-]+)\s*(?:,\s*(.+))?\)$/);
  if (!varMatch) return trimmed;
  const [, token, fallback] = varMatch;
  if (typeof document === "undefined") return fallback ?? "#000000";
  const resolved = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  return resolved || fallback || "#000000";
}

function parseColor(color: string): [number, number, number] {
  const resolvedColor = resolveCssColor(color);
  if (sharedColorCtx === undefined) {
    sharedColorCtx = document.createElement("canvas").getContext("2d");
  }
  const ctx = sharedColorCtx;
  if (!ctx) return [0, 0, 0];
  ctx.fillStyle = "#000";
  ctx.fillStyle = resolvedColor;
  const computed = ctx.fillStyle;
  if (computed.startsWith("#")) {
    const hex = computed.length === 4
      ? computed.slice(1).split("").map((c) => c + c).join("")
      : computed.slice(1);
    const num = parseInt(hex, 16);
    return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
  }
  const m = computed.match(/\d+/g);
  if (m) return [Number(m[0]), Number(m[1]), Number(m[2])];
  return [0, 0, 0];
}

export function DitherReveal({
  src,
  alt = "",
  progress,
  mode = "bayer",
  cell = 4,
  ink = "var(--ink, #171a18)",
  paper = "var(--background, #eceeea)",
  width,
  height,
  className,
  style,
}: DitherRevealProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const displayedRef = useRef(0); // eased progress actually drawn
  const targetRef = useRef(progress ?? 0);
  const progressPropRef = useRef(progress); // mirrors the raw prop (may be undefined) so the
  // long-lived rAF loop below never reads a stale closured `progress` value.
  const samplesRef = useRef<CellSample | null>(null);
  const naturalSizeRef = useRef<{ w: number; h: number } | null>(null);
  const inkRgbRef = useRef<[number, number, number]>([23, 26, 24]);
  const paperRgbRef = useRef<[number, number, number]>([236, 238, 234]);
  const shimmerPhaseRef = useRef(0);
  const lastTsRef = useRef<number | null>(null);
  const [settled, setSettled] = useState(false); // true once fully resolved -> hand off to <img>
  const settledRef = useRef(false); // mirrors `settled` for the rAF loop's stale-closure-free read
  const [reducedMotion, setReducedMotion] = useState(false);
  const indeterminate = progress === undefined;

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    inkRgbRef.current = parseColor(ink);
    paperRgbRef.current = parseColor(paper);
  }, [ink, paper]);

  // Load / reload the source image whenever `src` changes, WITHOUT resetting
  // displayedRef -- the reveal keeps its place, it just gets sharper data.
  useEffect(() => {
    let cancelled = false;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (cancelled) return;
      const canvas = canvasRef.current;
      const w = width ?? img.naturalWidth;
      const h = height ?? img.naturalHeight;
      const cols = Math.max(1, Math.round(w / cell));
      const rows = Math.max(1, Math.round(h / cell));
      samplesRef.current = sampleImageToCells(img, cols, rows);
      naturalSizeRef.current = { w, h };
      if (canvas) {
        canvas.width = w;
        canvas.height = h;
      }
    };
    img.src = src;
    return () => {
      cancelled = true;
    };
  }, [src, cell, width, height]);

  // Progress target tracking -- refs only, mirrored inside an effect (never
  // mutated during render).
  useEffect(() => {
    progressPropRef.current = progress;
    targetRef.current = progress ?? targetRef.current;
    if (progress !== undefined && progress < 1) settledRef.current = false;
  }, [progress]);

  // If a new non-terminal progress arrives while we'd already handed off to
  // the plain <img>, force back to canvas rendering this same render pass.
  // Derived purely from the `progress` prop and `settled` state -- no refs
  // touched here, so it's safe to compute during render.
  const forceUnsettled = progress !== undefined && progress < 1;
  const isSettled = settled && !forceUnsettled;

  // Main render loop: eases displayedRef toward targetRef, paints the canvas,
  // and (only once fully resolved and settled) swaps over to a plain <img>.
  useEffect(() => {
    let mounted = true;

    const paint = () => {
      const canvas = canvasRef.current;
      const samples = samplesRef.current;
      if (!canvas || !samples) return;
      // The canvas element can remount (e.g. coming back from the settled
      // <img> hand-off state) with the browser's 300x150 default backing
      // store. Re-apply the known natural size whenever it drifts.
      const natural = naturalSizeRef.current;
      if (natural && (canvas.width !== natural.w || canvas.height !== natural.h)) {
        canvas.width = natural.w;
        canvas.height = natural.h;
      }
      const { cols, rows, lum, r, g, b } = samples;
      const off = document.createElement("canvas");
      off.width = cols;
      off.height = rows;
      const offCtx = off.getContext("2d");
      if (!offCtx) return;
      const imageData = offCtx.createImageData(cols, rows);
      const data = imageData.data;
      const p = displayedRef.current;
      const [ir, ig, ib] = inkRgbRef.current;
      const [pr, pg, pb] = paperRgbRef.current;
      const shimmer = indeterminate ? shimmerPhaseRef.current : 0;

      for (let y = 0; y < rows; y++) {
        const by = BAYER4[y & 3];
        for (let x = 0; x < cols; x++) {
          const i = y * cols + x;
          const bayerVal = by[x & 3]; // 0..15
          const threshold = (bayerVal + 0.5) / 16;
          const o = i * 4;

          if (mode === "bayer") {
            const revealed = !indeterminate && threshold <= p;
            if (revealed) {
              data[o] = r[i];
              data[o + 1] = g[i];
              data[o + 2] = b[i];
            } else {
              // subtle shimmer: slowly walk the effective luminance so the
              // ink/paper split breathes instead of a static frozen still.
              const l = indeterminate ? (lum[i] + Math.sin(shimmer + i * 0.37) * 0.03) : lum[i];
              const isInk = l < threshold;
              data[o] = isInk ? ir : pr;
              data[o + 1] = isInk ? ig : pg;
              data[o + 2] = isInk ? ib : pb;
            }
          } else {
            // halftone: dot coverage sized by darkness, revealed cells show true color
            const revealed = !indeterminate && threshold <= p;
            if (revealed) {
              data[o] = r[i];
              data[o + 1] = g[i];
              data[o + 2] = b[i];
            } else {
              const l = indeterminate ? (lum[i] + Math.sin(shimmer + i * 0.37) * 0.03) : lum[i];
              const coverage = 1 - l; // darker => more ink coverage
              // Approximate a dot by blending ink/paper by coverage; the true
              // circular dot is drawn in the upscale pass below for crispness.
              data[o] = ir * coverage + pr * (1 - coverage);
              data[o + 1] = ig * coverage + pg * (1 - coverage);
              data[o + 2] = ib * coverage + pb * (1 - coverage);
            }
          }
          data[o + 3] = 255;
        }
      }
      offCtx.putImageData(imageData, 0, 0);

      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(off, 0, 0, canvas.width, canvas.height);

      if (mode === "halftone") {
        // Second pass: draw crisp circular dots for unrevealed cells over the
        // blended base so it reads as halftone rather than soft blur.
        const cw = canvas.width / cols;
        const ch = canvas.height / rows;
        ctx.fillStyle = `rgb(${ir}, ${ig}, ${ib})`;
        for (let y = 0; y < rows; y++) {
          const by = BAYER4[y & 3];
          for (let x = 0; x < cols; x++) {
            const i = y * cols + x;
            const bayerVal = by[x & 3];
            const threshold = (bayerVal + 0.5) / 16;
            if (!indeterminate && threshold <= p) continue;
            const l = indeterminate ? (lum[i] + Math.sin(shimmer + i * 0.37) * 0.03) : lum[i];
            const coverage = Math.max(0, Math.min(1, 1 - l));
            const radius = (Math.min(cw, ch) / 2) * Math.sqrt(coverage);
            if (radius < 0.35) continue;
            ctx.beginPath();
            ctx.arc(x * cw + cw / 2, y * ch + ch / 2, radius, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
    };

    const tick = (ts: number) => {
      if (!mounted) return;
      const last = lastTsRef.current ?? ts;
      const dt = Math.min(0.05, Math.max(0, (ts - last) / 1000));
      lastTsRef.current = ts;

      if (indeterminate) {
        shimmerPhaseRef.current += dt * (reducedMotion ? 0 : 1.4);
      }

      const target = indeterminate ? displayedRef.current : Math.max(0, Math.min(1, targetRef.current));
      if (reducedMotion) {
        displayedRef.current = target;
      } else {
        const damping = 1 - Math.exp(-6 * dt);
        displayedRef.current += (target - displayedRef.current) * damping;
        if (Math.abs(target - displayedRef.current) < 0.0015) displayedRef.current = target;
      }

      paint();

      // Read the live prop via a ref, not the closured `progress` -- this
      // effect only re-creates when mode/indeterminate/reducedMotion change,
      // so `progress` here would otherwise go stale across numeric updates
      // and freeze the loop's resolve/unresolve detection.
      const liveProgress = progressPropRef.current;
      const fullyResolved = !indeterminate && liveProgress !== undefined && liveProgress >= 1 && displayedRef.current >= 0.999;
      // Note: the loop deliberately keeps running (rAF is cheap when it's
      // just a comparison) so that a later prop change back to a
      // non-terminal progress can resume real painting without needing to
      // restart this effect. Stopping the loop here would strand a freshly
      // remounted canvas at its default 300x150 backing store forever.
      if (fullyResolved !== settledRef.current) {
        settledRef.current = fullyResolved;
        setSettled(fullyResolved);
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      mounted = false;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
    // Re-run when mode/indeterminate/reducedMotion changes; progress/src are
    // read live via refs so we don't restart the loop on every tick update.
  }, [mode, indeterminate, reducedMotion]);

  const aspect = useMemo(() => {
    if (width && height) return `${width} / ${height}`;
    return undefined;
  }, [width, height]);

  if (isSettled) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={alt}
        width={width}
        height={height}
        className={className}
        style={{ display: "block", width: "100%", height: "auto", ...style }}
      />
    );
  }

  return (
    <div
      ref={wrapRef}
      className={className}
      style={{ position: "relative", width: "100%", aspectRatio: aspect, overflow: "hidden", ...style }}
      aria-label={alt}
      role="img"
    >
      <canvas
        ref={canvasRef}
        style={{ display: "block", width: "100%", height: "100%" }}
      />
    </div>
  );
}

export default DitherReveal;
