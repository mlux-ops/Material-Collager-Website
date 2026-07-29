# Workbench interaction inventory

Date: 2026-07-29

Scope: the `/workbench` generator only. The landing page and `/generator`
experience are out of scope for this change.

## Pre-change regression baseline

- `npm run test:workbench`
- 127 tests passed, 0 failed.
- The existing local-only `.gitignore`, `.agents/`, `.claude/`, and
  `skills-lock.json` changes were present before this work and are not part of
  the workbench implementation.

## Existing interaction surface

### Canvas and graph

- Add a node from the desktop palette or compact `+ Add` spotlight.
- Start a connection from either side, type-check it, reject cycles, replace a
  single-input connection, or append to a multi-input connection.
- Drop a wire on empty canvas and choose a compatible node from the filtered
  spotlight.
- Select, drag, snap to the 22 px grid, align with helper lines, auto-tidy,
  pan, zoom, and use the desktop minimap.
- Delete a selected node by keyboard, corner affordance, or floating toolbar;
  duplicate or run a selected node from the floating toolbar.
- Delete selected wires from the compact toolbar.
- Inspect the selected node in the docked inspector.

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
- Typed input/output handles and color-coded edges.
- Full-resolution preview lightbox backed by cached thumbnails.
- Browse run history and pin/unpin a run so downstream execution remains
  frozen to it.
- Persist graph structure, source blobs, output blobs, masks, run history,
  and pins through the split IndexedDB autosave path.

### Node-specific behavior

| Node | Existing interaction |
| --- | --- |
| Photo | Upload/replace a PNG, JPEG, or WebP source image. |
| Text | Edit a reusable text value. |
| Prompt Builder | Compose domain, lighting, style, and extra direction. |
| Image Generate | Choose size, quality, and candidate count; generate from prompt/references. |
| Image Edit | Choose size, quality, and candidate count; edit a base image from prompt/references. |
| Compare | Adjust a before/after split view. |
| Save to Library | Edit filename and persist the connected image. |
| Note | Edit a non-executable canvas annotation. |
| References | Add/reorder/remove reference items and upload images per item. |
| Reference Analyzer | Identify type/brand/product/finish and emit a search query. |
| Reference Finder | Search, pause for candidate selection, import a choice, and resume. |
| Library Pick | Refresh the six-month library and select an image. |
| Collage Board | Choose collage type, orientation, resolution, and quality. |
| Relight | Apply a prompt-driven lighting edit. |
| Variations | Choose size, quality, and 1–10 candidates; select one candidate for the aggregate output. |
| Masked Edit | Choose GPT Image, Workers AI, or FLUX; draw rectangle/brush/polygon masks; undo/clear/apply. |
| Upscaler | Choose an upscale target and run a high-resolution edit. |
| Accuracy Reviewer | Select a reference subset and emit a structured report. |
| QA Correction | Repair a reported region using image/reference/report inputs. |
| AI Assistant | Choose an allowed model and ask about connected image/text context. |
| Resize | Enter target width and height. |
| Crop | Edit the normalized crop rectangle. |
| Export / Download | Choose PNG/JPEG and repeat a client-side download. |

## Regression requirements for this change

1. Masked Edit keeps the base image first, adds an optional reference-image
   port, and applies the mask to the base image. GPT Image receives the
   reference as the second image plus dedicated reference guidance. Workers AI
   and FLUX must clearly report that they do not support the reference input.
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
