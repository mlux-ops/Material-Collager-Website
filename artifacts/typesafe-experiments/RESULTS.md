# TypeSafe System One experiments — run of 2026-09-17

## Status: no TypeSafe measurements were produced

`TYPESAFE_API_KEY` was **not set** in the environment this ran in, and no
`.dev.vars` exists in the repo root. `loadApiKey()` threw in both scripts, and
both scripts caught that and degraded to their key-less paths. **Zero requests
were sent to `api.typesafe.ai`** (`usage.requests == 0` in both JSON files).

Consequently there are **no parity numbers, no rich numbers, no token counts,
no latencies, and no screening results**. The zeros recorded under `usage` and
under `counts.flagged*` are unset defaults, not measurements — in particular
`flaggedReject: 0` and `flaggedAccept: 0` mean *nothing was judged*, not *the
screen flagged nothing*.

No correction to the request shape was needed or made, because no request was
ever built. No HTTP status (401, 422, or otherwise) was observed. No file under
`scripts/` was edited.

## What did run

### 1. `slot-assignment.mjs` — baseline arm only

Printed summary, verbatim:

```
board                             baseline
Bath 2 fixture_collage            8/9
Bath 2 tile_collage               5/6
Bath 3 fixture_collage            9/9
Bath 3 tile_collage               6/6

slots: 30
baseline correct: 28

baseline misses:
  Bath 2 fixture_collage vanity_wood: expected B2-12, got none
  Bath 2 tile_collage vanity_wood: expected B2-12, got none
```

| arm | correct / 30 |
|---|---|
| baseline (shipped `SLOT_RULES` regexes) | 28 |
| parity | not run |
| rich | not run |

Per-slot misses: both are `vanity_wood`, both on Bath 2, both expected `B2-12`
and got nothing. `treatments` is `{}` on all four boards.

### 2. `reference-screening.mjs` — fixtures only

Printed summary, verbatim:

```
candidates: 39 accepted, 8 rejected (3 with the defect in metadata, 5 visible only in the picture)
No API key — fixtures only, nothing judged.
```

`cases` is `[]`. The 39/8 split and the metadata-vs-pixels breakdown (3 / 5) are
read from the hand-written fixture tables in the script, not judged by the API.

## 3. Baseline perturbation arm (added after the run above; no API needed)

`slot-assignment.mjs --baseline-only --perturb` rewrites each row the way a
different person might write the same schedule line — same product, finish and
size, ordinary trade shorthand — and re-scores the shipped regexes. The
rewrites are listed verbatim in `PERTURBED_NAMES`; every one names its product
unambiguously to a human reader.

| naming | correct / 30 | wrong row in the slot | slot emptied |
|---|---|---|---|
| canonical (names written against `SLOT_RULES`) | 28 | 0 | 2 |
| plausible rewording | **15** | **7** | 8 |

The 7 wrong-row cases are the serious ones: an `alternative` substitute
captured the slot from the preferred product, so the board renders a material
nobody selected and nothing in `gaps.md` says so.

```
Bath 2 fixture main_tile:   expected B2-01 (Palette Seafoam), got B2-14 (MSI Sande Ivory, an alternative)
Bath 2 fixture accent_tile: expected B2-02 (Gems Caraibi),    got B2-16 (MSI Convex Olive, an alternative)
Bath 2 tile    wall_tile:   expected B2-01,                   got B2-15 (Metropolitan Grass, an alternative)
Bath 2 tile    floor_tile:  expected B2-03 (Bottega Caliza),  got B2-14 (an alternative)
Bath 2 tile    accent_tile: expected B2-02,                   got B2-16 (an alternative)
Bath 3 fixture main_tile:   expected B3-01 (Grounded Alabaster), got B3-16 (MSI Sande Ivory, an alternative)
Bath 3 fixture accent_tile: expected B3-02 (Ligne Noir),      got B3-19 (Vivid Noir Glossy, an alternative)
```

Read together with arm 1: the pipeline scores 28/30 on names that were written
with the regexes in view, and 15/30 on names that were not. The Wieland library
is the case that matters — its rows come from a live Smartsheet edited by other
people, and `match.mjs`'s own header notes that the sheet mixes ALL CAPS, lower
and Title Case for the same manufacturer.

This arm measures the baseline only. It does not show that a System One
judgment would do better; that is what the unrun treatment arms are for.

## Token usage and latency

| run | input tokens | output tokens | requests | latency |
|---|---|---|---|---|
| slot-assignment | 0 | 0 | 0 | 0 ms |
| reference-screening | 0 | 0 | 0 | 0 ms |

## To complete these runs

Set `TYPESAFE_API_KEY` in the environment of the session that executes the
scripts, or write it to a git-ignored `.dev.vars` at the repo root, then re-run
both commands unchanged. A key held only as a Cloudflare Worker secret is not
readable here — Worker secrets are write-only.
