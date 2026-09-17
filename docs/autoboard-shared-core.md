# The autoboard shared core

`app/lib/autoboard/` holds the board-building rules that the CLI
(`scripts/autoboard/`) and the web review board both run. One implementation,
so a board built in the browser and a board built on the operator's machine
agree by construction rather than by two copies staying in sync.

The extraction that created it changed **no behaviour**. The proof is the test
suite: 602 tests passed before, the same 602 pass after, and
`tests/autoboard-parity.test.mjs` adds 7 more that pin the specific behaviours a
reasonable-looking port would have changed silently.

## What moved, and what did not

| Module | Holds | Why |
|---|---|---|
| `app/lib/autoboard/types.ts` | Shared shapes | Types only — see the `verbatimModuleSyntax` note below |
| `app/lib/autoboard/source.ts` | CSV parsing, room-label normalization, row normalization, the Smartsheet reader | No filesystem; the Smartsheet reader is `fetch`, which the edge has |
| `app/lib/autoboard/match.ts` | Slot rules, `assignSlots`, `buildBoards`, `applyBoardMerges`, brand/tier extraction | Pure computation over rows |
| `app/lib/autoboard/tiles.ts` | `resolveTileCode` | A Map lookup `buildBoards` needs; travels with it so the core never imports back into `scripts/` |
| `scripts/autoboard/lib/source.mjs` | `loadOfflineRows`, `loadLibraryRows` | Reads `build_manifest_v2.csv` off disk |
| `scripts/autoboard/lib/match.mjs` | `loadBuildLog`, `makeDiskImageResolver` | Reads `_BUILD_LOG.csv` and the photo folders |
| `scripts/autoboard/lib/tiles.mjs` | `indexTileCodes`, `readImageSize` | Walks the tile photo directory |

The `.mjs` files re-export everything that moved, so every existing
`from "./match.mjs"` import still works unchanged.

**Not moved:** `selectionHash` / `renderOptionsHash` (`render.mjs`) are backed by
`node:crypto` and are synchronous, so they cannot become `crypto.subtle` without
changing every caller's signature. They are `results.json` bookkeeping the
Worker has no reason to recompute. `variants.mjs` stays for the `node:path`
reason below.

## Rules for anything added to `app/lib/autoboard/`

These are enforced by `tests/autoboard-parity.test.mjs`, because **nothing else
produces a signal**: `npm run build`, `npm run lint` and `npm run typecheck` are
all silent on every one of them.

1. **No `node:` builtin.** `app/lib` is compiled into the browser bundle as well
   as the Worker, and nothing else in `app/` or `worker/` imports one today.
   `nodejs_compat` in `wrangler.jsonc` is a workerd runtime flag and says
   nothing about what the bundler will do with a client import.
2. **Explicit `.ts` on every relative import.** Node's ESM resolver rejects
   extensionless specifiers. The rest of `app/` gets away with them only because
   every importer goes through the `@/` alias, which a `.mjs` entry point does
   not have.
3. **No `@/` alias, no JSON imports, no imports back into `scripts/`.**
4. **Type-only imports must say `import type`.** Node's stripper erases only
   what is syntactically marked; it never resolves anything. A value-position
   import of a type is a link-time `SyntaxError` that `tsc` and `eslint` both
   accept happily. `tsconfig.json` sets `verbatimModuleSyntax` so it is a
   compile error instead.
5. **No enums, namespaces, decorators or parameter properties.**
   `tsconfig.json` sets `erasableSyntaxOnly`; without it, `tsc` and `eslint`
   accept all four and only `node --test` fails. (`node --check` is no backstop
   — it parses TypeScript fine and does not validate erasability.)

Both tsconfig flags were free to add: the typecheck error count is 32 before and
after, the same pre-existing set (Cloudflare ambient types, workbench,
scene-lab).

## Contracts that look like tidy-ups and are not

**`resolveImages` is synchronous.** `buildBoards` consumes the returned array
immediately and has no `await` anywhere. An async caller — anything backed by R2
or D1 — must pre-resolve into a Map first and pass
`(rowId) => map.get(rowId) ?? []`. On that side the `images` values are opaque
keys, not paths.

**The `sku` argument is dropped on purpose.** `buildBoards` calls
`resolveImages(rowId, sku)` with two arguments, and `makeDiskImageResolver`
honours the second one — it is the entire reused-row-id guard (the
GROHE-valve-turned-Hansgrohe-hand-shower case, observed 2026-09-06). But both
production call sites wrap the resolver in `withUploads`, whose closure takes
one parameter and drops it, so in the shipped CLI the guard never fires. Typing
the resolver `(rowId) => string[]` would delete the guard; forwarding the sku in
`withUploads` would switch it on and reroute which folder's photos land on a
board. Both are rendering changes. The signature keeps the optional `sku` and
`withUploads` keeps dropping it; parity test 1 pins both halves.

**`rowId: null` is a sentinel, not an absent value.** A tile injected from the
Wieland tile schedule carries `rowId === null`, and the CLI's HOLD warning keys
on exactly that to tell a schedule tile from a project whose tiles are ordinary
manifest rows (651 Belmont). The type is `string | null` and never optional:
`undefined` would make the warning silently vanish. Parity test 2 pins it with
`strictEqual`.

**A substitute is reported once per slot it was kept out of.** `assignSlots`
never adds a substitute to `assignedRowIds`, so it is re-tested against every
remaining slot and emits a record each time it matches — that is how `gaps.md`
tells the operator which slots it was held back from. Collapsing the accumulator
to a Map keyed by `rowId` is a natural-looking tidy-up (a `heldBack` Set is
already in scope) that passes every pre-existing test. Parity test 3 pins it.

## Known defect: `path.basename` is platform-sensitive

`variants.mjs` builds each reference name as
`${slotId}--${path.basename(imagePath)}`. The library root is a Windows path
(`DEFAULT_LIBRARY_ROOT`), so on the operator's machine `path.basename` strips the
backslash-separated directories and yields `photo.jpg`; on Linux it strips
nothing and the whole `H:\Games\...\photo.jpg` becomes the reference name. CI
runs Linux and never sees a backslash, so no test noticed.

This is pre-existing and was **not** fixed as part of the extraction — the fix
is a behaviour change on one platform and belongs in its own commit. Parity test
4 pins the value against `node:path` on the running platform, so a refactor
cannot change it in either direction; hand-rolling `imagePath.split("/").pop()`
passes on Linux and corrupts every name on Windows, which is the failure it
catches.

Until it is fixed, `variants.mjs` keeps its `node:path` import and stays on the
CLI side.

---

# The web review board

`/review-boards` points at a project's Smartsheet, narrows it to the subsection
you want, and stores the result as a project you can switch back to. It runs the
same `app/lib/autoboard` core the CLI does — it does not reimplement slot
matching.

## Why there is a preview step the CLI never needed

`buildBoards` cannot run before reference photos exist. An item whose
`resolveImages` returns nothing is recorded in `gaps.imagelessItems` and dropped,
so a board built straight from a freshly-read sheet comes back empty and every
board falls under `minSlots`. The web flow therefore has a step the CLI does not:

> read the sheet → see what each slot matched → gather photos for those rows →
> build boards

`previewBoards` is that middle step. It runs the same
`groupRowsByRoom → boardTypesForRoom → assignSlots` chain and mints ids with the
same `boardIdFor`, so a preview's board and the board finally built from it are
the same board. It differs from `buildBoards` in exactly two ways, both
deliberate:

- **It keeps an empty board.** `buildBoards` drops a board under `minSlots`; the
  whole point of a preview is to show that a subsection produced nothing.
- **It does not apply the tile gate.** That decision belongs to the build, once
  photos exist.

`tests/autoboard-web-preview.test.mjs` holds the two functions to the same
answer on board ids, slot assignment, substitutes and unmapped rows. Divergence
between them is the failure mode this feature can most easily develop.

## Storage

One D1 table, `autoboard_projects`, created lazily like `generation_jobs`. A
project stores the rows **as they read at build time** rather than re-fetching on
every view: a board is a record of what the sheet said when it was built, and a
live sheet changes underneath you. `PATCH { action: "refresh" }` is the explicit
way to take a new reading.

Rows and preview are stored as JSON in one row, so the write refuses anything
over 800 KB with a message saying to narrow the subsection. D1 caps a TEXT value
at 1 MB.

`SMARTSHEET_ACCESS_TOKEN` is a Worker secret (`wrangler secret put`), and locally
lives in git-ignored `.dev.vars` beside `OPENAI_API_KEY`.

## API

| Route | Does |
|---|---|
| `POST /api/autoboard/sheet` | Read a sheet, return its facets and what a subsection would fill. Stores nothing. |
| `GET /api/autoboard/projects` | List stored projects |
| `POST /api/autoboard/projects` | Build and store one |
| `GET /api/autoboard/projects/[id]` | One project with its preview |
| `PATCH /api/autoboard/projects/[id]` | `{ action: "refresh" }` or `{ name }` |
| `DELETE /api/autoboard/projects/[id]` | Remove it |

Mutating routes require `Content-Type: application/json`, the same CSRF defense
the CLI's review server uses.

Facets come from the **whole** sheet, never the filtered slice — a picker that
narrowed its own options as you chose would strand you. An empty filter means
everything, not nothing.

## Two things the page had to be built around

- **`body { overflow: hidden }`** above 1280px (globals.css), which propagates to
  the viewport. A document-scrolling page is clipped to one screenful on a wide
  display. `/review-boards` owns its own scroll, like `/archive`. A sticky offset
  inside it is measured from the scroll container's *padding* box, so the rail
  uses `top: 0` — anything else is added on top of the nav clearance rather than
  replacing it.
- **`*, *::before, *::after { border-radius: 0 !important }`** (globals.css
  §"v4 normalisation"): sharp corners are the house style, and separation comes
  from 1px rules and black/white inversion, never rounding, colour or shadow. Any
  `border-radius` written under `app/components/review-boards/` is dead on
  arrival. Colour appears in exactly one place — slot state — which AGENTS.md
  permits as state treatment, and shape and text carry the same distinction so it
  never depends on hue alone.

## Reference photos

A board is a set of reference images, so the preview only becomes a board once
photos exist. They arrive three ways, all landing in the same review grid:

- **From the sheet's reference link.** That column holds a product *page* far
  more often than an image, so a reference is resolved in two steps: fetch it,
  and if what comes back is HTML rather than an image, read the images the page
  declares about itself (`og:image`, then `twitter:image`, then
  `link rel="image_src"`). Taken by declaration rather than document order — a
  product page's `og:image` is its hero shot, while `twitter:image` is often a
  crop. Deliberately **not** every `<img>` on the page: that is chrome, badges
  and tracking pixels.
- **A pasted URL**, resolved the same way.
- **An uploaded file.**

Nothing collected is used until a person selects it. The CLI rounds of this work
produced an Energy Guide label, a freezer drawer full of food and a Porcelanosa
placeholder card among the "best available" scrapes; a person looking was the
only filter that held.

### The fetch is a server-side SSRF surface

A URL from a Smartsheet cell is untrusted input, and a Worker's `fetch` reaches
the network from inside the perimeter. `assertFetchableUrl` pins the scheme to
https and refuses loopback, link-local (including `169.254.169.254`, the cloud
metadata endpoint), RFC-1918, CGNAT, and `.local`/`.internal` hosts. Because
`redirect: "follow"` means a redirect has already happened by the time you see
it, the **final** URL is re-checked before any body is read, and both the HTML
and image reads are size-capped.

Names that *resolve* into a private range are not caught — that needs the
resolution the fetch itself performs. The https pin is what makes that
acceptable: the services worth reaching this way do not answer TLS.

### Storage and identity

Metadata in D1 (`autoboard_photos`), bytes in R2 under
`autoboard/<projectId>/<rowId>/<photoId>`. Content type is **sniffed from the
magic bytes**, never trusted from the server's `Content-Type` or a client's
filename, and dimensions come from the file header. A unique index on
`(project_id, row_id, sha256)` means the same image offered twice — which a page
listing one hero shot under both `og:image` and `twitter:image` does constantly —
is one row, not two.

Dimensions matter beyond bookkeeping: `isLowResolution` flags anything under 600
px on *either* edge, matching the CLI's `annotateReferenceMeta`, so both sides
mark the same photos. Like every other gap in this pipeline it is a flag, never
an exclusion.

### Building the boards

`GET /api/autoboard/projects/[id]` returns `built` alongside the project:
`buildBoards` run over the selected photos. This is the edge half of the
injected-resolver contract — the resolver must be **synchronous**, so the async
lookup happens once, up front, and what `buildBoards` receives is a plain Map
read over photo API urls rather than filesystem paths. A row with no selected
photo yields no images, so its slot is empty and the row lands in
`gaps.imagelessItems`, exactly as it does on the CLI when a library folder is
empty.

| Route | Does |
|---|---|
| `GET /api/autoboard/projects/[id]/photos` | Every photo for the project |
| `POST …/photos` `{action:"discover", url}` | What a URL offers, without storing |
| `POST …/photos` `{rowId, url}` | Fetch and store |
| `POST …/photos` `{rowId, mimeType, dataBase64}` | Store an upload |
| `PATCH /api/autoboard/photos/[photoId]` | `{status}` — candidate / selected / rejected |
| `DELETE /api/autoboard/photos/[photoId]` | Remove from D1 and R2 |
| `GET /api/autoboard/photos/[photoId]` | The bytes, `private` cache, `noindex` |

Vendor product photography is collected for internal design reference. It is
never committed to the repo, the served bytes carry `X-Robots-Tag: noindex`, and
it is not cleared for client-facing deliverables.

### One parser, two runtimes

`app/lib/autoboard/image-size.ts` reads dimensions from a PNG/JPEG/WebP header
with no decoder. It exists because neither side can use the obvious tool: the
Worker has no sharp, and the CLI's tile index is synchronous so it cannot use
sharp's async API either. It is written on `Uint8Array`/`DataView` rather than
`Buffer` — `Buffer` exists on the Worker under `nodejs_compat` but not in the
browser bundle, and `app/lib` compiles into both.

`scripts/autoboard/lib/tiles.mjs` keeps only the file reading: peek 64 KB, and
re-read the whole file if that was inconclusive, since a JPEG's SOF can sit past
a large EXIF segment. `tests/autoboard-image-size.test.mjs` checks every format
against sharp, because a hand-rolled binary parser rewritten by hand is exactly
the change that looks right and is wrong on one format.

## The render workflow

A board is only worth rendering once someone has said what they want from it.
`/review-boards` carries the four decisions the CLI's review server carries —
a board instruction, a note per slot, which slot anchors the composition, and
the render options — and shows the prompt those produce.

The prompt is **shown, not described**: it comes from the app's own
`buildGenerationPrompt`, over the same payload a render would send, so what is
on screen is what would go out.

### Board state is stored apart from the project on purpose

`autoboard_board_state` is keyed on `(project_id, board_id)`, not on a row. A
project's rows are a reading of the sheet and a refresh replaces them wholesale;
board state is a person's work and must survive that. Board ids are derived from
unit type, room and board kind, so a board that still exists after a refresh
keeps its notes.

The state is applied to a **copy** when building, never written back into the
rows a refresh replaces.

Saves are patches, not replacements — the UI saves one field at a time, and a
write that blanked the others would lose the notes on every keystroke elsewhere.
An emptied note is deleted rather than stored blank, so `selectionHash` returns
to exactly the value it had before the note existed.

### What makes a render stale, and what does not

| Change | `selectionHash` | `renderOptionsHash` |
|---|---|---|
| A slot's image | ✓ | |
| A slot's note, or the board instruction | ✓ | |
| Quality or background | | ✓ |
| Hero slot | reorders the payload | |
| `overriddenAt`, `title`, `provenance`, `imageMeta` | — | — |

Both are checked by `renderRecordIsStale`. The bookkeeping fields are excluded
deliberately: changing them must not invalidate an otherwise-identical render.

### A synchronous SHA-1 that is not node:crypto

Those digests are already written into every `results.json` on disk, so the
algorithm is not free to change — a different hash marks every stored render
stale and re-spends real money re-rendering approved boards.

`node:crypto`'s `createHash` is synchronous but is a `node:` builtin, which
`app/lib` must not import. `crypto.subtle` exists in both runtimes but is
**async**, while every caller is synchronous all the way up. So
`app/lib/autoboard/sha1.ts` implements it directly, and
`tests/autoboard-render-hash.test.mjs` checks it against `node:crypto` across
the padding and block boundaries where a hand-written loop goes wrong (55/56,
63/64/65, 119/120, 127/128), unicode, and 200 random inputs. The two workflow
digests are pinned to literals taken from `node:crypto` over the same material
the original hashed — the pure version has to keep reproducing them, not merely
be self-consistent.

It is a change detector. Do not reach for it where collision resistance matters.

### `basename` is injected, finally

`boardPayload` and `boardReferenceFiles` moved to the core and now take a
`basename` function. The two callers genuinely disagree about what a location
is: the CLI holds Windows filesystem paths and injects `node:path`'s basename,
the web holds `/api/autoboard/photos/<id>` urls and injects a last-segment split.
Hard-coding either corrupts the other. The same function must reach both
builders, or their lists drift out of the position-for-position alignment the
multipart upload depends on.

### Not yet wired

Actually spending money on a render. Everything up to the payload exists and is
validated; issuing the draft/confirm/final calls, storing the outputs and
picking between them is the next step.

### Rendering

`POST /api/autoboard/projects/[id]/boards/[boardId]/renders` renders one draft.
It **spends money**: one press, one image, no batching and no retry, so a
mistaken double-click costs one draft rather than a set. The button says what it
will spend on — a draft's bill is dominated by its reference count, not its
quality tier (see the cost note in CLAUDE.md).

The request goes through the app's **own** `/api/generate` as a same-origin
subrequest rather than calling OpenAI from here. That route already holds every
rule that matters — payload validation, the final-quality floor, reference
counting, usage and cost accounting, the diagnostics the CLI depends on — and a
second path to the image API is a second place for those to drift.

Every render records the `selectionHash` and `renderOptionsHash` it was made
under. The board compares them to its current values, so a render made before
the board changed is marked **stale** rather than quietly passing as current.
Picking is exclusive per board and kind: picking another draft releases the
first, so "the approved draft" is never ambiguous.

`renderBoardDraft` takes an injected `fetchImpl` (the same pattern
`loadSmartsheetRows` uses) so the chain can be exercised without spending.

| Route | Does |
|---|---|
| `POST …/boards/[boardId]/renders` | Render one draft — **costs money** |
| `GET …/boards/[boardId]/renders` | That board's renders |
| `GET /api/autoboard/projects/[id]/renders` | Every render in the project, one request |
| `PATCH /api/autoboard/renders/[renderId]` | `{status}` — candidate / picked / approved |
| `DELETE /api/autoboard/renders/[renderId]` | Remove from D1 and R2 |
| `GET /api/autoboard/renders/[renderId]/image` | The bytes, `private` cache, `noindex` |

Local development needs `OPENAI_API_KEY` in git-ignored `.dev.vars`; without it
the render stops at `/api/generate` with "Add an OpenAI API key in Settings".

### Seeding a local board

The web board's projects, photos and renders live in D1 and R2 under
`.wrangler/state`, which is **per-machine**. A fresh checkout starts empty, so
the first draft is otherwise an hour of collecting photos for rows whose photos
are already on disk from `autoboard:scaffold --fetch-images`.

```bash
npm run dev
npm run autoboard:seed-web -- --project 651-belmont --select
```

It reads the project definition and the library root, creates a project from
those rows, and uploads copies of the library's photos through the app's own
API. The library root is never written to.

- `--dry-run` lists what it would upload, and how many rows have no photo.
- `--rooms "Bath 2"` (repeatable) narrows to whole rooms.
- `--select` picks the first photo per row. Off by default: a selection is a
  person's decision, and the review grid exists precisely so nothing reaches a
  render because a script chose it.
- `--into <projectId>` adds photos to an existing project instead of creating
  one. Photos dedupe on `(project, row, sha256)`, so re-running is safe.
- `--per-row 2` is how many of a row's photos to upload.

Rows go to `POST /api/autoboard/projects` as `{ name, rows, source }` — the
offline half of that endpoint. They are sent **raw** (`roomType`, `itemName`),
because the server normalizes and gap-checks them with the same `collectRows`
the sheet reader uses; handing it an already-normalized row drops every one of
them on the blank-room check, with a message that sounds like the definition is
at fault. `tests/autoboard-seed-web.test.mjs` pins the shape.

A seeded project has no `sheet_id`, so `refresh` refuses it rather than silently
reading someone else's sheet.

### Type on /review-boards

The page uses the site's live type scale. Measure it off the running app, not
`globals.css`: the `.generator-shell` block near the end of that file overrides
the earlier rules, so the source reads nothing like what renders. `.section-kicker`
is the trap — its source rule is 11px/750 in `--accent-dark` (green), and what
actually renders is 8.4px/500 in black.

| Role | Rendered |
|---|---|
| Label, button, chip, pill, number | 8.4px / w500 / uppercase / ls 0.1575px |
| Help, sub text | 10px / w400 |
| Body, control value | 11px / w400 or w650 |
| Section heading | 14px / w500 |
| Item title | 14px / w700 |

**Nothing on any page of this app is larger than 14px**, and chrome text is
black `#000` or muted `#657069` — never the teal. A page here that reaches for a
22px title and green kickers looks like a different product, which is what the
first two attempts at this page did.

`docs/generator-design-concept.md` §4 proposes a different scale and calls the
current sub-12px type the generator's "most serious defect". It is marked
proposal, awaiting approval, it was rendered on this page and turned down, and
it is not what to match. Match the live app.
