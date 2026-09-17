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
