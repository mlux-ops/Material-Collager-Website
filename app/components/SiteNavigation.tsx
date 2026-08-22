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
          {/* Owner-authored mark (references/maxlux-logo2.svg, Illustrator
              export embedded verbatim): outlined letterforms with white cut
              details, ink via currentColor so the theme token applies. */}
          <svg viewBox="0 0 223.5 188" aria-hidden="true" focusable="false">
            <path fill="currentColor" d="M112.1,175.8c-6.4,0-12.1-0.9-16.9-2.7c-4.8-1.8-8.6-4.3-11.3-7.6s-4.1-7.2-4.1-11.7v-44.3l14.3-0.1l0,43.1 c0,0.3,0,0.6,0.1,0.8c0,1.6,0.6,2.9,1.5,4.1c1,1.4,2.5,2.5,4.3,3.3c0.9,0.4,3.3,1.1,5.8,1.5c2.6,0.4,5.2,0.4,6.4,0.4"/>
            <path fill="currentColor" d="M111.6,175.8c6.4,0,12.1-0.9,16.9-2.7c4.8-1.8,8.6-4.3,11.3-7.6s4.1-7.2,4.1-11.7v-44.3l-14.3-0.1l0,43.1 c0,0.3,0,0.6-0.1,0.8c0,1.6-0.6,2.9-1.5,4.1c-1,1.4-2.5,2.5-4.3,3.3c-0.9,0.4-3.3,1.1-5.8,1.5c-2.6,0.4-5.2,0.4-6.4,0.4"/>
            <path fill="currentColor" d="M6.1,76V9.5h22.4l4.7,20.8c0.4,1.8,0.9,4.1,1.4,7.1c0.5,2.9,1,6.1,1.5,9.5s1,6.6,1.4,9.7c0.4,3.1,0.7,5.7,1,7.9 h-2.6c0.2-2.1,0.6-4.8,1-7.9c0.4-3.1,0.9-6.3,1.4-9.7s1-6.5,1.5-9.5c0.5-2.9,1-5.3,1.3-7.1l4.6-20.8H68V76H53.7V50.3 c0-1.5,0-3.5,0.1-6S53.9,39,54,36c0.1-3,0.1-6,0.2-9.1s0.1-5.8,0.1-8.4h0.8c-0.4,2.8-0.9,5.8-1.4,8.8c-0.5,3-1.1,6-1.6,8.9 c-0.6,2.9-1.1,5.6-1.6,8s-1,4.4-1.3,6L43,76H31.2L25,50.3c-0.4-1.6-0.8-3.6-1.3-6c-0.5-2.4-1.1-5.1-1.7-8c-0.6-2.9-1.2-5.9-1.7-8.9 c-0.5-3-1-6-1.5-8.8h1c0,2.6,0,5.4,0.1,8.4C20,30,20,33,20.1,36c0.1,3,0.1,5.8,0.2,8.3s0.1,4.5,0.1,6V76H6.1z"/>
            <path fill="currentColor" d="M128.9,49.8v13.5 M112.9,14.8 M115.1,9.6L143.9,76h-14.3l-11-26.2c-2.7-6.9-5.2-13.6-7.1-19.5"/>
            <path fill="currentColor" d="M6.1,175.8v-66.6l14.4-0.1v52.7h47.4l0.1,14H6.1z"/>
            <path fill="currentColor" d="M153.8,175.6l27.4-39.1v13.3l-27.4-40.6h20l7.3,11.1c1.3,2,2.4,3.8,3.5,5.5c1,1.7,1.5,3.6,2.2,5.2 c0.7,1.6,1.4,3.2,2.2,4.6h-5.2c0.9-1.4,1.6-3,2.3-4.6c0.7-1.6,1.4-3.4,2.3-5.2c0.8-1.8,1.9-3.8,3.1-5.8l6.6-10.8h20.5L192,148.8 v-12.4l26.5,39.3h-20.6l-6.9-11c-1.1-1.8-2-3.4-2.7-4.6s-1.2-2.4-1.7-3.4c-0.5-1-1-2-1.7-3.1h2.3c-0.7,1.1-1.2,2.1-1.7,3.2 s-1,2.1-1.7,3.4c-0.6,1.2-1.6,2.8-2.7,4.6l-6.1,9.2l-1.2,1.8H153.8z"/>
            <rect x="-0.2" y="78" fill="currentColor" width="223.8" height="10"/>
            <rect x="-0.2" y="178" fill="currentColor" width="223.8" height="10"/>
            <polyline fill="currentColor" points="182,122 184.2,125.4 187,129.5 185.2,130.6 "/>
            <polyline fill="currentColor" points="190,122.3 187.8,125.7 185.1,129.8 186.8,130.9 "/>
            <polygon fill="#fff" points="173.8,175.7 186.1,155.5 175.4,177.4 "/>
            <polygon fill="#fff" points="198.3,175.7 186.1,155.5 196.8,177.4 "/>
            <rect x="111.5" y="49.8" fill="currentColor" width="13.6" height="13.5"/>
            <path fill="currentColor" d="M94.6,49.8v13.5 M110.6,14.8 M108.5,9.6L79.5,76h14.3l11-26.2c2.7-6.9,5.2-13.6,7.1-19.5l3.1-20.8"/>
            <rect x="98.3" y="49.8" fill="currentColor" width="13.6" height="13.5"/>
            <path fill="currentColor" d="M153.7,76l27.4-39.1v13.3L153.7,9.5h20l7.3,11.1c1.3,2,2.4,3.8,3.5,5.5c1,1.7,1.5,3.6,2.2,5.2 c0.7,1.6,1.4,3.2,2.2,4.6h-5.2c0.9-1.4,1.6-3,2.3-4.6c0.7-1.6,1.4-3.4,2.3-5.2c0.8-1.8,1.9-3.8,3.1-5.8l6.6-10.8h20.5l-26.5,39.5 V36.7L218.4,76h-20.6l-6.9-11c-1.1-1.8-2-3.4-2.7-4.6c-0.6-1.2-1.2-2.4-1.7-3.4c-0.5-1-1-2-1.7-3.1h2.3c-0.7,1.1-1.2,2.1-1.7,3.2 s-1,2.1-1.7,3.4c-0.6,1.2-1.6,2.8-2.7,4.6l-6.1,9.2l-1.2,1.8H153.7z"/>
            <polyline fill="currentColor" points="182,22.3 184.2,25.8 186.9,29.9 185.2,30.9 "/>
            <polyline fill="currentColor" points="190,22.6 187.8,26.1 185,30.2 186.8,31.2 "/>
            <polygon fill="#fff" points="173.8,76 186,55.8 175.3,77.7 "/>
            <polygon fill="#fff" points="198.3,76 186,55.8 196.7,77.7 "/>
          </svg>
        </span>
      </div>
    </header>
  );
}
