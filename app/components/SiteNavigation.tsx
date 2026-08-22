"use client";

import { useRef, useState, type ReactNode } from "react";
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
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuCloseSignal, setMenuCloseSignal] = useState(0);
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
      </nav>
      <div className="site-nav-right">
        {right}
        {/* MAX LUX wordmark — persistent, top right, on every page. Drawn as
            type + rule bars (not an image) so it stays crisp at any zoom and
            inherits the ink token. */}
        <span className="site-logo" role="img" aria-label="Max Lux">
          {/* Owner-authored FINAL mark (references/maxlux-logo-final.svg)
              embedded verbatim; children inherit currentColor so the ink
              token applies. vs v3: rule bars trimmed flush with the X's
              right edge, both X glyphs and the M's right half nudged left. */}
          <svg viewBox="0 0 248.656 192.867" fill="currentColor" aria-hidden="true" focusable="false">
            <path d="M9.502,174.324l.283-71.495h16.116v59.055h55.681v12.44H9.502Z"/>
            <rect x="9.502" y="79.101" width="221.382" height="8.174"/>
            <rect x="9.502" y="179.89" width="221.382" height="8.174"/>
            <polyline points="81.348 72.959 81.348 72.959 81.348 1.459 60.878 1.459 50.568 25.543 45.339 37.76 45.212 56.06 51.748 56.057 64.941 25.396 64.949 72.955" stroke="currentColor" strokeMiterlimit="10" strokeWidth=".1"/>
            <polyline points="25.901 73.025 25.909 25.466 39.102 56.127 45.638 56.13 45.511 37.83 40.282 25.613 29.972 1.529 9.502 1.529 9.502 73.029" stroke="currentColor" strokeMiterlimit="10" strokeWidth=".1"/>
            <polyline points="121.467 22.128 128.797 45.386 120.704 45.386 120.57 58.348 132.319 58.348 137.4 72.959 156.718 72.959 131.369 1.459 121.467 1.459 121.538 1.459 111.374 1.459 86.287 72.959 105.604 72.959 110.685 58.348 122.435 58.348 122.301 45.386 114.207 45.386 121.538 22.128"/>
            <line x1="91.773" y1="62.624" x2="97.699" y2="45.386" fill="none"/>
            <line x1="106.636" y1="74.025" x2="111.48" y2="59.414" fill="none"/>
            <line x1="85.83" y1="177.78" x2="85.83" y2="173.074" fill="none"/>
            <path d="M106.077,145.833c0,7.888,4.096,15.861,15.236,15.861l.064,12.629c-23.547,0-33.79-11.878-33.79-28.461h0l.12-43.035h18.37s0,43.103,0,43.103"/>
            <path d="M136.677,145.833c0,7.888-4.223,15.861-15.364,15.861l.064,12.629c23.547,0,33.79-11.878,33.79-28.461h0l-.12-43.035h-18.37s0,43.103,0,43.103"/>
            <polyline points="207.503 138.579 213.79 128.327 230.884 102.828 211.263 102.828 196.114 125.018 181.185 102.828 161.564 102.828 184.901 138.573 184.901 138.579 161.564 174.324 181.185 174.324 196.114 152.134 211.263 174.324 230.884 174.324 213.79 148.825 207.503 138.573"/>
            <polyline points="207.503 37.214 213.79 26.962 230.884 1.464 211.263 1.464 196.114 23.653 181.185 1.464 161.564 1.464 184.901 37.209 184.901 37.214 161.564 72.959 181.185 72.959 196.114 50.77 211.263 72.959 230.884 72.959 213.79 47.46 207.503 37.209"/>
            <path d="M120.512,169.257c.023.057.038.113.049.174l-.089-.665c.006.06.006.117.001.177l.089-.665c-.013.092-.037.177-.07.264l.252-.597c-.058.133-.133.254-.221.37l.391-.506c-.116.146-.251.275-.381.408-.26.266-.491.564-.704.867-.047.067-.087.136-.122.209-.103.211-.209.456-.285.678-.014.042-.027.084-.037.127-.078.368-.093.734-.133,1.103l.089-.665c-.01.075-.025.145-.054.215l.252-.597c-.016.032-.033.059-.055.088l.391-.506c-.015.018-.033.034-.051.048l.506-.391-.031.021c-.291.157-.525.372-.701.644-.221.241-.37.525-.447.85-.104.332-.119.665-.045.997.015.333.114.643.297.929.344.534.857,1.004,1.494,1.149.632.144,1.37.123,1.926-.252.446-.3.717-.53,1-.994.118-.194.207-.446.286-.658.015-.04.029-.079.038-.121.083-.367.092-.744.135-1.116l-.089.665c.013-.087.034-.168.066-.25l-.252.597c.048-.109.109-.208.18-.304l-.391.506c.113-.145.241-.275.371-.405.273-.275.509-.576.733-.894.056-.079.103-.162.145-.249.123-.254.265-.531.327-.815.121-.557.181-1.222-.035-1.768-.077-.325-.227-.609-.447-.85-.176-.272-.41-.487-.701-.644-.287-.183-.597-.282-.929-.297-.332-.074-.665-.06-.997.045-.605.196-1.189.571-1.494,1.149l-.252.597c-.119.443-.119.886,0,1.329h0Z"/>
            <path d="M124.498,168.557c.004-.013.009-.025.014-.038l-.252.597c.021-.05.049-.096.081-.14l-.391.506c.035-.045.074-.085.119-.119l-.506.391c.045-.034.093-.063.145-.085l-.597.252c.033-.014.068-.025.103-.033.325-.077.609-.227.85-.447.272-.176.487-.41.644-.701.183-.287.282-.597.297-.929.074-.332.06-.665-.045-.997l-.252-.597c-.222-.376-.521-.675-.897-.897l-.597-.252c-.443-.119-.886-.119-1.329,0-.029.007-.057.015-.084.025-.006.002-.013.005-.019.008l-.597.252s-.008.004-.012.005c-.012.006-.024.011-.036.018-.025.013-.049.028-.072.044-.195.138-.389.28-.567.439-.02.018-.039.037-.057.058-.078.089-.157.201-.221.284-.063.082-.153.188-.219.286-.015.022-.029.046-.041.07-.109.217-.204.442-.283.672-.104.332-.119.665-.045.997.015.333.114.643.297.929.157.291.372.525.644.701.241.221.525.37.85.447l.665.089c.451-.001.872-.115,1.262-.341l.506-.391c.31-.312.524-.68.643-1.103h0Z"/>
            <path d="M124.644,165.03l-.11-.11c-.226-.244-.495-.416-.805-.517-.298-.157-.619-.228-.963-.215-.344-.013-.665.059-.963.215-.31.101-.578.273-.805.517l-.391.506c-.226.39-.34.811-.341,1.262l.089.665c.119.424.333.791.643,1.103l.11.11c.226.244.495.416.805.517.298.157.619.228.963.215.344.013.665-.059.963-.215.31-.101.578-.273.805-.517l.391-.506c.226-.39.34-.811.341-1.262l-.089-.665c-.119-.424-.333-.791-.643-1.103h0Z"/>
            <path d="M121.665,168.638c3.217,0,3.223-5,0-5s-3.223,5,0,5h0Z"/>
            <path d="M121.665,168.087c3.217,0,3.223-5,0-5s-3.223,5,0,5h0Z"/>
            <path d="M121.335,167.757c3.217,0,3.223-5,0-5s-3.223,5,0,5h0Z"/>
            <path d="M121.225,167.757c3.217,0,3.223-5,0-5s-3.223,5,0,5h0Z"/>
            <path d="M121.225,167.647c3.217,0,3.223-5,0-5s-3.223,5,0,5h0Z"/>
            <path d="M122.273,167.318l.219-.112c.291-.157.525-.372.701-.644.221-.241.37-.525.447-.85.104-.332.119-.665.045-.997-.015-.333-.114-.643-.297-.929l-.391-.506c-.312-.31-.68-.524-1.103-.643l-.665-.089c-.451.001-.872.115-1.262.341l-.219.112c-.291.157-.525.372-.701.644-.221.241-.37.525-.447.85-.104.332-.119.665-.045.997.015.333.114.643.297.929l.391.506c.312.31.68.524,1.103.643l.665.089c.451-.001.872-.115,1.262-.341h0Z"/>
            <path d="M120.729,167.205c.223.107.453.2.684.29.033.013.068.025.102.035.03.009.061.016.091.023.244.051.56.082.758.105.067.008.134.012.202.009.036-.001.072-.004.107-.009.251-.03.508-.054.758-.105.325-.077.609-.227.85-.447.272-.176.487-.41.644-.701.183-.287.282-.597.297-.929.074-.332.06-.665-.045-.997l-.252-.597c-.222-.376-.521-.675-.897-.897l-.597-.252c-.443-.119-.886-.119-1.329,0-.026.005-.053.01-.08.014l.665-.089c-.107.014-.215.014-.322.001l.665.089c-.107-.014-.211-.042-.311-.083l.597.252c-.021-.009-.041-.018-.061-.028-.287-.183-.597-.282-.929-.297-.332-.074-.665-.06-.997.045-.325.077-.609.227-.85.447-.272.176-.487.41-.644.701l-.252.597c-.119.443-.119.886,0,1.329l.252.597c.222.376.521.675.897.897h0Z"/>
          </svg>
        </span>
      </div>
    </header>
  );
}
