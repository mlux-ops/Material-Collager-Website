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
 * onto the pill element as a transform + width, letting the CSS transition
 * in effects.css (var(--duration-fast) var(--ease-smooth-out)) do the actual
 * sliding. Re-measures on resize and on activeKey change.
 */

import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

export function useNavPillSlide(
  trackRef: RefObject<HTMLElement | null>,
  pillRef: RefObject<HTMLElement | null>,
  activeKey: string | null,
) {
  const frame = useRef<number | null>(null);

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
    pill.style.opacity = "1";
    pill.style.transform = `translateX(${link.offsetLeft}px)`;
    pill.style.width = `${link.offsetWidth}px`;
  };

  useLayoutEffect(() => {
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
