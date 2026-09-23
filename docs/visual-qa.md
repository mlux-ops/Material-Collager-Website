# Visual QA - Sunburst migration Task 2 Autoboard Review

Date: 2026-09-08
Status: **PASSED - LOCAL ONLY**

## Environment

- Local URL: `http://127.0.0.1:4199/`
- Browser: Playwright CLI (`autoboard-review` session)
- Viewports: 1440 x 900, 1280 x 800, 1024 x 768, 390 x 844
- Scope: Local Review board controls and persisted render-option summary; the
  render button was not activated and no paid/live image request was made.

## Checks

| Check | Result |
| --- | --- |
| Quality control | Passed; Stage default, Low, Medium, High, Extra high, Max, and Auto are visible |
| Background control | Passed; Solid white is selected by default and Transparent is available |
| Cost treatment | Passed; controls say cost after completion and history entries say cost unavailable when usage is absent |
| Review layout at required desktop/mobile viewports | Passed; no horizontal overflow or clipped option controls observed |
| Browser console during load | Passed; 0 errors, 0 warnings |

## Evidence captured

- [1440 x 900](../output/playwright/autoboard-review-1440x900.png)
- [1280 x 800](../output/playwright/autoboard-review-1280x800.png)
- [1024 x 768](../output/playwright/autoboard-review-1024x768.png)
- [390 x 844](../output/playwright/autoboard-review-390x844.png)

## Discrepancies fixed

- Added saved quality/background controls and a summary that includes the Final
  high minimum while preserving old-plan defaults.
- Added per-render metadata and status-aware cost text so pending, completed,
  and failed states do not imply a pre-render estimate.
- Completed status now reads usage cost from the stage that just finished;
  an earlier draft cannot mask a Confirm or Final result.
- Added an empty favicon response so the local browser console remains clean.

## Remaining known deviations

This pass did not click a render control or contact the deployed Worker. Queue,
request-payload, persistence, stale-candidate, duplicate-prevention, and actual
usage-cost behavior are covered by mocked regression tests.

## No-deploy confirmation

No deploy, publish, production-state write, or paid/live image request occurred.

---

# Visual QA - Sunburst migration Task 1

Date: 2026-09-08
Status: **PASSED - LOCAL ONLY**

## Environment

- Local URL: `http://127.0.0.1:3000/generator`
- Browser: Playwright CLI (`sunburst` session)
- Viewports: 1440 x 900, 1280 x 800, 1024 x 768, 390 x 844
- Scope: Generator setup controls only; no generation was submitted and no paid
  image call was made.

## Checks

| Check | Result |
| --- | --- |
| Solid white background is the default | Passed; visible in all four viewports |
| Background control is visible and labeled | Passed; `Solid white` shown in all four viewports, then `Transparent` selected and verified in Browser |
| Quality control retains high default | Passed; `High` shown in all four viewports |
| Generator layout at required desktop/mobile viewports | Passed; no horizontal overflow or clipped background control observed |
| Browser console during load | No migration-related errors observed |

## Evidence captured

- [1440 x 900](../output/playwright/generator-task1-1440x900.png)
- [1280 x 800](../output/playwright/generator-task1-1280x800.png)
- [1024 x 768](../output/playwright/generator-task1-1024x768.png)
- [390 x 844](../output/playwright/generator-task1-390x844.png)
- [1440 x 900 with Transparent selected](../output/playwright/generator-task1-1440x900-transparent.png)

## Discrepancies fixed

- Removed the legacy fixed-dollar labels from the Final Render Now and Economy
  Final actions; both now state that usage-based cost is shown after completion.
- History download labels now reflect the persisted output format instead of
  always claiming PNG.
- The new Background control fits the existing setup rail at each required
  viewport and preserves the established default visual state.

## Remaining known deviations

This pass did not submit a live generation request, upload references, or
exercise paid rendering in the browser. Those behaviors are covered by mocked
regression tests in Task 1; production/deployment verification remains outside
this implementation pass.

## No-deploy confirmation

No deploy, publish, or production-state write occurred during this QA pass.

---

# Visual QA - Workbench dialog focus containment (WP-3B, R14)

Date: 2026-09-22
Status: **KNOWN GAPS RECORDED - BROWSER PASS PENDING**

## Scope

`useModalFocus` (`app/components/workbench/useModalFocus.ts`) now contains
Tab/Shift+Tab inside a Workbench dialog, moves focus in on open, supports
Escape, and restores focus on close. Applied to the template chooser
(`TemplateGallery`), `ExportDialog`, `GraphManager`'s dialog, and `Spotlight`'s
own dismissible-modal render (the compact "Add node" overlay). This pass was
implemented and verified via lint + the typecheck gate only; the controller
runs the browser checks (see below) once, after integration, since several
worktrees cannot share the one dev server.

## Known gaps (deliberately not wired to useModalFocus)

- **Wire-drop-to-empty-canvas prompt** (`WorkbenchApp.tsx`, the
  `role="dialog"` rendered inline inside `CanvasInner`'s `wirePrompt && (...)`
  block, `aria-label="Connect to a node"`). It renders inline in a
  conditionally-executed branch of an existing component's render, not its
  own function component, so a `useModalFocus` call there would be
  conditional -- hooks cannot be called conditionally. Extracting it into its
  own component is a larger change than this defect needs and was not
  verified as part of this review.
- **Restore-error alertdialog** (`WorkbenchApp.tsx`, `role="alertdialog"`,
  `aria-label="Could not load your workbench"`). Same inline-conditional
  constraint. This one is deliberately non-dismissable (no
  `useModalDismiss`/backdrop-click/Escape path already, by design -- see its
  own comment) and **must stay non-dismissable** in any later change that
  gives it a focus trap; only a Retry that actually succeeds may let the user
  out of it.

## Fix round 1 — Escape wiring corrected

Date: 2026-09-23

Review found two dialogs where Tab containment shipped without a working
Escape-to-close:

- `GraphManager`'s dialog omitted `onEscape` entirely, so outside of an
  in-progress rename, Escape no longer closed the Graph Manager (only the
  rename row's own handler ran, and that only cancels the rename). Fixed
  with a guarded `onEscape`: `if (renamingId === null) requestClose();` —
  `useModalFocus`'s document-level capture listener calls `preventDefault()`
  but never `stopPropagation()`, and the rename input's own Escape handler
  doesn't consult `defaultPrevented`, so both behaviors now coexist: Escape
  during a rename still only cancels the rename (the guard skips the dialog
  close), and Escape anywhere else in the dialog now closes it, matching
  every other Workbench dialog.
- `Spotlight`'s own dismissible-modal render omitted `onEscape`, reasoned at
  the time as redundant with the search input's own local Escape handler.
  That reasoning missed that Tab containment now keeps focus inside the
  dialog on non-input controls (result buttons) too, where the local handler
  never fires — Escape did nothing there. Fixed by wiring
  `onEscape: requestClose`; when the input does have focus, both handlers
  now fire for the same keypress, which is harmless because
  `useModalDismiss`'s `requestClose` ignores a repeat call while already
  closing (its `timeoutRef` guard).

## Browser checks not yet performed (skipped per controller instruction; for the controller to run)

- Template chooser: after it opens on an empty canvas,
  `document.activeElement.closest('[role="dialog"]') !== null`; Tab x10 stays
  inside; Shift+Tab from the first control wraps to the last; Escape or
  **Skip** closes it and focus is not left on a removed node.
- Same two focus checks (open lands inside the dialog; Tab stays contained)
  repeated for the Export dialog.
- Task 3B.1 (R17): with `window.prompt` stubbed to return `null`, clicking
  "+ New workbench" creates nothing -- the graph count in the manager is
  unchanged and the active graph does not change.
- Task 3B.3 (R15): `/workbench` still reaches the app normally (`read_page`
  shows the canvas, not "Loading workbench…"). The failed-chunk branch itself
  cannot be triggered in a preview without editing code, so it stays a code
  read, not a browser check.
- **Escape closes the Graph Manager outside a rename** (fix round 1): open
  it, press Escape with no row being renamed, and confirm it closes like any
  other Workbench dialog. Then reopen it, click Rename on a row, press
  Escape, and confirm ONLY the rename cancels (input reverts to the
  non-editing row) and the dialog itself stays open.
- **Escape closes Spotlight's modal from a result button** (fix round 1):
  open the compact "Add node" overlay, Tab past the search input to a node-
  type result button, press Escape, and confirm the dialog closes (previously
  did nothing once focus had moved off the search input).

---

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

---

# Visual QA — Workbench node enhancements

Date: 2026-07-29

## Scope

Verify the new Masked Edit reference controls, separate Variations outputs,
Image Description node, final-output auto-save toggle, and Clear All Nodes
toolbar action without changing the generator or landing experience.

## Environment

- UI-only local URL: `http://127.0.0.1:3001/workbench`
- Browser: Codex in-app Browser
- Viewports: `1440 x 900` and `390 x 844`
- The normal Cloudflare-backed development server could not start because its
  remote Workers AI proxy is protected by Cloudflare Access and this
  non-interactive environment has no Access service-token credentials. A
  temporary, ignored Vite config stubbed only `cloudflare:workers` for
  client-side visual QA; no generation or save API route was invoked through
  that stub.

## Checks

| Check | Result |
| --- | --- |
| Masked Edit reference input handle | Passed; `Reference image (image)` rendered alongside the base image and prompt inputs |
| Reference guidance field | Passed; accepted dedicated guidance text with GPT Image selected |
| Unsupported reference engines | Passed; Workers AI disabled the guidance field and showed the explicit unsupported-engine explanation |
| Variations separate-output toggle | Passed; enabling four candidates exposed `Variation 1` through `Variation 4` image handles |
| Image Description node | Passed; image input, text output, vision-model selector, disabled-until-run editable description field, and focused helper copy rendered |
| Auto-save final toolbar toggle | Passed; `aria-pressed` changed from false to true and the label changed from `AUTO-SAVE FINAL OFF` to `AUTO-SAVE FINAL ON` |
| Clear All Nodes | Passed; confirmation removed all three QA nodes and disabled the empty-canvas action |
| Mobile toolbar | Passed; both new controls fit inside the `390 x 844` menu without horizontal overflow |
| Browser console | No warnings or errors observed |

## Evidence captured

- `workbench-enhancements-1440x900.png`
- `workbench-enhancements-readable-1440x900-v2.png`
- `workbench-enhancements-390x844.png`
- `workbench-enhancements-menu-390x844.png`

The screenshots are stored in the Codex visualization artifact directory for
this task, outside the repository.

## Discrepancies fixed

- The reference-guidance control now communicates its engine limitation
  instead of silently accepting an input that Workers AI or FLUX Fill would
  ignore.
- Variation-specific handles now participate in downstream cache signatures,
  preventing two different variation ports from sharing a stale downstream
  result.
- Presentation-only variation selection and separate-output toggling no longer
  trigger a paid re-run or duplicate an already auto-saved final image.

## Remaining known deviations

- A live paid GPT Image edit with two uploaded images and a mask was not sent
  during visual QA.
- A real automatic save request was not sent during visual QA. Request
  collection, terminal-output selection, deduplication, and failure handling
  are covered by the workbench regression suite.
- No deployment occurred.
