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

`SMARTSHEET_ACCESS_TOKEN` is a Secrets Store binding (`wrangler.jsonc`
`secrets_store_secrets`), so `env.SMARTSHEET_ACCESS_TOKEN` is an object with an
async `get()`, not a string; `smartsheetToken()` in `autoboard-projects.ts`
accepts either shape and says which step failed when neither yields a value.
Locally it comes from Miniflare's emulated store (`npx wrangler secrets-store
secret create <store-id> --name SMARTSHEET_ACCESS_TOKEN --scopes workers`), not
from `.dev.vars` — the binding owns the name. See `docs/DEPLOYING.md`.

## Lighting board (one per unit type, up to three when tiered)

Besides the per-room boards, `buildBoards` emits one `lighting_collage` board
per unit type that gathers **every light fixture across the unit's rooms**,
including rooms no board type maps to, such as a living room. The web preview
(`previewBoards`) mirrors it, so the picker shows it before any photo exists.

- **Membership** is `isLightFixture(row)`: a luminaire cost code (`26 51`)
  qualifies a row on its own; otherwise the name has to read as a fixture
  (pendant, chandelier, sconce, lamp, flush mount, downlight, recessed,
  "… light fixture / bar / kit", "vanity / ceiling / wall / under-cabinet …
  light", "lighting"). Bulbs, lamping, controls, "light rail" and budget
  allowances are excluded, and the global exclusions still apply. This is
  deliberately broader than the room boards' single `light_fixture` slot,
  which wants only the one fixture that belongs on a palette.
- **Order and hero**: by kind in `ITEM_PRESETS.lighting_collage` order
  (chandelier, pendant, ceiling light, sconce, vanity light, lamp, other), then
  source order. `heroFor` has no ranking for this type, so the first item — a
  chandelier or pendant when there is one — is the hero.
- **Slot ids** are `light_<rowId>` (`light_b2_07`, `light_1844209142501252`),
  not positions: review state (notes, hero pick) is keyed by slot id, and a
  positional id would move a note to a different fixture whenever the sheet
  gained one.
- **Roles** name the fixture's room, since the board spans them all: "Bath 2
  vanity light", "Living Room chandelier".
- **Identity**: `roomLabel` is `LIGHTING_SCOPE_LABEL` ("All Rooms"), so the id
  is `<unit>-all-rooms-lighting` and the title `<Unit> Lighting Collage`.
  Twin-unit merge rules key on real rooms and never touch it.
- **Gaps**: rows the lighting board accounts for — placed, imageless, or a
  held-back substitute — are left out of `unmappedItems` and out of a skipped
  room's `itemCount`; a room whose only rows are fixtures is no longer reported
  as skipped. Substitutes are reported once against `lighting_collage`, in
  addition to any room board that held them back, per the once-per-slot-per-
  board-type convention. Imageless fixtures carry the fixture's own room. The
  16-reference cap and `minSlots` apply as for any board; fixtures dropped for
  the cap are recorded in `unfilledSlots` with their `rowId` and `itemName`.
- `ITEM_PRESETS.lighting_collage` exists for the manual generator (every slot
  optional) and for kind naming; the autoboard core never fills those slots.
- **`isLightFixture` has false negatives, and a pin (below) is the fix**: an
  unusually named or uncoded row, or a fixture in a room `boardTypesForRoom`
  maps to nothing (a living room, a foyer — where lighting is often the ONLY
  finish category and is otherwise invisible, only counted in
  `previewBoards`' `skippedRooms`), needs a person to say so. `lightingFixtures`
  takes the same `pins` map every other board honours; a row pinned to
  `lighting_collage` is placed on the unit's board regardless of what
  `isLightFixture` and the substitute rule say, and `previewBoards` lists every
  such stranded row individually in `skippedRoomItems` — not just a `skippedRooms`
  count — precisely so there is something to pin.
- **Good/Better/Best** (`LIGHTING_TIERS`, `lightingTiersFor`, `lightingScopeLabel`
  in `match.ts`): the sheet's existing tier-tag convention — read by
  `extractTier`, the same function that tags a good/better/best alternate on
  any other board — can differentiate a unit's light fixtures too.
  `extractTier` recognizes the tag at either end of the item name: a leading
  `-Good- option - Duo Pendant` (the original convention) or a bare trailing
  `Duo Pendant - GOOD` (seen on the Penthouse lighting rows, no "option"
  wording). Whichever end it's on, the tag is stripped from the displayed name
  and only the tier survives onto `item.tier`.
  `lightingTiersFor(unitRows)` decides, per unit, whether ANY fixture carries a
  tier tag; if so, `buildLightingBoards`/`previewBoards` build THREE boards
  instead of one — `<unit>-all-rooms-good-lighting`, `…-better-…`, `…-best-…`,
  titled `<Unit> Lighting Collage — Good` and so on — each built by the same
  `lightingFixtures(rows, pins, tier)` call with `tier` narrowing which rows
  are candidates: a fixture tagged for a DIFFERENT tier is excluded, one
  tagged for no tier is kept on every board (it has no alternate to swap in,
  so each package still needs the whole plan). Both functions call the exact
  same `lightingTiersFor` — the preview and the build can never disagree on
  which units split. A unit with no tiered fixture at all still gets the
  single consolidated board exactly as before tiering existed: three
  identical boards would be pure noise and three times the render spend for
  no difference between them. A substitute held back from a tiered unit is
  still reported once against `lighting_collage`, not once per tier board.
  Pins are independent of tiering: a pinned untiered row still lands on every
  tier board, the same as it would with no tiering in play at all. The review
  UI needed no changes — a board is already rendered generically by its id,
  `roomLabel`, `kindLabel` and `title`, so three lighting boards per unit show
  up as three ordinary board cards.

## Edits on top of the sheet

The stored rows stay a reading of the sheet, replaced wholesale by a refresh.
A person's edits live beside them, keyed by row id, and are applied on every
read (`app/lib/autoboard/row-edits.ts`, pure; `app/lib/autoboard-row-edits.ts`,
D1 table `autoboard_row_edits`), so a refresh keeps them:

- **Pin** (`SlotPin`, `BuildBoardsOptions.pins`, `previewBoards(rows, { pins })`):
  places a row on one slot of one board type. In `assignSlots` a pinned row is
  a candidate for that slot only, ahead of every rule match, and never for
  another slot on that board type; a pin on a different board type has no
  effect on this one; a pinned substitute is placed (the pin is the decision).
  Two rows pinned to one slot: source order wins, the other is an alternate. A
  pin naming a slot the board type lacks is ignored. The preview marks a
  pinned slot `pinned: true`. The CLI passes no pins and is unchanged.
  The lighting board is the one exception to "one slot of one board type": it
  has no preset slots (every fixture gets its own, keyed by row id), so a pin
  there means "place this row regardless of `isLightFixture`," not "assign it
  to slot X" — `validatePin` accepts `{ collageType: "lighting_collage" }` and
  normalizes any `slotId` to the placeholder `"light_fixture"` rather than
  validating it against a list. `pinChoices` always offers this option,
  independent of the room's own board types (even `pinChoices([])`, a room
  with none), because the lighting board spans every room in the unit.
- **Remove** (`excluded`): the row leaves every board and every gap list; the
  snapshot taken at removal is what the Removed list shows, and Restore forgets
  the exclusion. Removal never touches the sheet.
- **Remove a whole board** (`excludeBoards`, `RemovedBoardSnapshot`): distinct
  from removing a row — the board's rows stay in the project and still count
  toward any OTHER board they belong to, only this one board's card disappears.
  Stored the same way as a row removal (same `autoboard_row_edits` table, kind
  `"excluded_board"`, `row_id` holding the board id instead of a row id) and
  the same shape of snapshot-and-restore. Unlike `applyRowEdits`, this cannot
  run before a board exists — a board's id is assigned by `buildBoards`/
  `previewBoards`, not present in the row list going in — so both
  `storedPreview` and `buildProjectBoards` call `excludeBoards` themselves on
  the boards array each one already produced, off the SAME ids (`boardIdFor`
  is deterministic — see "Lighting board" above), so a board removed from one
  view is gone from the other too. Board STATE (instruction, notes, render
  options; a separate table, `autoboard-board-state.ts`) is untouched by
  removal, so a restored board comes back exactly as it was left.
- **Manual rows** (`manual-<uuid>`): rows added by hand to a project with no
  sheet behind it (a blank project, or one seeded from a tracked definition),
  normalized by the same `normalizedRow` the reader uses and appended AFTER the
  stored rows, so a hand-added row never displaces a sheet row that matched a
  slot first — pin it if it should.
- **Adding to a sheet-backed project writes the sheet** (`sheet-write.ts`):
  the row form is one field per sheet column (`sheetSchema`: picklists as
  dropdowns, existing values as suggestions, system and formula columns left
  out, the reader's three required columns marked required), `addSheetRow`
  posts the row as a sibling below the last row with the same Unit Type and
  Room Type (`fileNewRow`; falling back to the same Unit Type, then the bottom
  of the sheet), and the project is re-read so the row arrives with its real
  row id. Nothing here edits an existing sheet row.

## API

| Route | Does |
|---|---|
| `POST /api/autoboard/sheet` | Read a sheet, return its facets and what a subsection would fill. Stores nothing. |
| `GET /api/autoboard/projects` | List stored projects |
| `POST /api/autoboard/projects` | Build and store one |
| `GET /api/autoboard/projects/[id]` | One project with its preview |
| `PATCH /api/autoboard/projects/[id]` | `{ action: "refresh" }` or `{ name }` |
| `DELETE /api/autoboard/projects/[id]` | Remove it |
| `POST /api/autoboard/projects` with `{ name, blank: true }` | A project with no sheet and no rows yet |
| `GET /api/autoboard/projects/[id]/rows` | The row form: one field per sheet column, or the manual field set |
| `POST /api/autoboard/projects/[id]/rows` | `{ values }` — into the sheet (then re-read) or as a manual row |
| `PATCH /api/autoboard/projects/[id]/rows/[rowId]` | `{ excluded: bool }` and/or `{ pin: { collageType, slotId } \| null }` |
| `PATCH /api/autoboard/projects/[id]/boards/[boardId]` | `{ excluded: bool }` removes/restores the whole board; otherwise board state fields (`instruction`, `heroItemId`, `quality`, `background`, `notes`) |

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

### Reading the 651 Belmont sheet

Checked against the live sheet (`FINISH DATABASE: 651 Belmont`, 6391628162879364)
before the first production read, which would otherwise have failed on the
first click:

- **The item name is in a column still titled "Primary Column."** No title
  alternate matches it, so `resolveColumnIds` now falls back to the column
  flagged `primary` — in Smartsheet the primary column is the row's name by
  convention. A titled name column still wins when one exists.
- **AGENT IGNORE is a checkbox the owner ticks on rows no automation should
  read** — the whole ARCHIVE section and superseded picks; 96 of 218 sampled rows.
  Ticked rows are excluded before matching and recorded in `gaps.ignoredRows`,
  so the exclusion is visible in `gaps.md` rather than silent. The column is
  optional; a sheet without it reads every row.
- **"Secondary Bathroom" is on the room picklist** and matched no board type,
  because the bath rule only matched labels starting with bath/primary bath/
  powder. It now aliases to "Secondary Bath" and maps to the bathroom boards.
  Laundry, Living Room, bedrooms, closets, Mudroom and Dining still map to
  nothing and are reported as skipped rooms — a Laundry board type is a
  standing open decision, not something to force onto a kitchen board.
- **The Image column is not a picture source.** 127 of 163 leaf rows have a
  value, and none is a URL — they are attachment filenames (`RS36A72J1N.jpg`),
  the display text of a Smartsheet cell image. Reaching those needs the
  attachments API and is not built. **Reference** is the picture source: 113 of
  163 populated, all Ferguson product pages, resolved through `og:image`.

`tests/autoboard-smartsheet-reader.test.mjs` uses the sheet's real column titles,
ids and primary flag as its fixture.

### The fetch is a server-side SSRF surface

A URL from a Smartsheet cell is untrusted input, and a Worker's `fetch` reaches
the network from inside the perimeter. `assertFetchableUrl` pins the scheme to
https and refuses loopback, link-local (including `169.254.169.254`, the cloud
metadata endpoint), RFC-1918, CGNAT, and `.local`/`.internal` hosts.
`assertFetchableUrl` also normalizes the hostname before any of those checks
run: lowercased, one trailing dot stripped (a DNS no-op the URL parser
otherwise keeps), and any resulting empty label refused.

`redirect: "follow"` would already have contacted a redirect's target by the
time its final URL could be checked, so `app/lib/guarded-fetch.ts`'s
`fetchPublic` uses `redirect: "manual"` instead and validates every `Location`
with `assertFetchableUrl` **before** requesting it — never just the final URL.
It follows only 301, 302, 303, 307 and 308 (every other 3xx goes back to the
caller's own `!response.ok` handling), up to 5 hops, all under one timeout for
the whole chain, and cancels each redirect's body before requesting the next
hop. Headers are sent to every hop, including one that redirected to a
different host, so callers must never pass credentials through it. Both the
HTML and image reads go through `readCapped`, which streams against a byte cap
— cancelling the download the moment it's exceeded rather than buffering the
whole thing first — and honours a declared Content-Length.

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

## Image digests in selectionHash

`selectionHash` appends an item's `[digest|null, …]` only when one of its images
has an entry in `board.imageDigests`; this keeps every existing hash byte-identical.
The digest is computed by the CLI review server (`node:crypto`), never in the
shared core. The web board doesn't need it because its uploads are content-addressed.

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

The request goes through the app's **own** `/api/generate` handler, called
**in-process as a function**, rather than calling OpenAI from here. That route
already holds every rule that matters — payload validation, the final-quality
floor, reference counting, usage and cost accounting, the diagnostics the CLI
depends on — and a second path to the image API is a second place for those to
drift.

It is not fetched over HTTP. A Worker cannot fetch its own hostname (Cloudflare
answers error 1042), and the request would reach the Access gate with no JWT.
Miniflare permits the self-fetch, which is how a design that only works locally
gets shipped; the first version of this did exactly that and was caught before
deploy.

Every render records the `selectionHash` and `renderOptionsHash` it was made
under. The board compares them to its current values, so a render made before
the board changed is marked **stale** rather than quietly passing as current.
Picking is exclusive per board and kind: picking another draft releases the
first, so "the approved draft" is never ambiguous.

`renderBoardDraft` takes the handler injected (`generate`), so a test can hand
in a stub and the chain can be exercised without spending.

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

A design concept once proposed a different scale here (an 11px floor, 18px
headings, a 24px board title) and called the current sub-12px type the
generator's "most serious defect". It was rendered on this page, reviewed and
rejected, and the document is deleted. Match the live app.
