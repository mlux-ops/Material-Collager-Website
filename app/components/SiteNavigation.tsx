"use client";

import Link from "next/link";
import type { ReactNode } from "react";

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
  return (
    <header className={className ? `site-navigation ${className}` : "site-navigation"}>
      <Link className="site-wordmark" href="/">Material Collager</Link>
      <nav aria-label="Primary navigation">
        <Link href="/" className={active === "library" ? "active" : undefined} aria-current={active === "library" ? "page" : undefined}>
          Library
        </Link>
        <Link href="/generator" className={active === "generator" ? "active" : undefined} aria-current={active === "generator" ? "page" : undefined}>
          Generator
        </Link>
        <Link href="/workbench" className={active === "workbench" ? "active" : undefined} aria-current={active === "workbench" ? "page" : undefined}>
          Workbench
        </Link>
      </nav>
      {right}
    </header>
  );
}
