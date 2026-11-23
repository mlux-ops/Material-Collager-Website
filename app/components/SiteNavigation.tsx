"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { MaxLuxMark } from "./MaxLuxMark";
import { WordmarkMenu } from "./WordmarkMenu";
import { TransitionLink } from "./TransitionLink";
import { useNavPillSlide } from "./useNavPillSlide";

// Warm heavy destination chunks on navigation intent so their fetch AND
// module parse/eval happen on an idle page instead of mid-wipe (the incoming
// side of a transition is live — a long eval there reads as a white freeze).
// Read-only side effects (imports, a GET, image cache fills) — FR-011 safe.
// GL/mount work is not warmable; both heavy routes defer their mount until
// the transition settles instead (SceneWheelV2, WorkbenchPage).
let libraryWarmed = false;
function warmLibraryChunk() {
  if (libraryWarmed) return;
  libraryWarmed = true;
  void import("./scene-wheel-v2/SceneWheelV2").catch(() => {
    libraryWarmed = false; // transient failure: allow a retry on next intent
  });
  void fetch("/api/library", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((payload: unknown) => {
      // The API returns { ok, items } — this read `records` for a while,
      // which silently warmed zero images.
      const items = Array.isArray((payload as { items?: unknown })?.items)
        ? ((payload as { items: { imageUrl?: string }[] }).items)
        : [];
      for (const item of items.slice(0, 8)) {
        if (typeof item.imageUrl !== "string") continue;
        const img = new Image();
        img.decoding = "async";
        img.src = item.imageUrl;
      }
    })
    .catch(() => {});
}

let workbenchWarmed = false;
function warmWorkbenchChunk() {
  if (workbenchWarmed) return;
  workbenchWarmed = true;
  void import("./workbench/WorkbenchApp").catch(() => {
    workbenchWarmed = false; // transient failure: allow a retry on next intent
  });
}

const WARMERS: Record<string, () => void> = {
  "/": warmLibraryChunk,
  "/workbench": warmWorkbenchChunk,
};

// Hover warming only helps when there IS a hover: a decisive click, a touch
// tap, or a keyboard activation reaches the link with the chunk still cold,
// and the workbench's readiness hold is gated on that chunk — which is how
// the loading veil (and its full-screen flash) still surfaced. So warm the
// heavy chunk once the current page has gone idle too. Import only: no fetch,
// no GL, nothing observable (FR-011), and imports are idempotent.
function warmOnIdle() {
  const run = () => warmWorkbenchChunk();
  const idle = (window as unknown as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  }).requestIdleCallback;
  if (typeof idle === "function") idle(run, { timeout: 2500 });
  else window.setTimeout(run, 1800);
}

export type SiteNavigationActive = "library" | "generator" | "workbench" | "review";

// The one shared top bar for every page (Library, Generator, Workbench,
// Review Board).
// Max explicitly likes this bar as-is -- it is the reference everything else
// on the page adopts. Do not restyle `.site-navigation` in app/globals.css;
// this component only centralizes the markup so every page renders the exact
// same header instead of each page (or, in the Library's case, a bespoke
// three.js-side header) reimplementing it slightly differently.
export function SiteNavigation({
  active,
  className,
  right,
  dimensionalLogo = false,
}: {
  /** null = no nav item is current (e.g. the Archive) — the pill hides. */
  active: SiteNavigationActive | null;
  className?: string;
  right?: ReactNode;
  dimensionalLogo?: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuCloseSignal, setMenuCloseSignal] = useState(0);
  const trackRef = useRef<HTMLElement>(null);
  const pillRef = useRef<HTMLSpanElement>(null);
  // Every page carries this bar, so this is "once the visitor is settled on
  // whatever page they landed on". Skipped on the workbench itself, where the
  // chunk is by definition already loading.
  useEffect(() => {
    if (active === "workbench") return;
    warmOnIdle();
  }, [active]);
  // The black block is one element that slides between the links rather
  // than a background that blinks from one link to the next.
  useNavPillSlide(trackRef, pillRef, active);

  const item = (key: SiteNavigationActive, href: string, label: string) => (
    <TransitionLink
      href={href}
      className={`nav-pill-link${active === key ? " active" : ""}`}
      data-nav-key={key}
      data-active={active === key}
      aria-current={active === key ? "page" : undefined}
      onPointerEnter={WARMERS[href]}
      onPointerDown={WARMERS[href]}
    >
      {label}
    </TransitionLink>
  );

  return (
    <header
      className={[
        "site-navigation",
        className ?? "",
        menuOpen ? "menu-open" : "",
      ].filter(Boolean).join(" ")}
    >
      {/* The wordmark toggles the frosted menu pane rather than linking home
          (the LIBRARY item covers home navigation). */}
      <button
        type="button"
        className="site-wordmark"
        aria-expanded={menuOpen}
        aria-haspopup="true"
        onClick={() => {
          if (menuOpen) setMenuCloseSignal((n) => n + 1); // graceful slide-up
          else setMenuOpen(true);
        }}
      >
        Material Collager
      </button>
      {menuOpen ? (
        <WordmarkMenu
          closeSignal={menuCloseSignal}
          onRequestClose={() => {
            setMenuOpen(false);
            setMenuCloseSignal(0);
          }}
        />
      ) : null}
      <nav aria-label="Primary navigation" className="nav-pill-track" ref={trackRef}>
        <span className="nav-pill" aria-hidden ref={pillRef} />
        {item("library", "/", "Library")}
        {item("generator", "/generator", "Generator")}
        {item("workbench", "/workbench", "Workbench")}
        {item("review", "/review-boards", "Review Board")}
      </nav>
      <div className="site-nav-right">
        {right}
        <MaxLuxMark dimensional={dimensionalLogo} />
      </div>
    </header>
  );
}
