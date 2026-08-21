"use client";

import Link from "next/link";
import { useRef, type ReactNode } from "react";
import { TransitionLink } from "./TransitionLink";
import { useNavPillSlide } from "./useNavPillSlide";

// Warm the Library on navigation intent: the scene chunk (module fetch) plus
// the card images, so the browser has them fetched and decoded before the
// scene mounts after the wipe. Read-only side effects (a GET and image cache
// fills) — spec FR-011 safe. GL init itself is not warmable; the scene
// defers its mount to after the transition instead (SceneWheelV2).
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
      onPointerEnter={href === "/" ? warmLibraryChunk : undefined}
      onPointerDown={href === "/" ? warmLibraryChunk : undefined}
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
          {["MAX", "LUX"].map((row) => (
            <span key={row} className="site-logo-row" aria-hidden="true">
              {row.split("").map((letter, i) => (
                <i key={i}>{letter}</i>
              ))}
            </span>
          ))}
        </span>
      </div>
    </header>
  );
}
