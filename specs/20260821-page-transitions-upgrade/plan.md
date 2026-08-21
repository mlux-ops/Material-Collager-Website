# React Implementation Plan: Page Transitions Upgrade

**Branch**: `feat/page-transitions-upgrade`
**Spec**: [spec.md](spec.md)
**Created**: 2026-08-21
**Status**: Ready for Review
**App Type**: Next.js SSR (App Router via vinext on Cloudflare Workers) | **State**: Zustand (workbench) / local React state
**Input**: Feature specification from `specs/20260821-page-transitions-upgrade/spec.md`

## Technical Context

### React Stack
- **React Version**: 19.2.6 (no `ViewTransition` export; Next 16.2.6 installed, 16.2.11 pinned — first-class `<ViewTransition>` lands in 16.3)
- **Build Tool**: Vite 8 + vinext + @cloudflare/vite-plugin
- **Language**: TypeScript 5.9 strict
- **State Management**: local React state; Zustand only in workbench (untouched here)
- **Routing**: Next App Router; client navigation via `next/link` + `router.push`
- **Styling**: token CSS (`globals.css`, `effects.css`, `motion-tokens.css`) + Tailwind 4
- **Testing**: Node built-in runner (`node --experimental-strip-types --test`) — **not** Jest/RTL; the template's RTL guidance is overridden by foundation convention

### Existing Patterns (the baseline being upgraded)
- `app/components/TransitionLink.tsx`: hand-rolled `document.startViewTransition`, promise resolved on pathname change + double-rAF, capped by `MAX_HOLD_MS = 850` (sized against the Library three.js route's ~790 ms cold paint).
- `app/effects.css`: `mc-plotter-wipe` clip-path keyframes on `::view-transition-new(root)`, `mc-hold` on old, 1px `drop-shadow` leading edge, reduced-motion disable.
- `app/components/SiteNavigation.tsx` + `useNavPillSlide.ts`: nav block with sliding ink pill.

### Architectural decision (Architect persona)

**Stay same-document.** This is an SPA-navigating App Router app; navigations are `router.push`, not document loads. Two consequences the research brief glosses over and this plan must not:

1. **Speculation Rules do not apply.** They prerender *document* navigations. The equivalent "background preparation" here is (a) Next's built-in `next/link` prefetch of the RSC payload (already on in production) and (b) **warming the heavy client chunks** — the three.js/R3F bundle behind the Library — via dynamic-import warm-up on hover/pointer-down intent. This satisfies FR-005 in SPA terms.
2. **`rel="expect"` does not apply** (cross-document only). The spec's "declared readiness condition" (FR-006) is implemented as an explicit **route-ready signal**: destination pages report readiness (mounted + painted; the R3F routes report on first-frame render), and the transition's update promise awaits that signal instead of a pathname-change heuristic. `MAX_HOLD_MS` survives only as the FR-007 bounded fallback, renamed and re-measured.

Migrating to cross-document transitions (`@view-transition`, Speculation Rules, `rel="expect"`) would mean abandoning client routing — rejected: unjustifiable blast radius for this feature, and it would regress the app-like surfaces. Re-evaluate only if the app ever moves to MPA navigation.

### New Dependencies
**None.** Everything used is platform (View Transitions API, transition types) or already installed. Bundle impact: ~2–3 KB of new first-party code (registry + direction logic + logging).

## Foundation Check

| Principle | Status | Notes |
|-----------|--------|-------|
| P1 Reference fidelity | Compliant | Visual language unchanged (wipe, 1px rule, tokens); direction/shared-element are additive; QA states preserved |
| P2 Preserve reference data | Compliant | No touch on upload/generation paths; FR-011 guards prefetch side effects |
| P3 Functional workspace | Compliant | No workbench/generator behavior changes; nav-only surface area |
| P4 Evidence-based rendering | Compliant | Same-document decision documented above with rationale; no new deps |
| P5 Motion designed/accessible/cheap | Compliant | Tokens reused; reduced-motion disables everything; chunk warming removes the mobile cost |
| P6 Verified completion | Compliant | Phase 3 gates on AGENTS.md viewport/QA matrix + completion report; no deploy without approval |

No violations; Complexity Tracking not needed.

## Component & State Architecture

### Component Tree (feature-relevant)
```
app/layout.tsx
└── SiteNavigation (view-transition-name: site-nav → exempt from root wipe)
    ├── TransitionLink ×3 (direction-aware; readiness-aware)
    └── nav pill (existing slide, now the visible continuity during transitions)
route pages (/, /generator, /workbench)
└── signal route-ready on mount+paint (R3F routes: on first rendered frame)
```

### State Design
- **Local State**: `TransitionLink` keeps its pending/settle refs; gains direction computation.
- **Shared State**: new tiny module `app/lib/route-ready.ts` — a registry: `markRouteReady(path)` / `awaitRouteReady(path, budgetMs)`. Module-scope pub/sub, no store; deliberately not Zustand (P4: no parallel stores for trivial state).
- **Server State**: none touched.
- **URL State**: unchanged; direction derives from nav order [`/`, `/generator`, `/workbench`] + Navigation API/`popstate` for back/forward.

### Data Flow
1. Hover/pointer-down on nav link → warm destination chunk (idempotent dynamic import) — FR-005.
2. Click → compute direction (target index vs current index; history traversal ⇒ reversed) → `startViewTransition` with `types: ['nav-forward'|'nav-back']` where supported; always also set `<html data-nav-direction>` as the styling fallback — FR-002 + degradation constraint.
3. Update promise awaits `awaitRouteReady(href, BUDGET)`; destination page marks ready; fallback timer (FR-007) settles if the signal never comes — never a blank mid-wipe (FR-008).
4. Dev-only logging wraps `transition.finished`/skips with reasons — FR-009. Latest-click-wins: a new navigation skips the in-flight transition (FR-010).

### CSS deltas (`effects.css`)
- `.site-nav { view-transition-name: site-nav; }` + a `::view-transition-group(site-nav)` rule so the nav never re-draws with the page (FR-003).
- Direction variants of `mc-plotter-wipe` selected by `html:active-view-transition-type(nav-back)` **and** `html[data-nav-direction="back"]` (belt-and-braces until types are universal).
- Reduced-motion block extends to the new pseudo-element rules.

## Implementation Phases

### Phase 0: Research & Measurement
**Deliverable**: `research.md` in this spec folder
- Measure real cold/warm paint times per route (replaces the guessed 850 ms; sets `READY_BUDGET_MS`).
- Verify `startViewTransition({ update, types })` object signature + `:active-view-transition-type()` in the actual target browsers; record the degradation matrix.
- Confirm chunk-warming actually moves the Library's first-paint (hover→click delta) — if it doesn't, FR-005 needs a different lever and the plan gets amended, not fudged.
- Decide `pagereveal` vs same-document instrumentation shape (same-document: wrap the `ViewTransition` object directly).

### Phase 1: Design
**Deliverables**: readiness contract + direction model, reviewed
- `route-ready.ts` API surface and the per-route ready definitions (DOM routes: mount + double-rAF; R3F routes: first `onRender`/`useFrame` tick).
- Direction table + history-traversal handling (Navigation API where present, `popstate` fallback).
- Nav exemption design: verify `view-transition-name: site-nav` composes with the root wipe (flat-tree clipping caveat from the research applies — nav is fixed chrome, so it should sit cleanly; prove it in a spike).
- Accessibility pass: confirm focus and SR announcement timing are unchanged by the readiness wait.

### Phase 2: Implementation (TDD)
**Deliverables**: code + tests, all suites green
- Tests first (`tests/transitions-*.test.mjs`, node runner): direction mapping (incl. traversal), readiness registry (signal, budget expiry, latest-click-wins), reduced-motion/no-support fallthrough logic (pure-function level; DOM-API paths behind small seams so they're testable without a browser).
- Implement `route-ready.ts`, extend `TransitionLink`, per-route ready signals, chunk warming, CSS deltas, dev logging.
- Remove `MAX_HOLD_MS` as primary; keep measured `READY_BUDGET_MS` fallback.

### Phase 3: Integration & Polish
**Deliverables**: verified feature + completion report
- Browser QA per `AGENTS.md`: all four viewports × transition directions; frame-rate check on 390×844; DevTools Animations panel inspection at 10% speed.
- Verify FR-011: warmed-but-unvisited routes fire no analytics/effects/credits (chunk import is side-effect-free by inspection + a test on module top-levels).
- Reduced-motion and unsupported-browser passes.
- `docs/visual-qa.md` entries for any discrepancies; completion report; **no deploy without approval** (P6).

## Testing Strategy

### Component/Unit Tests (node runner — repo convention)
- Direction: `(from, to, traversal) → forward|back|none` exhaustive over the 3-route matrix.
- Readiness registry: resolve-on-signal, resolve-on-budget, signal-after-budget is a no-op, re-entrant navigation cancels prior wait.
- Link guards: modified clicks, same-route clicks, reduced-motion, missing API → plain navigation path chosen.

### Integration
- Manual + scripted browser pass (Phase 3) — the repo has no browser test harness; per AGENTS.md, Browser inspection with recorded evidence is the integration gate.

### Visual
- Frozen QA states unaffected (`?qa=1&progress=…` before/after screenshots).
- Wipe direction screenshots at mid-transition (Animations panel, 10% speed) for the fidelity ledger.

## Performance Considerations
- **Bundle Impact**: ~2–3 KB first-party; zero new deps.
- **Render**: no new React re-renders on transition; registry is outside React.
- **Code Splitting**: unchanged; warming *uses* the existing split points.
- **Targets** (from spec): ≤100 ms click→wipe with warm chunks; budget = measured worst paint + margin; no LCP regression on the current page (warming is interaction-triggered, never eager on load).

## Risks & Mitigations
- **Transition types not supported in a target browser** → dual selectors (`data-nav-direction` attribute) keep direction working everywhere the API itself exists; symmetric wipe remains the floor (spec constraint).
- **Nav exemption interacts badly with the root clip-path wipe** (flat-tree clipping) → Phase 1 spike before committing; fallback is nav participating in the wipe as today (drop FR-003 to a follow-up rather than shipping a glitch — Principle 1 outranks the enhancement).
- **Chunk warming doesn't close the paint gap** → Phase 0 measurement gates the approach; alternative lever is pre-mounting the R3F canvas offscreen, which is a bigger change and would go back through `/buddy:spec` amendment.
- **Next 16.3 lands mid-work** → isolation: all trigger logic stays inside `TransitionLink` + `route-ready.ts`, so the future `<ViewTransition>`/`transitionTypes` migration deletes files rather than unpicking scattered code (spec assumption honored).

## Execution Status
- [x] Spec loaded and understood
- [x] Technical context documented
- [x] Foundation check passed
- [x] Component architecture designed
- [x] Phases defined
- [x] Testing strategy planned
