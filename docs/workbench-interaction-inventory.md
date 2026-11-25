# Workbench interaction inventory

Date: 2026-07-29

Scope: the `/workbench` generator only. The landing page and `/generator`
experience are out of scope for this change.

## Pre-change regression baseline

- `npm run test:workbench`
- 127 tests passed, 0 failed.
- `tests/workbench-wiring.test.mjs` (picker and validity rules) was added after
  this baseline and runs under the same command via its
  `tests/workbench-*.test.mjs` glob; the 127 above predates it.
- The existing local-only `.gitignore`, `.agents/`, `.claude/`, and
  `skills-lock.json` changes were present before this work and are not part of
  the workbench implementation.

## Existing interaction surface

### Canvas and graph

- Add a node from the desktop palette or compact `+ Add` spotlight.
- Start a connection from either side, type-check it, reject cycles, replace a
  single-input connection, or append to a multi-input connection.
- Port strip under each card header: input i on the left, output i on the
  right, each with its name in 8.4px uppercase. Labels are black when wired,
  `#657069` when unwired and optional, `#b3261e` for a required input with no
  wire. A multi port with wires shows its count, e.g. `REFERENCES · 3`.
- Port glyphs by data kind, all black ink: image ●, text ■, references ◆,
  mask ▲. Hollow when unwired, filled when wired. Wires keep their dash
  language: solid image, dashed text, dotted references, dash-dot mask.
- Each port has an invisible grab zone the size of its row (20px for fine
  pointers, 28px for coarse). The glyph grows on hover; wire endpoints still
  meet the glyph's box. `scripts/qa/workbench-wire-qa.mjs` drags real wires
  headlessly and reports these geometries and the drop outcomes.
- While a wire is in flight, ports it can validly land on (kind match, no
  self-wire, no cycle) enlarge with a halo and every other port dims. Cards
  with no compatible port fade (the origin card stays as is); hovering a card
  that has one outlines it.
- Drop a wire anywhere on a card body to attach it: to an empty single input
  first, then a multi input, then an occupied single input (replaced). A wire
  dragged backwards from an input attaches to the card's first visible
  compatible output. If nothing fits, nothing happens, and the add-node prompt
  never opens over a card.
- Drop a wire on empty canvas and choose a compatible node from the filtered
  spotlight; the node it adds is wired with the same picker.
- Select, drag, snap to the 22 px grid, align with helper lines, auto-tidy,
  pan, zoom, and use the desktop minimap.
- Delete a selected node by keyboard, corner affordance, or floating toolbar;
  duplicate or run a selected node from the floating toolbar.
- Delete selected wires from the compact toolbar.
- Inspect the selected node in the docked inspector.
- A card's Run button stays full width, with the "Missing required input"
  reason wrapping beneath it. On desktop the toolbar never overlaps the Add
  node palette; its run-blocker reason sits beneath the buttons,
  right-aligned.

### Workflow toolbar

- Run all terminal branches with required-input blocking, stale-node count,
  cost estimate, and high-cost confirmation.
- Cancel a running workflow or retry from the first failed node.
- Toggle draft mode for manifests that declare a cheaper draft request.
- Tidy the graph, open templates, switch named workbenches, export JSON, and
  import JSON.
- Collapse secondary actions into the compact viewport menu.

### Shared node behavior

- Status, error, progress, paid/cached cost, required-input state, and
  run/cancel controls.
- While a node runs, its status badge reads `Running m:ss` (the shared render
  clock, `app/components/RenderClock.tsx`); a run that ends in Done records its
  duration in this browser under `workbench:<kind>:<quality>`
  (`mc.renderDurations.v1`). The Generator and Review Boards use the same clock.
- The Run button's cost label comes from `app/lib/image-cost.ts`
  (`workbench/cost.ts` re-exports it unchanged; same localStorage keys). The
  Generator's Generate Collage / Quick Draft / Final Render Now and Review
  Boards' Render A/B/C now show a live estimate from that same estimator
  (`app/components/CostEstimate.tsx`, basis in `app/lib/collage-cost.ts`):
  `~$0.07` inside the button, `N references · input $X + output $Y` under it,
  `usage-based` for xhigh/max/auto. The Generator records each successful
  render's usage into the shared calibration; regression checks are in
  `tests/image-cost-breakdown.test.mjs`.
- Typed input/output ports, shape-coded by kind, with black wires told apart by
  dash pattern.
- Full-resolution preview lightbox backed by cached thumbnails.
- Browse run history and pin/unpin a run so downstream execution remains
  frozen to it.
- Persist graph structure, source blobs, output blobs, masks, run history,
  and pins through the split IndexedDB autosave path.

### Generator result stage and reference tray (`/generator`)

- Receipt: when a Quick Draft, Generate Collage or Final Render Now lands, a
  strip on the result stage's bottom edge (`app/components/ReceiptStamp.tsx`,
  line from `app/lib/render-receipt.ts`) reads e.g.
  `DRAFT · LOW · 0:48 · 6 REFS · $0.07`: the quality sent, the clock's elapsed
  time, the images actually uploaded, and the `costUsd` the route returned.
  Unknown parts are left out, never estimated. A failed render shows
  `FAILED · <quality> · <elapsed>`, plus the cost when a billed reply came
  back without an image, but only once the request was sent: an error raised
  before the `fetch` (validation, reference optimisation, the Final's size
  check) shows its message in the activity log and no receipt. A cancel shows
  nothing. The strip clears when a render
  starts, on Reset, on a board type change and on draft restore. Its arrival
  (dither-in, dollar count-up) plays once per receipt: after a prompt review
  it reappears settled. The activity
  log announces it once (`receiptAnnouncement`), in place of the Final's old
  `Usage cost: $…` sentence, as its own sentence after the message before it.
  The isolation test sets no receipt.
- While a render's post-render bookkeeping runs (draft save, history refresh)
  the pill, the work-progress clock and the stage's top rule hold that
  render's final time, still, until the work ends.
- Cost split lines count what the reference counter counts:
  `N references · …` under Generate Collage and Quick Draft
  (`N references + layout · …` when a layout master is sent), and
  `N references + draft · …` beside Final Render Now, 8px from its label. The
  dollar terms price every image sent.
- History rows print the same line inline (kind, quality, cost; `FAILED` for a
  failed job) with the four-decimal cost as its tooltip, then model and
  background; `Generation cost unavailable` stays when no cost was recorded.
- Compare: a result that lands over a previous one (a new draft or studio
  render over the last result, or a Final over its draft) arrives through
  `app/components/CompareStage.tsx` instead of the dither reveal: the new
  image wipes in over the previous one and leaves a draggable divider
  (keyboard: the stage's range control). The first result after load, reset or
  type change has no previous and still uses the dither reveal. The wipe plays
  once per result; after a prompt review or a cancelled or failed Final the
  same comparison returns settled. The range announces e.g.
  `63% new render shown`. The isolation test's image is shown on its own,
  never compared, and never becomes the previous image: the next real render
  is compared with the last real one. The completion sweep (`.is-lifted`) is not
  shown over the compare frame. The previous image's blob URL is held until a
  newer previous replaces it, the result is cleared, or the page unmounts.
- Whole-card drop (`app/components/SlotDrop.tsx`): while a file is dragged
  over the window every reference card that can still take a photo turns its
  dashed box solid black; the card under the pointer whitens it and its upload
  button reads `DROP TO SET 03`. A drop anywhere on a card adds to that card
  only (through `addReferences`, so the 16-image limit message still appears
  on a full board). The dashed box no longer has its own drop handler. A file
  dropped outside every card is refused instead of opening in the tab. Only
  files dragged in from outside the page count: an image picked up off the
  page (a tray thumbnail, the render on the stage) carries files too in
  Chrome, and is ignored by the cards and by "Upload a previous collage".
- "Upload a previous collage" now also takes a dropped image (same checks as
  its picker). Before, its input was hidden and a drop opened the file in the
  tab.
- A photo added by drop or by the picker resolves in once with the Bayer
  dissolve (`archive-image-dither`); photos restored from a saved draft keep
  the print-in classes. Reduced motion and potato mode skip the dissolve.

### Node-specific behavior

| Node | Existing interaction |
| --- | --- |
| Photo | Upload/replace a PNG, JPEG, or WebP source image. |
| Text | Edit a reusable text value. Text wired to the explicit-only Append port is shown read-only under the textarea and added to the output after a blank line. |
| Prompt Builder | Compose domain, lighting, style, and extra direction. |
| Image Generate | Choose size, quality, and candidate count; generate from prompt/references. |
| Image Edit | Choose size, quality, and candidate count; edit a base image from prompt/references. |
| Compare | Adjust a before/after split view. |
| Save to Library | Edit filename and persist the connected image. |
| Note | Edit a non-executable canvas annotation. |
| References | Add/reorder/remove reference items and upload images per item. |
| Reference Analyzer | Identify type/brand/product/finish and emit a search query. |
| Reference Finder | Search, pause for candidate selection, import a choice, and resume. |
| Library Pick | Refresh the library and select a saved image by name or open the finish palette atlas. Sample a point on a photograph or pin an extracted swatch. Up to two pinned tones rank images by Oklab color distance. The whole-library scan includes matches beyond the visible images. Choosing a photograph updates the same saved-image selection used by the node’s Run control. |
| Collage Board | Choose collage type, orientation, resolution, and quality. |
| Relight | Apply a prompt-driven lighting edit. |
| Variations | Choose size, quality, and 1–10 candidates; select one candidate for the aggregate output. |
| Multi-Run | Choose size, quality, PNG/WebP, images per press (1–150), images per call (1–10) and an images-per-minute cap (1–150, shared by every Multi-Run node, not part of the signature); one press sends the calls concurrently under the cap. A stopped, failed or cancelled press keeps what it paid for and the next press renders only the remainder. Select one candidate for the selected-image output. |
| Image Markup | Paint freehand marks in six named colours (brush size, undo, clear, zoom/pan) over the input image; type one instruction per colour used. Outputs a transparent PNG of the marks at the input's exact size (for Image Edit's Markup port) and the matching prompt text. Zero API cost. |
| Masked Edit | Draw rectangle/brush/polygon masks; undo/clear/apply. Runs only on the Sunburst edit path (no engine picker). |
| Upscaler | Choose an upscale target and run a high-resolution edit. |
| Accuracy Reviewer | Select a reference subset and emit a structured report. |
| QA Correction | Repair a reported region using image/reference/report inputs. |
| AI Assistant | Choose an allowed model and ask about connected image/text context. |
| Resize | Enter target width and height. |
| Crop | Edit the normalized crop rectangle. |
| Export / Download | Choose PNG/JPEG and repeat a client-side download. |

## Regression requirements for this change

1. Masked Edit keeps the base image first, adds an optional reference-image
   port, and applies the mask to the base image. The edit receives the
   reference as the second image plus dedicated reference guidance.
2. `Clear all nodes` removes every node and connected edge through React
   Flow's normal deletion path, so blob release and autosave dirtiness still
   occur. It is disabled while running and requires confirmation.
3. `Auto-save final output` persists successful terminal image results to the
   library, deduplicates candidates and already-saved run identities, skips an
   explicit Save to Library terminal, and reports failures without changing
   node execution results.
4. Variations preserves its aggregate selected-image output and can expose up
   to ten stable per-variation image handles without a paid rerun when the
   presentation toggle changes. Existing saved runs must resolve those
   handles from their aggregate candidate array.
5. Image Description requires an image, emits plain text focused on lighting,
   materiality, and organization, and lets the user edit the emitted text.
   Editing must change the propagated run identity and mark downstream work
   stale without re-billing the description node itself.
