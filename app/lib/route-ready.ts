/**
 * Route readiness registry for the plotter-wipe transition.
 *
 * The transition's update promise awaits the destination page declaring
 * itself painted (mount + frame for DOM routes; first rendered frame for the
 * Library's three.js scene) instead of a guessed timing constant. A bounded
 * budget still caps the wait so a route that never signals can't freeze the
 * page on a stale snapshot (spec FR-006/FR-007).
 *
 * Deliberately module-scope pub/sub, not a store: one pending navigation at a
 * time, latest wins. Readiness is per-navigation — marks that arrive while no
 * wait is pending are dropped, so a previous visit can't satisfy the next
 * navigation's wait. Pure enough for node --test
 * (tests/transitions-route-ready.test.mjs).
 */

import { normalizeRoutePath } from "./nav-direction.ts";

export type RouteReadyOutcome = "ready" | "timeout" | "superseded";

/** Worst measured cold paint (Library canvas init, 761 ms headless) + margin.
 * See specs/20260821-page-transitions-upgrade/research.md (T001). */
export const READY_BUDGET_MS = 900;

/**
 * The workbench earns a longer hold than the other routes: its readiness is
 * gated on a real dynamic chunk (WorkbenchApp + xyflow) fetching AND
 * evaluating, not just a mount, so on a cold cache or a slow link it can
 * outrun the standard budget — and the wipe then lands on the loading veil,
 * which is the full-screen flash the owner keeps seeing. Holding the
 * outgoing page longer is exactly the owner's own design for this route
 * ("wait for it to load, then wipe at normal speed"); hover/idle warming
 * (SiteNavigation) means the hold is usually imperceptible anyway.
 */
const ROUTE_BUDGET_MS: Record<string, number> = {
  "/workbench": 1600,
};

/** Readiness budget for a destination route. */
export function budgetFor(path: string): number {
  return ROUTE_BUDGET_MS[normalizeRoutePath(path)] ?? READY_BUDGET_MS;
}

interface PendingWait {
  path: string;
  resolve: (outcome: RouteReadyOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

let pending: PendingWait | null = null;

function settle(outcome: RouteReadyOutcome): void {
  if (!pending) return;
  clearTimeout(pending.timer);
  const { resolve } = pending;
  pending = null;
  resolve(outcome);
}

/** Called by route pages when their content has actually painted. */
export function markRouteReady(path: string): void {
  if (!pending) return; // no navigation in flight — drop (no stickiness)
  if (pending.path !== normalizeRoutePath(path)) return;
  settle("ready");
}

/**
 * Await readiness of `path`, bounded by `budgetMs`. A newer wait supersedes
 * the pending one (latest navigation wins).
 */
export function awaitRouteReady(
  path: string,
  budgetMs: number = READY_BUDGET_MS,
): Promise<RouteReadyOutcome> {
  settle("superseded");
  return new Promise<RouteReadyOutcome>((resolve) => {
    pending = {
      path: normalizeRoutePath(path),
      resolve,
      timer: setTimeout(() => settle("timeout"), budgetMs),
    };
  });
}

/** Settle any pending wait as superseded — never leaves a dangling promise. */
export function cancelRouteWait(): void {
  settle("superseded");
}

// ---------------------------------------------------------------------------
// Transition-idle signal. Heavy destination work (the Library's GL/texture
// init) stutters the wipe if it runs mid-animation, because the incoming
// side of a same-document transition is live-rendered. Pages that want to
// defer such work park it behind awaitTransitionSettled(): resolves
// immediately when no wipe is running, otherwise when the current one
// finishes (or is skipped — `finished` rejection counts as settled).

let activeTransition: Promise<void> | null = null;

/** Called by TransitionLink with the ViewTransition's `finished` promise. */
export function setActiveTransition(finished: Promise<unknown>): void {
  const p: Promise<void> = finished
    .catch(() => {})
    .then(() => {
      if (activeTransition === p) activeTransition = null;
    });
  activeTransition = p;
}

/** Resolves when no route transition is animating. */
export function awaitTransitionSettled(): Promise<void> {
  return activeTransition ?? Promise.resolve();
}

/** Test seam: identical to cancelRouteWait, kept as an explicit name. */
export const _resetRouteReadyForTests = cancelRouteWait;
