# Autoboard review site — 651 Belmont

A second autoboard review board, running beside the Wieland one. Same CLI, same
review UI; a separate library root, a separate run, a separate port. Nothing in
the Wieland pipeline is shared except the code — 651 Belmont's own data lives in
`scripts/autoboard/projects/651-belmont.json` and in the library root that file
scaffolds.

Source of the selections: `docs/projects/651-belmont-bathroom-recommendations.md`
(prepared 2026-09-16). Those are proposed design recommendations — not an
approved purchase order and not a construction specification. The project
definition carries that status per row (`preferred`, `alternative`, `pending`),
and a board render never turns a proposal into a decision.

## Why this project is set up differently from Wieland

| | Wieland (1529) | 651 Belmont |
|---|---|---|
| Row source | live Smartsheet sheet `8569278453206916`, or its exported `build_manifest_v2.csv` | `scripts/autoboard/projects/651-belmont.json`, scaffolded into a manifest |
| Tiles | no tile rows exist; photos are coded `WT#`/`AT#` under `Tile/tiles/` and picked per room in `tile-assignments.json` | ordinary manifest rows with real vendor SKUs; `Tile/tiles/` stays empty and `tile-assignments.json` gets **no** 651 Belmont keys |
| Unit type | `Penthouse`, `Triplex` | `651 Belmont` |
| Review port | 4790 (the CLI default) | 4791 (`--port`) |

Because the unit type differs, the two projects' room keys can never collide,
so `tile-assignments.json` and `board-merges.json` stay Wieland-only and need no
changes.

## Setting it up

### 1. Scaffold the library root

```bash
npm run autoboard:scaffold -- --project 651-belmont
```

Writes, into `H:\Games\651 Belmont - Master Library` (override with `--root`):

- `build_manifest_v2.csv` — what `plan --offline` reads.
- `Master_Library_Build/_BUILD_LOG.csv` — the `row_id` → folder join that
  resolves reference photos.
- `Master_Library_Build/<room>/<row-id>_<product>/` — one folder per item.
- `Tile/tiles/` — empty, but `tiles.mjs` requires it to exist.
- `REFERENCE-PHOTOS.md` — the per-item photo checklist, with each product's
  vendor link and what the shot should show.

It never touches photos already in place, so it is safe to re-run. `--dry-run`
reports without writing.

### 2. Drop in the reference photos

Put each product's photo in the folder `REFERENCE-PHOTOS.md` lists for it — the
real product shot, not the spec PDF's line drawing. References are sent to the
image model as images, so their quality is the board's quality.

Then re-run the scaffold so the build log picks them up:

```bash
npm run autoboard:scaffold -- --project 651-belmont
```

The summary line reports how many selected products still need a photo.
Rows marked `pending` have no product selected yet and are expected to stay
empty — Bathroom 1 is entirely in that state, so it produces no board at all
and is reported in `gaps.md` instead.

### 3. Plan the run

```bash
npm run autoboard -- plan --offline --library-root "H:\Games\651 Belmont - Master Library"
```

Prints a run id (`run-YYYYMMDD-HHMMSS`) and writes
`autoboard-runs/<run-id>/plan.json` plus `gaps.md`. Read `gaps.md` before
rendering: it lists every unfilled slot, every item with no photo, and every row
no slot matched (towel bars, the toilet-paper holders, the Rite-Temp rough
valve — all excluded from presentation boards by design).

With every selected product photographed, the run plans these boards:

| Board | Fills |
|---|---|
| `651-belmont-bath-2-fixture` | Purist wall-mount basin trim, tub/shower trim, cabinet pull, Cinch vanity light, Seafoam field as the main tile, Caraibi as the accent |
| `651-belmont-bath-2-tile` | Seafoam wall, Bottega Caliza floor, Caraibi accent, brushed-nickel finish |
| `651-belmont-bath-3-fixture` | Purist widespread basin faucet, showerhead/handshower kit, cabinet pull, Banda vanity light, Grounded Alabaster main tile, Ligne Noir accent |
| `651-belmont-bath-3-tile` | Alabaster wall and floor, Ligne Noir accent, matte-black finish |

Bath 2's `shower_head`, both rooms' `vanity_wood` and `countertop`, and all of
Bathroom 1 stay open until a product is chosen.

### 4. Open the review site on its own port

```bash
npm run autoboard -- review --run <run-id> --port 4791
```

`http://127.0.0.1:4791` — the Wieland board keeps 4790, so both can run at once.
Renders go to the deployed Worker by default (it holds the OpenAI key); pass
`--base-url http://localhost:3000` to drive a local dev server instead, which
then needs `OPENAI_API_KEY` locally.

From the board: pick each slot's item, draft, pick a draft, add notes, confirm,
final. Picks and notes save straight into that run's `plan.json` /
`results.json`.

## Changing a selection

Edit `scripts/autoboard/projects/651-belmont.json`, re-run the scaffold, and
plan a new run. Two rules the file's own `_readme` repeats:

- **Row order decides slot ownership.** `match.mjs` gives a preset slot to the
  first matching row, so each slot's preferred pick is listed before its
  alternatives. Bath 3's niche relief (`B3-02`) sits before the shower-floor
  mosaic (`B3-04`) for exactly this reason.
- **An `alternative` is a substitute, never an addition.** It names the row it
  replaces in `substituteFor`. Swap it in from the review board rather than
  adding it alongside the preferred product.

An alternative that is in the manifest but not on the board is still offered in
the review UI's per-slot library list, which is the cheapest place to compare
two substitutes before spending a render.

## Cost note

A render's cost is dominated by reference images, not quality: roughly 1,391
image input tokens per reference, and image input does not vary with the quality
tier. A six-reference board is about $0.07 in input tokens per draft. Trim slots
before trimming quality.
