# Review Remediation — Phase 4: Performance (Measure First), Docs, and the Deferred List

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- Land the performance changes that are cheap and safe without measurement: the executor lookup (P01-a) and the transport concurrency cap with a byte budget (P04-b).
- Measure before touching the rest: font preload (P05), Workbench drag cost (P01-b) and landing-canvas idle frames (P02).
- Bring the docs in line with Phases 0–3.
- Record everything deliberately not done, with the reason.

**Architecture:** The review measured no performance; it made proposals. Every task below that could change visible behaviour starts with a measurement and a written decision rule. It proceeds only if the number clears the bar. The measure-first tasks do not carry pre-written implementation code on purpose. Their design depends on the measurement, and code written now would rot while Phases 1–3 land. When a measurement clears its bar, the orchestrator (Opus) writes that task's detailed steps into this file before an implementer starts.

**Tech Stack:** Browser preview (`material-collager-dev`), `javascript_tool` for in-page measurement (`PerformanceObserver`, rAF counting), `node:test`.

**Inherits:** every rule in `2026-09-22-review-remediation-00-overview.md → Global Constraints`. Requires Phase 1 (WP-1D shares `image-transport.ts`).

**Model routing:**

| Task | Model |
|---|---|
| 4A.1, 4B.1, 4D.1 | Sonnet 5 |
| Measurements 4A.0, 4B.2, 4C.1 | Haiku 4.5 (scripted, numbers only) |
| Decisions and any follow-on design | Opus 5.5 |
| 4E.1 docs | Haiku 4.5 |

## Global Constraints

- **Measure first:** each measurement runs on the same fixture before and after, in the same preview session, and is recorded in `.test-work/perf/<task>.md` (local, git-ignored) with the numbers.
- Performance work must not change rendering. The landing scene's six reference states and the ViewTransition path stay pixel-equivalent (see `AGENTS.md` and `docs/visual-qa.md`).
- Keep what already works: scratch-vector reuse and texture disposal in the scene, `ImageBitmap.close()` in transport, and the completed-state `<img>` hand-off in `DitherReveal`.

---

## WP-4A — Font delivery (P05)

### Task 4A.0: Measure what the first visit actually preloads

- [ ] **Step 1:** Run `npm run build`. Expected: exit 0.
- [ ] **Step 2:** Count the font preloads the built landing page emits:
```bash
grep -rhoE '<link[^>]+rel="preload"[^>]+as="font"[^>]*>' dist/ | sort -u
```
If the build output has no static HTML to grep, open `/` in the preview instead and run `[...document.querySelectorAll('link[rel="preload"][as="font"]')].map((l) => l.href)`.
- [ ] **Step 3:** Record the hrefs in `.test-work/perf/4A.md`.

**Decision rule:**
- **Exactly one preload, the regular face:** stop. P05 is already satisfied; mark it done.
- **Two preloads (regular and italic):** continue to Task 4A.1. The italic (~376 KiB) is used only at `app/components/review-boards/review-boards.module.css:483`.

### Task 4A.1: Preload only the regular Inter face (only if 4A.0 found two)

**Files:**
- Modify: `app/layout.tsx:8-24` (the `localFont` call) and the root layout's returned `<html>`
- Create (only if typecheck needs it): `app/url-imports.d.ts`

`next/font/local` has one `preload` switch per call. Splitting regular and italic into two calls would create two font families and silently turn the italic into a synthesized oblique. So both faces stay in one call with `preload: false`, and the regular face is preloaded by hand through a Vite `?url` import (vinext is Vite-based).

- [ ] **Step 1: Implement**

In `app/layout.tsx`, add to the imports:
```tsx
import interRegularUrl from "./fonts/InterVariable.woff2?url";
```
Add `preload: false,` as the last property of the `localFont({ … })` call, with this comment above it:
```tsx
  // Both faces preloading made every first visit fetch the ~376 KiB italic,
  // which one review-board label uses. The regular face is preloaded by hand
  // in <head> below; the italic loads on first use.
  preload: false,
```
Inside the root layout's `<html …>`, before `<body>`, add (or extend an existing `<head>` with):
```tsx
      <head>
        <link rel="preload" href={interRegularUrl} as="font" type="font/woff2" crossOrigin="" />
      </head>
```
If `node scripts/typecheck-baseline.mjs` then reports a new error for the `?url` import, create `app/url-imports.d.ts`:
```ts
// Vite resolves `?url` imports to the asset's final (hashed) URL.
declare module "*?url" {
  const url: string;
  export default url;
}
```

- [ ] **Step 2: Verify the preload is the file the page actually uses**

Run `npm run build`, then open `/` in the preview and compare:
```js
(() => ({
  preloads: [...document.querySelectorAll('link[rel="preload"][as="font"]')].map((l) => l.href),
  faces: [...document.styleSheets].flatMap((s) => { try { return [...s.cssRules]; } catch { return []; } })
    .filter((r) => r instanceof CSSFontFaceRule).map((r) => r.style.getPropertyValue("src")),
}))()
```
Expected:
- Exactly one preload.
- Its href appears in the regular face's `src`.
- The italic still has an `@font-face`, but it is not preloaded.

**Stop rule:** if the preload href doesn't match a face `src` (a double download), revert this task, record why in `.test-work/perf/4A.md`, and mark P05 "not worth it on vinext".

- [ ] **Step 3: Fidelity check**

Text on `/`, `/generator` and `/workbench` renders in Inter with no fallback flash beyond what `display: swap` already allowed. On the review-board element at `review-boards.module.css:483`, italic still uses the true italic face: `document.fonts.check('italic 11px Inter')` resolves after first use.

- [ ] **Step 4: Commit**

```bash
git add app/layout.tsx app/url-imports.d.ts
git commit -m "perf: preload only the regular Inter face

Both variable faces were preloaded on every first visit, though the
italic is used on one review-board label. Preload the regular face by
hand and let the italic load on use.

Co-Authored-By: <model trailer>"
```
(`git add` of a file that doesn't exist fails, so drop `app/url-imports.d.ts` from the command if it wasn't created.)

---

## WP-4B — Workbench graph work (P01)

### Task 4B.1: The cost and blocker passes look nodes up in their own snapshot (P01-a)

**Files:**
- Modify: `app/components/workbench/executor.ts:296` and `:336`; add `snapshotNode` after `currentNode` (line ~41)
- Test: the existing `tests/workbench-cost.test.mjs` and the rest of the workbench suite (behaviour must not change)

`estimateStaleCost` and `unmetRequiredInputs` build `context.nodes`, a `Map` of the same store snapshot. They then call `currentNode(id)`, which scans the live store array: O(N) per scheduled node, on every render of the Run Workflow button, drags included. The run path (lines 48, 65, 76, 116, 200, 240) deliberately reads the **live** store during execution and is **not** changed.

- [ ] **Step 1: Confirm the current behaviour is covered**

Run: `npm run test:workbench`

Expected: PASS. Note the count.

- [ ] **Step 2: Implement**

Directly after `currentNode`, add:
```ts
// The estimate and blocker passes read one snapshot (their GraphContext), so
// they look nodes up there. currentNode scans the live store array — O(N) per
// scheduled node — and these passes run on every render of the Run Workflow
// button, drags included. Execution keeps using currentNode: it must see
// statuses that change mid-run.
function snapshotNode(context: GraphContext, id: string): WorkbenchNode {
  const node = context.nodes.get(id);
  if (!node) throw new Error("A connected node was removed mid-run.");
  return node;
}
```
In `estimateStaleCost`, replace `    const node = currentNode(id);` with `    const node = snapshotNode(context, id);`. Do the same in `unmetRequiredInputs`. Those are the two occurrences at lines ~296 and ~336. Leave every other `currentNode(` call unchanged.

- [ ] **Step 3: Run the suite**

Run: `npm run test:workbench && node scripts/typecheck-baseline.mjs`

Expected: PASS with the same count; the gate exits 0.

- [ ] **Step 4: Commit**

```bash
git add app/components/workbench/executor.ts
git commit -m "perf(workbench): look nodes up in the snapshot when estimating cost

estimateStaleCost and unmetRequiredInputs built a Map of the store
snapshot and then scanned the live nodes array per scheduled node.
Execution still reads the live store.

Co-Authored-By: <model trailer>"
```

### Task 4B.2: Measure drag cost on a large graph before restructuring subscriptions (P01-b)

The review's larger P01 change — selectors that ignore position, `nodeById` maps, topology-keyed edge decoration — is M-sized and touches `WorkbenchApp.tsx` and `nodes/shared.tsx`. Templates hold 4–8 nodes, and import caps at 300 (`export-import.ts:57`). Whether real graphs are big enough to matter is unknown, so measure first.

- [ ] **Step 1: Build fixtures.** Write a throwaway script `.test-work/perf/make-graph.mjs` (git-ignored) that emits Workbench export JSON with 50, 100 and 200 nodes. Use a chain of `imageEdit` nodes, with every fifth node a `photo` source, wired in sequence. Take the shape from `tests/workbench-export-import.test.mjs`'s fixtures and validate each file with the importer's validator (`tests/workbench-import-validator.test.mjs` shows the call).
- [ ] **Step 2: Measure.** In the preview, import the 100-node graph. Start a long-task observer:
```js
window.__long = []; new PerformanceObserver((l) => window.__long.push(...l.getEntries().map((e) => e.duration))).observe({ type: "longtask", buffered: false });
```
Then drag one node for about 2 s with `computer {action:"left_click_drag"}`, and read `({ count: __long.length, total: __long.reduce((a, b) => a + b, 0) })`. Repeat for 50 and 200 nodes. Record the numbers in `.test-work/perf/4B.md`.
- [ ] **Step 3: Decide.**

**Decision rule:**
- **Long tasks during a 2 s drag of the 100-node graph total under 200 ms:** stop. P01-b is not worth doing; record that.
- **Otherwise:** the orchestrator (Opus) writes Task 4B.3 into this file. The design uses the measurement and the review's P01 notes (`REVIEW.md → P01`). Keep it within these bounds:
  - a memoized `nodeById` in `WorkbenchApp`;
  - a topology key (edge ids + node kind/status, excluding position) for `coloredEdges`, `terminalIds`, cost and blockers;
  - `useStore` selectors with a custom equality in `nodes/shared.tsx`'s four hooks.

  Acceptance: same fixtures, same drag, total long-task time at least halved, and `npm run test:workbench` green.

---

## WP-4C — Landing canvas idle frames (P02)

### Task 4C.1: Measure frames rendered at rest

- [ ] **Step 1:** Open `/` in the preview, wait for the veil to lift, then wait 5 s without input.
- [ ] **Step 2:** Count animation frames requested over 2 s at rest. R3F's loop re-requests a frame every tick, so wrapping `requestAnimationFrame` now catches it:
```js
await new Promise((resolve) => {
  let frames = 0;
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => { frames += 1; return raf(cb); };
  setTimeout(() => { window.requestAnimationFrame = raf; window.__idleFrames = frames; resolve(); }, 2000);
});
window.__idleFrames
```
- [ ] **Step 3:** Record the number in `.test-work/perf/4C.md`.

**Decision rule:**
- **Under 10 frames in 2 s at rest:** stop; the scene already idles.
- **Otherwise** (the review expects about 120 with `frameloop="always"`): the orchestrator (Opus) writes Task 4C.2, a `frameloop="demand"` change with the following bounds:
  - Call `invalidate()` from `useNativeScrollProgress`'s handlers and from `SceneCard`'s pointer handlers.
  - Keep invalidating from the spring's `useFrame` while unsettled.
  - Preserve `onFirstFrame`/`FirstFramePing` and the `?qa=1&progress=X` freeze.

  Its acceptance:
  - (a) under 10 frames per 2 s at rest;
  - (b) scroll, hover and resize restart motion immediately;
  - (c) the six reference states (`?qa=1&progress=…` per `docs/visual-qa.md`) and the ViewTransition entry are screenshot-equivalent before and after;
  - (d) `tests/transitions-*.test.mjs` pass.

  This one needs the user's sign-off on the visual comparison before merge.

---

## WP-4D — Transport memory (P04-b)

### Task 4D.1: Bound concurrent reference preparation and cap the cache by bytes

**Files:**
- Modify: `app/lib/image-transport.ts` (`optimizeReferencesForTransport`; `transportCache` / `TRANSPORT_CACHE_LIMIT` and their use in `optimizeReferenceForTransport`)
- Test: `tests/image-transport-cache.test.mjs` (append)

**Why now, without measuring:** each over-budget reference is decoded to a full `ImageBitmap` on the main thread. A 24 MP photo decodes to about 96 MB. A 16-reference Final prepares them all at once, and a Chromium tab's renderer can fall over well before 1.5 GB. A limit of 2 costs a little wall-clock on a path that runs once per Final.

**Interfaces:**
- Produces:
```ts
export const TRANSPORT_CONCURRENCY = 2;
export function mapWithLimit<T, R>(items: T[], limit: number, run: (item: T, index: number) => Promise<R>): Promise<R[]>;
export function createByteBudgetCache(limitBytes: number): { get(key: string): File | undefined; set(key: string, file: File): void; readonly bytes: number };
```

- [ ] **Step 1: Write the failing tests**

Append to `tests/image-transport-cache.test.mjs`, and add `mapWithLimit, createByteBudgetCache` to the file's import from `../app/lib/image-transport.ts`:
```js
test("mapWithLimit keeps order and never runs more than `limit` at once", async () => {
  let running = 0;
  let peak = 0;
  const results = await mapWithLimit([30, 10, 20, 5, 15], 2, async (ms, index) => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, ms));
    running -= 1;
    return index;
  });
  assert.deepEqual(results, [0, 1, 2, 3, 4]);
  assert.equal(peak, 2);
});

test("the transport cache evicts oldest entries once it holds more bytes than its budget", () => {
  const cache = createByteBudgetCache(10);
  const file = (size) => new File([new Uint8Array(size)], "x.jpg", { type: "image/jpeg" });
  cache.set("a", file(4));
  cache.set("b", file(4));
  cache.set("c", file(4)); // 12 bytes > 10: "a" goes
  assert.equal(cache.get("a"), undefined);
  assert.ok(cache.get("b"));
  assert.ok(cache.get("c"));
  assert.equal(cache.bytes, 8);
});

test("an entry larger than the whole budget is still kept on its own", () => {
  const cache = createByteBudgetCache(10);
  cache.set("big", new File([new Uint8Array(20)], "x.jpg", { type: "image/jpeg" }));
  assert.ok(cache.get("big"));
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --experimental-strip-types --test tests/image-transport-cache.test.mjs`

Expected: FAIL; the exports are missing.

- [ ] **Step 3: Implement**

In `app/lib/image-transport.ts`, replace:
```ts
const transportCache = new Map<string, File>();
const TRANSPORT_CACHE_LIMIT = 64;
```
with:
```ts
// Bounded by bytes, not entries: 64 small thumbnails and 64 near-budget
// references are very different amounts of memory.
const TRANSPORT_CACHE_BYTES = 64 * 1024 * 1024;

export function createByteBudgetCache(limitBytes: number) {
  const entries = new Map<string, File>();
  let bytes = 0;
  return {
    get(key: string) {
      return entries.get(key);
    },
    set(key: string, file: File) {
      const previous = entries.get(key);
      if (previous) {
        entries.delete(key);
        bytes -= previous.size;
      }
      entries.set(key, file);
      bytes += file.size;
      // Oldest first (Map keeps insertion order); the newest entry always stays.
      for (const [oldestKey, oldest] of entries) {
        if (bytes <= limitBytes || oldestKey === key) break;
        entries.delete(oldestKey);
        bytes -= oldest.size;
      }
    },
    get bytes() {
      return bytes;
    },
  };
}

const transportCache = createByteBudgetCache(TRANSPORT_CACHE_BYTES);

// Each over-budget reference is decoded to a full bitmap on the main thread
// (about 96 MB for a 24 MP photo), so they are prepared a couple at a time,
// not all at once.
export const TRANSPORT_CONCURRENCY = 2;

export async function mapWithLimit<T, R>(items: T[], limit: number, run: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
```
In `optimizeReferenceForTransport`, replace:
```ts
  const optimized = await compressReferenceForTransport(file, targetBytes);
  if (transportCache.size >= TRANSPORT_CACHE_LIMIT) {
    const oldest = transportCache.keys().next().value;
    if (oldest !== undefined) transportCache.delete(oldest);
  }
  transportCache.set(cacheKey, optimized);
  return optimized;
```
with:
```ts
  const optimized = await compressReferenceForTransport(file, targetBytes);
  transportCache.set(cacheKey, optimized);
  return optimized;
```
In `optimizeReferencesForTransport`, replace:
```ts
  return Promise.all(files.map((file) => optimizeReferenceForTransport(file, targetBytes)));
```
with:
```ts
  return mapWithLimit(files, TRANSPORT_CONCURRENCY, (file) => optimizeReferenceForTransport(file, targetBytes));
```
`const cached = transportCache.get(cacheKey);` keeps working unchanged.

- [ ] **Step 4: Tests and the gate**

Run: `node --experimental-strip-types --test tests/image-transport-cache.test.mjs && node scripts/typecheck-baseline.mjs`

Expected: PASS; the gate exits 0.

- [ ] **Step 5: Commit**

```bash
git add app/lib/image-transport.ts tests/image-transport-cache.test.mjs
git commit -m "perf(transport): prepare references two at a time and cap the cache by bytes

Every over-budget reference was decoded at once on the main thread and
the cache was capped by entry count. Limit concurrency to 2 and evict by
a 64 MB byte budget.

Co-Authored-By: <model trailer>"
```

---

## WP-4E — Documentation

### Task 4E.1: Bring CLAUDE.md and the shared-core doc in line with what landed

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/autoboard-shared-core.md`

Make only the edits below, and only for work that actually landed; skip a bullet whose phase didn't merge.

- [ ] **Step 1: `CLAUDE.md` → Tests**
  - Replace `(466 tests)` with the current count, using the passing total from `node --experimental-strip-types --test --test-reporter=dot tests/*.test.mjs`.
  - Add `npm run test:storage` to the individual-suites code block, after `npm run test:autoboard`.
  - After that code block, add:
```markdown
Storage tests run real app modules against `tests/helpers/fake-worker-env.mjs`:
a `node:sqlite` D1 double that is strict where D1 is strict (binding
`undefined` throws; `batch()` is a transaction) and a Map-backed R2. Import
the helper first and load app modules with a dynamic `await import(...)` —
static imports resolve before its `cloudflare:workers` hook exists.
```
- [ ] **Step 2: `CLAUDE.md` → Gotchas.** Replace the sentence `The usable criterion is that a change adds none.` with:
```markdown
The gate is `node scripts/typecheck-baseline.mjs`: it fails when tsc reports
more errors than `scripts/typecheck-baseline.json` records. Pay debt down by
lowering that number, never by raising it.
```
- [ ] **Step 3: `CLAUDE.md` → Deploy.** After the first sentence, which ends `…before \`wrangler deploy\` — …do not treat it as real.`, add:
```markdown
A `verify` job (lint, the full node:test suite, the typecheck gate) runs on
every pull request and before every deploy; `deploy` needs it.
```
- [ ] **Step 4: `CLAUDE.md` → Autoboard.** After the paragraph ending `…read it before touching anything that fetches. See \`docs/autoboard-shared-core.md\`.`, add:
```markdown
Every server-side fetch of a user-supplied URL goes through
`app/lib/guarded-fetch.ts` (`fetchPublic` validates each redirect hop with
`assertFetchableUrl` before requesting it; `readCapped` streams against a byte
cap). CLI render ids are never reissued (`lastIssued` in each board's render
record), a queued confirm/final runs from the source it was queued against,
and an in-place photo replacement records a per-path digest
(`board.imageDigests`) that `selectionHash` folds in.
```
- [ ] **Step 5: `docs/autoboard-shared-core.md`.** Add a short section headed `## Image digests in selectionHash`. It says `selectionHash` appends an item's `[digest|null, …]` only when one of its images has an entry in `board.imageDigests`; that this keeps every existing hash byte-identical; that the digest is computed by the CLI review server (`node:crypto`), never in the shared core; and that the web board doesn't need it because its uploads are content-addressed.
- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md docs/autoboard-shared-core.md
git commit -m "docs: record the remediation's gates, helpers and render-identity rules

Co-Authored-By: <model trailer>"
```

---

## Deferred and not planned

Each item is recorded so it can be picked up deliberately later, not rediscovered.

| Item | Why not now | If it becomes worth doing |
|---|---|---|
| P03: DitherReveal buffer reuse / stable-progress repaint | The partial-progress path is only reachable on `/dither-lab`. Generator goes 0→1 in 80 ms, and `BoardWorkflow` passes `progress={1}`. | When a live caller holds partial progress: cache the last painted `(progress, src, ink, paper, mode)` and skip `paint()` when unchanged; reuse one offscreen canvas/`ImageData` per `(cols, rows)`. |
| P05: idle-warm save-data gate | This app's users are designers on office connections. Hover and focus already warm on intent, and the idle warm fixed a shipped veil-flash regression. | Skip the idle warm when `navigator.connection.saveData` or `effectiveType` is `2g`/`slow-2g`. |
| P05: Inter axis trim / subsetting | Needs external font tooling and visual QA. The UI uses continuous weights (650/750/850), so static instances are out. | Subset the variable font to Latin + punctuation with the weight axis kept, then compare glyph metrics on every page. |
| P06: durable reconciliation (queue/cron) | The bounded refresh (Task 2A.3) removes the long waits. `waitUntil` is unreachable from vinext route handlers, and `wrangler.jsonc` has no cron. | A Cron Trigger calling a reconcile function, or special-casing `/api/economy` in `worker/index.ts` to use `ctx.waitUntil`. |
| P07: duplicate R2 object per board draft | Costs cents per year. Board drafts appearing in `/archive` is current behaviour, and the second copy keeps each lifecycle independent (history's 180-day sweep never touches `autoboard_renders`). | If board drafts should leave the archive, add a `skipHistory` flag on the board payload (next to `renderKind`/`outputResolution` in `BoardPayloadOptions`) that makes `/api/generate` skip `persistGenerationOutput` while still returning `imageBase64`. |
| P08: bounded DAG concurrency | The review sequences it last, and paid parallelism needs the attempt identity and cancellation guarantees first. Also noted: a `needs-selection` pause halts unrelated branches. | Schedule ready branches with a per-kind limit, preserving pins, cache skips, human selection, cancellation and error policy. Test delayed independent branches and blocked descendants. |
| P09: CLI batch-finalize upload reuse | No API-cost saving (image tokens are charged per request regardless, and `/v1/images/edits` reports no cached tokens). It only saves upload seconds before a batch that takes up to 24 h. | A `Map` keyed by `path.resolve(imagePath)`, hoisted above the variant loop in `cli.mjs:1074-1089`. |
| R09: client idempotency key for Economy | Record-before-submit closes the demonstrated "paid but untracked" gap, and a user double-submit is rarer and visible in history. | The client mints an action id per Final click and sends it; `POST` looks up a row with that id before submitting. |
| R06: revision compare-and-swap | No client consumes a revision. Field-scoped writes make disjoint edits safe; same-field edits are last-write-wins by decision. | Add a `revision` column (the `generation-jobs.ts` ALTER pattern), return it from `PATCH`, and reject stale writes with 409. |
| R14: inline Workbench dialogs (wire-connect, restore-error) | They render inline in `WorkbenchApp`, so a hook can't attach without extracting them. The review verified only the startup chooser. | Extract each into its own component and apply `useModalFocus`. The restore-error dialog gets `initialFocus` on Retry, no `onEscape`, and `restoreFocus: false`; it must stay non-dismissable. |
| Review-board tab semantics | Lower priority per the review. | `id`/`aria-controls` pairs, `role="tabpanel"`, roving `tabIndex` and arrow keys at `ReviewBoards.tsx:613-638`. |
| Inspector typed editors | Needs a read of each node spec's param metadata; judgment-heavy. | Drive `GenericParamsInspector` (`Inspector.tsx:64-89`) from the manifests' enum/range metadata. |
| Observability (action id, phase timings, usage) | Not a defect. Worth doing once the attempt ledger exists. | Log per paid action: id, input digests in order, selected source, provider request id, model snapshot, phase timings and returned usage. No secrets, no raw references. |
| Python suite in the `verify` job | The legacy CLI isn't deployed by this workflow, and adding it means a `setup-python` step plus dependency install for code that rarely changes. | Add `actions/setup-python` and `PYTHONPATH=src python -m unittest discover -s tests -p "test_*.py"` to `verify` once Phase 0 confirms it passes without extra installs. |
| DNS-resolution SSRF checks | A Worker has no DNS API, and production egress can't reach private networks. | Only relevant if this code moves to a Node host. |
| Page design directions (brief → "Page-specific design direction") | Design proposals, not defects. `AGENTS.md` requires reference-driven design work for them. | Start each as its own spec (`superpowers:brainstorming`), one page at a time. |

## Phase 4 exit criteria

- [ ] `.test-work/perf/{4A,4B,4C}.md` hold the measurements and the decision taken for each.
- [ ] Tasks 4B.1 and 4D.1 landed. `npm run test:workbench` and `tests/image-transport-cache.test.mjs` pass.
- [ ] Full suite, lint and the typecheck gate pass.
- [ ] Docs updated (4E.1).
