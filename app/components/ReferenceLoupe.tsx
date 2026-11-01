"use client";

/**
 * ReferenceLoupe — a magnifier that follows the mouse over the generator's
 * reference-tray thumbnails, so a designer can read grain and veining
 * without opening the file. One instance serves the whole tray: listeners
 * are delegated from `scopeRef` (the `.items-list`), and every
 * `.reference-image-wrap img` under it is a target.
 *
 * Rules (pure decisions in app/lib/loupe.ts):
 *  - no React render per move: pointer events only store the latest
 *    position, and one requestAnimationFrame writes transform + background
 *    straight onto the box's style;
 *  - the box is `position: fixed` and moved by translate3d, so following
 *    the pointer never triggers layout, and `pointer-events: none` so it
 *    never steals the thumbnail's hover;
 *  - the background is the thumbnail's own loaded URL (an object/data URL),
 *    so magnifying costs no fetch;
 *  - mouse only: touch and pen events are ignored, and a coarse primary
 *    pointer or potato mode renders nothing at all;
 *  - reduced motion shows and hides instantly; otherwise it fades on the
 *    motion tokens (effects.css, `.reference-loupe`);
 *  - hidden over letterbox padding, on press, on scroll and on resize, so it
 *    is never left floating over something it no longer describes.
 *
 * The box is portalled to <body>: any transform, filter or backdrop-filter
 * on a tray ancestor would otherwise become the containing block for
 * `position: fixed` and offset the loupe from the pointer.
 */

import { useEffect, useRef, useSyncExternalStore, type RefObject } from "react";
import { createPortal } from "react-dom";
import { motionReduced, potatoMode, subscribeSettings } from "@/app/lib/site-settings";
import { containedImageRect, loupeMode, placeLoupe, sampleLoupe, type LoupeMode } from "@/app/lib/loupe";

const THUMBNAIL_SELECTOR = ".reference-image-wrap img";
const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";
const COARSE_QUERY = "(pointer: coarse)";

function subscribeMode(onChange: () => void): () => void {
  const unsubscribe = subscribeSettings(onChange);
  const reduced = window.matchMedia(REDUCED_QUERY);
  const coarse = window.matchMedia(COARSE_QUERY);
  reduced.addEventListener("change", onChange);
  coarse.addEventListener("change", onChange);
  return () => {
    unsubscribe();
    reduced.removeEventListener("change", onChange);
    coarse.removeEventListener("change", onChange);
  };
}

function readMode(): LoupeMode {
  return loupeMode({
    potato: potatoMode(),
    reduced: motionReduced(),
    coarsePointer: window.matchMedia(COARSE_QUERY).matches,
  });
}

// Server render (and hydration) never has the settings: start off, then the
// client snapshot takes over.
function readServerMode(): LoupeMode {
  return "off";
}

function thumbnailFor(target: EventTarget | null): HTMLImageElement | null {
  if (!(target instanceof Element)) return null;
  const img = target.closest(THUMBNAIL_SELECTOR);
  if (!(img instanceof HTMLImageElement) || !img.complete || img.naturalWidth <= 0) return null;
  return img;
}

function cssUrl(src: string): string {
  return `url("${src.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}")`;
}

export interface ReferenceLoupeProps {
  /** The element holding every tray thumbnail (the generator's `.items-list`). */
  scopeRef: RefObject<HTMLElement | null>;
}

export function ReferenceLoupe({ scopeRef }: ReferenceLoupeProps) {
  const mode = useSyncExternalStore(subscribeMode, readMode, readServerMode);
  const boxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (mode === "off") return;
    const scope = scopeRef.current;
    const box = boxRef.current;
    if (!scope || !box) return;

    let target: HTMLImageElement | null = null;
    let imageUrl = "";
    let pointer = { clientX: 0, clientY: 0 };
    let frame = 0;

    const hide = () => {
      target = null;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      box.removeAttribute("data-visible");
    };

    const paint = () => {
      frame = 0;
      if (!target || !target.isConnected) {
        hide();
        return;
      }
      const imageRect = containedImageRect(target.getBoundingClientRect(), target);
      const sample = sampleLoupe(pointer, imageRect);
      if (!sample.inside) {
        box.removeAttribute("data-visible");
        return;
      }
      const src = target.currentSrc || target.src;
      if (src !== imageUrl) {
        imageUrl = src;
        box.style.backgroundImage = cssUrl(src);
      }
      const at = placeLoupe(pointer, { width: window.innerWidth, height: window.innerHeight });
      box.style.transform = `translate3d(${at.x}px, ${at.y}px, 0)`;
      box.style.backgroundSize = sample.backgroundSize;
      box.style.backgroundPosition = sample.backgroundPosition;
      box.setAttribute("data-visible", "1");
    };

    const schedule = (event: PointerEvent) => {
      pointer = { clientX: event.clientX, clientY: event.clientY };
      if (!frame) frame = requestAnimationFrame(paint);
    };

    const onOver = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      const img = thumbnailFor(event.target);
      if (!img) return;
      target = img;
      schedule(event);
    };

    // A hide (press, scroll, resize) or a still-decoding preview leaves the
    // pointer on a thumbnail with no target and no new pointerover to come;
    // the next button-free move over a ready thumbnail re-arms it.
    const onMove = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      if (!target) {
        if (event.buttons !== 0) return;
        target = thumbnailFor(event.target);
        if (!target) return;
      }
      schedule(event);
    };

    const onOut = (event: PointerEvent) => {
      if (event.pointerType !== "mouse" || !target) return;
      if (event.target === target && event.relatedTarget !== target) hide();
    };

    scope.addEventListener("pointerover", onOver);
    scope.addEventListener("pointermove", onMove);
    scope.addEventListener("pointerout", onOut);
    scope.addEventListener("pointerdown", hide);
    scope.addEventListener("pointercancel", hide);
    window.addEventListener("scroll", hide, { capture: true, passive: true });
    window.addEventListener("resize", hide);
    return () => {
      scope.removeEventListener("pointerover", onOver);
      scope.removeEventListener("pointermove", onMove);
      scope.removeEventListener("pointerout", onOut);
      scope.removeEventListener("pointerdown", hide);
      scope.removeEventListener("pointercancel", hide);
      window.removeEventListener("scroll", hide, { capture: true });
      window.removeEventListener("resize", hide);
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      box.removeAttribute("data-visible");
    };
  }, [mode, scopeRef]);

  if (mode === "off") return null;
  return createPortal(
    <div className="reference-loupe" data-mode={mode} aria-hidden="true" ref={boxRef} />,
    document.body,
  );
}

export default ReferenceLoupe;
