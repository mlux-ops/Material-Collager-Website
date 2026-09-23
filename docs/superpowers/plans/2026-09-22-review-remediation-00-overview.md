# Review Remediation — Overview and Triage

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This file is the index: it holds the verdicts, the cost strategy and the constraints every phase plan inherits. The tasks themselves live in the five phase plans listed under **Phase map**.

**Goal:** Close the defects in the 2026-09-22 adversarial review that survive verification, in the order that protects user decisions, stored output and paid work first, at the lowest implementation cost that still proves each fix.

**Architecture:** No rewrite. Each fix is the smallest change that closes the verified defect, backed by a regression test that fails before the fix. One shared test harness (a strict D1/R2 fake over `node:sqlite`) is built once in Phase 0 and reused by every storage test. Route handlers stay adapters; the new shared pieces are a board save queue, a guarded outbound fetch, and a dirty-channel helper for Workbench autosave.

**Tech Stack:** Node 22/24 (`node --experimental-strip-types`, `node:test`, `node:sqlite`, `module.registerHooks`), Next.js App Router via vinext on a Cloudflare Worker, D1, R2, React 19, zustand, @xyflow/react, React Three Fiber. No new dependencies.

**Source review:** `C:\Users\cowey\Downloads\material-collager-review-brief.md` (condensed), `.test-work/review-20260922/REVIEW.md` (full), proofs in `.test-work/review-20260922/*.mjs` and `E:\Games\Claude\higgsfield-tasks\.audit-worker2-20260922\`. Reviewed commit `271cbe9`.

---

## How the review was verified

Every numbered finding was checked against `271cbe9`. Five read-only agents ran in parallel, one per subsystem. The crux functions were then read directly before any code went into these plans. The reviewer's proof scripts were read to confirm what they actually exercised but were not run. Verdicts:

- **Confirmed:** the code path exists as described at the current lines.
- **Narrower:** the defect is real but smaller in scope than the review claims.
- **Deferred:** the code fact is true but the cost/benefit does not justify doing it now.

| ID | Verdict | What the fix actually needs (vs. the review's proposal) | Size | Plan · WP |
|---|---|---|---|---|
| R01 | Confirmed, **CLI-only** (the web board uses `crypto.randomUUID()`) | A persisted per-kind high-water mark in `nextRenderId`. Exclusive file creation and a recoverable manifest are unnecessary: the render queue runs one job at a time in one process. | S | 02 · 1A |
| R02 | Narrower: only the CLI review-server queue gate. The web board is content-addressed (sha256 + unique R2 keys). | A board-level `imageDigests` map stamped by `/api/replace-image` and folded into `selectionHash` **only for images that have one**, so every existing hash is unchanged (no mass staleness). | M | 02 · 1A |
| R03 | Confirmed | Store the enqueue-time source `{kind, id}` on the job and execute that record; 409 if it was removed. "Reject if changed" is worse: it would also block a harmless A→B→A re-pick. | S | 02 · 1A |
| R04 | Confirmed, and **more severe than stated**: both callers (manual Save to Library and auto-save-on-finish) omit model/quality/background, so real D1 rejects the insert on every call. The R2 object is written first and orphaned. | `?? null` on three derivations. | S | 02 · 1C |
| R05 | Confirmed | Deep-merge `notes` in the pending patch. The fix lives in an extracted, Node-testable save queue. An ordered revisioned patch queue is not needed: `notes` is the only nested field. | S | 02 · 1B |
| R06 | Confirmed; the realistic race is same-tab (an immediate dropdown save racing a debounced text save) | Field-scoped `UPDATE` plus `json_patch` for notes, in one `DB.batch` with `INSERT OR IGNORE`. No revision CAS: no client consumes a revision, and same-field last-write-wins is acceptable for this tool. | M | 02 · 1B |
| R07 | Confirmed. The render route re-reads board state from D1 on every request. | An awaitable `flush()` before the render POST that rejects on a failed save. No revision needs to travel with the render. | S | 02 · 1B |
| R08 | Confirmed | Put both `UPDATE`s in one `DB.batch` (a D1 batch is a transaction; precedent: `library-thumbs-store.ts`). No canonical-selection column. | S | 02 · 1B |
| R09 (Economy) | Confirmed | Insert a `submitting` row **before** the paid batch call, then record the batch id; a failed call marks the row failed with its job id. The client idempotency key is deferred. A durable queue is not warranted, and `waitUntil` is unreachable from vinext route handlers anyway. | S–M | 03 · 2A |
| R09 (web abort) | Confirmed | Thread `request.signal` into the internal `/api/generate` request (`/api/generate` already honours it). | S | 03 · 2A |
| R10 | Confirmed | Reuse the repo's existing streaming capped reader (`references/import/route.ts`) and pre-check base64 length before `atob`. No aggregate memory-budget system: no caller processes many images at once per request. | S–M | 03 · 2B |
| R11 | Confirmed, and **broader**: four fetch sites follow redirects before validating, and the older regex guard misses `[::1]`, `0.0.0.0` and metadata hosts. | One `fetchPublic` helper that uses `redirect: "manual"`, validates each hop with the existing `assertFetchableUrl`, caps hops at 5 and streams with a cap. DNS-resolution checks are out of scope: Workers has no resolver API. | M | 03 · 2B |
| R12 | Confirmed | Sniff bytes with the existing, tested `sniffImageType` and name the file by its real type. | S | 02 · 1C |
| R13 | Confirmed | Make the message report whether any reference was re-encoded, using the File identity `optimizeReferenceForTransport` already returns. No provenance manifest. | S | 04 · 3C |
| R14 | Confirmed | Extract the landing lightbox's existing focus save/restore + `inert` pattern into a hook and apply it to the Workbench dialogs. No Radix or React Aria. | M | 04 · 3B |
| R15 | Confirmed; drafts are safe (IndexedDB) | A `failed` state with Retry. | S | 04 · 3B |
| R16 | Confirmed | Explicit `id`/`htmlFor` from `item.uiKey`, with the help button outside the label; the 11px rule must follow the new markup. | S | 04 · 3C |
| R17 | Confirmed | Return early on `null`. | S | 04 · 3B |
| R18 | Confirmed; the delete order is already safe (project row last, every step idempotent) | A `window.confirm` naming the project (precedent: `GraphManager.tsx:128`). | S | 04 · 3A |
| R19 | Confirmed, on the landing page | A fetch deadline that falls back to the existing `"fallback"` state. | S | 04 · 3D |
| R20 | Confirmed | Scope the leftward tooltip override so the first grid column grows right; browser check at four viewports. No portal library. | S | 04 · 3C |
| P01 | Confirmed | Now: swap `currentNode()`'s O(N) scan for the `Map` already built. Measure first: selector/memo restructuring. | S / M | 05 · 4B |
| P02 | Confirmed | Measure first, then `frameloop="demand"` with explicit `invalidate()` wiring; needs manual QA of the six reference states. | M | 05 · 4C |
| P03 | Confirmed but **only reachable on `/dither-lab`**: no production caller holds a partial progress value | Deferred until a partial-progress caller exists. | — | 05 · deferred |
| P04 | Confirmed; **the identity half is a correctness bug**. Workbench builds every reference as `input.<ext>` with a same-millisecond `lastModified`, so same-size images can share one cached compressed output and a paid render can receive the wrong picture. | Now: key the transport cache on a content digest. Later: concurrency cap + byte budget. | S / S–M | 02 · 1D, 05 · 4D |
| P05 | Confirmed; the italic file (≈376 KiB) is preloaded on every page and used on one non-initial route | Now: `preload: false` for italic, and a save-data gate on the idle warm (keep the warm itself; it fixed a shipped regression). Skip the axis trim. | S | 05 · 4A |
| P06 | Confirmed | Bound the synchronous refresh to 2 jobs per GET and exclude rows with no batch id. No background processing. | S | 03 · 2A |
| P07 | Confirmed (two identical R2 objects per board draft) | **Skip**: it costs cents per year, and removing it changes what `/archive` shows. See Decisions. | — | deferred |
| P08 | Confirmed (serial executor) | Skip; the review itself sequences it last. | — | deferred |
| P09 | Confirmed; no API-cost saving (file-ID reuse doesn't cut image-token charges; the batch takes up to 24 h) | Optional path-keyed cache. | S | deferred |
| Autosave (review "validation target") | **Confirmed by code trace**: an older save's completion clears a newer edit's dirty flag, a graph switch then skips the save and reloads, and the edit is lost. | A generation-counting dirty channel: a save acknowledges only the edits it read. | S | 02 · 1D |
| Python retries (REVIEW.md, unnumbered) | Confirmed: `OpenAI()` defaults to 2 automatic retries, so an accepted-but-timed-out image edit can be billed again | `OpenAI(max_retries=0)` in both factories. | S | 03 · 2A |
| Release gate | Confirmed: `deploy.yml` runs no tests, lint or typecheck | A `verify` job that `deploy` needs, plus a no-new-errors typecheck gate. | S | 01 · 0 |
| Baseline | TS2688 comes from a stale install: `@cloudflare/workers-types` is declared and locked but absent from `node_modules` | `npm ci`, then re-baseline. | S | 01 · 0 |
| Lower-priority UI | Located | Now: Dither Lab autoplay (one line), duplicate lab grain (one line), Spotlight `role="listbox"` removal. Later: review-board tab semantics. Deferred: Inspector typed editors. | S | 04 |

Also noted:

- **Stale reviewer script:** `.test-work/review-20260922/format-reproduce.mjs:38` expects HTTP 200. That predates R04; the authoritative result is `storage-lifecycle-repros.mjs:67` (HTTP 400, parameter 13).
- **Test count:** `npm run test:transitions` runs 466 tests per `CLAUDE.md`; the brief reports 719. Phase 0 records the real number.

---

## Phase map

```
Phase 0  Foundation ─────────────┐   (baseline, strict D1/R2 fake, CI gate)
                                 ▼
Phase 1  Data integrity          WP-1A CLI render identity   ─┐
         (parallel-safe WPs)     WP-1B Web board saves        ├─ disjoint files
                                 WP-1C Library save           │
                                 WP-1D Workbench identity    ─┘
                                 ▼
Phase 2  Paid work & ingestion   WP-2A Paid attempts   WP-2B Outbound fetch
                                 ▼
Phase 3  UI recovery & a11y      WP-3A Review boards  WP-3B Workbench  WP-3C Generator  WP-3D Landing/labs
                                 ▼
Phase 4  Performance (measure-first)  WP-4A Fonts/warm  WP-4B Workbench  WP-4C Canvas  WP-4D Transport
```

| Plan file | Work packages | Depends on |
|---|---|---|
| `2026-09-22-review-remediation-01-foundation.md` | WP-0 | — |
| `2026-09-22-review-remediation-02-data-integrity.md` | WP-1A, 1B, 1C, 1D | WP-0 (1B and 1C use the fake D1/R2) |
| `2026-09-22-review-remediation-03-paid-work-and-ingestion.md` | WP-2A, 2B | WP-0; 2A after 1C (same `generation-jobs` harness) |
| `2026-09-22-review-remediation-04-ui-recovery-a11y.md` | WP-3A–3D | WP-1B before 3A (both edit review-board components) |
| `2026-09-22-review-remediation-05-performance.md` | WP-4A–4D + deferred list | WP-1D before 4D (same transport module) |

Phases 0–2 hold every P1 finding, and every step in them has complete code. Phase 3 has complete code for all fixes, and each fix ends with a browser verification step because no test renders a React component. Phase 4 is **measure first** on purpose. The M-sized performance changes (P01 selectors, P02 demand rendering) start with a measurement task and continue only if the number justifies them. Code written for them now would be speculation and would rot while Phases 1–3 land.

---

## Cost strategy

### Model routing

| Work | Model | Why |
|---|---|---|
| Phase 0 install/baselines, CI YAML, one-line UI fixes (R17, grain, autoplay), doc updates, running suites and summarising failures | Haiku 4.5 | Mechanical; the exact commands and code are in the plan |
| Implementing tasks whose complete code is in the plan (most of Phases 1–3) | Sonnet 5 | Place the given code, run the tests, fix small mismatches |
| Per-task spec-compliance check | Same model as the implementer | A checklist against the task's acceptance criteria |
| Code-quality review at the end of WP-1B, 1D, 2A and 2B (concurrency, transactions, paid-call ordering, SSRF) | Opus 5.5 | Interleaving and security reasoning |
| Measure-first design for P01 selectors and P02 | Opus 5.5 | The design depends on what the measurement shows |
| Final review of each phase before merge | Opus 5.5 | One diff-level pass per phase |

### Session and context discipline

- **One implementer session per work package, not per task.** A WP's tasks touch the same files, so one session reads them once. The per-task commit and spec check still happen inside the session.
- Implementers receive only their WP section plus this file's **Global Constraints**. The plan quotes the current code of every function it changes, so an implementer should not need to read files beyond the WP's **Files** list.
- Test cadence:
  - After each task: the task's own test file.
  - At the end of each WP: the WP's suite script.
  - Once per phase: `node --experimental-strip-types --test --test-reporter=dot tests/*.test.mjs`, `npm run lint`, and `node scripts/typecheck-baseline.mjs`. The dot reporter keeps passing output to one line and still prints failures in full.
- Reviewers receive `git diff <wp-base>..HEAD` and the task text, not whole files.
- WP-1A to WP-1D touch disjoint files. Run them as parallel git worktrees if wall-clock matters; the token cost is the same either way.

### Paid-API guardrails

- There is no real `OPENAI_API_KEY` on disk (`.dev.vars` is a placeholder). Every test mocks the network (`t.mock.method(globalThis, "fetch", …)`).
- Everything in Phases 0–2 can be verified for free. Save to Library makes no OpenAI call. The CLI review server runs against a mocked Worker. Economy runs against mocked batch endpoints.
- **At most one paid check in the whole plan:** a single low-quality board draft (~$0.016) after WP-1B. It runs only if the user explicitly says yes, and it can be skipped.

### What this plan deliberately does not build

These are the review's proposals that verification showed to be unneeded for this codebase (YAGNI): revision compare-and-swap for board state, a canonical selected-render column, exclusive file creation for CLI renders, a durable job queue or cron, aggregate per-isolate memory budgets, a typed internal generation service (P07), provenance manifests (R13), Radix/React Aria, a collision-aware tooltip library, and bounded DAG concurrency (P08). Each is listed with its reason in `05-performance.md → Deferred and not planned`, so a later reader can revisit it deliberately.

---

## Global Constraints

Every task in every phase plan implicitly includes these.

- **Node:** `engines` is `>=22.13.0`, but any test importing `tests/helpers/fake-worker-env.mjs` needs `module.registerHooks` (Node ≥ 22.15). `tests/image-routes.test.mjs` already requires it. CI uses `node-version: 22`; local is v24.
- **Strip-types only:** anything a test imports must use erasable TypeScript (no `enum`, `namespace`, decorators or constructor parameter properties), and type-only imports must be `import type` (`verbatimModuleSyntax`). Relative imports in `.ts` files that tests load must carry the `.ts` extension. Node's strip-types cannot load `.tsx`, so logic that needs tests must live in `.ts` modules.
- **Shared core:** files under `app/lib/autoboard/` must not use `node:` builtins, the `@/` alias or extensionless imports (`tests/autoboard-parity.test.mjs` enforces this).
- **No new npm dependencies.**
- **No paid API calls** in tests or during implementation (see Paid-API guardrails). Nothing auto-retries a paid render.
- **Autoboard defaults unchanged:** drafts render `low`/`standard`, confirm `medium`/`standard`, final `high`/`final`. Variants stay `soft_daylight` + `materials_only`; never change `DEFAULT_VARIANTS`. Automated QA stays opt-in (`--qa`).
- **`scripts/autoboard/lib/review-page.mjs`** is one template literal. No backticks or escaped double quotes inside its embedded JS, comments included. Run `node --check scripts/autoboard/lib/review-page.mjs` after any edit. No task in this plan edits it.
- **UI fidelity:** follow `AGENTS.md`. Measure the running app, not `globals.css`. The live scale is 8.4px uppercase labels/buttons, 10px sub text, 11px body/controls and 14px headings; nothing is larger than 14px. Chrome text is black or `#657069`; teal is reserved for state. CSS-affecting changes get the four-viewport check (1440×900, 1280×800, 1024×768, 390×844).
- **Typecheck** is a no-new-errors gate: `node scripts/typecheck-baseline.mjs` (created in Phase 0) must pass.
- **Shell:** commands are written for bash (Git Bash on Windows). Do not start dev servers with Bash; use the Browser preview tool with the `material-collager-dev` launch configuration (port 3000).
- **Local dev gate:** `npm run dev` answers 403 unless `.dev.vars` blanks `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` (see `.dev.vars.example`).
- **Secrets:** never log or print API keys, Access tokens or raw private references.
- **Style:** match the surrounding code's comment density, naming and idiom. Comments explain why, as the existing ones do.
- **Commits:** one commit per task, conventional prefix (`fix:`, `test:`, `perf:`, `ci:`, `docs:`). The commit blocks in the phase plans end with `Co-Authored-By: <model trailer>`. Replace it with the trailer of the model that wrote the change, for example `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`, or for orchestrator commits `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push, open PRs or deploy without the user's explicit go-ahead.

---

## Decisions (defaults applied unless the user says otherwise)

1. **Nested clone.** `./Material-Collager-Website/` is an untracked independent clone inside the repo. tsconfig's `**/*.ts` include and `eslint .` both scan it, so local numbers include a second copy of the app. **Default:** Phase 0 stops and asks the user to move it outside the repo; nothing deletes it.
2. **P07 (board drafts double-stored).** **Default:** keep the current behaviour. Board drafts stay visible in the generic history/archive, and the second copy costs cents per year. Say so if board drafts should *not* appear in `/archive`; the fix is then a small `skipHistory` flag (sketched in the deferred list).
3. **Release gate.** **Default:** add a `verify` job that blocks `deploy` on failing tests/lint/typecheck-regression. This changes production deploy behaviour, so a red test stops a push to `main` from deploying.
4. **Economy idempotency key.** **Default:** deferred. Record-before-submit closes the demonstrated "paid but untracked" gap; a client-minted key is a later, separate change.
5. **Same-field concurrent edits on a board** (two people typing the same instruction at once). **Default:** last write wins. Disjoint edits are made safe in WP-1B.

---

## Execution handoff

Recommended: **subagent-driven**, one fresh implementer per work package (model per the routing table), a spec check per task, and an Opus review at the end of each WP flagged above. Start with `01-foundation.md`.
