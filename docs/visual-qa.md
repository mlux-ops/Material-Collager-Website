# Visual QA - Workbench Node Editor Phase 2 (S32)

Date: 2026-07-25
Status: **PENDING - NOT YET EXECUTED**

## Explicit status

No browser session has been opened for this QA pass. Every row in the
checklist and viewport matrix below is unverified and marked PENDING. This
implementation pass (plan-refined.json S1-S31, plus seven post-approval fix
rounds) completed the code, the framework-free unit-test gate (`npm run
test:workbench`, 127/127 passing), `npm run lint` (0 errors), `npx tsc
--noEmit` (0 workbench-scoped errors), and `npm run build` (production build
succeeds). It did **not** include a real
Browser tool session against a running `vinext dev`/`vinext start` instance,
so none of S32's required screenshots, interaction checks, or the seeded-v1-
IndexedDB migration check have been captured. Do not treat this section as
evidence that visual/browser QA occurred - it is a scaffold recording exactly
what remains to be checked, per plan.

## Required viewport matrix (all PENDING)

| Viewport | Purpose | Status |
| --- | --- | --- |
| 1440 x 900 | Primary desktop workbench canvas | PENDING |
| 1280 x 800 | Secondary desktop size | PENDING |
| 1024 x 768 | Smallest supported desktop size | PENDING |
| 390 x 844 | Touch/stylus Masked Edit region modal ONLY (workbench is desktop-first otherwise) | PENDING |

## Required states/screenshots (all PENDING)

| # | State | Plan step | Status |
| --- | --- | --- | --- |
| 1 | Empty-canvas templates gallery (3 domain presets + blank) | S25 | PENDING |
| 2 | A wired multi-node graph with source-kind edge colors, verified to survive a save + reload (colors re-derived from source-handle metadata, not persisted) | S1 | PENDING |
| 3 | A paused Reference Finder awaiting selection, candidate cards visible (thumbnail/source/confidence/official badge) | S11 | PENDING |
| 4 | A Variations candidate grid with an active-candidate selection (not index 0) propagating downstream | S14 | PENDING |
| 5 | The Masked Edit region-selection modal, exercised via touch/stylus at 390x844 | S15 | PENDING |
| 6 | A report/QA-correction chain: Accuracy Reviewer -> QA Correction with a corrected image | S17/S18 | PENDING |
| 7 | Pin badge, "Cached - no charge" badge, high-cost confirm dialog, and the Draft mode toggle, all visible in one or more screenshots | S21/S27/S28 | PENDING |
| 8 | Inspector panel (selected node), Spotlight add-menu (search + drag-wire-to-empty-canvas filtered by compatible kind), and the Graph Manager UI (new/rename/delete/switch) | S29 | PENDING |

## Required interaction checks (all PENDING)

- [ ] Connect/validate/reject: Photo(image) and References(references) both validate into a reference input; text->image is rejected.
- [ ] Run workflow, then Cancel mid-run; confirm the paid upstream call is actually aborted (network tab), not just the UI state.
- [ ] Reference Finder pause/resume: run halts at Finder with downstream nodes idle (not failed); picking a candidate resumes downstream execution and reuses cached ancestors (no re-bill visible in Network tab).
- [ ] Retry-from-failed-node after a mid-graph failure re-runs only from the failed node onward.
- [ ] A node missing a required input shows a disabled Run button with a visible reason.
- [ ] aria-live region announces run start/finish/failure (verify via accessibility tree/screen reader or the DOM `aria-live` node's text changes).
- [ ] Export a graph to JSON, then import it back; confirm images and structure round-trip.
- [ ] Attempt a cyclic connection (e.g. wiring QA Correction's output back to the Accuracy Reviewer it descends from) and confirm it is rejected.

## Required IndexedDB migration check (PENDING - cannot be done in a Node unit test, W4)

- [ ] Seed a populated v1 database (the pre-named-graph `current` singleton, with at least one Photo/References upload and one paid-node output) in a real browser profile.
- [ ] Load the workbench and confirm the `onupgradeneeded` v1->v2 transaction migrates it into a named graph with no data loss and no orphaned legacy `blob:` keys (inspect via DevTools > Application > IndexedDB).
- [ ] Confirm a node with multiple blobs (uploads + candidates + thumbnails + pinned/active outputs) round-trips without key collisions, and that multiple named graphs coexist without blob-key collisions.

## No-deploy confirmation

No `wrangler deploy` or any production push has been run as part of this
implementation pass. All changes remain uncommitted in the working tree per
the pipeline's stage-6 instructions.

## Next action

A future pass with an interactive Browser tool session against
`vinext dev`/`vinext start` (local URL, e.g. `http://localhost:3000/workbench`
or the project's configured dev port) must complete every PENDING row above,
replacing "PENDING" with the actual observed result (Passed/Failed/Notes) and
attaching real captured evidence, before S32 can be considered satisfied.

---

# Visual QA - Scene Lab V2 production promotion

Date: 2026-07-18

## Scope

Promote the approved Scene Lab V2 linear glass rail from GitHub commit `6f62bf58198eb6b005ab7db7dfd30d5b59f9f5db` to the production Library homepage. Preserve the original Scene Lab at `/scene-lab`, the V2 review route at `/scene-lab-v2`, the Generator, API routes, and Library data integration.

## Environment

- Local URL: `http://localhost:4173/`
- V2 review URL: `http://localhost:4173/scene-lab-v2`
- Browser: Codex in-app Browser
- Desktop viewport: `1280 x 720`

## Checks

| Check | Result |
| --- | --- |
| Production homepage renderer | `scene-wheel-v2-linear-glass` |
| Library source | `/api/library`, with completed-collage fixtures as local fallback |
| Native scroll progression | Passed; progress changed from `0.00000` to `0.76444` |
| Glass hover extraction | Passed; hovered pane separated and displayed its title |
| Pane viewer | Passed; click opened the full Warm oak fixture collage viewer |
| Horizontal overflow | None observed |
| Browser console | No errors or warnings observed |
| Automated checks | Scene Lab tests, lint, and production build passed |

## Evidence captured

- Settled desktop rail at initial progress.
- Scrolled rail with a visibly different pane composition.
- Hover title and glass-pane extraction.
- Full collage viewer after pane selection.

## Discrepancy fixed

The previous deployment promoted a separate world-space QA prototype. The tested V2 implementation is a distinct linear-glass rail under `app/components/scene-wheel-v2`; the homepage now loads that exact renderer.

## Remaining known deviations

- Mobile acceptance is intentionally out of scope at the user's direction.
- The original `/scene-lab` remains available as V1 and is not the production homepage.

## Navigation restoration

Date: 2026-07-18

- Restored the approved 580 px desktop navigation cluster: `MATERIAL COLLAGER / LIBRARY / GENERATOR`.
- Confirmed all three controls are visible above the Scene Lab V2 canvas at `1280 x 720`.
- Confirmed `GENERATOR` navigates from `/` to `/generator` and the working Board setup screen renders.
- Confirmed no framework overlay and no Browser console errors or warnings.
- Mobile navigation remains outside this acceptance scope at the user's direction.

## Wheel interaction repair

Date: 2026-07-18

- Reproduced the deployed regression: downward mouse-wheel input left both `window.scrollY` and scene progress unchanged.
- Changed Scene Lab V2 to consume wheel deltas directly and advance the glass rail in either direction, while preserving native-scroll updates for keyboard and scrollbar input.
- Browser acceptance requires forward wheel input to increase progress and reverse wheel input to return toward the starting composition without console errors.

## iPhone 15 Pro Max responsive pass

Date: 2026-07-18

- Target viewport: `430 x 932` CSS pixels, portrait orientation.
- Mobile navigation must fit the usable viewport with three 58 px touch targets and the approved `MATERIAL COLL.` abbreviation.
- Mobile WebGL framing uses the same rail geometry with a portrait-specific camera fit so the diagonal pane field fills the viewport instead of collapsing into a clipped sliver.
- The page opts into `viewport-fit=cover`; navigation, captions, and the viewer account for iPhone safe-area insets.
- The rail preserves vertical touch panning, and the full-screen viewer exposes a 44 px minimum Close target.
- The Generator fits the phone viewport without inner horizontal overflow, respects top/bottom safe areas, and exposes 44 px minimum form and button targets without changing application behavior.
- Desktop camera values remain unchanged.

## iPhone 15 final usability audit

Date: 2026-07-18

- The collage viewer locks background scrolling, moves focus to its Close control, restores focus on dismissal, and keeps the underlying rail inert while the dialog is open.
- Generator disclosure rows, Add item, remove-item, help, save/reset, and primary action controls expose at least 44 px touch targets in portrait and landscape layouts.
- Generator help text opens as a viewport-contained banner below the fixed navigation so field explanations never clip off either edge of the phone.
- Generator text inputs, selects, and textareas render at 16 px on phones to prevent Mobile Safari from zooming the page when a field receives focus.
- Portrait and landscape layouts account for iPhone safe areas; the landscape Library and Generator retain their wider desktop-derived composition without horizontal overflow.
- Local visual QA can freeze the WebGL rail deterministically with `?qa=1&progress=0.00` through `1.00`; production browsing keeps the normal continuous scroll behavior.
- Browser verification passed at `1440 x 900`, `1280 x 800`, `1024 x 768`, `390 x 844`, and the target `430 x 932` viewport. At each size, progress `0.00`, `0.20`, `0.40`, `0.60`, `0.80`, and `1.00` rendered the V2 canvas with an exact matching QA value, fitted navigation, and no horizontal overflow.
