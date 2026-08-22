"use client";

/**
 * WordmarkMenu
 * ------------
 * The frosted pane behind the "Material Collager" wordmark: clicking the
 * wordmark slides a glass panel down from the top (same motion family as the
 * page wipe) until it rests against the bottom of the screen, where it stays
 * until the wordmark is clicked again, the user clicks outside the panel, or
 * presses Escape — each close slides it back up. Once the slide lands, the
 * placeholder rows (OPTION 1…) dither into existence in tiny ink dots
 * (DitherTextIn), staggered top to bottom.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DitherTextIn } from "./DitherTextIn";

const ROWS = ["OPTION 1", "OPTION 2", "OPTION 3", "OPTION 4", "OPTION 5", "OPTION 6"];

export function WordmarkMenu({
  onRequestClose,
  closeSignal = 0,
}: {
  onRequestClose: () => void;
  /** Increment to request a graceful close from outside (wordmark re-click). */
  closeSignal?: number;
}) {
  const [closing, setClosing] = useState(false);
  const [landed, setLanded] = useState(false);
  const closeTimer = useRef<number | null>(null);

  const requestClose = useCallback(() => {
    if (closeTimer.current !== null) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      onRequestClose();
      return;
    }
    setClosing(true);
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      setClosing(false);
      onRequestClose();
    }, 440);
  }, [onRequestClose]);

  // Mounted only while open (SiteNavigation renders it conditionally), so
  // every open starts fresh; unmount clears any in-flight close timer.
  useEffect(() => () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
  }, []);

  useEffect(() => {
    if (closeSignal <= 0) return;
    const t = window.setTimeout(requestClose, 0); // defer: no sync setState in effects
    return () => window.clearTimeout(t);
  }, [closeSignal, requestClose]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [requestClose]);

  // Portaled to <body>: the nav header's backdrop-filter would otherwise
  // become the containing block for these fixed elements, trapping the
  // panel inside the 58px bar.
  return createPortal(
    <>
      {/* Transparent click-catcher: "outside the panel" closes. Sits under
          the nav bar (z-index), so the wordmark stays clickable as a toggle. */}
      <div className="wordmark-menu-outside" onPointerDown={requestClose} aria-hidden="true" />
      <div className="wordmark-menu-clip">
        <div
          className={closing ? "wordmark-menu wordmark-menu-leaving" : "wordmark-menu"}
          role="navigation"
          aria-label="Site menu"
          onAnimationEnd={(event) => {
            if (event.animationName.includes("menu-slide-down")) setLanded(true);
          }}
        >
        <ul className="wordmark-menu-rows">
          {ROWS.map((row, i) =>
            landed ? (
              <li key={row}>
                <button type="button" className="wordmark-menu-row-btn">
                  <DitherTextIn text={row} delay={i * 70} duration={505} cell={1} fontSize={13.2} />
                </button>
              </li>
            ) : (
              <li key={row} aria-hidden="true" />
            ),
          )}
        </ul>
        </div>
      </div>
    </>,
    document.body,
  );
}

export default WordmarkMenu;
