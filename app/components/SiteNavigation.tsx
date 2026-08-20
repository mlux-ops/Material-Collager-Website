"use client";

import Link from "next/link";
import { useRef, type ReactNode } from "react";
import { TransitionLink } from "./TransitionLink";
import { useNavPillSlide } from "./useNavPillSlide";

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
      {right}
    </header>
  );
}
