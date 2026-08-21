# Feature Specification: Page Transitions Upgrade

**Branch**: `feat/page-transitions-upgrade`
**Created**: 2026-08-21
**Status**: Ready for Review
**Input**: User description: "The complete page-transitions upgrade from the 2026 research: prerendering of the three main routes, replacing the fixed hold timeout with a declared readiness condition, directional transition motion (forward/back), one shared element carried across routes, and transition instrumentation." (Scope confirmed interactively; see Clarifications Resolved.)

## Context

The site already ships a designed route transition: the outgoing page holds still while the incoming page is drawn over it from the left behind a 1px rule — the "plotter wipe" — with reduced-motion and no-support fallbacks. This feature upgrades that transition's reliability and expressiveness without changing its visual language. Research basis: *Page Transitions, 2026* brief (artifact, 22 sources). Governing rules: `AGENTS.md`, `directive/foundation.md` (Principles 1, 5, 6).

## Clarifications Resolved

1. **Shared element**: the site navigation block (with its sliding ink pill) is the element that visibly persists and morphs across routes.
2. **Direction**: derived from nav route order (Library → Generator → Workbench). Moving right in that order wipes forward (left-to-right, as today); moving left in the order — and browser back — wipes in reverse.
3. **Viewports**: the transition runs on all viewports, including 390×844; prerendering is the mitigation for mobile cost, not gating.

---

## User Scenarios & Testing

### Primary Use Cases

1. **Navigating between the three main surfaces.** A user on the Library clicks "Generator" in the nav. The current page holds still; the Generator page is drawn over it left-to-right behind the 1px rule. The nav block does not participate in the wipe — it reads as one continuous fixture, its ink pill sliding to the new active item while the sheet beneath it changes.
2. **Going back.** The user presses the browser back button (or clicks a nav item earlier in the route order). The wipe runs in the reverse direction, so the spatial metaphor holds: forward draws the new sheet in from the left, backward withdraws toward it.
3. **Slow route.** The user navigates to a route whose content is still loading. The transition waits for the destination to declare itself ready rather than revealing a blank or half-painted page — and rather than holding a frozen snapshot indefinitely. In the common case the destination was already prepared in the background at hover/press time, so the transition begins immediately.
4. **Reduced motion / unsupported browser.** Users with `prefers-reduced-motion`, or on browsers without the underlying capability, get an instant, ordinary navigation. No degraded half-animation.

### Visual States

- **Idle**: no transition artifacts present; pages appear exactly as they do today.
- **Transitioning (forward)**: outgoing page frozen at full strength; incoming page clipped and expanding left-to-right; 1px ink rule at the leading edge; nav block exempt from the wipe, pill sliding to the destination item.
- **Transitioning (backward)**: mirror of forward.
- **Waiting**: if the destination is not yet ready, the outgoing page remains fully visible and interactive-looking (no spinner, no dimming) until readiness or the fallback triggers.
- **Fallback**: destination shown as-is (instant swap) when the readiness condition cannot be met in time, the browser lacks support, or reduced motion is set.
- **Error**: a failed navigation behaves exactly as it does without transitions — the transition layer must never mask or alter navigation errors.

### Acceptance Scenarios

1. **Given** the Library page in a supporting browser, **When** the user clicks "Workbench", **Then** a forward wipe plays, the nav block never blinks or re-draws, and the pill lands on "Workbench".
2. **Given** the Workbench page reached from the Library, **When** the user presses browser back, **Then** a backward wipe plays and ends on the Library exactly as it was left (scroll position per normal browser behavior).
3. **Given** a cold cache and a route that takes long to first paint, **When** the user navigates to it, **Then** at no point is a blank or partially painted page revealed mid-wipe; either the wipe starts on a ready page or navigation completes without the wipe.
4. **Given** a user with reduced motion enabled, **When** they navigate anywhere, **Then** navigation is instant and no wipe, hold, or directional motion occurs.
5. **Given** the user hovers or presses a nav link, **When** they then complete the click, **Then** the destination appears with no perceptible wait in the common case (background preparation succeeded).
6. **Given** any transition plays, **When** developers inspect the dev console, **Then** skipped, timed-out, or failed transitions are visibly logged with their reason.

### Edge Cases

- Rapid successive navigations (click Generator, immediately click Workbench): the later navigation wins; no stacked or queued wipes.
- Modified clicks (new tab, middle-click) bypass the transition entirely — browser default behavior.
- Navigating to the current route does nothing.
- Background preparation must not run for external links and must not corrupt analytics or one-time effects on prepared pages (prepared-then-abandoned pages must have no user-visible side effects).
- QA determinism: the frozen scene states (`?qa=1&progress=…`) must remain reachable and unaffected by background preparation.

---

## Requirements

### Functional Requirements

**Navigation & Motion**:
- **FR-001**: Navigations between Library, Generator, and Workbench MUST use the plotter-wipe transition in supporting browsers.
- **FR-002**: The wipe's direction MUST encode navigation direction: forward along the nav route order (Library → Generator → Workbench) draws left-to-right; backward along the order, and browser back, draws in reverse.
- **FR-003**: The nav block MUST be exempt from the page wipe and persist as a continuous element across routes; its active-item pill MUST animate to the destination item during the transition.
- **FR-004**: The transition's visual language MUST remain the established one: outgoing page held at full strength, no crossfade, no blur, a single 1px ink rule at the leading edge, existing duration/easing tokens.

**Readiness & Performance**:
- **FR-005**: The three main routes MUST be prepared in the background ahead of likely navigation (e.g., on hover/press intent), so that in the common case the destination is fully renderable at click time.
- **FR-006**: The transition MUST wait on a *declared readiness condition* of the destination page — not on a hard-coded timeout constant. The existing fixed hold (850 ms) is removed as the primary mechanism.
- **FR-007**: A bounded fallback MUST still exist: if readiness is not reached within a sane budget, the destination is shown as-is rather than holding a frozen page indefinitely.
- **FR-008**: The transition MUST never reveal a blank or partially painted destination mid-wipe.

**Robustness & Instrumentation**:
- **FR-009**: Skipped, timed-out, or failed transitions MUST be logged in development with their reason (no-support, reduced-motion, timeout, navigation error).
- **FR-010**: Rapid successive navigations MUST resolve to the most recent target with no visual artifacts.
- **FR-011**: Background preparation MUST be side-effect safe: prepared pages that are never visited must not fire user-visible effects, mutate shared state, or consume generation credits.

### Accessibility Requirements

- **Motion**: `prefers-reduced-motion` MUST disable the wipe, the directional motion, and the hold entirely — instant navigation. (Existing behavior; must survive the upgrade.)
- **Keyboard Navigation**: nav links MUST remain ordinary links — keyboard activation, focus order, and focus visibility unchanged; focus MUST land per normal navigation semantics on the new page.
- **Screen Reader**: transitions MUST NOT delay or suppress the announcement of the new page; assistive technology experiences an ordinary navigation.
- **Visual**: the 1px leading rule and pill motion must not be the sole indicator of navigation state; the URL and page content change as normal.

### Responsive Design

- **All viewports** (390×844 through 1440×900): the transition runs identically; no viewport gating. Mobile cost is mitigated by background preparation (FR-005), not by disabling motion.

### Performance

- **Interaction Response**: with successful background preparation, perceived navigation delay target is ≤ 100 ms from click to wipe start.
- **Fallback budget**: the readiness wait must be bounded (on the order of the current 850 ms budget, tuned against the slowest route's real paint time — measured, not guessed).
- **Frame rate**: the wipe must hold frame rate at all four mandated QA viewports; a transition that stutters on 390×844 fails QA (per `AGENTS.md` completion rules).
- **No LCP regression**: background preparation must not regress initial-load metrics of the page the user is currently on.

---

## Dependencies & Constraints

### Dependencies
- Existing route-transition behavior (plotter wipe) and its reduced-motion/no-support fallbacks — the baseline being upgraded, not replaced.
- Existing nav block with sliding active-item pill — becomes the shared continuous element.
- The three main routes and their current navigation entry points.
- Deterministic QA scene states (`?qa=1&progress=…`) — must remain intact for visual comparison.

### Constraints
- **Browser support**: the upgrade is progressive enhancement. Browsers without the underlying capabilities get ordinary navigation; no polyfills, no JS-library fallback animation.
- **Directional capability caveat**: direction-aware styling is Baseline-new (Jan 2026); where absent, the symmetric (current) wipe is the acceptable degradation.
- **Design system**: durations and easings come from the existing motion tokens; line weight stays 1px; palette unchanged. No new visual vocabulary.
- **Governance**: `AGENTS.md` completion-report and visual-QA rules apply; foundation Principle 5 (motion designed, accessible, cheap) and Principle 6 (verified completion) bind this work.
- **Deployment**: behavior must be verified locally and approved before deploy (Principle 6).

### Assumptions
- The framework's first-class transition support (expected in the next minor framework release) may replace the hand-rolled trigger; this spec is written to be satisfiable either way, and the hand-rolled path remains acceptable if the upgrade hasn't landed.
- Background preparation is achievable within the current hosting platform's capabilities for same-origin routes.
- The slowest route's paint time (~790 ms cold, measured previously) is improvable but not a blocker for this feature; FR-007's budget accommodates it.

---

## Review & Acceptance Checklist

### Content Quality
- [x] No implementation details (component names, hooks, state shapes, CSS)
- [x] Focused on user interactions and visual outcomes
- [x] All mandatory sections completed
- [x] Accessibility requirements addressed

### Requirement Completeness
- [x] No [NEEDS CLARIFICATION] markers remain (3 raised, 3 resolved interactively)
- [x] Requirements are testable and unambiguous
- [x] All visual states documented (idle, transitioning ×2, waiting, fallback, error)
- [x] Error scenarios and recovery flows specified
- [x] Responsive behavior defined
- [x] Scope is clearly bounded

## Execution Status
- [x] User description parsed (scope confirmed interactively)
- [x] Key concepts extracted
- [x] Scope determined
- [x] Ambiguities marked and resolved
- [x] User scenarios defined
- [x] Visual states documented
- [x] Requirements generated
- [x] Review checklist passed
