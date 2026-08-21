# Transitions QA — Page Transitions Upgrade

Date: 2026-08-21
Feature: specs/20260821-page-transitions-upgrade (spec / plan / tasks / research)
Status: **Verified locally (headless). Physical-device pass and deploy approval remain open.**

## Method

Headless Chrome (`--headless=new`) driven over raw CDP against the local dev
server (`npm run dev`, Miniflare). Headless composites offscreen, so paint,
rAF, and the View Transitions API behave as in a visible browser. Screenshot
evidence lives in the session scratchpad (`qa-forward-mid.png`,
`qa-back-mid.png`, `qa-back-realtime.png`, `qa-state-040.png`). A visible
in-app-pane or physical-device pass per the AGENTS.md viewport matrix has
NOT been run and stays a release gate.

## Results

| Check | Viewport | Result |
|---|---|---|
| Forward wipe (`/` → `/generator`), direction attribute set, wipe left-origin, nav continuous | 1440×900 | PASS (mid-wipe screenshot) |
| Back wipe (`/generator` → `/`), wipe right-origin with `-1px` leading rule | 1440×900 | PASS (mid-wipe + real-timing screenshots) |
| Readiness signal (`ready` logged, no `timeout`) both directions | 1440×900 | PASS |
| `data-nav-direction` cleared after `finished` | 1440×900 | PASS |
| Direction + readiness + logs | 390×844 | PASS (behavioral run) |
| Reduced motion: no transition, no direction attribute, correct log reason, navigation intact | 1440×900 | PASS |
| Frozen QA state `/?qa=1&progress=0.40` renders canvas + 4 anchors, query preserved | 1440×900 | PASS (screenshot) |
| Test suites: transitions 30/30; workbench 136; collage 19; scene-lab 16 | — | PASS, 0 regressions |

## Findings during QA (fixed in the same pass)

1. **rAF deadlock inside the update callback.** `requestAnimationFrame` never
   fires while a ViewTransition update callback is pending (verified
   empirically: microtask 0 ms, task 0 ms, rAF never in >1500 ms). All ready
   signals and the settle step were moved to effect/task level. Notably, the
   pre-upgrade implementation awaited a double-rAF inside its callback too —
   meaning the shipped wipe always rode its 850 ms cap.
2. **Library signal placement.** A signal inside the R3F tree never fires
   during a transition (R3F mounts children via its rAF loop). The signal
   lives at the DOM level in `SceneWheelV2` instead; its loading veil is
   designed content, so commit-level readiness satisfies FR-008.

## Known deviations (accepted, documented)

- **Browser back/forward navigates without a wipe.** Traversal is handled
  inside the router; wrapping it externally would race vinext's own popstate
  handling. Revisit on Next 16.3, whose `<ViewTransition>` covers traversal
  natively. (Spec FR-002 partially met: direction is correct for all click
  navigations.)
- **Nav crossfade dip at stretched durations.** With the root wipe slowed to
  2.5 s for QA, the `site-nav` group finishes early and the bar reads as
  faded mid-transition. At the real 200 ms group duration the bar is
  continuous (verified at real timing). QA scripts must slow ALL groups if
  they slow any.
- **Cross-browser rows are from published data.** Safari/Firefox behavior
  (types support tiers) is engine-reported, not locally tested; the
  attribute-selector fallback covers the gap by construction.

## Environment repairs made during this work (dev-only)

Recorded in specs/20260821-page-transitions-upgrade/research.md: Cloudflare
plugin remote-bindings failure under Access without a service token
(`remoteBindings: false` temporarily in `vite.config.ts` — REVERT before
committing if Access tokens are provisioned), missing `.dev.vars` (created,
no secrets), and a stale Vite dep-graph crash whose fix is a
registry-preserving restart (kill server → restart WITHOUT deleting
`node_modules/.vite`; deleting it re-triggers the mixed-hash crash on next
first load).
