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

## User eyeball round 1 (2026-08-21) — findings and resolutions

First visible-browser pass by the owner. Items 4 (no flashes) and the wipe
shape itself passed. Three changes came out of it:

1. **Wipe too fast (both directions)** → new semantic tokens `--wipe-dur:
   700ms` / `--wipe-ease` in `motion-tokens.css`; all root wipe animations
   now use them (was 400 ms via the generic `--duration-slow`). Verified
   live: computed `--wipe-dur` = 700ms.
2. **0–100% veil interrupts Generator → Library** → the veil is now
   first-arrival-only: a module-scope session flag in `SceneWheelV2` starts
   re-entries revealed. Full page load still shows the counter. Verified:
   `veilShown: false` after SPA re-entry; this also resolves the one header
   continuity break the owner saw (item 5, veil painting the screen white).
3. **Error popups obscuring transitions into Workbench** → not transition
   noise: `node_modules` was stale (`@xyflow/react` missing entirely,
   wrangler/next at older versions than the lockfile), so `WorkbenchApp`'s
   dynamic import crashed on every load — which was ALSO the root cause of
   the earlier "workbench has zero nav anchors" finding. `npm install`
   synced from the intact lockfile (no lockfile changes). Verified:
   /workbench renders with 4 nav anchors, no runtime-error overlay.

Post-round verification: transitions 30/30, workbench 136, collage 19,
scene-lab 16, lint 0 errors; forward/back QA run clean (`ready` →
`finished`, direction attribute lifecycle correct).

## User eyeball round 2 (2026-08-21) — findings and resolutions

Confirmed by the owner: no flashes, no workbench errors, nav continuity,
snappy warm navigation, reduced-motion instant, modified clicks, no
traversal wipe, library/workbench function. New findings, all addressed:

1. **FPS question** — the wipe is compositor-driven and vsync-locked (runs
   at the display's maximum). Perceived stutter was main-thread work on the
   live incoming page, not animation frame-rate; see items 2–3.
2. **Stutter entering the Library as pictures load** — with the veil gone on
   re-entry, GL init + texture upload ran mid-wipe on the live incoming
   side. The scene mount now defers until the transition settles
   (`awaitTransitionSettled()` in route-ready; scene work is ~50ms right
   after the sheet lands). Hover warming now also prefetches + decodes the
   first 8 library images alongside the chunk.
3. **Workbench header momentarily blurry near wipe end** — the bar's old/new
   snapshots differ in size between pages (right-side content), and scaling
   them to the morphing group box resamples the text. Snapshots are now
   pinned at natural size (`object-fit: none`, anchored left/top).
4. **Ink pill jumps instead of sliding on backward navigation** — each page
   mounts its own nav with the pill already at the destination, so no live
   slide ever crossed a navigation. The pill now carries its own
   `view-transition-name: nav-pill`, so the browser morphs its box between
   the old and new positions — a real slide in both directions (250ms,
   pill excluded from the bar's snapshots; crossfade disabled in favor of
   the geometry morph).
5. **First-load 0–100 count too fast to be satisfying** — the counter is now
   rate-capped (~1.1%/frame): a warm load ramps over ~1.6s with the same
   eased tail; slow loads still track real progress.
6. **Header not clickable mid-wipe** — the snapshot overlay swallowed input.
   `::view-transition { pointer-events: none }` lets clicks through to the
   live incoming page; a mid-wipe nav click now triggers the next
   transition, with latest-navigation-wins already covering the semantics.
7. Clarified, no change: `?qa=1&progress=…` intentionally freezes the scene
   (deterministic visual-QA states per AGENTS.md) — non-scrolling there is
   the feature. Dev console transition logs are optional diagnostics (F12).

Post-round verification (headless): 34/34 transition tests; wipe 700ms;
`nav-pill` group present; veil skipped on re-entry; canvas mounts after
transition settle; ready→finished both directions; lint 0 errors.

## User eyeball round 3 (2026-08-21) — texture-gap placeholder + D1 persistence

Owner confirmed all round-2 fixes; remaining item was the white flash while
the Library's textures load. Shipped their design: tiny stored thumbnails
of the cards hold the canvas area as a 1-bit Bayer-dithered row
(DitherReveal, the generator's effect); the scene's first painted frame —
signalled from inside the texture Suspense boundary, so empty clear-frames
can't fire it — resolves the dither and fades the row.

Storage graduated from localStorage to **D1** (`library_thumbs`, lazy
schema per the generation-jobs pattern) behind `GET/PUT
/api/library/thumbs`: thumbnails are captured client-side after a
successful paint (~48px JPEG data URIs), validated on both write and read
(data:-URI-only regex, per-entry 12KB cap, 16 max, unknown fields
stripped), and shared across devices; localStorage remains as an instant
local cache hydrated from the server.

Verified headless: capture stores 16 to D1 on first visit; re-entry shows
a 7-card dithered row and fades after paint; a fresh profile (empty
localStorage) hydrates 16 from the server; first-ever loads stay
veil-covered with the row locked out (no late placeholder flash — a
regression where the flash-guard skipped the capture pass was caught and
fixed in the same round). 40/40 transition tests, lint 0 errors.

## User eyeball round 4 (2026-08-21) — placeholders moved into the cascade

Owner: the dithered placeholders must not be a detached centered strip —
they should stand where the cards are and dissolve into them; and the
dither must be generator-fine, not chunky.

- **In-place projection**: new `project-card-rects.ts` runs the scene's own
  curve model + camera (`getSceneWheelPose`, `SCENE_WHEEL_CAMERA`, plain
  three math, no GL) to project each card's quad to screen space; the
  placeholder layer positions each DitherReveal with a CSS matrix on those
  quads (tilt approximated linearly), z-stacked by rail depth, opacity from
  the pose. Recomputed on resize; wrap-around card handled. Covered by
  tests/transitions-card-projection.test.mjs (5 tests).
- **Dither scale**: capture resolution raised 48px → 224px wide and cell 3
  (the generator is cell 4 on full-res images) → ~3px on-screen cells.
  Per-entry cap raised to 28k chars; store schema v2 with per-thumb aspect
  ratio (`ar`, clamped to SceneCard's 0.72–1.65), D1 column added via the
  PRAGMA-checked additive-migration pattern; legacy/absent aspect defaults
  to 4/3. Stale coarse sets were wiped from dev D1.

Verified headless: re-entry renders 12 placed dithered cards in the exact
cascade (screenshot); fade-through to the painted scene unchanged. 46/46
transition tests, lint 0 errors.

## User eyeball round 5 (2026-08-21) — exact registration + pill dip revert

- **Placeholder outlines didn't line up with the cards**: the parallelogram
  approximation ignored perspective foreshortening. Placement is now a full
  projective map — Heckbert square-to-quad homography as CSS matrix3d onto
  the four projected corners. A unit test asserts the matrix lands all four
  corners within 0.01px, and a half-opacity ghost capture over the painted
  scene shows exact registration on all 12 visible cards.
- **Ink pill dipped vertically during route changes**: the snapshot-morph
  interpolated both axes between per-page bar positions. Reverted in favor
  of a live slide — the incoming bar seats its pill on the previous route's
  item (remembered at module scope) and slides horizontally within its own
  bar; the pill's view-transition-name is gone (verified computed "none").
  Reduced motion seats directly with no slide.

47/47 transition tests, lint 0 errors.

## User eyeball round 6 (2026-08-21) — colorized, finer dither

- Cell size halved again (cell 3 → 1.5 on 224px captures; ~1.5px on-screen).
- New `colorize` mode on DitherReveal (opt-in; the generator's uses are
  unchanged): dithered ink cells take the image's own sampled color at that
  cell instead of flat ink, so the placeholder reads as the picture
  screened onto paper and the resolve-to-photo handoff is nearly
  imperceptible. Verified with a re-entry capture: all 12 placed cards
  render the colorized fine dither in place.

47/47 transition tests, lint 0 errors.

## User eyeball round 7 (2026-08-21) — the uniform upward jump, root-caused

All cards shifted up a few px at the reveal. Pixel-scanned same-viewport
captures (placeholder layer vs painted scene, top-edge y per card band):
placeholders sat a near-uniform 16–20px LOW. That magnitude matches one
mechanism exactly: R3F orients its default camera toward the origin, and
from y=0.15 that is a 0.69° downward pitch ≈ 16px across a 38° fov at
900px. The projection camera now applies the same lookAt(0,0,0).
Re-measured deltas: 19/40/18/16/20 → 5/25/3/1/4 px (the 25 is a luminance-
threshold artifact on a sparse tan band; the ghost capture shows every
card fused). The measurement harness (pixel top-edge scan) is the new
regression tool for placeholder alignment.

## Environment repairs made during this work (dev-only)

Recorded in specs/20260821-page-transitions-upgrade/research.md: Cloudflare
plugin remote-bindings failure under Access without a service token
(`remoteBindings: false` temporarily in `vite.config.ts` — REVERT before
committing if Access tokens are provisioned), missing `.dev.vars` (created,
no secrets), and a stale Vite dep-graph crash whose fix is a
registry-preserving restart (kill server → restart WITHOUT deleting
`node_modules/.vite`; deleting it re-triggers the mixed-hash crash on next
first load).
