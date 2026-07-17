"use client";

import { useEffect, useRef, type RefObject } from "react";

const CENTER_FRACTION = 0.5;
const EDGE_FRACTION = 0.12;
const CARDS_PER_VIEWPORT = 1.18;

export function useNativeScrollProgress(trackRef: RefObject<HTMLElement | null>) {
  const target = useRef(0);

  useEffect(() => {
    let frame = 0;
    let lastScrollY = window.scrollY;
    let recentering = false;

    const metrics = () => {
      const track = trackRef.current;
      if (!track) return null;
      const start = window.scrollY + track.getBoundingClientRect().top;
      const distance = Math.max(1, track.offsetHeight - window.innerHeight);
      return { distance, start };
    };

    const centerScroll = () => {
      const current = metrics();
      if (!current) return;
      const nextY = current.start + current.distance * CENTER_FRACTION;
      recentering = true;
      window.scrollTo({ left: 0, top: nextY, behavior: "auto" });
      lastScrollY = nextY;
      window.requestAnimationFrame(() => {
        recentering = false;
      });
    };

    const update = () => {
      frame = 0;
      const current = metrics();
      if (!current || recentering) return;

      const nextScrollY = window.scrollY;
      const deltaPixels = nextScrollY - lastScrollY;
      lastScrollY = nextScrollY;
      target.current += (deltaPixels / Math.max(1, window.innerHeight)) * CARDS_PER_VIEWPORT;

      const localFraction = (nextScrollY - current.start) / current.distance;
      const displayProgress = ((target.current % 1) + 1) % 1;
      trackRef.current?.style.setProperty("--scene-wheel-progress", displayProgress.toFixed(5));

      if (localFraction < EDGE_FRACTION || localFraction > 1 - EDGE_FRACTION) centerScroll();
    };

    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(update);
    };

    const initialize = () => {
      const current = metrics();
      if (!current) return;
      const centerY = current.start + current.distance * CENTER_FRACTION;
      window.scrollTo({ left: 0, top: centerY, behavior: "auto" });
      lastScrollY = centerY;
      trackRef.current?.style.setProperty("--scene-wheel-progress", "0");
    };

    const initializeFrame = window.requestAnimationFrame(initialize);
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    const observer = new ResizeObserver(schedule);
    if (trackRef.current) observer.observe(trackRef.current);

    return () => {
      window.cancelAnimationFrame(initializeFrame);
      if (frame) window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [trackRef]);

  return target;
}
