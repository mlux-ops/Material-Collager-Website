"use client";

/**
 * CountUp
 * -------
 * Tweens an integer from 0 (or `from`) to `value` once the element enters
 * the viewport. Built for small "2 / 16" style counters, not big dashboard
 * numbers -- no easing library, just a token-driven ease on a rAF loop.
 *
 * Respects prefers-reduced-motion: renders the final number immediately.
 */

import { useEffect, useRef, useState } from "react";

export type CountUpProps = {
  value: number;
  from?: number;
  className?: string;
  /** Formats the integer for display, e.g. (n) => `${n}` or padding. */
  format?: (n: number) => string;
  /** Root margin for the IntersectionObserver trigger. */
  rootMargin?: string;
};

export function CountUp({ value, from = 0, className, format, rootMargin = "0px" }: CountUpProps) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [display, setDisplay] = useState(from);
  const hasRun = useRef(false);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const run = () => {
      if (hasRun.current) return;
      hasRun.current = true;

      if (reducedMotion) {
        setDisplay(value);
        return;
      }

      const durationMs = 400; // --duration-slow
      const start = performance.now();
      const startValue = from;
      const delta = value - from;

      const tick = (ts: number) => {
        const t = Math.min(1, (ts - start) / durationMs);
        // ease-smooth-out equivalent (cubic-bezier(0.22,1,0.36,1)) approximated
        // with a standard easeOutCubic so no CSS is needed to read it back.
        const eased = 1 - Math.pow(1 - t, 3);
        setDisplay(Math.round(startValue + delta * eased));
        if (t < 1) {
          rafRef.current = requestAnimationFrame(tick);
        } else {
          setDisplay(value);
        }
      };
      rafRef.current = requestAnimationFrame(tick);
    };

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) run();
        }
      },
      { rootMargin, threshold: 0.2 },
    );
    observer.observe(el);

    return () => {
      observer.disconnect();
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [value, from, rootMargin]);

  return (
    <span ref={ref} className={className}>
      {format ? format(display) : display}
    </span>
  );
}

export default CountUp;
