/**
 * Site settings — the SETTINGS row of the wordmark menu.
 *
 * Four owner-chosen preferences, persisted in localStorage and applied to
 * <html> so CSS can honor them without prop-threading:
 *
 *  - reduceMotion    forces the reduced-motion path site-wide (wipes, dithers,
 *                    slides), on top of the OS setting, which still wins when
 *                    it is on. Read through motionReduced() — never
 *                    matchMedia directly — so both sources agree everywhere.
 *  - potato          "potato machine": drops the expensive-but-decorative work
 *                    (WebGL hover gradients, the workbench reveal, archive
 *                    dithers) while keeping every layout and interaction.
 *  - wipeSpeed       scales the page wipe via --wipe-dur.
 *  - landing         which surface a fresh visit opens on.
 *
 * The value helpers are pure so they can be unit-tested under node --test
 * (tests/site-settings.test.mjs); only load/save/apply touch the DOM.
 */

export type WipeSpeed = "slow" | "normal" | "fast";
export type LandingRoute = "/" | "/generator" | "/workbench" | "/archive";

export interface SiteSettings {
  reduceMotion: boolean;
  potato: boolean;
  wipeSpeed: WipeSpeed;
  landing: LandingRoute;
}

export const DEFAULT_SETTINGS: SiteSettings = {
  reduceMotion: false,
  potato: false,
  wipeSpeed: "normal",
  landing: "/",
};

const STORE_KEY = "mc:site-settings:v1";

export const WIPE_SPEEDS: WipeSpeed[] = ["slow", "normal", "fast"];
export const LANDING_ROUTES: LandingRoute[] = ["/", "/generator", "/workbench", "/archive"];

const WIPE_DURATION_MS: Record<WipeSpeed, number> = {
  slow: 980,
  normal: 700,
  fast: 420,
};

const LANDING_LABELS: Record<LandingRoute, string> = {
  "/": "LIBRARY",
  "/generator": "GENERATOR",
  "/workbench": "WORKBENCH",
  "/archive": "ARCHIVE",
};

/** Wipe duration for a speed, in ms (the --wipe-dur value). */
export function wipeDurationMs(speed: WipeSpeed): number {
  return WIPE_DURATION_MS[speed] ?? WIPE_DURATION_MS.normal;
}

export function landingLabel(route: LandingRoute): string {
  return LANDING_LABELS[route] ?? LANDING_LABELS["/"];
}

/** Next value in a cycling control — every setting advances by click. */
export function cycleWipeSpeed(current: WipeSpeed): WipeSpeed {
  const index = WIPE_SPEEDS.indexOf(current);
  return WIPE_SPEEDS[(index + 1) % WIPE_SPEEDS.length];
}

export function cycleLanding(current: LandingRoute): LandingRoute {
  const index = LANDING_ROUTES.indexOf(current);
  return LANDING_ROUTES[(index + 1) % LANDING_ROUTES.length];
}

/** Coerce anything (unknown JSON, a partial patch, garbage) into settings. */
export function normalizeSettings(raw: unknown): SiteSettings {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_SETTINGS };
  const input = raw as Partial<Record<keyof SiteSettings, unknown>>;
  const speed = input.wipeSpeed;
  const landing = input.landing;
  return {
    reduceMotion: input.reduceMotion === true,
    potato: input.potato === true,
    wipeSpeed: WIPE_SPEEDS.includes(speed as WipeSpeed) ? (speed as WipeSpeed) : DEFAULT_SETTINGS.wipeSpeed,
    landing: LANDING_ROUTES.includes(landing as LandingRoute) ? (landing as LandingRoute) : DEFAULT_SETTINGS.landing,
  };
}

// ---------------------------------------------------------------------------
// Live state. Module-scope cache + subscribers: several components read these
// on every hover/paint, so this stays synchronous and never re-parses JSON.

let cached: SiteSettings | null = null;
const listeners = new Set<() => void>();

export function getSettings(): SiteSettings {
  if (cached) return cached;
  if (typeof window === "undefined") return { ...DEFAULT_SETTINGS };
  try {
    const stored = window.localStorage.getItem(STORE_KEY);
    cached = normalizeSettings(stored ? JSON.parse(stored) : null);
  } catch {
    cached = { ...DEFAULT_SETTINGS };
  }
  return cached;
}

/** Merge a patch, persist, re-apply to <html>, notify subscribers. */
export function setSettings(patch: Partial<SiteSettings>): SiteSettings {
  const next = normalizeSettings({ ...getSettings(), ...patch });
  cached = next;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(STORE_KEY, JSON.stringify(next));
    } catch {
      // Private-mode / quota: the setting still applies for this session.
    }
    applySettings();
  }
  for (const listener of listeners) listener();
  return next;
}

export function subscribeSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Write the current settings onto <html> (attributes + the wipe duration). */
export function applySettings(): void {
  if (typeof document === "undefined") return;
  const settings = getSettings();
  const root = document.documentElement;
  if (settings.reduceMotion) root.dataset.reduceMotion = "1";
  else delete root.dataset.reduceMotion;
  if (settings.potato) root.dataset.potato = "1";
  else delete root.dataset.potato;
  root.style.setProperty("--wipe-dur", `${wipeDurationMs(settings.wipeSpeed)}ms`);
}

/**
 * The single reduced-motion question for the whole site: the OS preference
 * OR the site setting. Every animation guard reads this instead of
 * matchMedia, so the setting reaches code CSS can't (canvas dithers, the
 * view-transition guard, the pill's seat-then-slide).
 */
export function motionReduced(): boolean {
  if (typeof window === "undefined") return false;
  if (getSettings().reduceMotion) return true;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** True when decorative GPU work should be skipped. */
export function potatoMode(): boolean {
  if (typeof window === "undefined") return false;
  return getSettings().potato;
}

/** Test seam: drop the cache so a fresh read re-parses storage. */
export function _resetSettingsCacheForTests(): void {
  cached = null;
  listeners.clear();
}
