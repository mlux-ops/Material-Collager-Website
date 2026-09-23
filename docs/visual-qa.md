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
- **Three node-editor dialogs outside this pass's scope entirely** (not
  inline-conditional -- each is its own component -- so nothing here explains
  why they were skipped; they simply were), found by `grep -rn 'role="dialog"'
  app/components/workbench/nodes/`. Each uses `useModalDismiss` for its close
  animation but never `useModalFocus`: no Tab containment, no focus-in on
  open, no restore-focus-on-close, and each already has its own `window`-level
  `keydown` handler for Escape that a later `useModalFocus` wiring would need
  to reconcile, not just add to -- the three do not agree on what Escape does:
  - `crop-editor.tsx`, `aria-label="Crop the image"`. A draft polygon in
    progress absorbs Escape (clears it); otherwise Escape closes the dialog.
  - `maskedEdit.tsx`, `aria-label="Draw the mask to edit"`. Escape only ever
    clears a draft polygon (a no-op if there isn't one) and never closes the
    dialog -- its Cancel/Apply buttons are the only close path.
  - `viewImage.tsx`, `aria-label="Full-resolution image"`. No polygon
    concept; Escape always closes.

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

## Browser checks not yet performed (skipped per controller instruction; now the user's post-merge checks, not a controller/CI gate)

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

---

# Visual QA - Generator item-field labels and help-bubble placement (WP-3C, R16/R20)

Date: 2026-09-23
Status: **STATIC CASCADE TRACE ONLY - BROWSER PASS PENDING**

## Scope

Task 3C.1 (R16) gives each item field its own visible `<label htmlFor>` (the
implicit `<label>` it replaces had the help `<button>` as its only labelable
child, so the input itself had no accessible label). Task 3C.2 (R20) re-anchors
the item-field help bubble (`.field-help`) to grow up-and-right from its own
label's left edge instead of 210px leftward from the help button, which
`.references-surface`'s `overflow: auto` clipped for the first column's cards.

Verified via static CSS-cascade tracing and the lint/typecheck gates only, per
the controller: the Browser preview cannot serve this branch and has no WebGL.
No dev server, `.dev.vars`, or Browser tool was used; nothing below was observed
in a running browser. Before-measurements are the controller's, from the
equivalent `main` checkout (`app/globals.css` byte-identical to this worktree's).

## Before measurements

`/generator`, item 1, **Item details** open, 1440x900 unless noted.

- R16, `.item-fields > *` first field ("Item type"): `label` computed style
  `{fontSize:11px, fontWeight:650, color:rgb(101,112,105), marginBottom:5px,
  display:flex, gap:6px}`; `fieldBox`/`inputBox` both `{x:247, width:303.328125}`;
  `inputLabels: []` — the R16 defect.
- R20, first help bubble vs. tray: `bubble {x:111.453125, width:210}`,
  `tray {x:240, width:652}`, `inside: false` — the bubble grew 210px leftward and
  was clipped by the tray's `overflow: auto` before reaching `tray.left`.

## R16 - static cascade trace (after-expectation)

The diff changes only the wrapper element (`<label>` -> `<div class="item-field">`),
adds an explicit `<label htmlFor>`, and moves the label row's styling from
`label > span` to `.item-field > .field-label`. No sizing property of
`.item-fields`/`.material-item`/`.items-list` is touched.

| Element | Property | Before | After | Match |
| --- | --- | --- | --- | --- |
| `.field-label` | `display` | `flex` | `flex` (unmodified rule) | Yes |
| `.field-label` | `gap` | `6px` | `6px` (unmodified rule) | Yes |
| `.field-label` | `color` | `rgb(101,112,105)` | same, now from `.item-field > .field-label` (`label > span` no longer matches) | Yes |
| `.field-label` | `font-size` | `11px` | `11px`, same substitution | Yes |
| `.field-label` | `font-weight` | `650` | `650`, same substitution | Yes |
| `.field-label` | `margin-bottom` | `5px` | `5px`, same substitution | Yes |
| wrapper | `fieldBox` | `width:303.33` | unchanged (no sizing property touched; grid-item blockifies identically; `min-width:0` preserved) | Yes, within 0.5px |
| input | `inputBox` | `width:303.33` | unchanged (`.item-fields input` untouched) | Yes, within 0.5px |
| `input#...-role` | `.labels` | `[]` | `["Item type"]` | Yes, fixes defect |
| `.item-fields [id]` | uniqueness | n/a | guaranteed by stable `item.uiKey` | Traced correct |

`.item-fields label > span { font-size: 11px }` is deleted: no `<span>` is a
direct child of a `<label>` in the new markup, confirmed by grep.

## R20 - placement argument (conclusions)

- **Horizontal, all viewports, by construction.** `.field-label` (`position:
  relative`) is the bubble's containing block; `.help-wrap` is `position: static`.
  `left: 0` pins the bubble to `.field-label`'s own left edge; `width: min(210px,
  100%)` caps its width at `.field-label`'s own width — so it can never spill past
  the card's right edge, for any column/card/desktop viewport. Confirmed that
  neither `@media (max-width: 1240px)` (~1183) nor either `@media (max-width:
  1280px)` block (~2347, ~3271) touches `.material-item`/`.items-list`/
  `.item-fields`/`.field-label`/`.help-wrap`/`.field-help`.
- **Vertical (superseded by the fix round below).** `bottom: calc(100% + 6px)`
  grows the bubble upward, and this argument only checked clearance to the
  tray's top. It missed a closer clipping ancestor: the item's own `<details>`.
  `details::details-content { overflow-y: clip }` (globals.css ~798-808) applies
  whether or not the details is `[open]` — the `[open]` rule (~810-814) sets
  `block-size`/`filter`/`opacity` only, never `overflow-y` — so vertical overflow
  is clipped from both paint and hit-testing at that box's edge, well before the
  bubble ever reaches the tray. Item 1's first field has no room *above* that box,
  so its bubble was clipped away entirely; see the fix round.
- **390x844 (phone) — corrected after review.** The phone media query's
  `.generator-shell .field-help` ties on specificity with `.item-fields
  .field-help` but wins by source order for every property it sets. It did not
  set `bottom`, so `.item-fields .field-help`'s `bottom: calc(100% + 6px)` leaked
  through: with `position: fixed` (containing block = viewport) and `top` also
  set, CSS 2.1 §10.6.4 solves a negative `auto` height, collapsing the bubble to
  zero height on phones. Fixed by adding `bottom: auto;` and `transform-origin:
  100% 14px;` (restoring the pre-3C.2 value, which also leaked) to the phone
  block. Full per-property table is in the WP-3C report (outside this repo).
  Phones are not literally unchanged — `bottom`/`transform-origin` are now
  explicit resets rather than silently absent — but the computed result matches
  pre-3C.2 behavior.
- A residual ~24px gap between an independent CSS re-derivation of the first
  card's width and the measured `fieldBox` width affects neither argument (R16: no
  sizing property changed; R20: containment holds regardless of actual width).

## R20 - accordion clip, first bubble invisible on desktop (fix round, 2026-09-23)

The "Vertical" bullet above missed that `.item-fields` lives inside the item's
`<details>`, whose `::details-content` box clips vertical overflow (`overflow-y:
clip`) regardless of `[open]`. The first field's bubble opens upward from
`.field-label` with no field above it to give it room inside that box, so it
sits entirely above the clip line and is removed from paint and hit-testing;
the second field's bubble loses its top ~6px (padding only, text unaffected).

Fix: directly after `.item-fields .field-help`, added
`.item-fields :where(.item-field:first-child) .field-help { bottom: auto; top:
calc(100% + 6px); transform-origin: 0 0; }` (globals.css ~1810-1826), so the
first field's bubble opens downward, into the clip box, instead of upward past
its top. `:where()` holds this at the same (0,2,0) specificity as the rule it
sits next to, so `.generator-shell .field-help` in the `@media (max-width:
760px)` block (also (0,2,0), and later in source order) still wins under 760px
— confirmed by reading both selectors, not just reasoning about them.

**Verification method — static harness, not the running app.** Checked with a
standalone HTML file (`r20-repro.html` / `r20-verify.html`, outside this repo)
that inlines the relevant rules copied verbatim from `app/globals.css` plus the
item-card markup from `app/generator/page.tsx` — no dev server, no `.dev.vars`,
no live app. Because a `file://` path outside the project renders in the
browser pane only as an inert static snapshot (no script execution, no
`elementFromPoint`), the harness was loaded by navigating to a real page and
using `document.open()`/`document.write()` to replace the document with the
harness's markup and styles, which does execute scripts normally.

Per-bubble check used `document.elementFromPoint` at three points on each
bubble's vertical extent (top edge + 2px, middle, bottom edge − 2px, all
horizontally centered) rather than `getBoundingClientRect()` alone, because
`overflow: clip` removes the clipped pixels from hit-testing too, not just
paint — a bounding rect doesn't show that. Run at 1440x900, 1280x900 and
1024x900 (`resize_window`, reset to `desktop` after): identical at all three
widths, since nothing in this card is responsive below the 760px phone
breakpoint the harness doesn't include.

| Bubble | Before fix | After fix (isolated, one bubble shown — matches real `:hover`/`:focus-within`, which only ever shows one at a time) |
| --- | --- | --- |
| 1st field ("Item type") | All 3 points miss (rect fully above the clip line) | All 3 points hit at all 3 widths — **fixed** |
| 2nd field ("Product / model") | `top+2` misses, `middle`/`bottom-2` hit | Unchanged: `top+2` still misses (~6.2px of the bubble's 8px top padding is clipped; text starts well below it and is unaffected) — left as-is per the approved fix scope |
| 3rd field ("Brand") | All 3 points hit | Unchanged — all 3 points hit |

Forcing *all* bubbles visible at once — the harness's own screenshot
convention (`body.force`), not a real state — makes the first bubble's new
downward extent overlap the second bubble's upward extent (both fill the
narrow band between the two fields, from opposite directions), and the later
bubble in DOM order paints on top at equal `z-index`. Isolating each bubble one
at a time (simulating real `:hover`/`:focus-within`, which only one `.help-wrap`
can have at once) confirms this never occurs in the app: the table above is the
isolated result. This is a property of the static harness's all-at-once
convention, not a regression.

This static-harness check is stronger than pure CSS-cascade tracing (it
executes the real cascade and hit-tests real geometry) but is still not the
running app. The live check remains the user's post-merge check, below.

## Pending - live browser check (post-merge)

Nothing above was observed in a running browser. These are the user's checks
to run after merge, not a controller/CI gate.

- Re-run the R16 snippet; confirm the "after" column; click label text (focus ->
  input); click "?" (focus -> button, bubble shows); reorder/remove an item (ids
  stay unique).
- Re-run the R20 snippet at 1440x900, 1280x800, 1024x768, 390x844 on the first/last
  field of the first/last visible card; confirm `inside: true` at the three desktop
  sizes, and confirm the phone help bubble renders with its content at 390x844
  (the zero-height regression this fix round corrected).
- The two known-gap dialogs from Task 3B.2 are unrelated and remain as recorded in
  the WP-3B entry above.
- Confirm the first field's help bubble in the live app with real `:hover`/
  `:focus-within`, on the actual `<details>` accordion (not the static
  harness's copy) at 1440, 1280 and 1024.
- hit-test (elementFromPoint), not bounding rects.
