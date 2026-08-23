"use client";

/**
 * WordmarkMenu
 * ------------
 * The frosted pane behind the "Material Collager" wordmark: clicking the
 * wordmark slides a glass panel down from the top (same motion family as the
 * page wipe) until it rests against the bottom of the screen, where it stays
 * until the wordmark is clicked again, the user clicks outside the panel, or
 * presses Escape — each close slides it back up. Once the slide lands, the
 * row labels dither into existence in tiny ink dots (DitherTextIn),
 * staggered top to bottom.
 *
 * Rows (owner spec):
 *  - external links (SHB STUDIO PORTAL, EMAIL, and every vendor/site child)
 *    open in a new tab;
 *  - VENDORS / SITES / SETTINGS are expandable: clicking extends the row's
 *    gradient box downward to fit its child links (rows below are pushed
 *    down by the same height transition), and moving the mouse out of the
 *    box slides it back up to default size BEFORE the gradient fades away;
 *  - ARCHIVE routes to /archive through the plotter wipe (TransitionLink).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DitherTextIn } from "./DitherTextIn";
import { TransitionLink } from "./TransitionLink";
import Velaris from "./ui/velaris";

type MenuChild = { label: string; href?: string };
type MenuRow =
  | { label: string; kind: "external"; href: string }
  | { label: string; kind: "route"; href: string }
  | { label: string; kind: "expand"; children: MenuChild[] };

const ROWS: MenuRow[] = [
  { label: "SHB STUDIO PORTAL", kind: "external", href: "https://epc.shb.studio" },
  { label: "EMAIL", kind: "external", href: "https://www.gmail.com" },
  {
    label: "VENDORS",
    kind: "expand",
    children: [
      { label: "FERGUSON HOME", href: "https://fergusonhome.com" },
      { label: "LIGHTOLOGY", href: "https://www.lightology.com" },
      { label: "STUDIO41", href: "https://www.s41tradeconnect.com" },
      { label: "ABT", href: "https://www.abt.com" },
    ],
  },
  {
    label: "SITES",
    kind: "expand",
    children: [
      { label: "SMARTSHEET", href: "https://www.smartsheet.com" },
      { label: "FIELDWIRE", href: "https://www.fieldwire.com" },
      { label: "OPENSPACE", href: "https://www.openspace.ai" },
      { label: "ADAPTIVE", href: "https://www.adaptive.build" },
    ],
  },
  { label: "ARCHIVE", kind: "route", href: "/archive" },
  {
    label: "SETTINGS",
    kind: "expand",
    // Placeholders until each setting ships — inert on purpose.
    children: [
      { label: "DARK MODE · SOON" },
      { label: "REDUCE MOTION · SOON" },
      { label: "PERFORMANCE MODE · SOON" },
    ],
  },
];

/* How long a just-left row keeps its gradient mounted so it can fade out —
   matches the 420ms opacity transition in effects.css plus a beat. */
const GLOW_FADE_MS = 460;
/* Height transition of an expanding row (effects.css .wordmark-menu-row). An
   expanded row collapses for this long BEFORE its glow starts fading. */
const COLLAPSE_MS = 300;
/* Geometry shared with effects.css: header row 56px (19px padding + 18px
   label box), each child link 34px, plus a bottom inset on the open box. */
const ROW_H = 56;
const SUB_H = 34;
const OPEN_PAD = 10;

/* Per-row Velaris palettes over the black background — each row also gets
   its own seed, so pattern AND palette are unique per option. Rows 1-3 are
   the owner's Rechroma exports (oklch converted to sRGB hex); rows 4-6 are
   curated to sit alongside them. Module-scope constants: a fresh array
   literal per render would re-init the WebGL context on every hover state
   change. */
const VELARIS_BG = "#000000";
const ROW_PALETTES: string[][] = [
  ["#fab9b3", "#8ddbe3", "#cec3fa"], // 1 - sunlit starfish / milk waterfall / heather
  ["#a1de9f", "#f9185b", "#a36fff"], // 2 - fresh avocado / habanero / orchid
  ["#5f8df8", "#c46aca", "#42ac4c"], // 3 - lupine / linen bubblegum / matcha
  ["#d9a441", "#cd6543", "#4a5560"], // 4 - ochre / terracotta / slate ink
  ["#3a7ca5", "#7ac9bc", "#e8c98f"], // 5 - cerulean / sea glass / sand
  ["#1a1a1a", "#7a7a7a", "#c9c9c9"], // 6 - house monochrome inks
];

/* Owner pick from the dither mockup round: fine riso — 1px color dither,
   two levels per channel, on every row. */
const ROW_DITHER = { cell: 1, levels: 2 };

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
  // Velaris gradient hover: the animated gradient is mounted per-row, only
  // while that row is hovered/focused plus a fade-out grace — so at most two
  // WebGL canvases (the hot row and the one fading back) ever run at once.
  const [hotRow, setHotRow] = useState<number | null>(null);
  const [fadingRow, setFadingRow] = useState<number | null>(null);
  // Which expandable row is currently extended (one at a time).
  const [expandedRow, setExpandedRow] = useState<number | null>(null);
  const fadeTimer = useRef<number | null>(null);
  // A leave deferred while its row's box collapses back to default height.
  const pendingLeave = useRef<{ index: number; timer: number } | null>(null);

  const finishLeave = useCallback((index: number) => {
    setHotRow((current) => (current === index ? null : current));
    setFadingRow(index);
    if (fadeTimer.current !== null) window.clearTimeout(fadeTimer.current);
    fadeTimer.current = window.setTimeout(() => {
      fadeTimer.current = null;
      setFadingRow(null);
    }, GLOW_FADE_MS);
  }, []);

  const enterRow = useCallback((index: number) => {
    // Re-entering a row whose deferred leave hasn't fired yet keeps its glow.
    if (pendingLeave.current !== null) {
      window.clearTimeout(pendingLeave.current.timer);
      pendingLeave.current = null;
    }
    // Reduced motion keeps the plain black-tint hover (still styled in CSS)
    // instead of a perpetually animating canvas.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    setHotRow(index);
  }, []);

  const leaveRow = useCallback((index: number) => {
    if (expandedRow === index) {
      // Owner spec: the box slides back up to default size FIRST, then the
      // gradient fades away like normal.
      setExpandedRow(null);
      if (pendingLeave.current !== null) window.clearTimeout(pendingLeave.current.timer);
      pendingLeave.current = {
        index,
        timer: window.setTimeout(() => {
          pendingLeave.current = null;
          finishLeave(index);
        }, COLLAPSE_MS),
      };
      return;
    }
    finishLeave(index);
  }, [expandedRow, finishLeave]);

  // Mounted only while open (SiteNavigation renders it conditionally), so
  // every open starts fresh; unmount clears any in-flight timers.
  useEffect(() => () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    if (fadeTimer.current !== null) window.clearTimeout(fadeTimer.current);
    if (pendingLeave.current !== null) window.clearTimeout(pendingLeave.current.timer);
  }, []);

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

  const label = (text: string, index: number) => (
    <span className="wordmark-row-label">
      <DitherTextIn text={text} delay={index * 70} duration={505} cell={1} fontSize={13.2} />
    </span>
  );

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
          className={closing ? "wordmark-menu-shadow wordmark-menu-leaving-shadow" : "wordmark-menu-shadow"}
          aria-hidden="true"
        />
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
              <li key={row.label}>
                <div
                  className="wordmark-menu-row"
                  style={{
                    height:
                      row.kind === "expand" && expandedRow === i
                        ? ROW_H + row.children.length * SUB_H + OPEN_PAD
                        : ROW_H,
                  }}
                  onPointerEnter={() => enterRow(i)}
                  onPointerLeave={() => leaveRow(i)}
                >
                  {(hotRow === i || fadingRow === i) && (
                    <span
                      className={hotRow === i ? "wordmark-row-glow wordmark-row-glow-in" : "wordmark-row-glow"}
                      aria-hidden="true"
                    >
                      <Velaris
                        height="100%"
                        bg={VELARIS_BG}
                        colors={ROW_PALETTES[i % ROW_PALETTES.length]}
                        seed={i + 1}
                        dither={ROW_DITHER}
                      />
                    </span>
                  )}
                  {row.kind === "external" ? (
                    <a
                      className="wordmark-menu-row-btn"
                      href={row.href}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      {label(row.label, i)}
                    </a>
                  ) : row.kind === "route" ? (
                    <TransitionLink className="wordmark-menu-row-btn" href={row.href}>
                      {label(row.label, i)}
                    </TransitionLink>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="wordmark-menu-row-btn"
                        aria-expanded={expandedRow === i}
                        onClick={() => setExpandedRow((open) => (open === i ? null : i))}
                        onFocus={() => enterRow(i)}
                        onBlur={() => leaveRow(i)}
                      >
                        {label(row.label, i)}
                      </button>
                      {/* Always mounted (revealed by the row's height) so the
                          collapse can animate over real content. */}
                      <div className="wordmark-sub-list" aria-hidden={expandedRow !== i}>
                        {row.children.map((child) =>
                          child.href ? (
                            <a
                              key={child.label}
                              className="wordmark-sub-link"
                              href={child.href}
                              target="_blank"
                              rel="noreferrer noopener"
                              tabIndex={expandedRow === i ? 0 : -1}
                            >
                              {child.label}
                            </a>
                          ) : (
                            <span key={child.label} className="wordmark-sub-link wordmark-sub-inert">
                              {child.label}
                            </span>
                          ),
                        )}
                      </div>
                    </>
                  )}
                </div>
              </li>
            ) : (
              <li key={row.label} aria-hidden="true" />
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
