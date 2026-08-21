/**
 * Dev-only visibility into route transitions (spec FR-009). Transitions fail
 * silently by design — a skipped or timed-out ViewTransition surfaces nowhere
 * except its own promises — so development logs every outcome with a reason.
 * Inert in production builds.
 */

const DEV = process.env.NODE_ENV !== "production";

export type TransitionLogReason =
  | "no-view-transition-api"
  | "reduced-motion"
  | "modified-click"
  | "same-route"
  | "ready"
  | "timeout"
  | "superseded"
  | "finished"
  | "transition-error";

export function logTransition(reason: TransitionLogReason, detail?: unknown): void {
  if (!DEV) return;
  console.info(`[transition] ${reason}`, detail ?? "");
}

/** Attach dev logging to a started ViewTransition's lifecycle. */
export function observeTransition(vt: ViewTransition): void {
  if (!DEV) return;
  vt.finished
    .then(() => logTransition("finished"))
    .catch((err: unknown) =>
      logTransition("transition-error", err instanceof Error ? `${err.name}: ${err.message}` : err),
    );
}
