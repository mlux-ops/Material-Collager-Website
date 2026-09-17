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
