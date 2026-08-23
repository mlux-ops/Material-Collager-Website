"use client";

/**
 * useNavPillSlide
 * ----------------
 * NOT WIRED IN. Companion hook for the `.nav-pill` snippet in
 * app/effects.css. The nav markup itself is being rewritten by another
 * agent right now, so this ships as a ready-to-drop-in primitive rather
 * than being connected to app/globals.css's `.site-navigation`.
 *
 * Usage once the markup lands:
 *
 *   const trackRef = useRef<HTMLElement>(null);
 *   const pillRef = useRef<HTMLSpanElement>(null);
 *   useNavPillSlide(trackRef, pillRef, activeKey);
 *
 *   <nav ref={trackRef} className="nav-pill-track">
 *     <span ref={pillRef} className="nav-pill" aria-hidden />
 *     {items.map((item) => (
 *       <a
 *         key={item.key}
 *         data-nav-key={item.key}
 *         data-active={item.key === activeKey}
 *         className="nav-pill-link"
 *       >
 *         {item.label}
 *       </a>
 *     ))}
 *   </nav>
 *
 * The hook measures the active link's offsetLeft/offsetWidth and writes them
 * onto the pill as a single transform (translateX + scaleX against the fixed
 * 100px base width in effects.css), letting the CSS transition
 * (var(--duration-fast) var(--ease-smooth-out)) slide it entirely on the
 * compositor. Re-measures on resize and on activeKey change.
 */

import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { motionReduced } from "@/app/lib/site-settings";

// Each page mounts its own nav, so without help the pill would simply appear
// at the destination. Remembering the previous page's active key at module
// scope lets a freshly mounted bar seat the pill on the OLD item first, then
// slide it to the new one — a purely horizontal move inside one bar, which
// is what keeps route transitions from reading as a jump (the earlier
// snapshot-morph approach tracked each page's bar position and dipped
// vertically when those differed).
let lastActiveKey: string | null = null;

export function useNavPillSlide(
  trackRef: RefObject<HTMLElement | null>,
  pillRef: RefObject<HTMLElement | null>,
  activeKey: string | null,
) {
  const frame = useRef<number | null>(null);
  const slideFrom = useRef<string | null>(null);

  // The pill keeps a fixed 100px base width (effects.css) and is sized with
  // scaleX so the slide is a single compositor-driven transform — animating
  // `width` re-layouts and repaints every frame on the main thread, which
  // visibly stutters while a route commit is in flight.
  const PILL_BASE_WIDTH = 100;

  const seat = (pill: HTMLElement, link: HTMLElement) => {
    pill.style.opacity = "1";
    pill.style.transform =
      `translateX(${link.offsetLeft}px) scaleX(${link.offsetWidth / PILL_BASE_WIDTH})`;
  };

  const measure = () => {
    const track = trackRef.current;
    const pill = pillRef.current;
    if (!track || !pill || activeKey == null) {
      if (pill) pill.style.opacity = "0";
      return;
    }
    const link = track.querySelector<HTMLElement>(`[data-nav-key="${CSS.escape(activeKey)}"]`);
    if (!link) {
      pill.style.opacity = "0";
      return;
    }
    const fromKey = slideFrom.current;
    slideFrom.current = null;
    const fromLink = fromKey && fromKey !== activeKey
      ? track.querySelector<HTMLElement>(`[data-nav-key="${CSS.escape(fromKey)}"]`)
      : null;
    if (fromLink && !motionReduced()) {
      // Seat on the previous route's item without animating, then let the
      // CSS transition carry it to the new one on the next frame.
      const previousTransition = pill.style.transition;
      pill.style.transition = "none";
      seat(pill, fromLink);
      void pill.offsetWidth; // flush the un-animated seat
      pill.style.transition = previousTransition;
      frame.current = requestAnimationFrame(() => seat(pill, link));
      return;
    }
    seat(pill, link);
  };

  useLayoutEffect(() => {
    if (lastActiveKey !== activeKey) {
      slideFrom.current = lastActiveKey;
      lastActiveKey = activeKey;
    }
    measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey]);

  useEffect(() => {
    const onResize = () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(measure);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

export default useNavPillSlide;
