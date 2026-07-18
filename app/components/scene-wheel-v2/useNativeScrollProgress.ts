"use client";

import { useEffect, useRef, type RefObject } from "react";

const CENTER_FRACTION = 0.5;
const EDGE_FRACTION = 0.12;
const CARDS_PER_VIEWPORT = 1.72;
const RESTORE_DELAY_MS = 140;

export function useNativeScrollProgress(
  trackRef: RefObject<HTMLElement | null>,
) {
  const target = useRef(0);

  useEffect(() => {
    let scrollFrame = 0;
    let resizeFrame = 0;
    let releaseFrame = 0;
    let releaseFrameTwo = 0;
    let restoreTimer = 0;
    let lastScrollY = window.scrollY;
    let suppressScroll = false;

    const previousScrollRestoration = window.history.scrollRestoration;
    window.history.scrollRestoration = "manual";

    const metrics = () => {
      const track = trackRef.current;
      if (!track) return null;

      const start = window.scrollY + track.getBoundingClientRect().top;
      const distance = Math.max(1, track.offsetHeight - window.innerHeight);

      return {
        centerY: start + distance * CENTER_FRACTION,
        distance,
        start,
      };
    };

    const writeProgress = () => {
      const displayProgress = ((target.current % 1) + 1) % 1;
      trackRef.current?.style.setProperty(
        "--scene-wheel-progress",
        displayProgress.toFixed(5),
      );
    };

    const releaseScrollSuppression = () => {
      if (releaseFrame) window.cancelAnimationFrame(releaseFrame);
      if (releaseFrameTwo) window.cancelAnimationFrame(releaseFrameTwo);

      releaseFrame = window.requestAnimationFrame(() => {
        releaseFrameTwo = window.requestAnimationFrame(() => {
          lastScrollY = window.scrollY;
          suppressScroll = false;
          releaseFrame = 0;
          releaseFrameTwo = 0;
        });
      });
    };

    const recenter = () => {
      const current = metrics();
      if (!current) return;

      suppressScroll = true;
      window.scrollTo({ left: 0, top: current.centerY, behavior: "auto" });
      lastScrollY = current.centerY;
      writeProgress();
      releaseScrollSuppression();
    };

    const updateFromScroll = () => {
      scrollFrame = 0;
      const current = metrics();
      if (!current) return;

      const nextScrollY = window.scrollY;

      if (suppressScroll) {
        lastScrollY = nextScrollY;
        return;
      }

      const deltaPixels = nextScrollY - lastScrollY;
      lastScrollY = nextScrollY;

      if (deltaPixels !== 0) {
        target.current +=
          (deltaPixels / Math.max(1, window.innerHeight)) *
          CARDS_PER_VIEWPORT;
        writeProgress();
      }

      const localFraction =
        (nextScrollY - current.start) / current.distance;

      if (
        localFraction < EDGE_FRACTION ||
        localFraction > 1 - EDGE_FRACTION
      ) {
        recenter();
      }
    };

    const scheduleScrollUpdate = () => {
      if (scrollFrame) return;
      scrollFrame = window.requestAnimationFrame(updateFromScroll);
    };

    const scheduleRecenter = () => {
      if (resizeFrame) window.cancelAnimationFrame(resizeFrame);
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = 0;
        recenter();
      });
    };

    const handleWheel = (event: WheelEvent) => {
      if (event.ctrlKey) return;

      const current = metrics();
      if (!current) return;

      event.preventDefault();

      const deltaPixels = event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? event.deltaY * 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? event.deltaY * window.innerHeight
          : event.deltaY;

      target.current +=
        (deltaPixels / Math.max(1, window.innerHeight)) *
        CARDS_PER_VIEWPORT;
      writeProgress();

      if (Math.abs(window.scrollY - current.centerY) > 2) {
        recenter();
      } else {
        lastScrollY = window.scrollY;
      }
    };

    const handlePageShow = () => {
      scheduleRecenter();
      window.clearTimeout(restoreTimer);
      restoreTimer = window.setTimeout(recenter, RESTORE_DELAY_MS);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") scheduleRecenter();
    };

    const initializeFrame = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(recenter);
    });
    restoreTimer = window.setTimeout(recenter, RESTORE_DELAY_MS);

    window.addEventListener("scroll", scheduleScrollUpdate, { passive: true });
    window.addEventListener("resize", scheduleRecenter, { passive: true });
    window.addEventListener("pageshow", handlePageShow);
    window.addEventListener("wheel", handleWheel, { passive: false });
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.visualViewport?.addEventListener("resize", scheduleRecenter, {
      passive: true,
    });

    return () => {
      window.history.scrollRestoration = previousScrollRestoration;
      window.clearTimeout(restoreTimer);
      window.cancelAnimationFrame(initializeFrame);
      if (scrollFrame) window.cancelAnimationFrame(scrollFrame);
      if (resizeFrame) window.cancelAnimationFrame(resizeFrame);
      if (releaseFrame) window.cancelAnimationFrame(releaseFrame);
      if (releaseFrameTwo) window.cancelAnimationFrame(releaseFrameTwo);

      window.removeEventListener("scroll", scheduleScrollUpdate);
      window.removeEventListener("resize", scheduleRecenter);
      window.removeEventListener("pageshow", handlePageShow);
      window.removeEventListener("wheel", handleWheel);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.visualViewport?.removeEventListener("resize", scheduleRecenter);
    };
  }, [trackRef]);

  return target;
}
