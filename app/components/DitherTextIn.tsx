"use client";

/**
 * DitherTextIn
 * ------------
 * A line of text that materializes as a 1-bit ordered dither: tiny ink dots
 * appear cell-by-cell (4x4 Bayer threshold, ~1px cells) until the glyphs are
 * fully formed, then the canvas swaps for real selectable text. Companion to
 * DitherReveal (images) — same visual language at type scale.
 *
 * Transparent everywhere it isn't ink, so it sits on glass. Reduced motion
 * renders the plain text immediately.
 */

import { useEffect, useRef, useState } from "react";

const BAYER4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

export type DitherTextInProps = {
  text: string;
  /** Delay before the dither starts (ms) — lets rows stagger. */
  delay?: number;
  /** Reveal duration once started (ms). */
  duration?: number;
  /** Dither cell size in CSS px. */
  cell?: number;
  fontSize?: number;
  letterSpacing?: number;
  ink?: string;
  className?: string;
};

export function DitherTextIn({
  text,
  delay = 0,
  duration = 420,
  cell = 1,
  fontSize = 11,
  letterSpacing = 1.6,
  ink = "#000000",
  className,
}: DitherTextInProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [done, setDone] = useState(false);
  // Client-only component (mounts on menu open), so the media query is safe
  // to read in the initializer; guarded anyway for any future SSR path.
  const [reduced] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  useEffect(() => {
    if (done || reduced) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    let raf = 0;
    let timer = 0;
    let cancelled = false;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const font = `750 ${fontSize * dpr}px ${getComputedStyle(document.body).fontFamily}`;
    const cellPx = Math.max(1, Math.round(cell * dpr));
    // The canvas and the final <span> must occupy the exact same block box,
    // or the row jumps when the dither hands off to real text (the same
    // box-mismatch class of bug as the library placeholder panels).
    const boxH = Math.ceil(fontSize * 1.3);

    // Rasterize the line once at device resolution.
    const off = document.createElement("canvas");
    const octx = off.getContext("2d", { willReadFrequently: true });
    if (!octx) { raf = requestAnimationFrame(() => setDone(true)); return () => cancelAnimationFrame(raf); }
    octx.font = font;
    const spacing = letterSpacing * dpr;
    const width = Math.ceil(
      text.split("").reduce((w, ch) => w + octx.measureText(ch).width + spacing, 0),
    );
    off.width = Math.max(1, width);
    off.height = boxH * dpr;
    octx.font = font;
    octx.fillStyle = "#000";
    octx.textBaseline = "alphabetic";
    let x = 0;
    const baseline = Math.round(fontSize * dpr * 1.02);
    for (const ch of text) {
      octx.fillText(ch, x, baseline);
      x += octx.measureText(ch).width + spacing;
    }
    const src = octx.getImageData(0, 0, off.width, off.height).data;

    canvas.width = off.width;
    canvas.height = off.height;
    canvas.style.display = "block";
    canvas.style.width = `${off.width / dpr}px`;
    canvas.style.height = `${boxH}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) { raf = requestAnimationFrame(() => setDone(true)); return () => cancelAnimationFrame(raf); }
    ctx.fillStyle = ink;

    const cols = Math.ceil(off.width / cellPx);
    const rows = Math.ceil(off.height / cellPx);
    let start: number | null = null;

    // Deterministic per-cell/per-frame hash for the glitch artifacts.
    const hash = (cx: number, cy: number, seed: number) => {
      let h = (cx * 374761393 + cy * 668265263) ^ (seed * 69069 + 1);
      h = (h ^ (h >>> 13)) * 1274126177;
      return (h ^ (h >>> 16)) >>> 0;
    };

    const paint = (ts: number) => {
      if (cancelled) return;
      if (start === null) start = ts;
      const t = Math.min(1, (ts - start) / duration);
      const frameSeed = Math.floor(ts / 48); // artifact set mutates ~20x/sec
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (let cy = 0; cy < rows; cy += 1) {
        const brow = BAYER4[cy & 3];
        for (let cx = 0; cx < cols; cx += 1) {
          const threshold = (brow[cx & 3] + 0.5) / 16;
          if (threshold > t) continue;
          // Cell is "ink" when the rasterized glyph covers its center — so
          // every artifact stays inside the letterform's own footprint.
          const px = Math.min(off.width - 1, cx * cellPx + (cellPx >> 1));
          const py = Math.min(off.height - 1, cy * cellPx + (cellPx >> 1));
          if (src[(py * off.width + px) * 4 + 3] <= 96) continue;
          const x0 = cx * cellPx;
          const y0 = cy * cellPx;
          // Frontier cells (recently crossed the threshold) glitch: they
          // flicker and materialize as smaller mixed artifacts — dashes,
          // ticks, dots — before settling into the solid cell.
          if (t < 1 && t - threshold < 0.24) {
            const h = hash(cx, cy, frameSeed);
            if ((h & 3) === 0) continue; // flicker off this frame
            switch ((h >> 2) & 3) {
              case 0: // horizontal dash
                ctx.fillRect(x0, y0 + (cellPx >> 1), cellPx, Math.max(1, cellPx >> 1));
                break;
              case 1: // vertical tick
                ctx.fillRect(x0 + ((h >> 4) & 1 ? cellPx >> 1 : 0), y0, Math.max(1, cellPx >> 1), cellPx);
                break;
              case 2: // corner dot
                ctx.fillRect(
                  x0 + ((h >> 4) & 1 ? cellPx >> 1 : 0),
                  y0 + ((h >> 5) & 1 ? cellPx >> 1 : 0),
                  Math.max(1, cellPx >> 1),
                  Math.max(1, cellPx >> 1),
                );
                break;
              default: // full cell, early
                ctx.fillRect(x0, y0, cellPx, cellPx);
            }
          } else {
            ctx.fillRect(x0, y0, cellPx, cellPx);
          }
        }
      }
      if (t >= 1) { setDone(true); return; }
      raf = requestAnimationFrame(paint);
    };

    timer = window.setTimeout(() => { raf = requestAnimationFrame(paint); }, delay);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      cancelAnimationFrame(raf);
    };
  }, [text, delay, duration, cell, fontSize, letterSpacing, ink, done, reduced]);

  const boxH = Math.ceil(fontSize * 1.3);
  if (done || reduced) {
    return (
      <span
        className={className}
        style={{
          display: "block",
          height: boxH,
          fontSize,
          fontWeight: 750,
          letterSpacing,
          color: ink,
          lineHeight: `${boxH}px`,
        }}
      >
        {text}
      </span>
    );
  }
  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ display: "block", height: boxH }}
      aria-label={text}
      role="img"
    />
  );
}

export default DitherTextIn;
