/**
 * Decision logic for the Library viewer's card morph (SceneWheelV2): a
 * clicked wheel card morphs into the viewer's image through a shared-element
 * view transition, and back into the card on close. Kept pure so the
 * fallthrough matrix is testable without a DOM — the same shape as
 * shouldStartViewTransition in nav-direction.ts.
 *
 * The CSS half lives in app/effects.css ("Library viewer: card morph").
 */

/** Transition types; effects.css selects on these, and on the mirrored
 * `html[data-wheel-viewer]` attribute for engines without types. */
export const WHEEL_VIEWER_OPEN_TYPE = "wheel-viewer-open";
export const WHEEL_VIEWER_CLOSE_TYPE = "wheel-viewer-close";

export type WheelMorphGuardInput = {
  hasViewTransitionAPI: boolean;
  prefersReducedMotion: boolean;
  /** Whether the card projects to a usable on-screen quad. */
  hasPlacement: boolean;
};

/**
 * True when the viewer should open/close through the morph. Otherwise the
 * caller keeps the plain path: the two-phase slide/frost close without the
 * API, the immediate swap under reduced motion, and a plain open whenever the
 * card cannot be placed (invisible slot, degenerate quad).
 */
export function shouldMorphViewer(input: WheelMorphGuardInput): boolean {
  if (!input.hasViewTransitionAPI) return false;
  if (input.prefersReducedMotion) return false;
  if (!input.hasPlacement) return false;
  return true;
}
