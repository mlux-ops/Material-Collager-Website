"use client";

import { useEffect, useRef, type RefObject } from "react";
import { MathUtils } from "three";

export function useNativeScrollProgress(trackRef: RefObject<HTMLElement | null>) {
  const target = useRef(0);

  useEffect(() => {
    let frame = 0;

    const update = () => {
      frame = 0;
      const track = trackRef.current;
      if (!track) return;
      const start = window.scrollY + track.getBoundingClientRect().top;
      const distance = Math.max(1, track.offsetHeight - window.innerHeight);
      target.current = MathUtils.clamp((window.scrollY - start) / distance, 0, 1);
      track.style.setProperty("--scene-wheel-progress", target.current.toFixed(5));
    };

    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(update);
    };

    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    const observer = new ResizeObserver(schedule);
    if (trackRef.current) observer.observe(trackRef.current);

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [trackRef]);

  return target;
}
