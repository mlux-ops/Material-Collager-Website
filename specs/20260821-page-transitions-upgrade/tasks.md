# Task Breakdown: Page Transitions Upgrade

**Plan**: [plan.md](plan.md) · **Spec**: [spec.md](spec.md)
**Created**: 2026-08-21
**Status**: In Progress

## Progress
- [X] T001 — measured headless (Chrome CDP): Library canvas 688–761 ms doc-load / 32–60 ms SPA re-entry; other routes ≤ 47 ms SPA. `READY_BUDGET_MS = 900`. → [research.md](research.md)
- [X] T002 — full support confirmed locally (Chrome 148); degradation matrix recorded
- [X] T003 — **GO**: nav exemption composes with the root wipe, no clipping; crossfade-of-pill-states noted
- [X] T004 — measured; **conclusion revised**: canvas cost is GL/texture init, warming is a minor assist; readiness signal + budget is the mechanism (plan risk #3 exercised)
- [X] T005–T007 — 27 tests written first, confirmed red (missing modules)
- [X] T008 — `app/lib/route-ready.ts` (registry + `READY_BUDGET_MS = 900`, latest-wins, no stickiness)
- [X] T009 — `app/lib/nav-direction.ts` (direction matrix + normalization + transition guards)
- [X] T010 — `TransitionLink` rewritten: readiness wait replaces `MAX_HOLD_MS`; direction via `vt.types` + `data-nav-direction`; guards extracted; dev logging. Traversal (browser back) noted as deferred to Next 16.3's `<ViewTransition>` — documented in the component header.
- [X] T011 — ready signals: `RouteReady` on generator/workbench; `ReadyOnFirstFrame` (R3F `useFrame`) in `SceneWheelCanvas`
- [X] T012 — Library chunk warming on nav intent (`SiteNavigation`, import-only, retry on failure)
- [X] T013 — `effects.css`: `mc-plotter-wipe-back` + dual selectors (types / data attribute), `site-nav` exemption, reduced-motion coverage extended
- [X] T014 — `app/lib/transition-debug.ts` (dev-only, FR-009)
- [X] T015 — `tests/transitions-warm-safety.test.mjs` (no fetches, no timers at import; logger never throws)
- [X] T016 — headless QA: forward/back wipes verified with screenshots (1440×900 + real-timing), behavioral pass at 390×844, reduced-motion pass. Two deadlocks found and fixed (rAF inside update callback; R3F-tree signal). → [docs/transitions-qa.md](../../docs/transitions-qa.md)
- [X] T017 — frozen QA state `?qa=1&progress=0.40` verified intact (canvas + anchors + query)
- [X] T018 — docs updated: component-guide (TransitionLink), troubleshooting (+2 new entries), docs index, transitions-qa.md created
- [X] T019 — completion report delivered in-session; **no deploy** (P6); physical-device pass remains a release gate

**Status: Completed 2026-08-21** (with two documented deviations: browser-back traversal wipe deferred to Next 16.3; cross-browser tiers from published data)
**Phase 3.1 gate: PASSED** · **Red checkpoint: PASSED** · **Green checkpoint: 30/30 transitions + 171 existing tests, 0 regressions** · **QA: PASSED locally**

## Task Format
- `T{NNN}` — sequential task ID
- `[P]` — parallel-safe (different files, no dependency)
- Tests come before implementation (TDD)
- Repo conventions apply: Node built-in test runner (`node --experimental-strip-types --test`), feature code under `app/`, no new dependencies

---

## Phase 3.1 — Setup & Research (plan Phase 0 + design spikes)

| ID | P | Task | File(s) |
|----|---|------|---------|
| T001 | | Measure real cold/warm first-paint per route (`/`, `/generator`, `/workbench`) with performance marks in a dev build; derive `READY_BUDGET_MS` (worst measured paint + margin). Record method + numbers. | `specs/20260821-page-transitions-upgrade/research.md` |
| T002 | | Verify `startViewTransition({ update, types })` object signature and `:active-view-transition-type()` in the actual target browsers; record the degradation matrix (types-supported / API-only / no-API). | `research.md` (same file — sequential) |
| T003 | | **Spike (go/no-go for FR-003)**: apply `view-transition-name: site-nav` to the nav block alongside the root clip-path wipe; confirm no flat-tree clipping glitch. Screenshot evidence; decision recorded. | `research.md` + throwaway branch |
| T004 | | Verify chunk warming works: measure hover→click delta on Library with an idempotent dynamic import of the R3F chunk. If it does not close the gap, STOP — amend plan before proceeding (plan risk #3). | `research.md` |

**Gate**: `research.md` complete; `READY_BUDGET_MS` decided; FR-003 go/no-go made.

---

## Phase 3.2 — Tests (TDD, red phase)

| ID | P | Task | File(s) |
|----|---|------|---------|
| T005 | [P] | Direction-mapping tests: exhaustive `(fromRoute, toRoute, isTraversal) → 'forward' \| 'back' \| 'none'` over the 3-route order incl. browser back/forward reversal. Also add the `test:transitions` npm script. | `tests/transitions-direction.test.mjs`, `package.json` |
| T006 | [P] | Route-ready registry tests: resolves on signal; resolves on budget expiry; late signal after expiry is a no-op; re-entrant navigation cancels the prior wait (latest-click-wins, FR-010). | `tests/transitions-route-ready.test.mjs` |
| T007 | [P] | Link-guard tests (pure seams, no DOM): modified clicks, same-route click, reduced-motion, missing API → each selects the plain-navigation path (FR spec §fallback). | `tests/transitions-link-guards.test.mjs` |

**Checkpoint**: `npm run test:transitions` — all new tests exist and FAIL.

---

## Phase 3.3 — Core Implementation (green phase)

| ID | P | Task | File(s) |
|----|---|------|---------|
| T008 | [P] | Implement the readiness registry: `markRouteReady(path)` / `awaitRouteReady(path, budgetMs)`; module-scope pub/sub, cancellation on re-entry. No Zustand (plan/P4). | `app/lib/route-ready.ts` |
| T009 | [P] | Implement direction computation as a pure function over the nav order + traversal flag (Navigation API where present, `popstate` fallback). | `app/lib/nav-direction.ts` |
| T010 | | Extend `TransitionLink`: compute direction; pass `types` where supported **and** set `html[data-nav-direction]`; await `awaitRouteReady(href, READY_BUDGET_MS)` in the update promise (replaces `MAX_HOLD_MS` as primary — FR-006/007); latest-click-wins; keep all existing guards. Depends on T008 + T009. | `app/components/TransitionLink.tsx` |
| T011 | [P] | Add per-route ready signals: DOM routes mark ready on mount + double-rAF; Library marks ready on the R3F canvas's first rendered frame. | `app/page.tsx`, `app/generator/page.tsx`, `app/workbench/page.tsx`, `app/components/scene-wheel-v2/SceneWheelCanvas.tsx` |
| T012 | | Chunk warming on nav intent: `pointerenter`/`pointerdown` on nav links triggers an idempotent dynamic import of the destination's heavy chunk (FR-005). After T010 (same component area). | `app/components/SiteNavigation.tsx` (or `TransitionLink.tsx` per T010's final shape) |

**Checkpoint**: `npm run test:transitions` green; `npm run lint` clean; existing suites (`test:workbench`, `test:collage`, `test:scene-lab`) still green.

---

## Phase 3.4 — Integration (CSS + instrumentation + safety)

| ID | P | Task | File(s) |
|----|---|------|---------|
| T013 | | CSS deltas: directional `mc-plotter-wipe` variants selected by `html:active-view-transition-type(nav-back)` **and** `html[data-nav-direction="back"]`; `view-transition-name: site-nav` + group rule (only if T003 = go); extend the reduced-motion block to every new pseudo-element rule (FR-002/003/004 + a11y). | `app/effects.css`, `app/components/SiteNavigation.tsx` (class hook) |
| T014 | [P] | Dev-only instrumentation: wrap the `ViewTransition` object; log skipped/timed-out/failed transitions with reason (no-support, reduced-motion, timeout, nav error) — FR-009. Stripped or inert in production. | `app/lib/transition-debug.ts`, wiring in `TransitionLink.tsx` |
| T015 | [P] | FR-011 warm-safety: test that warmed modules execute no user-visible side effects at import time (no fetches, no analytics, no store writes on module top level). | `tests/transitions-warm-safety.test.mjs` |

---

## Phase 3.5 — Polish & Verification (plan Phase 3, AGENTS.md gates)

| ID | P | Task | File(s) |
|----|---|------|---------|
| T016 | | Browser QA per `AGENTS.md`: all four viewports (1440×900 → 390×844) × forward/back × reduced-motion on/off; frame-rate check on 390×844; DevTools Animations panel captures at 10% speed for the ledger. Log discrepancies. | `docs/visual-qa.md` |
| T017 | [P] | QA-state regression: `?qa=1&progress=…` frozen states screenshot-compared before/after; confirm warming/readiness changed nothing (spec edge case). | `docs/visual-qa.md` |
| T018 | [P] | Documentation: update the `TransitionLink` section (readiness model replaces the 850 ms note), add a troubleshooting entry for the readiness signal, ledger entry for the direction/shared-element change. | `docs/component-guide.md`, `docs/troubleshooting.md`, `docs/fidelity-ledger.md` |
| T019 | | Completion report per `AGENTS.md` (files, commands, local URL, screenshots, discrepancies, deviations, tests). **No deploy** — foundation P6. | report in PR/summary |

---

## Dependencies Graph

```
T001 → T002 → T003 → T004            (research gate, single file)
T004 → T005,T006,T007 [P]            (gate → red tests)
T005,T006,T007 → T008,T009 [P]       (red → core libs)
T008,T009 → T010 → T012              (libs → link → warming)
T008 → T011 [P with T010]            (registry → route signals)
T010,T011,T012 → T013                (core → CSS)
T013 → T014,T015 [P]                 (CSS → instrumentation/safety)
T014,T015 → T016 → T017,T018 [P] → T019
```

## Parallel Execution Examples

- After T004: write T005 + T006 + T007 simultaneously (three new test files).
- After the red checkpoint: T008 + T009 together (two new lib files), then T010 while T011 proceeds in the route files.
- After T013: T014 + T015 together.
- After T016: T017 + T018 together.

## Validation Checklist

- [x] Every spec FR maps to ≥1 task (FR-001/004→T013; FR-002→T005/T009/T013; FR-003→T003/T013; FR-005→T004/T012; FR-006→T006/T008/T010; FR-007→T001/T010; FR-008→T010/T011/T016; FR-009→T014; FR-010→T006/T010; FR-011→T015)
- [x] Tests precede implementation (T005–T007 before T008–T012; T015 is a new safety test with its own subject)
- [x] Parallel tasks touch disjoint files
- [x] Accessibility covered (reduced-motion in T013, QA pass in T016)
- [x] Loading/error behavior covered (readiness wait + fallback: T006/T010; error transparency verified in T016)
- [x] Each task names exact file paths
- [x] Numbering sequential T001–T019
- [x] Error-boundary task intentionally omitted: the feature adds no new render surfaces; navigation errors must pass through untouched (spec §Error) — verified in T016 rather than wrapped
