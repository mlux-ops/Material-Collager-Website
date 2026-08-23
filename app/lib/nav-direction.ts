/**
 * Navigation direction + transition guards for the plotter-wipe route
 * transition. Pure module: no DOM access, so the fallthrough matrix is
 * testable under node --test (tests/transitions-direction.test.mjs,
 * tests/transitions-link-guards.test.mjs).
 */

/** The main surfaces in progression order. Forward = moving right. The
 * archive sits past the workbench: entering it from anywhere wipes forward,
 * leaving it wipes back. */
export const NAV_ORDER = ["/", "/generator", "/workbench", "/archive"] as const;

export type NavDirection = "forward" | "back" | "none";

/** Strip query/hash and trailing slash (keeping bare "/") so mount-time and
 * click-time spellings of the same route compare equal. */
export function normalizeRoutePath(path: string): string {
  const bare = path.split(/[?#]/, 1)[0];
  if (bare.length > 1 && bare.endsWith("/")) return bare.slice(0, -1);
  return bare;
}

/**
 * Direction of a navigation between two routes. History traversal needs no
 * special casing: back/forward lands on a route whose index comparison gives
 * the same answer as a direct click.
 */
export function navDirection(from: string, to: string): NavDirection {
  const a = NAV_ORDER.indexOf(normalizeRoutePath(from) as (typeof NAV_ORDER)[number]);
  const b = NAV_ORDER.indexOf(normalizeRoutePath(to) as (typeof NAV_ORDER)[number]);
  if (a === -1 || b === -1 || a === b) return "none";
  return b > a ? "forward" : "back";
}

export interface TransitionGuardInput {
  modifierPressed: boolean;
  button: number;
  samePath: boolean;
  hasViewTransitionAPI: boolean;
  prefersReducedMotion: boolean;
  defaultPrevented: boolean;
}

/**
 * Whether a click should go down the view-transition path. Every `false`
 * falls through to a plain client navigation (or the browser's own handling
 * for modified clicks) — never a degraded half-animation.
 */
export function shouldStartViewTransition(input: TransitionGuardInput): boolean {
  if (input.defaultPrevented) return false;
  if (input.modifierPressed) return false;
  if (input.button !== 0) return false;
  if (input.samePath) return false;
  if (!input.hasViewTransitionAPI) return false;
  if (input.prefersReducedMotion) return false;
  return true;
}
