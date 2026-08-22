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

    // Rasterize the line once at device resolution.
    const off = document.createElement("canvas");
    const octx = off.getContext("2d", { willReadFrequently: true });
    if (!octx) { raf = requestAnimationFrame(() => setDone(true)); return () => cancelAnimationFrame(raf); }
    octx.font = font;
    const spacing = letterSpacing * dpr;
    const width = Math.ceil(
      text.split("").reduce((w, ch) => w + octx.measureText(ch).width + spacing, 0),
    );
    const height = Math.ceil(fontSize * dpr * 1.3);
    off.width = Math.max(1, width);
    off.height = height;
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
    canvas.style.width = `${off.width / dpr}px`;
    canvas.style.height = `${off.height / dpr}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) { raf = requestAnimationFrame(() => setDone(true)); return () => cancelAnimationFrame(raf); }
    ctx.fillStyle = ink;

    const cols = Math.ceil(off.width / cellPx);
    const rows = Math.ceil(off.height / cellPx);
    let start: number | null = null;

    const paint = (ts: number) => {
      if (cancelled) return;
      if (start === null) start = ts;
      const t = Math.min(1, (ts - start) / duration);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (let cy = 0; cy < rows; cy += 1) {
        const brow = BAYER4[cy & 3];
        for (let cx = 0; cx < cols; cx += 1) {
          if ((brow[cx & 3] + 0.5) / 16 > t) continue;
          // Cell is "ink" when the rasterized glyph covers its center.
          const px = Math.min(off.width - 1, cx * cellPx + (cellPx >> 1));
          const py = Math.min(off.height - 1, cy * cellPx + (cellPx >> 1));
          if (src[(py * off.width + px) * 4 + 3] > 96) {
            ctx.fillRect(cx * cellPx, cy * cellPx, cellPx, cellPx);
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

  if (done || reduced) {
    return (
      <span
        className={className}
        style={{ fontSize, fontWeight: 750, letterSpacing, color: ink, lineHeight: 1.3 }}
      >
        {text}
      </span>
    );
  }
  return <canvas ref={canvasRef} className={className} aria-label={text} role="img" />;
}

export default DitherTextIn;
