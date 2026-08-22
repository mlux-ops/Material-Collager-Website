"use client";

/**
 * /dither-lab — isolated verification harness for DitherReveal, CountUp,
 * the grain overlay, and the hover-focus card grid. Not linked from any
 * nav; visited directly for screenshotting.
 */

import { useEffect, useRef, useState } from "react";
import DitherReveal from "../components/DitherReveal";
import CountUp from "../components/CountUp";

const IMG = "/sample-collage.png";

function FpsMeter({ running }: { running: boolean }) {
  const [fps, setFps] = useState<number | null>(null);
  const frames = useRef(0);
  const start = useRef(0);
  const raf = useRef<number | null>(null);

  useEffect(() => {
    if (!running) return;
    frames.current = 0;
    start.current = performance.now();
    const loop = () => {
      frames.current += 1;
      const elapsed = performance.now() - start.current;
      if (elapsed >= 1000) {
        setFps(Math.round((frames.current * 1000) / elapsed));
        frames.current = 0;
        start.current = performance.now();
      }
      raf.current = requestAnimationFrame(loop);
    };
    raf.current = requestAnimationFrame(loop);
    return () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current);
    };
  }, [running]);

  return <span data-testid="fps-readout">{fps === null ? "measuring…" : `${fps} fps`}</span>;
}

export default function DitherLabPage() {
  const [progress, setProgress] = useState<number | undefined>(0);
  const [cell, setCell] = useState(4);
  const [mode, setMode] = useState<"bayer" | "halftone">("bayer");
  const [autoPlay, setAutoPlay] = useState(false);

  useEffect(() => {
    if (!autoPlay) return;
    const stages = [0, 0.35, 0.7, 1];
    let i = 0;
    // Deferred so the first stage-set happens in a task, not synchronously
    // inside the effect body (demo-harness only; avoids a cascading render).
    const kickoff = setTimeout(() => setProgress(stages[0]), 0);
    const id = setInterval(() => {
      i += 1;
      if (i >= stages.length) {
        clearInterval(id);
        return;
      }
      setProgress(stages[i]);
    }, 1400);
    return () => {
      clearTimeout(kickoff);
      clearInterval(id);
    };
  }, [autoPlay]);

  return (
    <main
      style={{
        minHeight: "100dvh",
        background: "var(--background, #eceeea)",
        color: "var(--ink, #000000)",
        fontFamily: "var(--font-inter), Arial, sans-serif",
        padding: "40px",
      }}
    >
      <div className="grain-overlay" aria-hidden />

      <h1
        style={{
          fontSize: "14px",
          fontWeight: 500,
          marginBottom: "24px",
          textTransform: "uppercase",
          letterSpacing: "0.1575px",
        }}
      >
        Dither Lab — verification harness
      </h1>

      {/* Controls */}
      <section
        style={{
          display: "flex",
          gap: "10px",
          flexWrap: "wrap",
          marginBottom: "32px",
          alignItems: "center",
          fontSize: "10.5px",
          fontWeight: 500,
          letterSpacing: "0.1575px",
          textTransform: "uppercase",
        }}
      >
        {[0, 0.15, 0.35, 0.55, 0.75, 1].map((p) => (
          <button
            key={p}
            data-testid={`progress-${p}`}
            onClick={() => {
              setAutoPlay(false);
              setProgress(p);
            }}
            style={{
              background: progress === p ? "var(--ink, #000000)" : "var(--background, #eceeea)",
              color: progress === p ? "var(--background, #eceeea)" : "var(--ink, #000000)",
              border: "1px solid var(--ink, #000000)",
              borderRadius: 0,
              padding: "8px 12px",
              cursor: "pointer",
            }}
          >
            {p}
          </button>
        ))}
        <button
          data-testid="progress-indeterminate"
          onClick={() => {
            setAutoPlay(false);
            setProgress(undefined);
          }}
          style={{
            background: progress === undefined ? "var(--ink, #000000)" : "var(--background, #eceeea)",
            color: progress === undefined ? "var(--background, #eceeea)" : "var(--ink, #000000)",
            border: "1px solid var(--ink, #000000)",
            borderRadius: 0,
            padding: "8px 12px",
            cursor: "pointer",
          }}
        >
          hold
        </button>
        <button
          data-testid="progress-autoplay"
          onClick={() => setAutoPlay(true)}
          style={{
            background: "var(--background, #eceeea)",
            color: "var(--ink, #000000)",
            border: "1px solid var(--ink, #000000)",
            borderRadius: 0,
            padding: "8px 12px",
            cursor: "pointer",
          }}
        >
          autoplay discrete jumps
        </button>

        <span style={{ marginLeft: "20px" }}>cell</span>
        {[2, 3, 4, 6].map((c) => (
          <button
            key={c}
            data-testid={`cell-${c}`}
            onClick={() => setCell(c)}
            style={{
              background: cell === c ? "var(--ink, #000000)" : "var(--background, #eceeea)",
              color: cell === c ? "var(--background, #eceeea)" : "var(--ink, #000000)",
              border: "1px solid var(--ink, #000000)",
              borderRadius: 0,
              padding: "8px 12px",
              cursor: "pointer",
            }}
          >
            {c}px
          </button>
        ))}

        <span style={{ marginLeft: "20px" }}>mode</span>
        {(["bayer", "halftone"] as const).map((m) => (
          <button
            key={m}
            data-testid={`mode-${m}`}
            onClick={() => setMode(m)}
            style={{
              background: mode === m ? "var(--ink, #000000)" : "var(--background, #eceeea)",
              color: mode === m ? "var(--background, #eceeea)" : "var(--ink, #000000)",
              border: "1px solid var(--ink, #000000)",
              borderRadius: 0,
              padding: "8px 12px",
              cursor: "pointer",
            }}
          >
            {m}
          </button>
        ))}

        <span style={{ marginLeft: "20px", fontVariantNumeric: "tabular-nums" }}>
          <FpsMeter running={progress !== undefined && progress < 1} />
        </span>
      </section>

      {/* Primary DitherReveal demo */}
      <section style={{ maxWidth: "640px", marginBottom: "48px" }}>
        <div style={{ border: "1px solid var(--line, #d6dbd5)" }} data-testid="dither-reveal-wrap">
          <DitherReveal
            key="single-demo"
            src={IMG}
            alt="Sample material collage"
            progress={progress}
            mode={mode}
            cell={cell}
            width={1536}
            height={1024}
          />
        </div>
      </section>

      {/* Count-up demo */}
      <section style={{ marginBottom: "48px" }}>
        <p style={{ fontSize: "8.4px", color: "var(--muted, #68706b)", marginBottom: "8px" }}>
          scroll-triggered counter (re-mount to re-trigger)
        </p>
        <div
          style={{
            fontSize: "48px",
            fontWeight: 500,
            fontVariantNumeric: "tabular-nums",
          }}
          data-testid="count-up"
        >
          <CountUp value={16} format={(n) => `${n} / 16`} />
        </div>
      </section>

      {/* Hover-focus grid demo */}
      <section style={{ marginBottom: "48px" }}>
        <p style={{ fontSize: "8.4px", color: "var(--muted, #68706b)", marginBottom: "8px" }}>
          hover-focus card grid — hover one, siblings drop to ~60%
        </p>
        <div
          className="focus-grid-block"
          data-testid="focus-grid"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: "1px",
            background: "var(--line, #d6dbd5)",
            border: "1px solid var(--line, #d6dbd5)",
          }}
        >
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className="focus-grid-item"
              tabIndex={0}
              style={{
                background: "var(--background, #eceeea)",
                padding: "20px",
                fontSize: "10.5px",
                fontWeight: 500,
                letterSpacing: "0.1575px",
                textTransform: "uppercase",
              }}
            >
              item {i + 1}
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
