# TypeSafe System One experiments — 651 Belmont

Model `jev-latest`, endpoint `POST https://api.typesafe.ai/v1/systemone`.
Run on 2026-09-16 from the Windows workstation, where `.dev.vars` holds the key.
Earlier attempts from the cloud session produced no measurements: that
environment predates `TYPESAFE_API_KEY`, and a Cloudflare Worker secret cannot
be read back into a shell — it is readable only as `env.TYPESAFE_API_KEY`
inside a deployed Worker.

Two questions were rewritten between run 1 and run 2 of each experiment. Both
rewrites fixed something underspecified in the question, not something wrong in
the answer; both runs are reported so the tuning is visible. No further
iteration was done — the label set is 30 hand-written slots, and chasing the
last miss through question text would fit the labels rather than the task.

## 1. Slot assignment — Choice, one per slot

Can a Choice fill a board's preset slots more reliably than `match.mjs`'s regex
`SLOT_RULES`? 30 labelled slots over four boards. `parity` shows the model only
what the regex sees (name, cost code); `rich` adds sku, status and spec.

| arm | run 1 | run 2 (corrected questions) |
|---|---|---|
| baseline (shipped regexes) | 28 / 30 | 28 / 30 |
| parity | 25 / 30 | 27 / 30 |
| **rich** | 25 / 30 | **29 / 30** |

Per board, run 2 — baseline / parity / rich:

| board | baseline | parity | rich |
|---|---|---|---|
| Bath 2 fixture | 8/9 | 8/9 | **9/9** |
| Bath 2 tile | 5/6 | 5/6 | **6/6** |
| Bath 3 fixture | 9/9 | 8/9 | 8/9 |
| Bath 3 tile | 6/6 | 6/6 | 6/6 |

Both arms fix the failure that motivated the experiment: "Light natural-wood
vanity" reaches `vanity_wood`, which the regex cannot do because that slot
excludes `/light/i` to keep light fixtures out. The row no longer has to be
renamed to suit the matcher.

### What the two question rewrites were

1. `main_tile` was described as "the surface that covers the most area". The
   model answered with the floor tile on two boards, which is a fair reading of
   that sentence. It now says "the primary WALL field tile … not the floor
   tile".
2. Nothing said what a `(product pending)` placeholder row means. The model read
   it as "not a product" and declined four slots those rows exist to hold. The
   question now states the pipeline's convention: a placeholder holds its slot.

### Remaining misses, run 2

```
rich    Bath 3 fixture valve_trim: expected none, got B3-07 (confidence 0.73)
parity  Bath 3 fixture valve_trim: expected none, got B3-07 (confidence 0.82)
parity  Bath 2 fixture accent_tile: expected B2-02, got B2-13 (confidence 0.65)
parity  Bath 2 tile    accent_tile: expected B2-02, got B2-13 (confidence 0.71)
```

`valve_trim` is the rewrite biting back: B3-07 is the Rite-Temp rough valve,
which the slot's own description excludes as a concealed part, but it is also
`(product pending)`, and the new sentence tells the model a pending row holds
its slot. Two instructions in one question now disagree for this row. That is a
question to fix, not a model error, and it is deliberately left unfixed here.

Parity's two extra misses are `B2-13`, "Niche sill and shelf material (product
pending)", taken for the niche accent. `rich` gets both right because `status`
and `spec` tell it that B2-02 is the accent and B2-13 is the sill. That gap
between the arms is the clearest result in this experiment: the win comes from
fields the regex cannot read, not from reading names better.

### Confidence does not separate right from wrong here

| arm | correct: mean confidence (min) | wrong: mean confidence |
|---|---|---|
| parity | 0.81 (0.50) | 0.73 |
| rich | 0.89 (0.63) | 0.73 |

In `rich` the single error sits at 0.73 while correct answers run down to 0.63.
No threshold separates them. With one error the calibration is unmeasurable in
any case — but the evidence there is says **do not plan on confidence catching
a bad slot assignment**. The review board and `gaps.md` stay the safety net.

### Cost

8 requests (one per board per arm), 68,562 input and 13,834 output tokens,
2,248 ms total. A single plan run would be 4 requests. Next to a render's
~1,391 image input tokens per reference, this is noise.

## 2. Reference screening — Noul, per candidate

Can a Noul flag a bad reference photo from metadata alone, before download?
39 accepted and 8 rejected URLs from the 651 Belmont review. Threshold 0.5.

| | run 1 | run 2 (finish asked only where a finish is specified) |
|---|---|---|
| metadata-visible defects caught | 3 / 3 | **3 / 3** |
| pixel-only defects caught | 2 / 5 | 2 / 5 |
| false positives | 11 / 39 | **3 / 39** |

The pre-registered hypothesis — catch the 3 metadata-visible rejects, miss the
5 pixel-only ones, flag none of the 39 — was right about the first two and
wrong about the third.

**Run 1's 11 false positives were all products with no required finish.** The
question asked whether the filename showed the product "in the required
finish"; for a tile or a Lightology numeric ID there is no finish and no
evidence either way, the model returned 0.2–0.4 for "the filename does not say",
and the policy code read that as a failure. Asking the finish question only
where a SKU carries a finish suffix drops false positives to 3 while keeping
every real catch.

**The 2 "pixel-only" catches are not detections.** The chrome-sink brand image
and the Porcelanosa placeholder card scored low for reasons the metadata cannot
justify; the same run passes two genuine text-overlay graphics. Treat them as
incidental.

**The 3 remaining false positives are the same "no evidence" problem**, now for
products that do have a required finish but filenames that carry none
(Lightology's `1040836.jpg`, Sonneman's `210032.jpg`). Separating "the evidence
contradicts the finish" from "there is no evidence" needs a third question and
policy that only flags on present-and-contradicting evidence. Not attempted.

25 requests, 25,247 input and 1,288 output tokens, 4,439 ms.

## 3. Baseline perturbation arm (no API)

`--perturb` rewrites each row the way a different person might write the same
schedule line — same product, finish and size, ordinary trade shorthand — and
re-scores the shipped regexes. The rewrites are listed verbatim in
`PERTURBED_NAMES`.

| naming | correct / 30 | wrong row in the slot | slot emptied |
|---|---|---|---|
| canonical (names written against `SLOT_RULES`) | 28 | 0 | 2 |
| plausible rewording | **15** | **7** | 8 |

The 7 wrong-row cases were the serious ones: an `alternative` substitute
captured the slot from the preferred product, so the board rendered a material
nobody selected and nothing in `gaps.md` said so.

### After holding substitutes back from automatic assignment

`assignSlots` now skips rows a project marked `alternative` and reports the slot
each was kept out of.

| naming | correct / 30 | wrong row in the slot | slot emptied |
|---|---|---|---|
| canonical, before → after | 28 → 28 | 0 → 0 | 2 → 2 |
| reworded, before → after | 15 → 14 | 7 → **0** | 8 → 16 |

The normal case is unchanged and every silent substitution is gone. The reworded
arm loses one more slot because Bath 2's tile board stops existing: its
wall/floor/accent gate had been satisfied by three alternatives, so the board
that disappeared was built on three materials nobody chose. Accuracy is not what
this buys — visibility is.

A second finding fell out of the live run: on the real 651 Belmont library the
regexes offer **"Sonneman Stiletto Vanity Light" as a `main_tile` candidate**,
because `main_tile` matches `/tile/i` and "Stiletto" contains t-i-l-e. It loses
only because the Seafoam tile is listed first.

## Reproducing

```bash
node --experimental-strip-types scripts/experiments/typesafe/slot-assignment.mjs
node scripts/experiments/typesafe/reference-screening.mjs
node --experimental-strip-types scripts/experiments/typesafe/slot-assignment.mjs --baseline-only --perturb
```

The key is read from `TYPESAFE_API_KEY` or from a git-ignored `.dev.vars` at the
repo root. Node 22.13+ is required; this machine has no Node installed, and
these runs used the stock v24.19.0 that ships inside Adobe Creative Cloud
Experience. That works but is not a toolchain anyone should depend on — install
Node properly before doing real work here.
