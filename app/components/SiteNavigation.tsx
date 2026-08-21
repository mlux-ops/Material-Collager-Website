"use client";

import Link from "next/link";
import { useRef, type ReactNode } from "react";
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
      const records = Array.isArray((payload as { records?: unknown })?.records)
        ? ((payload as { records: { imageUrl?: string }[] }).records)
        : [];
      for (const record of records.slice(0, 8)) {
        if (typeof record.imageUrl !== "string") continue;
        const img = new Image();
        img.decoding = "async";
        img.src = record.imageUrl;
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

export type SiteNavigationActive = "library" | "generator" | "workbench";

// The one shared top bar for all three pages (Library, Generator, Workbench).
// Max explicitly likes this bar as-is -- it is the reference everything else
// on the page adopts. Do not restyle `.site-navigation` in app/globals.css;
// this component only centralizes the markup so every page renders the exact
// same header instead of each page (or, in the Library's case, a bespoke
// three.js-side header) reimplementing it slightly differently.
export function SiteNavigation({
  active,
  className,
  right,
}: {
  active: SiteNavigationActive;
  className?: string;
  right?: ReactNode;
}) {
  const trackRef = useRef<HTMLElement>(null);
  const pillRef = useRef<HTMLSpanElement>(null);
  // The black block is one element that slides between the three links rather
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
    <header className={className ? `site-navigation ${className}` : "site-navigation"}>
      <Link className="site-wordmark" href="/">Material Collager</Link>
      <nav aria-label="Primary navigation" className="nav-pill-track" ref={trackRef}>
        <span className="nav-pill" aria-hidden ref={pillRef} />
        {item("library", "/", "Library")}
        {item("generator", "/generator", "Generator")}
        {item("workbench", "/workbench", "Workbench")}
      </nav>
      <div className="site-nav-right">
        {right}
        {/* MAX LUX wordmark — persistent, top right, on every page. Drawn as
            type + rule bars (not an image) so it stays crisp at any zoom and
            inherits the ink token. */}
        <span className="site-logo" role="img" aria-label="Max Lux">
          {/* textLength + spacingAndGlyphs stretches every glyph to the same
              exact width — the mark's six letters are uniform blocks with
              near-zero whitespace, which per-letter cells can't achieve
              (glyphs keep natural widths and an X leaves air an M doesn't). */}
          <svg viewBox="0 0 60 47" aria-hidden="true" focusable="false">
            {["MAX", "LUX"].map((row, rowIndex) => (
              <g key={row}>
                {row.split("").map((letter, i) => (
                  <text
                    key={i}
                    x={0.8 + i * 20}
                    y={16.5 + rowIndex * 25}
                    fontSize="22"
                    fontWeight="900"
                    textLength="18.4"
                    lengthAdjust="spacingAndGlyphs"
                    fill="currentColor"
                  >
                    {letter}
                  </text>
                ))}
                <rect x="0" y={19.5 + rowIndex * 25} width="60" height="2.5" fill="currentColor" />
              </g>
            ))}
          </svg>
        </span>
      </div>
    </header>
  );
}
