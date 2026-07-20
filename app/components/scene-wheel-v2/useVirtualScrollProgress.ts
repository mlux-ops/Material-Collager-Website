"use client";

import { useEffect, useRef, type RefObject } from "react";

const CARDS_PER_VIEWPORT = 1.58;
const TOUCH_CARDS_PER_VIEWPORT = 1.32;
const MAX_TOUCH_VELOCITY = 0.075;
const TOUCH_FRICTION = 0.91;

export function normalizeSceneWheelDelta(
  delta: number,
  deltaMode: number,
  viewportHeight: number,
) {
  const pixels = deltaMode === 1
    ? delta * 16
    : deltaMode === 2
      ? delta * viewportHeight
      : delta;

  return (pixels / Math.max(1, viewportHeight)) * CARDS_PER_VIEWPORT;
}

export function useVirtualScrollProgress(
  surfaceRef: RefObject<HTMLElement | null>,
) {
  const target = useRef(0);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;

    const query = new URLSearchParams(window.location.search);
    const requestedProgress = Number(query.get("progress"));
    const qaFrozen = query.get("qa") === "1"
      && query.has("progress")
      && Number.isFinite(requestedProgress);

    const writeProgress = () => {
      const displayProgress = ((target.current % 1) + 1) % 1;
      surface.style.setProperty("--scene-wheel-progress", displayProgress.toFixed(5));
      surface.dataset.sceneProgress = target.current.toFixed(5);
    };

    if (qaFrozen) {
      target.current = Math.min(1, Math.max(0, requestedProgress));
      writeProgress();
      return;
    }

    const root = document.documentElement;
    const body = document.body;
    const previousRootOverflow = root.style.overflow;
    const previousBodyOverflow = body.style.overflow;
    const previousOverscroll = root.style.overscrollBehavior;
    const previousScrollRestoration = window.history.scrollRestoration;

    root.style.overflow = "hidden";
    root.style.overscrollBehavior = "none";
    body.style.overflow = "hidden";
    window.history.scrollRestoration = "manual";
    if (window.scrollY !== 0) window.scrollTo({ left: 0, top: 0, behavior: "auto" });

    let activePointer = -1;
    let lastPointerY = 0;
    let lastPointerTime = 0;
    let touchVelocity = 0;
    let inertiaFrame = 0;

    const cancelInertia = () => {
      if (inertiaFrame) window.cancelAnimationFrame(inertiaFrame);
      inertiaFrame = 0;
    };

    const runInertia = () => {
      target.current += touchVelocity;
      touchVelocity *= TOUCH_FRICTION;
      writeProgress();
      if (Math.abs(touchVelocity) > 0.0008) {
        inertiaFrame = window.requestAnimationFrame(runInertia);
      } else {
        inertiaFrame = 0;
      }
    };

    const handleWheel = (event: WheelEvent) => {
      if (event.ctrlKey) return;
      event.preventDefault();
      cancelInertia();
      target.current += normalizeSceneWheelDelta(
        event.deltaY,
        event.deltaMode,
        window.innerHeight,
      );
      writeProgress();
    };

    const handlePointerDown = (event: PointerEvent) => {
      if (event.pointerType === "mouse" || activePointer !== -1) return;
      cancelInertia();
      activePointer = event.pointerId;
      lastPointerY = event.clientY;
      lastPointerTime = event.timeStamp;
      touchVelocity = 0;
      surface.setPointerCapture?.(event.pointerId);
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (event.pointerId !== activePointer) return;
      event.preventDefault();
      const elapsed = Math.max(8, event.timeStamp - lastPointerTime);
      const delta = ((lastPointerY - event.clientY) / Math.max(1, window.innerHeight))
        * TOUCH_CARDS_PER_VIEWPORT;
      target.current += delta;
      touchVelocity = Math.max(
        -MAX_TOUCH_VELOCITY,
        Math.min(MAX_TOUCH_VELOCITY, delta * (16 / elapsed)),
      );
      lastPointerY = event.clientY;
      lastPointerTime = event.timeStamp;
      writeProgress();
    };

    const finishPointer = (event: PointerEvent) => {
      if (event.pointerId !== activePointer) return;
      activePointer = -1;
      surface.releasePointerCapture?.(event.pointerId);
      if (Math.abs(touchVelocity) > 0.001) {
        inertiaFrame = window.requestAnimationFrame(runInertia);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      const targetElement = event.target;
      if (targetElement instanceof HTMLInputElement
        || targetElement instanceof HTMLTextAreaElement
        || targetElement instanceof HTMLSelectElement
        || (targetElement instanceof HTMLElement && targetElement.isContentEditable)) return;

      const amount = event.key === "PageDown" || event.key === "PageUp" ? 0.88 : 0.3;
      const direction = event.key === "ArrowDown" || event.key === "PageDown"
        ? 1
        : event.key === "ArrowUp" || event.key === "PageUp"
          ? -1
          : 0;
      if (!direction) return;
      event.preventDefault();
      cancelInertia();
      target.current += amount * direction;
      writeProgress();
    };

    writeProgress();
    window.addEventListener("wheel", handleWheel, { passive: false });
    window.addEventListener("keydown", handleKeyDown);
    surface.addEventListener("pointerdown", handlePointerDown);
    surface.addEventListener("pointermove", handlePointerMove, { passive: false });
    surface.addEventListener("pointerup", finishPointer);
    surface.addEventListener("pointercancel", finishPointer);
    surface.addEventListener("lostpointercapture", finishPointer);

    return () => {
      cancelInertia();
      root.style.overflow = previousRootOverflow;
      root.style.overscrollBehavior = previousOverscroll;
      body.style.overflow = previousBodyOverflow;
      window.history.scrollRestoration = previousScrollRestoration;
      window.removeEventListener("wheel", handleWheel);
      window.removeEventListener("keydown", handleKeyDown);
      surface.removeEventListener("pointerdown", handlePointerDown);
      surface.removeEventListener("pointermove", handlePointerMove);
      surface.removeEventListener("pointerup", finishPointer);
      surface.removeEventListener("pointercancel", finishPointer);
      surface.removeEventListener("lostpointercapture", finishPointer);
    };
  }, [surfaceRef]);

  return target;
}
