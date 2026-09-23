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

---

# Visual QA - Generator item-field labels and help-bubble placement (WP-3C, R16/R20)

Date: 2026-09-23
Status: **STATIC CASCADE TRACE ONLY - BROWSER PASS PENDING**

## Scope

Task 3C.1 (R16) gives each of the five item fields (`Item type`, `Product / model`,
`Brand`, `Finish / color`, `Generation notes`) its own visible `<label htmlFor>`,
replacing the implicit `<label>` wrapper whose only labelable child was the help
`<button>` (so the input itself had no accessible label). Task 3C.2 (R20) re-anchors
the item-field help bubble (`.field-help`) to grow up-and-right from its own label's
left edge instead of growing 210px leftward from the help button, which
`.references-surface`'s `overflow: auto` clipped for the first column's cards.

This pass was implemented and verified via static CSS-cascade tracing and the
lint/typecheck gates only, per the controller's instruction: the Browser preview
cannot serve this worktree's branch and has no WebGL, so no dev server, `.dev.vars`,
or Browser/preview tool was used. Nothing below was observed in a running browser;
every value is either a "before" measurement handed to this pass by the controller
(captured on the equivalent `main` checkout, whose `app/globals.css` is byte-identical
to this worktree's) or a value derived by tracing which CSS rules apply to the new
markup and classes.

## Before measurements (recorded by the controller, prior to any code change)

Page `/generator`, item 1 ("vanity faucet" fixture), **Item details** open,
viewport 1440x900 unless noted.

### R16 - `.item-fields > *` first child ("Item type" field)

```json
{
  "label": {
    "fontSize": "11px",
    "fontWeight": "650",
    "color": "rgb(101, 112, 105)",
    "marginBottom": "5px",
    "display": "flex",
    "gap": "6px"
  },
  "fieldBox": { "x": 247, "y": 299.09375, "width": 303.328125, "height": 55.5, "top": 299.09375, "right": 550.328125, "bottom": 354.59375, "left": 247 },
  "inputBox": { "x": 247, "y": 320.59375, "width": 303.328125, "height": 34, "top": 320.59375, "right": 550.328125, "bottom": 354.59375, "left": 247 },
  "inputLabels": []
}
```

`inputLabels: []` is the R16 defect: the input had no associated `<label>` because
the help `<button>` was the implicit label's only labelable control.

### R20 - first help bubble vs. the reference tray

Viewport 1440x900, item 1's first help button (`aria-label` starts "Item type: ..."),
focused via `button.focus()` (a real DOM focus state; `:focus-within` is what the
CSS branches on, so this matches keyboard/assistive-tech use - a synthetic click
did not move `document.activeElement` in this preview environment, recorded as a
deviation at the time):

```json
{
  "inside": false,
  "bubble": { "x": 111.453125, "y": 292.34375, "width": 210, "height": 62.171875, "top": 292.34375, "right": 321.453125, "bottom": 354.515625, "left": 111.453125 },
  "tray":   { "x": 240, "y": 66, "width": 652, "height": 834, "top": 66, "right": 892, "bottom": 900, "left": 240 }
}
```

`inside: false`: the bubble grew 210px leftward from the help button and was
clipped by `.references-surface`'s `overflow: auto` well before reaching the
tray's own left edge (`bubble.left` 111.45 vs `tray.left` 240).

## R16 - static cascade trace (after-expectation)

The diff (`FieldLabel` in `app/generator/page.tsx`, and the new `.item-field` /
`.item-field > .field-label` rules in `app/globals.css`) changes only: the wrapper
element (`<label>` -> `<div class="item-field">`), the addition of an explicit
`<label htmlFor>` around the field's text, and which selector supplies the label
row's color/size/weight/spacing. It does not touch `.item-fields`'s own grid
definition, `.material-item`, `.items-list`, or any input/textarea rule.

| Element | Property | Before (measured) | After (traced) | Match |
| --- | --- | --- | --- | --- |
| `.field-label` | `display` | `flex` | `flex` -- still set by the unmodified `.field-label { display: flex; ... }` rule (class beats the `label > span` type-selector combo it used to also match) | Yes |
| `.field-label` | `gap` | `6px` | `6px` -- same rule, unmodified | Yes |
| `.field-label` | `color` | `rgb(101, 112, 105)` (`--muted`) | `rgb(101, 112, 105)` -- before, from `label > span` (matched because `.field-label` was a `<span>` directly inside a `<label>`); after, `.field-label` is a `<span>` inside a `<div class="item-field">`, so `label > span` no longer matches anything in this markup, and the new `.item-field > .field-label { color: var(--muted); ... }` supplies the identical value | Yes |
| `.field-label` | `font-size` | `11px` | `11px` -- same substitution as `color`, new rule states `11px` explicitly | Yes |
| `.field-label` | `font-weight` | `650` | `650` -- same substitution, new rule states `650` explicitly | Yes |
| `.field-label` | `margin-bottom` | `5px` | `5px` -- same substitution, new rule states `5px` explicitly | Yes |
| `.item-fields > *` (wrapper) | `fieldBox` (position/size) | `{x:247, width:303.328125, height:55.5, ...}` | Unchanged -- no sizing property (`.item-fields`'s `display`/`gap`/`grid-template-columns`, `.material-item`/`.items-list` padding, gap, or track sizing) is touched by this diff; the wrapper's tag changes from `<label>` to `<div>`, both of which are blockified identically as a grid item, and `min-width: 0` is preserved via the new `.item-field` rule replacing the old `label { min-width: 0; }` | Yes (within 0.5px, unchanged by construction) |
| input/textarea | `inputBox` (position/size) | `{x:247, width:303.328125, height:34, ...}` | Unchanged -- `.item-fields input, .item-fields textarea` is an unmodified descendant-combinator rule; the input is still a descendant of `.item-fields` regardless of the wrapper's tag name | Yes (within 0.5px, unchanged by construction) |
| `input#...-role` | `labels` (via `input.labels`) | `[]` | `["Item type"]` -- `<label htmlFor="${item.uiKey}-role">Item type</label>` now explicitly targets `<input id="${item.uiKey}-role">` | Yes (fixes the defect) |
| `.item-fields [id]` | id uniqueness | n/a (no ids existed before) | `item.uiKey` (from `createUiKey()`, minted once per item and stable across reorders) makes every one of the 5xN ids (`${uiKey}-role`, `-name`, `-brand`, `-finish`, `-notes`, and their `-help` companions) unique per item and stable when items are reordered or removed | Traced correct; not executed in a browser |

No mismatch found. `.item-fields label > span { font-size: 11px; }` (an older,
redundant rule) no longer matches anything in the new markup -- no `<span>` is a
direct child of a `<label>` inside `.item-fields` any more (the new inner
`<label htmlFor>` wraps only plain text) -- but since it only ever restated the same
`11px` the base rule already gave, its going inert changes nothing.

## R20 - static placement argument (why the bubble stays inside the card)

`FieldLabel`/`.field-help` is used only for these five item fields (confirmed by
searching `app/generator/page.tsx` for `FieldLabel` and `.field-help`); there is no
other call site whose bubble positioning this scoped fix could disturb.

**Horizontal - true by construction, independent of viewport or column count.**
`.item-fields .field-label { position: relative }` plus `.item-fields .help-wrap
{ position: static }` make `.field-label` the containing block for the
absolutely-positioned `.field-help` bubble (rather than `.help-wrap`, as before).
`.field-label` is a block-level flex container inside a plain-block `.item-field`,
itself the sole column of `.item-fields`'s single-column grid (`grid-template-columns:
1fr`), so `.field-label` always fills exactly the item-field's own content width --
which sits entirely inside `.material-item`'s padded content box, which is in turn
sized by `.items-list`'s grid to fit inside `.references-surface`'s padded content
box (the scrolling tray). The new rule sets `left: 0` (flush with `.field-label`'s
own left edge, always at or past the tray's left edge by at least the card's own
padding+border) and `width: min(210px, 100%)`, where `100%` resolves against that
same containing block. Because the bubble's width can never exceed `.field-label`'s
own width, its right edge can never exceed `.field-label`'s right edge either -- so
the bubble cannot spill past the card's own right edge, regardless of which column
the card sits in, how many columns fit at a given viewport width, or how wide the
card itself is. This is a structural guarantee, not a value that could drift with a
breakpoint. It holds identically for the first field and the last field
(`Generation notes`, a `.wide-field`) of any card, since `.item-fields .wide-field
{ grid-column: auto }` is a no-op in a single-column grid -- every field is the same
width.

**Vertical.** `bottom: calc(100% + 6px)` grows the bubble upward from the label's
own top edge. Using the before measurements above (same page state, same viewport):
item 1's first field sits at `fieldBox.top` approximately 299 while the tray's own
top is `tray.top = 66` -- roughly 233px of clearance above the field before reaching
the tray's top edge, comfortably more than the old bubble's own height (`62.17px`)
or a noticeably longer help string wrapped at 210px width. Every other field in the
same card sits lower still (more clearance above it), and a card in a lower grid row
has the rows above it for clearance too -- so the first field of the first (topmost)
card is the tightest case, and it has ample room.

**1440x900, 1280x800, 1024x768.** None of the three intermediate/desktop breakpoints
(`@media (max-width: 1280px)`, which only repositions `.workbench`/
`.controls-surface`/`.references-surface`/`.output-surface`) touch `.material-item`,
`.items-list`, `.item-fields`, `.field-label`, `.help-wrap`, or `.field-help` at all --
so the card/field-internal relationships the argument above relies on are identical
at all three widths. Only the number of `.items-list` columns (and hence overall
card width) changes between them, and the argument above does not depend on that
number.

**390x844.** The combined query `@media (max-width: 760px), (orientation: landscape)
and (max-width: 960px) and (max-height: 700px)` matches at 390x844 (`max-width: 760px`
alone). Inside it, `.generator-shell .field-help { position: fixed; ... }` has the
same specificity (two classes) as the new `.item-fields .field-help` rule but comes
later in `app/globals.css`'s source order, so it wins outright at this width -- the
phone bubble is the pre-existing fixed, viewport-anchored one, completely unchanged
by this fix. (`1024x768` does not match this query: it is landscape, but `1024 > 960`
and `768 > 700`, so neither clause applies.)

A residual, unreconciled discrepancy: independently re-deriving the first card's
outer width from `.items-list`'s `repeat(auto-fit, minmax(255px, 1fr))` track sizing
and `.references-surface`'s measured 652px rect did not land on exactly the measured
303.328125px `fieldBox` width (off by roughly 24px, under either a 1- or
2-card-per-row hypothesis). This does not affect either argument above -- R16's
equivalence holds because no sizing property changed, and R20's containment holds
by the `min(210px, 100%)` construction regardless of the actual card width -- but it
means the exact column arrangement at 1440px was not independently confirmed from
source alone, and is called out here rather than papered over.

## Pending - live browser check (post-merge, for the controller/user)

Nothing above was observed in a running browser. The following still need a real
`vinext dev` session against this merged branch, per `AGENTS.md`'s verification
workflow:

- Re-run the Task 3C.1 Step 1/Step 4 snippet on `/generator` after the merge and
  confirm the `label`/`fieldBox`/`inputBox`/`inputLabels` values match this trace's
  "after" column; click the "Item type" text and confirm focus lands on the input;
  click the "?" button and confirm focus lands on the button (not the input) and
  the bubble shows; reorder/remove an item and confirm the `.item-fields [id]`
  uniqueness check.
- Re-run the Task 3C.2 Step 1/Step 3 snippet at 1440x900, 1280x800, 1024x768 (via
  `resize_window`) and 390x844 (`preset: "mobile"`, then reload) on the first and
  last field of the first and last visible card; confirm `inside: true` at the three
  desktop sizes and that the phone bubble renders as before at 390x844.
- The two known-gap dialogs from Task 3B.2 (Workbench wire-drop-to-empty-canvas
  prompt and the restore-error alertdialog) are unrelated to this pass and remain
  as recorded in the WP-3B entry above.
