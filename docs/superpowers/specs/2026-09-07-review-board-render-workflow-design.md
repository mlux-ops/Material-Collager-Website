# Review board render workflow — design

Date: 2026-09-07
Status: approved in conversation, awaiting written review
Scope: `scripts/autoboard/` (local review tooling). No change to the deployed app.

## Goal

Complete the whole autoboard workflow from the local review board at
`http://127.0.0.1:4173`: select items, send for drafts, pick a draft, add
notes/instructions, send for a confirmed (medium) render, send for the final
(high) render — with a live draft / confirmed / final viewer beside every
board's slot cards. Today only item selection happens in the board; every
render step is a CLI command.

Confirmed decisions:

- Prompt input is **both** per-item notes (on each slot card) and a
  board-level instruction (in the panel).
- Drafts: choose variant **A, B or C**, then a free **count** (1–10) of drafts
  of that variant.
- Confirm is **optional**: Final may start from a picked draft or an approved
  confirmed render.
- Renders run through **one server-side queue**, strictly one at a time
  across boards; the page stays usable while it runs.
- Draft **history is kept**: earlier revisions collapse but remain pickable.
- Cost guard: a confirm dialog **only for Final**; drafts and confirm fire
  immediately, with an approximate cost on the button label.
- **Local first.** Hosting the board on the deployed site is a follow-up (see
  "Later phases").
- Automated QA stays **opt-in** (checkbox, off by default) — the user is the QA.

## Architecture

```
scripts/autoboard/
  cli.mjs                 thin: arg parsing; generate/redraft/confirm/finalize call lib/render.mjs
  lib/render.mjs          NEW  payload builders, postGeneration, result recording, cost table
  lib/render-queue.mjs    NEW  in-process FIFO with progress, cancel, held/resume, persistence
  lib/access.mjs          NEW  (moved from cli.mjs) Cloudflare Access credential discovery, waitForServer
  lib/review-server.mjs   + render endpoints; owns one RenderQueue per run
  lib/review-page.mjs     + render panel per board, status polling, lightbox
```

Rules that do not change: drafts render at quality `low` / resolution
`standard`; confirm at `medium` / `standard` with the picked draft as the
approved-draft layout reference; final at `high` / `final` with the picked
draft or approved confirmed render as layout reference and `renderKind:
"final"` so it lands in the site Library. Variants keep `soft_daylight` +
`materials_only`. The CLI and the panel call the same functions, so behaviour
cannot diverge.

The review server takes `--base-url` (default: the deployed Worker) and
resolves Access credentials once at startup using `lib/access.mjs`. An
expired `cloudflared` session is reported in the status payload
(`accessError`) and disables render buttons with the login command shown;
it never fails click by click.

### `lib/render.mjs`

Pure functions except `postGeneration`:

- `selectionHash(board)` — stable hash of `[slotId, images, note]` per item
  plus the board instruction; used for stale detection and revision bumps.
- `buildDraftPayload(board, variant, { instruction, qa })`,
  `buildConfirmPayload(board, variant, sourceRender, {...})`,
  `buildFinalPayload(board, variant, sourceRender, {...})` — return
  `{ payload, files }` already passed through `validateCollageRequest`.
  Per-item notes come from `item.note`. The collage request has no
  board-level notes field (only per-item `notes`), so the board instruction
  is appended to the **hero item's** notes as `Board instruction: <text>` —
  the hero is always first in payload order. A request-level field in the app
  is a follow-up that needs a deploy.
- `postGeneration(baseUrl, payload, files, { accessHeaders, signal })` —
  moved from `cli.mjs` unchanged in behaviour (reference resize-on-upload,
  Access 302/403 detection, `retryAfterMs` on the thrown error), plus an
  `AbortSignal`.
- `recordDraft / recordConfirmed / recordFinal(results, boardId, record)` —
  append to `results.renders[boardId]`, bump revision when the hash changed,
  and mirror the picked draft into `results.candidates["<board>--<variant>"]`.
- `estimateCost(kind, quality, size, count)` — constant table, labelled
  approximate.

### `lib/render-queue.mjs`

- `enqueue(job)` → `{ jobId, position }`; runs jobs strictly FIFO, one at a
  time. A draft job with `count: n` is one job with progress `i/n`; each
  finished draft is recorded as it lands.
- `cancel(jobId)`: queued → removed; running → `AbortController.abort()`,
  job ends `cancelled after i of n`, drafts already saved are kept.
- Failure records `{ message, code, status, retryAfterMs, diagnostics }` on
  the job and continues with the next job. Nothing auto-retries.
- Access failure (302/403) sets a queue-wide `accessError`; remaining jobs
  move to `held`. `resume()` re-checks credentials and releases them.
- Queue state is persisted in `results.json` (`queue`). On restart a job
  found `running` becomes `interrupted` and is never re-run silently;
  `queued`/`held` jobs stay as they were.
- Emits status snapshots the server serves; no websockets — the page polls.

## Data model (`autoboard-runs/<run>/results.json`)

```jsonc
{
  "candidates": { "penthouse-bath-2-fixture--A": { /* unchanged, CLI compatibility */ } },
  "finals": { /* unchanged */ },
  "renders": {
    "penthouse-bath-2-fixture": {
      "instruction": "more breathing room, tile lower-left",
      "pickedDraftId": "d-0007",
      "approvedConfirmedId": null,
      "drafts": [
        {
          "id": "d-0007", "variant": "A", "revision": 3, "index": 2,
          "path": "boards/penthouse-bath-2-fixture/drafts/d-0007.png",
          "jobId": "<worker job id>", "createdAt": "2026-09-07T…", "durationMs": 24000,
          "selectionHash": "9f3a…",
          "instruction": "…", "itemNotes": { "shower_head": "…" },
          "qa": null
        }
      ],
      "confirmed": [ { "id": "c-0002", "fromDraftId": "d-0007", "…": "same fields" } ],
      "finals":    [ { "id": "f-0001", "fromRenderId": "c-0002", "libraryJobId": "…", "…": "same fields" } ]
    }
  },
  "queue": [
    { "jobId": "q-…", "boardId": "…", "kind": "draft", "variant": "A", "count": 3,
      "state": "running", "progress": "2/3", "startedAt": "…", "error": null }
  ]
}
```

- `revision` increments per board whenever `selectionHash` differs from the
  latest draft's; drafts sharing a revision group together in the panel.
- Stale is computed: `draft.selectionHash !== selectionHash(board)`.
- Per-item notes live on `plan.json` items as `item.note`. Existing
  `notes.json` files are imported once into `item.note` when the server first
  opens a run, then ignored.
- Picking a draft mirrors `{ savedPath, revision, jobId, renderKind: "studio",
  status: "ok" }` into `candidates["<board>--<variant>"]` so
  `npm run autoboard -- finalize <board>--<variant>` keeps working and points
  at the same draft. Confirmed renders set `candidate.confirmedAt`; finals
  write `finals[...]` exactly as today.
- Render PNGs go under `boards/<boardId>/drafts|confirmed|finals/<id>.png`.
  The legacy `boards/<boardId>/<variant>.png` written by the CLI keeps being
  written for the picked draft (it is what the CLI reads as the approved
  draft).

## Server endpoints (`review-server.mjs`)

| Endpoint | Body | Effect |
|---|---|---|
| `POST /api/render` | `{ boardId, kind: "draft"\|"confirm"\|"final", variant?, count?, qa? }` | Validates: board exists; draft needs `variant` ∈ A/B/C and `count` 1–10; confirm needs a picked draft; final needs a picked draft or approved confirmed render whose `selectionHash` matches the board now. Snapshots selection, notes and instruction at click time; enqueues; returns `{ jobId, position }`. |
| `GET /api/render-status` | — | `{ accessError, queue, renders, costTable }` — one payload for the whole run. |
| `POST /api/render-cancel` | `{ jobId }` | Cancel as described in the queue section. |
| `POST /api/render-resume` | — | Re-check Access credentials; release held jobs. |
| `POST /api/pick-draft` | `{ boardId, draftId }` | Sets `pickedDraftId`; mirrors into `candidates`. |
| `POST /api/approve-confirmed` | `{ boardId, confirmedId \| null }` | Sets or clears `approvedConfirmedId`. |
| `POST /api/instruction` | `{ boardId, instruction }` | Saves the board instruction. |
| `POST /api/item-note` | `{ boardId, slotId, note }` | Saves `item.note` into `plan.json`. |
| `GET /render-image/<boardId>/<kind>/<file>` | — | Serves render PNGs; path is resolved and checked to stay inside the run's `boards/` directory. |

All existing endpoints stay. Errors return `{ ok: false, error }` with a 4xx
status, consistent with the current server.

## UI (`review-page.mjs`)

Right column of every board section; the slot grid keeps the left.

**Header row:** variant toggle `A | B | C` (default: last used for that
board, else A) · count stepper 1–10 (default 3) · **Draft ▶** labelled with
count and approximate cost (`Draft ×3 · ~$0.05`) · QA checkbox (off) ·
⏹ cancel, visible only while this board has a queued or running job.

**Status line:** `queued (2 ahead)` · `rendering draft 2 of 3 · 24 s` ·
`done 14:02` · `failed: <message>` (for a 429, a countdown from
`retryAfterMs`) · `cancelled after 2 of 5` · `interrupted (server restarted)`
· `Access session expired — run cloudflared access login <url>` with a
**Resume** button.

**Drafts strip:** current revision's thumbnails in a row, newest right, each
badged with variant letter and index. Click opens a lightbox (full size,
←/→ between drafts of the board, Esc closes). A radio-style **pick** on each
thumbnail; the picked one shows a tick and border. Older revisions collapse
under `earlier drafts (rev 1 · 3)` and remain pickable. A draft whose
`selectionHash` no longer matches shows a grey **stale** ribbon. A draft
rendered with an instruction or notes shows a 💬 badge whose tooltip is that
text.

**Instruction + notes:** one-line textarea for the board instruction under
the strip, autosaved on blur. Each slot card on the left gains a small note
field, autosaved on blur. Both are read at click time and stamped into the
render record.

**Confirm ▶ / Final ▶ row:** Confirm enabled when a draft is picked (stale
allowed). Final enabled when a picked draft or an approved confirmed render
exists and that source is not stale; approved-confirmed wins as the layout
source. Final opens the single confirmation dialog: "Render final at high
quality, <size>, ~$X, from <source>? It will appear in the site Library."
Drafts and Confirm fire immediately.

**Confirmed / Final strips:** same thumbnail treatment. Confirmed thumbnails
carry an **approve** toggle (one approved at a time). Final thumbnails carry
a 🔗 opening the Library entry on the deployed site by `libraryJobId`.

**Polling:** `GET /api/render-status` every 2 s while anything is queued or
running, otherwise every 15 s. Only panels whose data changed re-render, so
the slot grid being edited never flickers. A header badge shows
`Rendering: Bath 3 · 2 queued`.

Implementation note for this file: it is one template literal containing the
client-side JavaScript. Backticks and escaped double quotes inside the
embedded script — including inside comments — corrupt the served page.
`node --check` on the whole file is mandatory after every edit.

## Errors, cancellation, cost

- Worker/OpenAI failure: job → `failed` with message, `code`, `retryAfterMs`
  and attempt diagnostics; queue continues; nothing auto-retries.
- Cancel: queued → removed; running → abort in-flight fetch (the Worker
  cancels upstream). Saved drafts of that batch are kept.
- Access expiry mid-run: first 302/403 fails that job with `accessError`,
  remaining jobs are `held`; **Resume** re-checks and releases.
- Restart: running → `interrupted`; queued/held unchanged.
- Stale guard applies to Final only.
- Costs are approximate constants in `render.mjs`; no live pricing lookup.
- Access tokens and the OpenAI key never appear in status payloads or logs.

## Testing

- `render.mjs`: payload builders for draft/confirm/final at each quality;
  layout-reference wiring; notes and instruction injection; `selectionHash`
  stability and sensitivity; record functions incl. the `candidates` mirror.
  Pure, no network.
- `render-queue.mjs`: FIFO order; progress events; cancel queued vs running
  (fake worker); a failure does not stop the queue; held/resume on Access
  error; restart marks `interrupted`.
- `review-server.mjs`: every new endpoint against a scratch run directory
  with a mocked `postGeneration` — validation errors, pick/approve/
  instruction/note persistence, `notes.json` import, image path traversal
  rejected.
- CLI: existing dry-run tests for `generate`/`redraft`/`confirm`/`finalize`
  keep passing against the extracted library (no behaviour drift).
- `review-page.mjs`: `node --check` on the whole file plus a smoke test that
  the served HTML contains the panel markup.
- Manual: one real 1-draft render through the panel against the deployed
  Worker before the feature is called done.

## Out of scope / later phases

- **Phase 2 — "Boards" tab on the deployed site (read-mostly):** the review
  server syncs run plan and render metadata to D1 and PNGs to R2 after each
  action; a site tab shows each board's draft / confirmed / final strips with
  pick and approve working (D1 only). Render buttons still require the local
  server (reference photos and the Access session live locally). Every
  render record already carries `jobId` = the Library's D1 id to join on.
- **Phase 3 — fully hosted:** upload the library photo pool to R2, move slot
  matching to the Worker, and obtain a Smartsheet API token so the Worker
  can read the sheet. Only then can plan generation leave this machine.
- Not planned: cron/scheduled runs, Smartsheet writes, economy/batch
  finalize (blocked upstream, see memory), multiple concurrent renders.
