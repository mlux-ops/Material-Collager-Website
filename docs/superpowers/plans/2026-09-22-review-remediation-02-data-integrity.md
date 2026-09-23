# Review Remediation — Phase 1: Data Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the verified ways the app loses a person's decisions or stored output, or builds a render from inputs other than the ones selected: R01, R02, R03, R04, R05, R06, R07, R08, R12, the Workbench autosave race, and the transport-cache identity half of P04.

**Architecture:** Four work packages that touch disjoint files. Each can run in its own session or worktree.
- **WP-1A:** CLI render identity. IDs are never reissued, a queued job keeps its source, and in-place photo replacements reach the stale check.
- **WP-1B:** Web board saves. A Node-testable save queue does per-slot note merging, serial writes and a render barrier. On the server, SQL writes only the supplied fields, and render selection becomes one transaction.
- **WP-1C:** Library save. Unknown metadata becomes `null`, the stored type follows the bytes, and a failed insert takes its fresh R2 object with it.
- **WP-1D:** Workbench identity. Autosave counts edits instead of flagging them, and the transport cache keys on content.

**Tech Stack:** `node:test` with `--experimental-strip-types`; `tests/helpers/fake-worker-env.mjs` (Phase 0) for D1/R2; `sharp` (already a dependency) for image fixtures.

**Inherits:** every rule in `2026-09-22-review-remediation-00-overview.md → Global Constraints`. **Requires Phase 0** (the fake D1/R2 helper and the typecheck gate).

**Model routing:** implementer Sonnet 5 for every WP. Opus 5.5 code-quality review at the end of WP-1B (transaction and ordering reasoning) and WP-1D (autosave interleaving). WP-1A and WP-1C get a Sonnet spec check only.

## Global Constraints

- App modules that import `cloudflare:workers` are loaded in tests with a dynamic `await import(...)` placed after `import … from "./helpers/fake-worker-env.mjs"`.
- `app/lib/autoboard/**` stays free of `node:` builtins, `@/` and extensionless imports.
- Don't change the pinned-literal hash tests in `tests/autoboard-render-hash.test.mjs` (lines 73–76). If one fails, the change altered hashes that are already written into `results.json` files on disk, and that change is wrong.
- The render queue's "Fix 5" behaviour stays. Board state (instruction, notes, selection hash) is still read **at execution time**. Only the *source render* of a queued confirm/final is pinned at enqueue time.
- No test may call the network. Every `fetch` is mocked with `t.mock.method(globalThis, "fetch", …)` or replaced by the injected dependency.

## File Structure

| File | WP | Change |
|---|---|---|
| `scripts/autoboard/lib/render.mjs` | 1A | `nextRenderId` high-water mark; `queuedSource`; `runRenderJob` uses it |
| `scripts/autoboard/lib/render-queue.mjs` | 1A | Job keeps `source` |
| `scripts/autoboard/lib/review-server.mjs` | 1A | Passes `source` on enqueue; records an image digest on replace; comment fix |
| `scripts/autoboard/lib/review-core.mjs` | 1A | `recordImageDigest(plan, imagePath, digest)` |
| `app/lib/autoboard/types.ts` | 1A | `Board.imageDigests?` |
| `app/lib/autoboard/render-options.ts` | 1A | `selectionHash` folds in digests of images that have one |
| `tests/autoboard-render.test.mjs`, `tests/autoboard-render-queue.test.mjs`, `tests/autoboard-render-hash.test.mjs`, `tests/autoboard-review.test.mjs` | 1A | New cases |
| `app/lib/board-save-queue.ts` (new) | 1B | `createBoardSaveQueue`, `mergeBoardPatch` |
| `app/components/review-boards/BoardWorkflow.tsx` | 1B | Uses the queue; the render waits on `flush()` |
| `app/lib/autoboard-board-state.ts` | 1B | Field-scoped `saveBoardState` + `json_patch` notes |
| `app/lib/autoboard-renders.ts` | 1B | `setRenderStatus` in one `DB.batch` |
| `tests/autoboard-board-save-queue.test.mjs`, `tests/autoboard-board-state.test.mjs`, `tests/autoboard-renders.test.mjs` (new) | 1B | |
| `app/lib/generation-jobs.ts` | 1C | `?? null`; orphan cleanup on a failed insert |
| `app/api/workbench/save/route.ts` | 1C | Sniffed type drives the filename |
| `tests/storage-library-save.test.mjs` (new) | 1C | |
| `app/components/workbench/persistence.ts` | 1D | `createDirtyChannel` |
| `app/components/workbench/WorkbenchApp.tsx` | 1D | Autosave uses dirty channels; flush waits for in-flight saves |
| `app/lib/image-transport.ts` | 1D | `transportCacheKey` (content digest) |
| `tests/workbench-autosave-ack.test.mjs`, `tests/image-transport-cache.test.mjs` (new) | 1D | |

---

## WP-1A — CLI render identity

Suite: `npm run test:autoboard`. One Sonnet session for all three tasks, which share `render.mjs` and `review-server.mjs`.

### Task 1A.1: Render IDs are never reissued (R01)

**Files:**
- Modify: `scripts/autoboard/lib/render.mjs:262-264` (`nextRenderId`)
- Modify: `scripts/autoboard/lib/review-server.mjs:198-203` (comment only)
- Test: `tests/autoboard-render.test.mjs`

**Interfaces:**
- Produces: `nextRenderId(renders, prefix)` is unchanged in signature and still returns `"<prefix>-NNNN"`. It now also sets `renders.lastIssued[prefix]`, which is persisted in `results.json` with the rest of the record.

- [ ] **Step 1: Write the failing tests**

In `tests/autoboard-render.test.mjs`, change the `node:fs` import on line 3 to:
```js
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
```
Add these tests directly after the existing test `"ensureRenders creates the per-board record once and nextRenderId zero-pads per kind"`:
```js
test("nextRenderId never reissues an id, even after the newest render is deleted or the board is reset", () => {
  const results = { candidates: {}, finals: {} };
  const renders = ensureRenders(results, "b");
  for (let n = 0; n < 3; n++) renders.drafts.push({ id: nextRenderId(renders, "d") });
  assert.deepEqual(renders.drafts.map((entry) => entry.id), ["d-0001", "d-0002", "d-0003"]);
  renders.drafts.splice(1, 1); // delete d-0002 from the middle
  const fourth = nextRenderId(renders, "d");
  assert.equal(fourth, "d-0004");
  renders.drafts.push({ id: fourth });
  renders.drafts.pop(); // delete d-0004, the newest
  assert.equal(nextRenderId(renders, "d"), "d-0005");
  renders.drafts = []; // what resetNonFinalRenders leaves behind
  assert.equal(nextRenderId(renders, "d"), "d-0006");
});

test("a render record written before the high-water mark existed continues after its highest surviving id", () => {
  const renders = { instruction: "", pickedDraftId: null, approvedConfirmedId: null, drafts: [{ id: "d-0001" }, { id: "d-0007" }], confirmed: [], finals: [] };
  assert.equal(nextRenderId(renders, "d"), "d-0008");
  assert.equal(nextRenderId(renders, "c"), "c-0001");
});

test("deleting a middle draft and rendering again leaves every surviving file's bytes untouched", async (t) => {
  const { runDir, plan, results } = scratchRun();
  const boardId = plan.boards[0].id;
  let call = 0;
  t.mock.method(globalThis, "fetch", async () => {
    call += 1;
    // A different trailing byte per render, so an overwrite is detectable.
    const image = Buffer.concat([PNG, Buffer.from([call])]).toString("base64");
    return Response.json({ ok: true, imageBase64: image, mimeType: "image/png", jobId: `job-${call}` });
  });
  const ctx = { plan, results, runDir, baseUrl: "https://w.example", accessHeaders: {}, signal: new AbortController().signal, onProgress: () => {}, persist: async () => {} };
  await runRenderJob({ jobId: "q1", boardId, kind: "draft", variant: "A", count: 3, instructionSnapshot: "", selectionHash: "h" }, ctx);
  const bytesOf = (id) => readFileSync(path.join(runDir, results.renders[boardId].drafts.find((entry) => entry.id === id).path));
  const third = bytesOf("d-0003");
  await removeRender(results, runDir, boardId, "draft", "d-0002");
  await runRenderJob({ jobId: "q2", boardId, kind: "draft", variant: "A", count: 1, instructionSnapshot: "", selectionHash: "h" }, ctx);
  const ids = results.renders[boardId].drafts.map((entry) => entry.id);
  assert.deepEqual(ids, ["d-0001", "d-0003", "d-0004"]);
  assert.deepEqual(bytesOf("d-0003"), third);
  rmSync(runDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --experimental-strip-types --test --test-name-pattern="never reissues|high-water|surviving file" tests/autoboard-render.test.mjs`

Expected: 3 failures. The first gets `d-0003` where `d-0004` was expected. The third gets ids `["d-0001","d-0003","d-0003"]`, which is the overwrite.

- [ ] **Step 3: Implement**

In `scripts/autoboard/lib/render.mjs`, replace:
```js
export function nextRenderId(renders, prefix) {
  return `${prefix}-${String(renders[LIST_FOR_PREFIX[prefix]].length + 1).padStart(4, "0")}`;
}
```
with:
```js
function idNumber(id) {
  const value = Number.parseInt(String(id ?? "").slice(2), 10);
  return Number.isFinite(value) ? value : 0;
}

// Ids are never reissued. Counting the renders that survive — or even taking
// the highest survivor — hands a deleted render's id, and so its file name, to
// the next render: the write overwrites a picture another record still points
// at, and findRender's first-match lookup then resolves the old metadata over
// new bytes. `lastIssued` remembers the highest id ever handed out per kind; a
// record written before it existed starts after its highest surviving id,
// which is the best a record that never kept one can do.
export function nextRenderId(renders, prefix) {
  const surviving = renders[LIST_FOR_PREFIX[prefix]].map((entry) => idNumber(entry.id));
  const next = Math.max(renders.lastIssued?.[prefix] ?? 0, ...surviving) + 1;
  renders.lastIssued = { ...renders.lastIssued, [prefix]: next };
  return `${prefix}-${String(next).padStart(4, "0")}`;
}
```
In `scripts/autoboard/lib/review-server.mjs`, replace the comment:
```js
      // The `v` token is what makes a re-render visible in the browser. Render
      // ids restart at 0001 after a reset, so a fresh draft lands on the same
      // boards/<id>/drafts/d-0001.png path as the one it replaced — and
      // /render-image answers with Cache-Control: max-age=3600, so without a
      // per-render token the board shows the DELETED render's picture for an
      // hour and the new one looks identical to the old.
```
with:
```js
      // The `v` token is what makes a re-render visible in the browser.
      // /render-image answers with Cache-Control: max-age=3600, and results
      // written before nextRenderId kept a high-water mark could reuse a
      // deleted render's id — and so its path — for a new picture. New ids are
      // never reused; the token keeps those older ones showing the right image.
```

- [ ] **Step 4: Check the other callers**

Run: `grep -rn "nextRenderId" scripts app --include=*.mjs --include=*.ts`

Expected: definitions and uses in `render.mjs` only (the `recordDraft`/`recordConfirmed`/`recordFinal` fallbacks and `runRenderJob`), plus any re-export. Every caller only needs a fresh unique id, so the new side effect on `renders.lastIssued` is safe. If a caller elsewhere depends on the old length-derived value, stop and report it.

- [ ] **Step 5: Run the file's tests**

Run: `node --experimental-strip-types --test tests/autoboard-render.test.mjs`

Expected: all pass, including the pre-existing `"ensureRenders creates the per-board record once…"` test. Its `deepEqual` runs before any `nextRenderId` call, so the lazily added `lastIssued` key doesn't affect it.

- [ ] **Step 6: Commit**

```bash
git add scripts/autoboard/lib/render.mjs scripts/autoboard/lib/review-server.mjs tests/autoboard-render.test.mjs
git commit -m "fix(autoboard): never reissue a render id after a deletion

nextRenderId counted surviving renders, so deleting d-0002 of three made
the next draft d-0003 and overwrote the survivor's file. Keep a per-kind
high-water mark in the render record instead.

Co-Authored-By: <model trailer>"
```

### Task 1A.2: A queued confirm/final renders from the source it was queued against (R03)

**Files:**
- Modify: `scripts/autoboard/lib/render-queue.mjs` (the `job` object in `enqueue`, after `force: Boolean(fields.force),`)
- Modify: `scripts/autoboard/lib/review-server.mjs` (the `queue.enqueue({ … })` call in `POST /api/render`)
- Modify: `scripts/autoboard/lib/render.mjs` (new `queuedSource`; the `renderSource` line in `runRenderJob`)
- Test: `tests/autoboard-render-queue.test.mjs`, `tests/autoboard-render.test.mjs`

**Interfaces:**
- Consumes: `sourceIdentity` (`{ kind: "draft" | "confirm", id }` or `null`), already computed in `review-server.mjs` for the dedupe key.
- Produces: `job.source` (the same shape, or `null`). `runRenderJob` executes `job.source` when present and throws `status: 409` if that record was removed.

- [ ] **Step 1: Write the failing tests**

Add to `tests/autoboard-render-queue.test.mjs`, after the `"enqueue threads force through…"` test:
```js
test("enqueue keeps the source a confirm/final was queued against on the job, defaulting to null", async () => {
  const seen = [];
  const execute = (job) => { seen.push(job.source); return Promise.resolve(); };
  const queue = new RenderQueue({ execute });
  queue.enqueue({ boardId: "a", kind: "final", source: { kind: "draft", id: "d-0001" } });
  await tick();
  queue.enqueue({ boardId: "b", kind: "draft", variant: "A", count: 1 });
  await tick();
  assert.deepEqual(seen, [{ kind: "draft", id: "d-0001" }, null]);
  await queue.idle;
});
```
Add to `tests/autoboard-render.test.mjs`, after the `"runRenderJob renders a stale final anyway when job.force is true"` test:
```js
test("a queued final renders from the source it was queued against, not whatever is picked when it runs", async (t) => {
  const { runDir, plan, results } = scratchRun();
  const boardId = plan.boards[0].id;
  const fresh = selectionHash(plan.boards[0], "");
  for (const id of ["d-0001", "d-0002"]) {
    const rel = await saveRenderImage(runDir, boardId, "draft", id, PNG.toString("base64"));
    recordDraft(results, boardId, { id, variant: "A", index: 1, path: rel, jobId: id, durationMs: 1, selectionHash: fresh, instruction: "", itemNotes: {} });
  }
  await pickDraft(results, runDir, boardId, "d-0001");
  const queuedFrom = { kind: "draft", id: "d-0001" };
  await pickDraft(results, runDir, boardId, "d-0002"); // re-picked while the final waited in the queue
  t.mock.method(globalThis, "fetch", async () => Response.json({ ok: true, imageBase64: PNG.toString("base64"), mimeType: "image/png", jobId: "job-final", libraryVisible: true }));
  const ctx = { plan, results, runDir, baseUrl: "https://w.example", accessHeaders: {}, signal: new AbortController().signal, onProgress: () => {}, persist: async () => {} };
  await runRenderJob({ jobId: "q", boardId, kind: "final", instructionSnapshot: "", selectionHash: fresh, source: queuedFrom }, ctx);
  assert.equal(results.renders[boardId].finals[0].fromRenderId, "d-0001");
  rmSync(runDir, { recursive: true, force: true });
});

test("a queued final whose source was removed stops with 409 before any paid call", async (t) => {
  const { runDir, plan, results } = scratchRun();
  const boardId = plan.boards[0].id;
  const rel = await saveRenderImage(runDir, boardId, "draft", "d-0002", PNG.toString("base64"));
  recordDraft(results, boardId, { id: "d-0002", variant: "A", index: 1, path: rel, jobId: "j", durationMs: 1, selectionHash: selectionHash(plan.boards[0], ""), instruction: "", itemNotes: {} });
  await pickDraft(results, runDir, boardId, "d-0002");
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls += 1; return Response.json({ ok: true }); });
  const ctx = { plan, results, runDir, baseUrl: "https://w.example", accessHeaders: {}, signal: new AbortController().signal, onProgress: () => {}, persist: async () => {} };
  await assert.rejects(
    runRenderJob({ jobId: "q", boardId, kind: "final", instructionSnapshot: "", selectionHash: "h", source: { kind: "draft", id: "d-0001" } }, ctx),
    (error) => error.status === 409 && /was removed/.test(error.message),
  );
  assert.equal(calls, 0);
  rmSync(runDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --experimental-strip-types --test --test-name-pattern="keeps the source|queued against|was removed" tests/autoboard-render-queue.test.mjs tests/autoboard-render.test.mjs`

Expected: 3 failures. The queue test gets `[undefined, undefined]`. The final gets `fromRenderId` `"d-0002"`. The removal test gets a non-409 rejection and `calls === 1`.

- [ ] **Step 3: Implement**

In `scripts/autoboard/lib/render-queue.mjs`, directly after `      force: Boolean(fields.force),` in the `job` object, add:
```js
      // The render a confirm/final is built from, as picked when the job was
      // queued. The dedupe key already names it, so execution must use it too:
      // a re-pick while the job waits must not change what the paid render
      // starts from (runRenderJob → queuedSource).
      source: fields.source ?? null,
```
In `scripts/autoboard/lib/review-server.mjs`, in the `queue.enqueue({ … })` call of `POST /api/render`, replace:
```js
          renderOptionsSnapshot: options, dedupeKey,
          force: Boolean(body.force),
        });
```
with:
```js
          renderOptionsSnapshot: options, dedupeKey,
          force: Boolean(body.force),
          source: sourceIdentity,
        });
```
In `scripts/autoboard/lib/render.mjs`, directly after the `itemNotesOf` function, add:
```js
// The render a queued confirm/final was enqueued against (job.source, set by
// the review server). Resolving the pick again here would let a re-pick made
// while the job waited silently change what the paid render is built from. A
// source deleted in the meantime stops the job before anything is sent. Jobs
// built without a source (direct callers, older fixtures) keep reading the
// current pick.
function queuedSource(results, boardId, { kind, id }) {
  const record = ensureRenders(results, boardId)[DIR_FOR_KIND[kind]]?.find((entry) => entry.id === id);
  if (!record) {
    const label = kind === "confirm" ? "confirmed render" : "draft";
    throw Object.assign(new Error(`The ${label} this job was queued from (${id}) was removed. Queue the step again.`), { status: 409 });
  }
  return { kind, record };
}
```
and in `runRenderJob` replace:
```js
  const source = renderSource(results, board.id, job.kind);
```
with:
```js
  const source = job.source ? queuedSource(results, board.id, job.source) : renderSource(results, board.id, job.kind);
```

- [ ] **Step 4: Run the suite**

Run: `npm run test:autoboard`

Expected: all pass, including `"runRenderJob confirm and final use the current source render…"` (its jobs carry no `source`, so they keep the current-pick behaviour).

- [ ] **Step 5: Commit**

```bash
git add scripts/autoboard/lib/render-queue.mjs scripts/autoboard/lib/review-server.mjs scripts/autoboard/lib/render.mjs tests/autoboard-render-queue.test.mjs tests/autoboard-render.test.mjs
git commit -m "fix(autoboard): run a queued confirm/final from the source it was queued against

The dedupe key named the picked source but the job didn't carry it, so a
re-pick while the job waited changed what the paid render was built from.
Store the source on the job; stop with 409 if it was removed.

Co-Authored-By: <model trailer>"
```

### Task 1A.3: In-place photo replacements mark earlier renders stale (R02)

**Files:**
- Modify: `app/lib/autoboard/types.ts` (the `Board` type)
- Modify: `app/lib/autoboard/render-options.ts` (`selectionHash`)
- Modify: `scripts/autoboard/lib/review-core.mjs` (new export `recordImageDigest`)
- Modify: `scripts/autoboard/lib/review-server.mjs` (imports; the `POST /api/replace-image` handler)
- Test: `tests/autoboard-render-hash.test.mjs`, `tests/autoboard-review.test.mjs`

**Interfaces:**
- Produces:
  - `Board.imageDigests?: Record<string, string>`, mapping an image path to the sha256 hex of its current bytes.
  - `recordImageDigest(plan, imagePath: string, digest: string): void` stamps the entry on every board of the plan.
  - `selectionHash(board, instruction)` has the same signature. It appends `[digest|null, …]` to an item's tuple **only** when one of that item's images has a digest.

**Why this shape:**
- **Board level, not item level.** `resetSelection` restores an item from its `_auto` snapshot, which would drop an item-level digest while the file keeps its new bytes.
- **Every board.** Tiles and fixture photos are shared files. A board using the path now, or after a later pick, must hash the new bytes.
- **Conditional append.** Hashes of boards with no replaced photo stay byte-identical to what `results.json` files already hold.

- [ ] **Step 1: Write the failing tests**

Add to `tests/autoboard-render-hash.test.mjs`, after its last `selectionHash` test:
```js
test("a photo replaced in place changes selectionHash only for boards whose items use it", () => {
  const before = selectionHash(board(), "");
  const replaced = board({ imageDigests: { "/a.jpg": "1".repeat(64) } });
  assert.notEqual(selectionHash(replaced, ""), before);
  assert.notEqual(selectionHash(board({ imageDigests: { "/a.jpg": "2".repeat(64) } }), ""), selectionHash(replaced, ""));
  // A digest for a path no item uses leaves the hash exactly as it was — which
  // is what keeps every hash already written to results.json valid.
  assert.equal(selectionHash(board({ imageDigests: { "/elsewhere.jpg": "3".repeat(64) } }), ""), before);
});

test("a render made before an in-place photo replacement is stale afterwards", () => {
  const record = { selectionHash: selectionHash(board(), "") };
  assert.equal(renderRecordIsStale(board(), record, "final", ""), false);
  assert.equal(renderRecordIsStale(board({ imageDigests: { "/b.jpg": "4".repeat(64) } }), record, "final", ""), true);
});
```
In `tests/autoboard-review.test.mjs`:
- Add `import { createHash } from "node:crypto";` after line 1.
- Add `recordImageDigest,` to the `review-core.mjs` import list, alphabetically after `libraryOptionsForSlot,`.
- Add this test after the `"POST /api/replace-image swaps a real row's photo…"` test:
```js
test("recordImageDigest stamps the replaced path on every board, so every board using it can go stale", () => {
  const shared = "/lib/tiles/T1.png";
  const plan = { boards: [
    { id: "kitchen", items: [{ slotId: "floor_tile", images: [shared] }] },
    { id: "bath", items: [{ slotId: "wall_tile", images: [shared] }] },
    { id: "closet", items: [{ slotId: "shelf", images: ["/lib/other.png"] }] },
  ] };
  recordImageDigest(plan, shared, "a".repeat(64));
  for (const entry of plan.boards) assert.equal(entry.imageDigests[shared], "a".repeat(64));
  recordImageDigest(plan, shared, "b".repeat(64));
  assert.equal(plan.boards[1].imageDigests[shared], "b".repeat(64));
});
```
- In the existing `"POST /api/replace-image swaps a real row's photo…"` test, directly after the line `assert.equal(persisted.boards[0].items[0].images[0], data.item.images[0]);`, add:
```js
    // Same path, new bytes: the digest is what lets selectionHash see it.
    assert.equal(
      persisted.boards[0].imageDigests?.[data.item.images[0]],
      createHash("sha256").update(ONE_BY_ONE_PNG).digest("hex"),
    );
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --experimental-strip-types --test tests/autoboard-render-hash.test.mjs tests/autoboard-review.test.mjs`

Expected:
- **Hash tests:** the `notEqual` assertions fail, because the digest is ignored.
- **Review tests:** `recordImageDigest` is not exported. That surfaces as a `SyntaxError` at import, which fails the whole file; that is expected.

- [ ] **Step 3: Implement the type and the hash**

In `app/lib/autoboard/types.ts`, inside `export type Board = { … }`, after the line `  renderOptions?: { quality?: string; background?: string };`, add:
```ts

  // Set by the CLI review server when a photo is replaced in place: the same
  // path now holds different bytes, which the path alone cannot show.
  // selectionHash folds in the digest of every image an item uses that has one.
  imageDigests?: Record<string, string>;
```
In `app/lib/autoboard/render-options.ts`, replace the whole `selectionHash` function:
```ts
export function selectionHash(board: Board, instruction: unknown = ""): string {
  const material = {
    instruction: String(instruction ?? "").trim(),
    // item.notes goes through modelNotes so an edit to a legacy provenance
    // sentence it strips anyway (see modelNotes/LEGACY_NOTE_PATTERNS in
    // variants.mjs) doesn't mark an otherwise-unchanged draft stale.
    items: orderedBoardItems(board).map((item) => [item.slotId, item.images ?? [], modelNotes(item.notes) ?? "", String(item.note ?? "").trim()]),
  };
  return sha1Hex(JSON.stringify(material));
}
```
with:
```ts
export function selectionHash(board: Board, instruction: unknown = ""): string {
  const digests = board.imageDigests ?? {};
  const material = {
    instruction: String(instruction ?? "").trim(),
    // item.notes goes through modelNotes so an edit to a legacy provenance
    // sentence it strips anyway (see modelNotes/LEGACY_NOTE_PATTERNS in
    // variants.mjs) doesn't mark an otherwise-unchanged draft stale.
    items: orderedBoardItems(board).map((item) => {
      const images = item.images ?? [];
      const entry: unknown[] = [item.slotId, images, modelNotes(item.notes) ?? "", String(item.note ?? "").trim()];
      // A photo replaced in place keeps its path, so only its digest shows the
      // pixels changed. Appended only when one of this item's images has a
      // digest, so every hash computed before digests existed is unchanged.
      const imageDigests = images.map((image) => digests[image] ?? null);
      if (imageDigests.some(Boolean)) entry.push(imageDigests);
      return entry;
    }),
  };
  return sha1Hex(JSON.stringify(material));
}
```

- [ ] **Step 4: Implement the stamp and wire the handler**

In `scripts/autoboard/lib/review-core.mjs`, directly after the `replaceItemImage` function, add:
```js
// A replaced photo keeps its path (uploads.mjs writes a deterministic name), so
// selectionHash can only see the new pixels through a digest. Recorded on
// every board: whichever board uses this file — now, or after a later pick —
// must hash the new bytes, not only the board the replacement was made from.
// A board that never uses the path is unaffected; selectionHash only looks up
// the images an item has.
export function recordImageDigest(plan, imagePath, digest) {
  for (const board of plan.boards) {
    board.imageDigests = { ...(board.imageDigests ?? {}), [imagePath]: digest };
  }
}
```
In `scripts/autoboard/lib/review-server.mjs`:
- Add `import { createHash } from "node:crypto";` directly above `import { createReadStream, existsSync } from "node:fs";`.
- In the `review-core.mjs` import on line 11, add `recordImageDigest` after `libraryOptionsForSlot`.
- In `POST /api/replace-image`, replace:
```js
        if (matchesCurrentItem) {
          const updated = replaceItemImage({ board, slotId, imagePath });
          await persistPlan();
          sendJson(response, 200, { item: serializeItem(updated) });
        } else {
          sendJson(response, 200, { imagePath });
        }
        return;
```
with:
```js
        // Same path, new bytes: without the digest, every render made from the
        // old photo would still pass renderRecordIsStale.
        recordImageDigest(plan, imagePath, createHash("sha256").update(buffer).digest("hex"));
        if (matchesCurrentItem) {
          const updated = replaceItemImage({ board, slotId, imagePath });
          await persistPlan();
          sendJson(response, 200, { item: serializeItem(updated) });
        } else {
          await persistPlan();
          sendJson(response, 200, { imagePath });
        }
        return;
```

- [ ] **Step 5: Run the suite, including parity**

Run: `npm run test:autoboard`

Expected: all pass, including:
- **`tests/autoboard-parity.test.mjs`:** `render-options.ts` gained no imports.
- **The pinned-literal hash tests:** no fixture has `imageDigests`.

- [ ] **Step 6: Commit**

```bash
git add app/lib/autoboard/types.ts app/lib/autoboard/render-options.ts scripts/autoboard/lib/review-core.mjs scripts/autoboard/lib/review-server.mjs tests/autoboard-render-hash.test.mjs tests/autoboard-review.test.mjs
git commit -m "fix(autoboard): make in-place photo replacements mark earlier renders stale

Replace-image rewrites the same path, and selectionHash hashed paths, so
a Final could pass the stale gate with an outdated layout reference.
Record a per-path sha256 on every board and fold it into the hash only
for images that have one, leaving every existing hash unchanged.

Co-Authored-By: <model trailer>"
```

**Known residual (documented, not fixed):** `autoboard plan` rebuilds `plan.json` boards from scratch and so drops `imageDigests`. A re-plan after a replacement loses the stale signal, as it already loses `overriddenAt`.

### WP-1A exit

- [ ] `npm run test:autoboard` passes.
- [ ] Sonnet spec check against R01/R02/R03 acceptance. Delete at any position, add, restart: ids stay unique and survivors' bytes are unchanged. Different bytes at the same path go stale while unchanged inputs stay current. Enqueue from A, pick B: A is used, and a removed A gives 409.

---

## WP-1B — Web board saves

Suite: `npm run test:autoboard`. One Sonnet session; **Opus review at the end**.

### Task 1B.1: A save queue that merges notes per slot and gates renders (R05, R07)

**Files:**
- Create: `app/lib/board-save-queue.ts`
- Modify: `app/components/review-boards/BoardWorkflow.tsx:16` (imports), `:101-153` (refs, `save`, `saveSoon`, unmount flush), `:167-183` (`renderDraft`), and the call sites at `:220`, `:231`, `:244`, `:257`, `:302`
- Test: `tests/autoboard-board-save-queue.test.mjs` (new)

**Interfaces:**
- Produces:
```ts
export type BoardPatch = { instruction?: string; heroItemId?: string | null; quality?: string | null; background?: string | null; notes?: Record<string, string> };
export function mergeBoardPatch(older: BoardPatch | null, newer: BoardPatch): BoardPatch;
export type BoardSaveQueue = {
  saveSoon(patch: BoardPatch): void;
  saveNow(patch: BoardPatch): Promise<boolean>;
  flush(): Promise<void>;
  takePending(): BoardPatch | null;
};
export function createBoardSaveQueue(options: { send: (patch: BoardPatch) => Promise<void>; debounceMs: number; onError?: (error: Error) => void }): BoardSaveQueue;
```

**Why no revision travels with the render:** `POST …/renders` calls `getProject(id)` → `buildProjectBoards` → `listBoardState`, which reads D1 fresh on every request (`app/lib/autoboard-projects.ts`). Once `flush()` resolves, the render sees exactly what was typed.

- [ ] **Step 1: Write the failing tests**

Create `tests/autoboard-board-save-queue.test.mjs`:
```js
import assert from "node:assert/strict";
import test from "node:test";
import { createBoardSaveQueue, mergeBoardPatch } from "../app/lib/board-save-queue.ts";

const tick = () => new Promise((resolve) => setImmediate(resolve));

// A fake PATCH: records what reached the "server", can fail, can be held.
function recorder({ fail = () => false, delay } = {}) {
  const state = { sent: [], inFlight: 0, maxInFlight: 0 };
  state.send = async (patch) => {
    state.inFlight += 1;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    try {
      if (delay) await delay;
      if (fail(patch)) throw new Error("HTTP 503");
      state.sent.push(structuredClone(patch));
    } finally {
      state.inFlight -= 1;
    }
  };
  return state;
}

test("two notes typed inside one debounce window are both sent (R05)", async () => {
  const server = recorder();
  const queue = createBoardSaveQueue({ send: server.send, debounceMs: 5 });
  queue.saveSoon({ notes: { faucet: "brushed brass" } });
  queue.saveSoon({ notes: { tile: "cool grey" } });
  await queue.flush();
  assert.deepEqual(server.sent, [{ notes: { faucet: "brushed brass", tile: "cool grey" } }]);
});

test("clearing a note survives coalescing as an explicit empty value", async () => {
  const server = recorder();
  const queue = createBoardSaveQueue({ send: server.send, debounceMs: 5 });
  queue.saveSoon({ notes: { faucet: "brushed brass", tile: "cool grey" } });
  queue.saveSoon({ notes: { faucet: "" } });
  await queue.flush();
  assert.deepEqual(server.sent, [{ notes: { faucet: "", tile: "cool grey" } }]);
});

test("flush sends a still-debouncing instruction before it resolves, so a render sees it (R07)", async () => {
  const server = recorder();
  const queue = createBoardSaveQueue({ send: server.send, debounceMs: 60_000 });
  queue.saveSoon({ instruction: "warm oak" });
  await queue.flush();
  assert.deepEqual(server.sent, [{ instruction: "warm oak" }]);
});

test("flush waits for a write that is already in flight", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const server = recorder({ delay: gate });
  const queue = createBoardSaveQueue({ send: server.send, debounceMs: 5 });
  const now = queue.saveNow({ quality: "medium" });
  let flushed = false;
  const flush = queue.flush().then(() => { flushed = true; });
  await tick();
  assert.equal(flushed, false);
  release();
  await flush;
  assert.equal(await now, true);
  assert.deepEqual(server.sent, [{ quality: "medium" }]);
});

test("a failed save makes flush reject — so no render goes out — and keeps the edit for the next attempt", async () => {
  let failing = true;
  const errors = [];
  const server = recorder({ fail: () => failing });
  const queue = createBoardSaveQueue({ send: server.send, debounceMs: 5, onError: (error) => errors.push(error.message) });
  queue.saveSoon({ instruction: "warm oak" });
  await assert.rejects(queue.flush(), /HTTP 503/);
  assert.deepEqual(errors, ["HTTP 503"]);
  failing = false;
  queue.saveSoon({ notes: { tile: "cool grey" } });
  await queue.flush();
  assert.deepEqual(server.sent, [{ instruction: "warm oak", notes: { tile: "cool grey" } }]);
});

test("writes reach the server one at a time, in order", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const server = recorder({ delay: gate });
  const queue = createBoardSaveQueue({ send: server.send, debounceMs: 5 });
  const first = queue.saveNow({ quality: "medium" });
  const second = queue.saveNow({ background: "transparent" });
  await tick();
  release();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(server.maxInFlight, 1);
  assert.deepEqual(server.sent, [{ quality: "medium" }, { background: "transparent" }]);
});

test("takePending hands over what has not been sent and cancels its timer", async () => {
  const server = recorder();
  const queue = createBoardSaveQueue({ send: server.send, debounceMs: 5 });
  queue.saveSoon({ instruction: "left mid-sentence" });
  assert.deepEqual(queue.takePending(), { instruction: "left mid-sentence" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(server.sent, []);
});

test("mergeBoardPatch keeps the newer scalar values and merges notes per slot", () => {
  assert.deepEqual(
    mergeBoardPatch({ instruction: "a", notes: { x: "1" } }, { instruction: "b", notes: { y: "2" } }),
    { instruction: "b", notes: { x: "1", y: "2" } },
  );
  assert.deepEqual(mergeBoardPatch(null, { quality: "low" }), { quality: "low" });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --experimental-strip-types --test tests/autoboard-board-save-queue.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `app/lib/board-save-queue.ts`.

- [ ] **Step 3: Write the queue**

Create `app/lib/board-save-queue.ts`:
```ts
// Pending edits for one review board, and the order they reach the server in.
//
// A note is typed a character at a time, so edits are coalesced for a moment
// before they are sent; a dropdown change goes at once. Two rules matter:
//
// - Coalescing merges `notes` per slot. A shallow merge replaced the whole
//   notes object, so a second note typed inside the debounce window silently
//   dropped the first before anything was sent.
// - flush() is the barrier a paid render waits on. It sends whatever is still
//   pending, waits for every write already in flight, and rejects if the last
//   attempt failed. The render route reads board state from D1, so once flush
//   resolves the render sees what the reviewer typed — and a save that failed
//   stops the render instead of paying for one built from stale text.
//
// Writes go out one at a time. A failed write's patch is kept, beneath
// anything typed since, and goes out with the next save or flush, so nothing
// typed is lost to a transient error. Framework-free so node --test can
// exercise it without a DOM.

export type BoardPatch = {
  instruction?: string;
  heroItemId?: string | null;
  quality?: string | null;
  background?: string | null;
  notes?: Record<string, string>;
};

export function mergeBoardPatch(older: BoardPatch | null, newer: BoardPatch): BoardPatch {
  const merged: BoardPatch = { ...(older ?? {}), ...newer };
  if (older?.notes && newer.notes) merged.notes = { ...older.notes, ...newer.notes };
  return merged;
}

export type BoardSaveQueue = {
  /** Coalesces `patch` with anything pending; sends after `debounceMs` of quiet. */
  saveSoon(patch: BoardPatch): void;
  /** Sends `patch`, with anything pending, now. Resolves false on failure (reported through onError). */
  saveNow(patch: BoardPatch): Promise<boolean>;
  /** Sends anything pending and waits for every write in flight; rejects if the last write failed. */
  flush(): Promise<void>;
  /** Removes and returns what has not been sent yet, for a last-chance send on unmount. */
  takePending(): BoardPatch | null;
};

export function createBoardSaveQueue(options: {
  send: (patch: BoardPatch) => Promise<void>;
  debounceMs: number;
  onError?: (error: Error) => void;
}): BoardSaveQueue {
  let pending: BoardPatch | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<void> = Promise.resolve();

  const takePending = (): BoardPatch | null => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const taken = pending;
    pending = null;
    return taken;
  };

  const enqueue = (patch: BoardPatch): Promise<void> => {
    const write = chain
      .then(() => options.send(patch))
      .catch((cause: unknown) => {
        pending = mergeBoardPatch(patch, pending ?? {});
        const error = cause instanceof Error ? cause : new Error(String(cause));
        options.onError?.(error);
        throw error;
      });
    chain = write.catch(() => undefined);
    return write;
  };

  return {
    saveSoon(patch) {
      pending = mergeBoardPatch(pending, patch);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const queued = takePending();
        if (queued) enqueue(queued).catch(() => undefined);
      }, options.debounceMs);
    },
    async saveNow(patch) {
      try {
        await enqueue(mergeBoardPatch(takePending(), patch));
        return true;
      } catch {
        return false;
      }
    },
    async flush() {
      await chain;
      const queued = takePending();
      if (queued) await enqueue(queued);
    },
    takePending,
  };
}
```

- [ ] **Step 4: Run the queue tests**

Run: `node --experimental-strip-types --test tests/autoboard-board-save-queue.test.mjs`

Expected: PASS, 8 tests.

- [ ] **Step 5: Wire the queue into `BoardWorkflow`**

In `app/components/review-boards/BoardWorkflow.tsx`:

(a) Replace line 16:
```tsx
import { useCallback, useEffect, useRef, useState } from "react";
```
with:
```tsx
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createBoardSaveQueue } from "@/app/lib/board-save-queue";
```

(b) Replace the block starting at `  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);` and ending at the closing `  }, [projectId, board.id]);` of the unmount-flush effect (this spans the `pending` ref, `save`, `saveSoon`, the "Flush on unmount" comment and its effect) with:
```tsx
  const onSavedRef = useRef(onSaved);
  useEffect(() => {
    onSavedRef.current = onSaved;
  }, [onSaved]);

  // Every edit reaches the server through one queue per board
  // (app/lib/board-save-queue.ts): notes coalesce per slot, writes go out one
  // at a time, and a render waits on flush() so it never starts before what
  // was typed is stored.
  const queue = useMemo(() => {
    const url = `/api/autoboard/projects/${encodeURIComponent(projectId)}/boards/${encodeURIComponent(board.id)}`;
    return createBoardSaveQueue({
      debounceMs: SAVE_DEBOUNCE_MS,
      onError: (cause) => setError(cause.message),
      send: async (patch) => {
        setSaving(true);
        setError("");
        try {
          const response = await fetch(url, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(patch),
          });
          const payload = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
          if (!response.ok || !payload?.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`);
        } finally {
          setSaving(false);
        }
        // The patch is stored at this point. A failed reload is reported but is
        // not a failed save, so it must not put the patch back in the queue.
        await Promise.resolve(onSavedRef.current()).catch((cause: unknown) => setError((cause as Error).message));
      },
    });
  }, [projectId, board.id]);

  // Flush on unmount or board switch, so leaving mid-sentence does not discard
  // what was typed. keepalive lets the request outlive a closing tab.
  useEffect(() => {
    return () => {
      const queued = queue.takePending();
      if (queued) {
        void fetch(
          `/api/autoboard/projects/${encodeURIComponent(projectId)}/boards/${encodeURIComponent(board.id)}`,
          { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(queued), keepalive: true },
        );
      }
    };
  }, [queue, projectId, board.id]);
```

(c) In `renderDraft`, replace:
```tsx
  const renderDraft = useCallback(async (variantKey: string) => {
    setRenderingVariant(variantKey);
    setError("");
    try {
      const response = await fetch(
```
with:
```tsx
  const renderDraft = useCallback(async (variantKey: string) => {
    setRenderingVariant(variantKey);
    setError("");
    try {
      // The render route builds the prompt from what D1 holds, so an unsaved
      // note or instruction would be missing from a render the reviewer pays
      // for. A save that fails stops the render.
      try {
        await queue.flush();
      } catch (cause) {
        throw new Error(`Not rendered: your latest changes could not be saved (${(cause as Error).message}).`);
      }
      const response = await fetch(
```
and change its dependency list from `}, [projectId, board.id, onSaved]);` to `}, [projectId, board.id, onSaved, queue]);`. This `renderDraft` dependency list is the only one containing exactly `[projectId, board.id, onSaved]` and ending in `setRenderingVariant(null);` just above it.

(d) Update the call sites:
- Line ~220: `saveSoon({ instruction: event.target.value });` → `queue.saveSoon({ instruction: event.target.value });`
- Line ~231: `onChange={(event) => void save({ quality: event.target.value })}` → `onChange={(event) => void queue.saveNow({ quality: event.target.value })}`
- Line ~244: `onChange={(event) => void save({ background: event.target.value })}` → `onChange={(event) => void queue.saveNow({ background: event.target.value })}`
- Line ~257: `onChange={(event) => void save({ heroItemId: event.target.value })}` → `onChange={(event) => void queue.saveNow({ heroItemId: event.target.value })}`
- Line ~302: `saveSoon({ notes: { [item.slotId]: event.target.value } });` → `queue.saveSoon({ notes: { [item.slotId]: event.target.value } });`

Run: `grep -n "saveSoon(\|save(\|pending.current\|timer.current" app/components/review-boards/BoardWorkflow.tsx`

Expected: only `queue.saveSoon(` / `queue.saveNow(` matches remain. `renderDraft` and `setRenderStatus` keep their own fetches.

- [ ] **Step 6: Lint and typecheck the component**

Run: `npx eslint app/components/review-boards/BoardWorkflow.tsx app/lib/board-save-queue.ts && node scripts/typecheck-baseline.mjs`

Expected: no new lint errors, and the typecheck gate exits 0. If `react-hooks/exhaustive-deps` flags the `useMemo`, include only stable values; `setError` and `setSaving` are state setters.

- [ ] **Step 7: Commit**

```bash
git add app/lib/board-save-queue.ts app/components/review-boards/BoardWorkflow.tsx tests/autoboard-board-save-queue.test.mjs
git commit -m "fix(review-boards): keep every pending note and save before rendering

The 700 ms debounce merged patches shallowly, so a second note replaced
the first before either was sent, and renderDraft posted while an edit
was still waiting. A per-board save queue now merges notes per slot,
sends writes one at a time, and renders wait on its flush().

Co-Authored-By: <model trailer>"
```

### Task 1B.2: Board saves write only the fields they carry (R06)

**Files:**
- Modify: `app/lib/autoboard-board-state.ts:116-185` (the comment above `saveBoardState`, and `saveBoardState` itself; new `notesMergePatch`)
- Test: `tests/autoboard-board-state.test.mjs` (new)

**Interfaces:**
- Produces: `saveBoardState(projectId, boardId, patch): Promise<BoardState>`, with an unchanged signature and validation messages. The returned state is now read back from the row.

- [ ] **Step 1: Write the failing tests**

Create `tests/autoboard-board-state.test.mjs`:
```js
import assert from "node:assert/strict";
import test from "node:test";
import { createFakeD1, installWorkerEnv } from "./helpers/fake-worker-env.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));

// Holds the first write that reaches the database until released, so a second
// save can run to completion in between — the interleaving the review
// reproduced for R06.
let holdNextWrite = false;
let held = false;
let release;
const gate = new Promise((resolve) => { release = resolve; });
const DB = createFakeD1({
  beforeStatement: async (_kind, sql) => {
    if (holdNextWrite && /^\s*INSERT/i.test(sql)) {
      holdNextWrite = false;
      held = true;
      await gate;
    }
  },
});
installWorkerEnv({ DB });
const { listBoardState, saveBoardState } = await import("../app/lib/autoboard-board-state.ts");

test("two partial saves that overlap keep both fields (R06)", async () => {
  holdNextWrite = true;
  const first = saveBoardState("p-race", "b", { instruction: "warm oak" });
  for (let i = 0; !held && i < 200; i++) await tick();
  assert.ok(held, "the first save never reached its write");
  await saveBoardState("p-race", "b", { notes: { faucet: "brushed brass" } });
  release();
  await first;
  const state = (await listBoardState("p-race")).get("b");
  assert.equal(state.instruction, "warm oak");
  assert.deepEqual(state.notes, { faucet: "brushed brass" });
});

test("notes saved at the same time for different slots are all kept", async () => {
  await Promise.all([
    saveBoardState("p-notes", "b", { notes: { faucet: "brushed brass" } }),
    saveBoardState("p-notes", "b", { notes: { tile: "cool grey" } }),
    saveBoardState("p-notes", "b", { notes: { mirror: "round" } }),
  ]);
  assert.deepEqual((await listBoardState("p-notes")).get("b").notes, { faucet: "brushed brass", tile: "cool grey", mirror: "round" });
});

test("an emptied note is removed and fields the patch does not name keep their values", async () => {
  await saveBoardState("p-clear", "b", { instruction: "keep me", quality: "medium", notes: { faucet: "brass", tile: "grey" } });
  const next = await saveBoardState("p-clear", "b", { notes: { faucet: "  " } });
  assert.deepEqual(next.notes, { tile: "grey" });
  assert.equal(next.instruction, "keep me");
  assert.equal(next.quality, "medium");
});

test("the first save for a board creates its row with the patch applied", async () => {
  const state = await saveBoardState("p-new", "b", { heroItemId: " vanity_faucet " });
  assert.equal(state.heroItemId, "vanity_faucet");
  assert.equal(state.instruction, "");
  assert.deepEqual(state.notes, {});
});

test("an invalid patch is rejected before anything is written", async () => {
  await saveBoardState("p-invalid", "b", { instruction: "before" });
  await assert.rejects(saveBoardState("p-invalid", "b", { instruction: "after", quality: "ultra" }), /quality must be one of/);
  await assert.rejects(saveBoardState("p-invalid", "b", { instruction: "after", notes: ["x"] }), /notes must be an object/);
  assert.equal((await listBoardState("p-invalid")).get("b").instruction, "before");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --experimental-strip-types --test tests/autoboard-board-state.test.mjs`

Expected: at least 2 failures.
- **"overlap":** `notes` is `{}`, because the held write restored its stale read.
- **"same time":** only one note survives.

Record which tests fail.

- [ ] **Step 3: Implement**

In `app/lib/autoboard-board-state.ts`, replace everything from the comment line `// A patch, not a replacement: the UI saves one field at a time, and a partial` through the closing `}` of `saveBoardState` (the line after `  return next;`) with:
```ts
// A patch, not a replacement: the UI saves one field at a time, and a partial
// write that blanked the others would lose a reviewer's notes on every
// keystroke elsewhere. So the write names only the columns the patch carries,
// and notes are merged by SQLite itself (json_patch) instead of being read,
// merged here and written back. Two saves that overlap — a dropdown change
// while a typed note is still in flight — must both land, and a
// read-merge-write lets the later one restore the earlier one's stale snapshot.
// The insert and the update run as one batch, which D1 executes atomically.
export async function saveBoardState(
  projectId: string,
  boardId: string,
  patch: BoardStatePatch,
): Promise<BoardState> {
  const DB = await ensureBoardStateStorage();
  const now = Date.now();
  const sets = ["updated_at = ?"];
  const values: (string | number | null)[] = [now];
  if (patch.instruction !== undefined) {
    sets.push("instruction = ?");
    values.push(String(patch.instruction ?? "").trim());
  }
  if (patch.heroItemId !== undefined) {
    sets.push("hero_item_id = ?");
    values.push(String(patch.heroItemId ?? "").trim() || null);
  }
  if (patch.quality !== undefined) {
    sets.push("quality = ?");
    values.push(validOption(patch.quality, SUNBURST_QUALITY_OPTIONS, "quality"));
  }
  if (patch.background !== undefined) {
    sets.push("background = ?");
    values.push(validOption(patch.background, SUNBURST_BACKGROUND_OPTIONS, "background"));
  }
  if (patch.notes !== undefined) {
    // A stored value that is not valid JSON restarts from {} rather than
    // failing every later save, matching publicState, which reads it as none.
    sets.push("notes_json = json_patch(CASE WHEN json_valid(notes_json) THEN notes_json ELSE '{}' END, ?)");
    values.push(JSON.stringify(notesMergePatch(patch.notes)));
  }

  await DB.batch([
    DB.prepare("INSERT OR IGNORE INTO autoboard_board_state (project_id, board_id, updated_at) VALUES (?, ?, ?)")
      .bind(projectId, boardId, now),
    DB.prepare(`UPDATE autoboard_board_state SET ${sets.join(", ")} WHERE project_id = ? AND board_id = ?`)
      .bind(...values, projectId, boardId),
  ]);
  const row = await DB.prepare("SELECT * FROM autoboard_board_state WHERE project_id = ? AND board_id = ?")
    .bind(projectId, boardId)
    .first<StateRow>();
  return row ? publicState(row) : emptyBoardState(boardId);
}

// The notes part of a patch as a JSON merge patch (RFC 7396), which is what
// json_patch applies: a note sets its slot, and an emptied note becomes null,
// which removes the slot. Removing rather than storing blank keeps
// selectionHash seeing the same material it saw before the note existed.
function notesMergePatch(notes: unknown): Record<string, string | null> {
  if (!notes || typeof notes !== "object" || Array.isArray(notes)) {
    throw new Error("notes must be an object of slot id to note.");
  }
  const merge: Record<string, string | null> = {};
  for (const [slotId, note] of Object.entries(notes as Record<string, unknown>)) {
    merge[slotId] = String(note ?? "").trim() || null;
  }
  return merge;
}
```

- [ ] **Step 4: Run the tests**

Run: `node --experimental-strip-types --test tests/autoboard-board-state.test.mjs`

Expected: PASS, 5 tests. This also proves that the `node:sqlite` build supports `json_patch` and `json_valid`. D1 documents both (the JSON functions under "Query JSON").

- [ ] **Step 5: Run the suite and the gate**

Run: `npm run test:autoboard && node scripts/typecheck-baseline.mjs`

Expected: all pass; the gate exits 0.

- [ ] **Step 6: Commit**

```bash
git add app/lib/autoboard-board-state.ts tests/autoboard-board-state.test.mjs
git commit -m "fix(review-boards): make overlapping board saves keep each other's fields

saveBoardState read the row, merged in JS and rewrote every column, so a
note save and an instruction save in flight together lost one of them.
Write only the supplied columns and merge notes with json_patch, in one
atomic batch.

Co-Authored-By: <model trailer>"
```

### Task 1B.3: Picking a render is one transaction (R08)

**Files:**
- Modify: `app/lib/autoboard-renders.ts:262-278` (`setRenderStatus`)
- Test: `tests/autoboard-renders.test.mjs` (new)

**Interfaces:**
- Produces: `setRenderStatus(renderId, status)`, with the same signature, messages and return value.

- [ ] **Step 1: Write the failing tests**

Create `tests/autoboard-renders.test.mjs`:
```js
import assert from "node:assert/strict";
import test from "node:test";
import { createFakeD1, createFakeR2, installWorkerEnv } from "./helpers/fake-worker-env.mjs";

const TARGET = /UPDATE autoboard_renders SET status = \? WHERE id = \?/;
let failTarget = false;
// Both picks read their row before either writes: the interleaving that let
// two renders end up picked.
let raceActive = false;
let reads = 0;
let bothRead;
const readBarrier = new Promise((resolve) => { bothRead = resolve; });

const DB = createFakeD1({
  beforeStatement: async (kind, sql) => {
    if (failTarget && kind !== "batch" && TARGET.test(sql)) throw new Error("injected");
    if (!raceActive) return;
    if (/^\s*SELECT \* FROM autoboard_renders WHERE id = \?/i.test(sql)) {
      reads += 1;
      if (reads === 2) bothRead();
      return;
    }
    if (kind === "batch" || /^\s*UPDATE/i.test(sql)) await readBarrier;
  },
  onBatchStatement: (sql) => {
    if (failTarget && TARGET.test(sql)) throw new Error("injected");
  },
});
installWorkerEnv({ DB, OUTPUTS: createFakeR2() });
const { ensureRenderStorage, setRenderStatus } = await import("../app/lib/autoboard-renders.ts");

async function seed(projectId, renders) {
  const storage = await ensureRenderStorage();
  for (const [id, status] of renders) {
    await storage.prepare(`INSERT INTO autoboard_renders
      (id, project_id, board_id, kind, variant, status, r2_key, selection_hash, render_options_hash, quality, background, cost_usd, created_at)
      VALUES (?, ?, 'b', 'draft', 'A', ?, ?, 'h', 'o', 'low', 'opaque', NULL, ?)`)
      .bind(id, projectId, status, `autoboard/renders/${projectId}/b/${id}.png`, Date.now())
      .run();
  }
}

async function statuses(projectId) {
  const { results } = await DB.prepare("SELECT id, status FROM autoboard_renders WHERE project_id = ? ORDER BY id").bind(projectId).all();
  return Object.fromEntries(results.map((row) => [row.id, row.status]));
}

test("two picks made at the same time leave exactly one picked render (R08)", async () => {
  await seed("p-race", [["r-a", "candidate"], ["r-b", "candidate"]]);
  raceActive = true;
  await Promise.all([setRenderStatus("r-a", "picked"), setRenderStatus("r-b", "picked")]);
  raceActive = false;
  const picked = Object.values(await statuses("p-race")).filter((status) => status === "picked");
  assert.equal(picked.length, 1);
});

test("a pick that fails part-way keeps the previous pick (R08)", async () => {
  await seed("p-fail", [["r-a", "picked"], ["r-b", "candidate"]]);
  failTarget = true;
  await assert.rejects(setRenderStatus("r-b", "picked"), /injected/);
  failTarget = false;
  assert.deepEqual(await statuses("p-fail"), { "r-a": "picked", "r-b": "candidate" });
});

test("setting a render back to candidate leaves the others alone", async () => {
  await seed("p-cand", [["r-a", "picked"], ["r-b", "approved"]]);
  await setRenderStatus("r-a", "candidate");
  assert.deepEqual(await statuses("p-cand"), { "r-a": "candidate", "r-b": "approved" });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --experimental-strip-types --test tests/autoboard-renders.test.mjs`

Expected: the first two fail: `picked.length` is 2, and `r-a` becomes `candidate`. If the race test unexpectedly passes, the barrier didn't engage. Check that `setRenderStatus`'s first statement is exactly `SELECT * FROM autoboard_renders WHERE id = ?` and adjust the regex, not the assertion.

- [ ] **Step 3: Implement**

In `app/lib/autoboard-renders.ts`, replace the body of `setRenderStatus` after `if (!row) return null;`:
```ts
  if (status !== "candidate") {
    await DB.prepare("UPDATE autoboard_renders SET status = 'candidate' WHERE project_id = ? AND board_id = ? AND kind = ? AND id != ?")
      .bind(row.project_id, row.board_id, row.kind, renderId).run();
  }
  await DB.prepare("UPDATE autoboard_renders SET status = ? WHERE id = ?").bind(status, renderId).run();
  return publicRender({ ...row, status: status as RenderStatus });
```
with:
```ts
  // One selection per board and kind. Clearing the others and marking this one
  // go out as ONE batch, which D1 runs as a transaction: two picks made at the
  // same time can no longer interleave into two selections, and a failure
  // part-way can no longer leave the board with none.
  const statements: D1PreparedStatement[] = [];
  if (status !== "candidate") {
    statements.push(
      DB.prepare("UPDATE autoboard_renders SET status = 'candidate' WHERE project_id = ? AND board_id = ? AND kind = ? AND id != ?")
        .bind(row.project_id, row.board_id, row.kind, renderId),
    );
  }
  statements.push(DB.prepare("UPDATE autoboard_renders SET status = ? WHERE id = ?").bind(status, renderId));
  await DB.batch(statements);
  return publicRender({ ...row, status: status as RenderStatus });
```
If the exact text differs from the quote (whitespace, line breaks), match on the two `UPDATE autoboard_renders` statements; the logic must end up as shown.

- [ ] **Step 4: Run the tests, the suite and the gate**

Run: `node --experimental-strip-types --test tests/autoboard-renders.test.mjs && npm run test:autoboard && node scripts/typecheck-baseline.mjs`

Expected: all pass; the gate exits 0.

- [ ] **Step 5: Commit**

```bash
git add app/lib/autoboard-renders.ts tests/autoboard-renders.test.mjs
git commit -m "fix(review-boards): pick a render in one transaction

Clearing the other picks and marking the target were separate
statements, so concurrent picks left two selected and a failure in
between left none. Run both in one D1 batch.

Co-Authored-By: <model trailer>"
```

### WP-1B exit

- [ ] `npm run test:autoboard` passes.
- [ ] **Opus review** of `git diff <wp-base>..HEAD`, checking:
  - The queue's failure path re-queues beneath newer edits.
  - The unmount path can't double-send a patch that is already in flight. It can only send `takePending()`, which excludes in-flight patches.
  - `json_patch` semantics hold for slot ids containing quotes.
  - The batch statements are the only writes in `saveBoardState` and `setRenderStatus`.
- [ ] **Optional, free browser check.** `npm run dev` via the Browser preview (`material-collager-dev`, with `.dev.vars` Access vars blanked). Open a review-board project, type into two note fields within a second, and reload: both notes persist. Then type an instruction and immediately click a Render button. With no real API key the render fails at `/api/generate`, which costs nothing. `read_network_requests` must show the board `PATCH` completing **before** the `…/renders` `POST`. Skip this if no local project exists.
- [ ] **Optional paid check (only with the user's explicit yes):** one draft render at quality `low` (~$0.016) with a real key, to confirm the end-to-end chain still produces a stored render.

---

## WP-1C — Library save

Suite: `npm run test:storage`. One Sonnet session.

### Task 1C.1: Save to Library works without generation metadata (R04)

**Files:**
- Modify: `app/lib/generation-jobs.ts:191-193` (three derivations) and the `else` (INSERT) branch of `persistGenerationOutput`
- Test: `tests/storage-library-save.test.mjs` (new)

**Interfaces:**
- Produces: `persistGenerationOutput` binds `null` for unknown `model`/`quality`/`background`. When the history INSERT fails, it deletes the R2 object it just created and rethrows. The replace path (`existing`) is unchanged.

- [ ] **Step 1: Write the failing tests**

Create `tests/storage-library-save.test.mjs`:
```js
import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { createFakeD1, createFakeR2, installWorkerEnv } from "./helpers/fake-worker-env.mjs";

let failJobInsert = false;
const DB = createFakeD1({
  beforeStatement: (_kind, sql) => {
    if (failJobInsert && /^\s*INSERT INTO generation_jobs/i.test(sql)) throw new Error("D1 unavailable");
  },
});
const OUTPUTS = createFakeR2();
installWorkerEnv({ DB, OUTPUTS });
const { POST } = await import("../app/api/workbench/save/route.ts");

// The exact request both Workbench callers send (saveToLibrary.tsx and
// auto-save-final.ts): no model, quality or background anywhere.
async function save(bytes, { type = "image/png", filename } = {}) {
  const form = new FormData();
  form.append("payload", JSON.stringify({ filename, prompt: "Workbench output", format: "workbench", workflow: "test graph" }));
  form.append("image", new File([bytes], "upload", { type }));
  return POST(new Request("http://localhost/api/workbench/save", { method: "POST", body: form }));
}

const png = await sharp({ create: { width: 4, height: 4, channels: 4, background: "#808080" } }).png().toBuffer();

test("Save to Library stores a Workbench output that carries no generation metadata (R04)", async () => {
  const response = await save(png, { filename: "board.png" });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  const row = await DB.prepare("SELECT model, quality, background, output_key FROM generation_jobs WHERE id = ?").bind(body.jobId).first();
  assert.deepEqual({ model: row.model, quality: row.quality, background: row.background }, { model: null, quality: null, background: null });
  assert.ok(OUTPUTS.objects.has(row.output_key));
});

test("a history row that fails to insert takes its new R2 object with it", async () => {
  const before = OUTPUTS.objects.size;
  failJobInsert = true;
  const response = await save(png, { filename: "doomed.png" });
  failJobInsert = false;
  assert.notEqual(response.status, 200);
  assert.equal(OUTPUTS.objects.size, before);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm run test:storage`

Expected: the first new test fails. The response is not 200, because the route surfaces `D1_TYPE_ERROR … parameter 13`. The second fails because `OUTPUTS.objects.size` grew by 1, leaving an orphan.

- [ ] **Step 3: Implement**

In `app/lib/generation-jobs.ts`, replace:
```ts
  const model = input.model ?? stringField(input.payload, "model");
  const quality = input.quality ?? stringField(input.payload, "quality");
  const background = input.background ?? stringField(input.payload, "background");
```
with:
```ts
  // Unknown stays unknown: D1 refuses to bind undefined, and a Workbench save
  // carries no generation metadata at all. null is the honest value — never a
  // guessed model or quality.
  const model = input.model ?? stringField(input.payload, "model") ?? null;
  const quality = input.quality ?? stringField(input.payload, "quality") ?? null;
  const background = input.background ?? stringField(input.payload, "background") ?? null;
```
Then wrap the INSERT branch. Replace:
```ts
  } else {
    await DB.prepare(`INSERT INTO generation_jobs
```
with:
```ts
  } else {
    try {
      await DB.prepare(`INSERT INTO generation_jobs
```
and replace:
```ts
        now + RETENTION_MS,
      ).run();
  }
  const row = await DB.prepare("SELECT * FROM generation_jobs WHERE id = ?").bind(id).first<JobRow>();
```
with:
```ts
        now + RETENTION_MS,
      ).run();
    } catch (error) {
      // The object above is new and only this call knows its key. Without a
      // row nothing would ever show, expire or delete it (cleanupExpiredJobs
      // sweeps by row), so it goes too. The replace path keeps its object:
      // that key still belongs to the existing row.
      await bucket.delete(outputKey).catch(() => undefined);
      throw error;
    }
  }
  const row = await DB.prepare("SELECT * FROM generation_jobs WHERE id = ?").bind(id).first<JobRow>();
```
Re-indent the INSERT statement between the new `try {` and `} catch` by two spaces.

- [ ] **Step 4: Run the tests and the gate**

Run: `npm run test:storage && node --experimental-strip-types --test tests/image-routes.test.mjs && node scripts/typecheck-baseline.mjs`

Expected: all pass; `image-routes` is unaffected because it stubs `generation-jobs`.

- [ ] **Step 5: Commit**

```bash
git add app/lib/generation-jobs.ts tests/storage-library-save.test.mjs
git commit -m "fix(library): let Workbench outputs save without generation metadata

Both Workbench save paths omit model/quality/background, so the history
insert bound undefined and D1 rejected it after the R2 write had landed.
Bind null for unknown fields and delete the fresh object if the insert
fails.

Co-Authored-By: <model trailer>"
```

### Task 1C.2: The stored type follows the bytes (R12)

**Files:**
- Modify: `app/api/workbench/save/route.ts` (imports; `POST`; `safeFilename`)
- Test: `tests/storage-library-save.test.mjs`

**Interfaces:**
- Consumes: `sniffImageType(bytes): "image/png" | "image/jpeg" | "image/webp" | null` from `app/lib/autoboard/image-size.ts` (already tested in `tests/autoboard-image-size.test.mjs`).

- [ ] **Step 1: Write the failing tests**

Append to `tests/storage-library-save.test.mjs`:
```js
test("JPEG and WebP outputs keep their real type in R2 and in the history record (R12)", async () => {
  for (const [format, mime, extension] of [["jpeg", "image/jpeg", "jpg"], ["webp", "image/webp", "webp"]]) {
    const bytes = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#808080" } })[format]().toBuffer();
    const response = await save(bytes, { type: mime, filename: "board.png" });
    assert.equal(response.status, 200, `${format} save failed`);
    const { jobId } = await response.json();
    const row = await DB.prepare("SELECT output_key, output_format, filename FROM generation_jobs WHERE id = ?").bind(jobId).first();
    assert.match(row.output_key, new RegExp(`\\.${extension}$`));
    assert.equal(row.output_format, extension);
    assert.equal(row.filename, `board.${extension}`);
    assert.equal(OUTPUTS.objects.get(row.output_key).httpMetadata.contentType, mime);
  }
});

test("bytes that are not PNG, JPEG or WebP are refused before anything is stored", async () => {
  const before = OUTPUTS.puts.length;
  const response = await save(new TextEncoder().encode("GIF89a not really an image"), { type: "image/gif" });
  assert.notEqual(response.status, 200);
  assert.equal(OUTPUTS.puts.length, before);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm run test:storage`

Expected: the R12 test fails. The key ends in `.png` and the content type is `image/png`. The GIF test fails because a put happened.

- [ ] **Step 3: Implement**

In `app/api/workbench/save/route.ts`:
- Add, after the existing two imports:
```ts
import { sniffImageType } from "@/app/lib/autoboard/image-size";
```
- In `POST`, replace:
```ts
    const stored = await persistGenerationOutput({
      imageBase64: base64FromBytes(new Uint8Array(await image.arrayBuffer())),
      filename: safeFilename(payload.filename),
```
with:
```ts
    const bytes = new Uint8Array(await image.arrayBuffer());
    // The bytes decide the type, not the caller's filename or Content-Type:
    // persistence derives the R2 content type and the history's format from
    // the extension, so it has to be the real one.
    const type = sniffImageType(bytes);
    if (!type) throw new Error("Only PNG, JPEG or WebP images can be saved to the library.");
    const stored = await persistGenerationOutput({
      imageBase64: base64FromBytes(bytes),
      filename: safeFilename(payload.filename, type),
```
- Replace `safeFilename`:
```ts
function safeFilename(value?: string) {
  const raw = value?.trim() || "workbench-output.png";
  const withExtension = raw.toLowerCase().endsWith(".png") ? raw : `${raw}.png`;
  return withExtension.replace(/[<>:"/\\|?*]+/g, "_");
}
```
with:
```ts
const EXTENSION_FOR_TYPE = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" } as const;

// Renaming is not transcoding: "board.png" holding JPEG bytes is stored as
// "board.jpg", so its name, MIME type and recorded format all agree.
function safeFilename(value: string | undefined, type: keyof typeof EXTENSION_FOR_TYPE) {
  const stem = (value?.trim() || "workbench-output").replace(/\.(png|jpe?g|webp)$/i, "");
  return `${stem}.${EXTENSION_FOR_TYPE[type]}`.replace(/[<>:"/\\|?*]+/g, "_");
}
```

- [ ] **Step 4: Run the tests and the gate**

Run: `npm run test:storage && node scripts/typecheck-baseline.mjs`

Expected: all pass; the gate exits 0.

- [ ] **Step 5: Commit**

```bash
git add app/api/workbench/save/route.ts tests/storage-library-save.test.mjs
git commit -m "fix(library): store Workbench JPEG/WebP outputs under their real type

The save route forced a .png name, and persistence derives the MIME
type and format from it, so JPEG/WebP bytes were stored as image/png.
Sniff the bytes and name the file by what they are.

Co-Authored-By: <model trailer>"
```

### WP-1C exit

- [ ] `npm run test:storage` passes (6 + 4 tests).
- [ ] Sonnet spec check. PNG/JPEG/WebP saves work without metadata, which covers both callers because they send the same payload. A failed insert leaves no orphan. The replace path is untouched.

---

## WP-1D — Workbench identity

Suite: `npm run test:workbench` plus `tests/image-transport-cache.test.mjs`. One Sonnet session; **Opus review at the end**.

### Task 1D.1: Autosave acknowledges only the edits it saved

**Files:**
- Modify: `app/components/workbench/persistence.ts` (new `createDirtyChannel`, directly after `decidePendingSave`)
- Modify: `app/components/workbench/WorkbenchApp.tsx:954-955`, `:1012-1030`, `:1036-1057`, `:1081-1098`
- Test: `tests/workbench-autosave-ack.test.mjs` (new)

**Interfaces:**
- Produces:
```ts
export type DirtyChannel = { edit(): void; begin(): number; settle(begun: number): void; readonly dirty: boolean };
export function createDirtyChannel(): DirtyChannel;
```

**The traced race:**
1. Edit A's 900 ms timer fires and starts `saveGraphStructure`.
2. Edit B arrives while that save is in flight and arms a new timer.
3. A's save resolves and sets `structureDirtyRef.current = false`.
4. The user switches graphs before B's timer fires.
5. `flushPendingSaves` cancels B's timer, reads `decidePendingSave(false, false)` → `"none"`, and skips the save.
6. `switchGraph` reloads the page, and B is gone.

- [ ] **Step 1: Write the failing tests**

Create `tests/workbench-autosave-ack.test.mjs`:
```js
import assert from "node:assert/strict";
import test from "node:test";
import { createDirtyChannel, decidePendingSave } from "../app/components/workbench/persistence.ts";

test("a save that lands after a newer edit leaves that edit owed", () => {
  const structure = createDirtyChannel();
  structure.edit();                  // edit A
  const saveA = structure.begin();   // A's autosave reads the store
  structure.edit();                  // edit B, while A's save is in flight
  structure.settle(saveA);           // A's save lands
  assert.equal(structure.dirty, true);
  assert.equal(decidePendingSave(structure.dirty, false), "structure");
});

test("an older save settling after a newer one does not un-save anything", () => {
  const channel = createDirtyChannel();
  channel.edit();
  const older = channel.begin();
  channel.edit();
  const newer = channel.begin();
  channel.settle(newer);
  channel.settle(older);
  assert.equal(channel.dirty, false);
});

test("a save that never settles (it failed) keeps the channel dirty", () => {
  const channel = createDirtyChannel();
  channel.edit();
  channel.begin();
  assert.equal(channel.dirty, true);
});

test("a fresh channel is clean", () => {
  assert.equal(createDirtyChannel().dirty, false);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --experimental-strip-types --test tests/workbench-autosave-ack.test.mjs`

Expected: FAIL — `createDirtyChannel` is not exported (a `SyntaxError` at import).

- [ ] **Step 3: Implement the channel**

In `app/components/workbench/persistence.ts`, directly after the closing `}` of `decidePendingSave`, add:
```ts

// One autosave channel's dirty state, counted instead of flagged. A save
// covers only the edits that existed when it read the store; an edit made
// while it was in flight is still owed. With a boolean, that older save's
// completion cleared the flag, a graph switch then decided nothing was
// pending, skipped the save and reloaded the edit away. Pure and
// framework-free, like decidePendingSave, so the ordering is unit-testable.
export type DirtyChannel = {
  /** An edit happened. */
  edit(): void;
  /** A save is reading the store now; hand the result to settle() when it succeeds. */
  begin(): number;
  /** The save that began at `begun` succeeded: everything up to it is stored. */
  settle(begun: number): void;
  readonly dirty: boolean;
};

export function createDirtyChannel(): DirtyChannel {
  let edits = 0;
  let saved = 0;
  return {
    edit() {
      edits += 1;
    },
    begin() {
      return edits;
    },
    settle(begun) {
      if (begun > saved) saved = begun;
    },
    get dirty() {
      return edits > saved;
    },
  };
}
```

- [ ] **Step 4: Run the channel tests**

Run: `node --experimental-strip-types --test tests/workbench-autosave-ack.test.mjs`

Expected: PASS, 4 tests.

- [ ] **Step 5: Wire it into `WorkbenchApp`**

In `app/components/workbench/WorkbenchApp.tsx`:

(a) Add `createDirtyChannel` to the existing import from `./persistence` (the one that already brings in `decidePendingSave`).

(b) Replace lines 954–955:
```tsx
  const structureDirtyRef = useRef(false);
  const blobDirtyRef = useRef(false);
```
with:
```tsx
  // Counted, not boolean: see createDirtyChannel (persistence.ts).
  const [structureDirty] = useState(createDirtyChannel);
  const [blobDirty] = useState(createDirtyChannel);
  // Autosaves still writing. A flush waits for them before deciding what is
  // owed, so it never races an older write for the same graph's records and
  // never re-writes one that is about to land.
  const inFlightSavesRef = useRef(new Set<Promise<void>>());
  const trackSave = useCallback((save: Promise<void>) => {
    inFlightSavesRef.current.add(save);
    save.then(
      () => inFlightSavesRef.current.delete(save),
      () => inFlightSavesRef.current.delete(save),
    );
    return save;
  }, []);
```
(`useState`, `useRef` and `useCallback` are already imported by this component; confirm and add any that are missing.)

(c) Replace the structure-only autosave effect (from `  useEffect(() => {` through `  }, [dirtyStamp]);`) with:
```tsx
  useEffect(() => {
    if (!hasRestored.current || !dirtyStamp) return;
    structureDirty.edit();
    const timeout = window.setTimeout(() => {
      structureTimeoutRef.current = null;
      const begun = structureDirty.begin();
      const state = useWorkbenchStore.getState();
      trackSave(
        saveGraphStructure(graphIdRef.current, state.nodes as WorkbenchNode[], state.edges).then(() => {
          structureDirty.settle(begun);
        }),
      ).catch(() => {
        // Autosave is best-effort; the canvas keeps working without it.
        // Leaves the channel dirty so a later graph-switch flush still
        // attempts this save rather than silently skipping it.
      });
    }, 900);
    structureTimeoutRef.current = timeout;
    return () => window.clearTimeout(timeout);
  }, [dirtyStamp, structureDirty, trackSave]);
```

(d) Replace the blob autosave effect (from its `  useEffect(() => {` through `  }, [blobStamp]);`) with:
```tsx
  useEffect(() => {
    if (!hasRestored.current || !blobStamp) return;
    blobDirty.edit();
    const timeout = window.setTimeout(() => {
      blobTimeoutRef.current = null;
      const blobBegun = blobDirty.begin();
      const structureBegun = structureDirty.begin();
      const state = useWorkbenchStore.getState();
      trackSave(
        saveGraph(graphIdRef.current, state.nodes as WorkbenchNode[], state.edges).then(() => {
          blobDirty.settle(blobBegun);
          // saveGraph also rewrites the structure record in the same
          // transaction (see its own comment), so the structure edits it read
          // are stored too — only those; a later edit stays owed.
          structureDirty.settle(structureBegun);
          setSavedAt(Date.now());
        }),
      ).catch(() => {
        // Autosave is best-effort; the canvas keeps working without it.
      });
    }, 400);
    blobTimeoutRef.current = timeout;
    return () => window.clearTimeout(timeout);
  }, [blobStamp, blobDirty, structureDirty, trackSave]);
```

(e) Replace `flushPendingSaves` (from `  const flushPendingSaves = useCallback(async (): Promise<void> => {` through `  }, [cancelPendingTimers]);`) with:
```tsx
  const flushPendingSaves = useCallback(async (): Promise<void> => {
    cancelPendingTimers();
    // Let autosaves already writing land (or fail) first; only then do the
    // channels say what is still owed.
    await Promise.allSettled([...inFlightSavesRef.current]);
    const decision = decidePendingSave(structureDirty.dirty, blobDirty.dirty);
    if (decision === "none") return;
    const structureBegun = structureDirty.begin();
    const blobBegun = blobDirty.begin();
    const state = useWorkbenchStore.getState();
    const nodes = state.nodes as WorkbenchNode[];
    const edges = state.edges;
    const graphId = graphIdRef.current;
    if (decision === "full") {
      await saveGraph(graphId, nodes, edges);
      blobDirty.settle(blobBegun);
      structureDirty.settle(structureBegun);
      setSavedAt(Date.now());
      return;
    }
    await saveGraphStructure(graphId, nodes, edges);
    structureDirty.settle(structureBegun);
  }, [cancelPendingTimers, structureDirty, blobDirty]);
```

(f) Run: `grep -n "structureDirtyRef\|blobDirtyRef" app/components/workbench/WorkbenchApp.tsx`

Expected: no matches.

- [ ] **Step 6: Lint, the suite and the gate**

Run: `npx eslint app/components/workbench/WorkbenchApp.tsx app/components/workbench/persistence.ts && npm run test:workbench && node scripts/typecheck-baseline.mjs`

Expected: no new lint errors, all workbench tests pass, and the gate exits 0.

- [ ] **Step 7: Commit**

```bash
git add app/components/workbench/persistence.ts app/components/workbench/WorkbenchApp.tsx tests/workbench-autosave-ack.test.mjs
git commit -m "fix(workbench): don't let an older autosave clear a newer edit's dirty flag

A save that finished after a later edit cleared the boolean dirty flag;
switching graphs then skipped the save and reloaded the edit away.
Count edits per channel so a save only acknowledges what it read, and
let a flush wait for in-flight autosaves before deciding.

Co-Authored-By: <model trailer>"
```

### Task 1D.2: The transport cache keys on content, not file metadata (P04 identity)

**Files:**
- Modify: `app/lib/image-transport.ts:124-127` (`optimizeReferenceForTransport`); add `transportCacheKey`
- Test: `tests/image-transport-cache.test.mjs` (new)

**Interfaces:**
- Produces: `transportCacheKey(file: File, targetBytes: number): Promise<string>` returns `"<sha256 hex>|<targetBytes>"`. `fileFingerprint` is **unchanged**, because photo-node run signatures persist it (`photo.tsx`, `persistence.ts`, `export-import.ts`).

- [ ] **Step 1: Write the failing tests**

Create `tests/image-transport-cache.test.mjs`:
```js
import assert from "node:assert/strict";
import test from "node:test";
import { fileFingerprint, transportCacheKey } from "../app/lib/image-transport.ts";

test("two different images that share a fingerprint get different transport cache keys", async () => {
  // How Workbench builds every reference (fileFromCacheKey): a fixed
  // "input.<ext>" name, and lastModified from the same millisecond.
  const lastModified = 1_700_000_000_000;
  const a = new File([new Uint8Array([1, 2, 3, 4])], "input.png", { type: "image/png", lastModified });
  const b = new File([new Uint8Array([4, 3, 2, 1])], "input.png", { type: "image/png", lastModified });
  assert.equal(fileFingerprint(a), fileFingerprint(b));
  assert.notEqual(await transportCacheKey(a, 1000), await transportCacheKey(b, 1000));
});

test("the same bytes under different names share a key, and the target size is part of it", async () => {
  const bytes = new Uint8Array([9, 8, 7]);
  const a = new File([bytes], "input.png", { type: "image/png" });
  const b = new File([bytes], "renamed.png", { type: "image/png" });
  assert.equal(await transportCacheKey(a, 1000), await transportCacheKey(b, 1000));
  assert.notEqual(await transportCacheKey(a, 1000), await transportCacheKey(a, 2000));
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --experimental-strip-types --test tests/image-transport-cache.test.mjs`

Expected: FAIL — `transportCacheKey` is not exported.

- [ ] **Step 3: Implement**

In `app/lib/image-transport.ts`, directly above `export async function optimizeReferenceForTransport`, add:
```ts
// Keyed on the bytes. fileFingerprint (name, size, date, type) is not identity
// here: Workbench hands every reference over as a fresh `input.<ext>` File
// stamped in the same millisecond (fileFromCacheKey), so two different images
// of one type and byte length would share a key, and a paid render would
// receive the other image's compressed copy. Hashing costs far less than the
// decode and re-encode this cache exists to skip.
export async function transportCacheKey(file: File, targetBytes: number): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return `${hex}|${targetBytes}`;
}

```
and in `optimizeReferenceForTransport` replace:
```ts
  const cacheKey = `${fileFingerprint(file)}|${targetBytes}`;
```
with:
```ts
  const cacheKey = await transportCacheKey(file, targetBytes);
```

- [ ] **Step 4: Run the tests and the gate**

Run: `node --experimental-strip-types --test tests/image-transport-cache.test.mjs && node scripts/typecheck-baseline.mjs`

Expected: PASS, 2 tests; the gate exits 0.

- [ ] **Step 5: Commit**

```bash
git add app/lib/image-transport.ts tests/image-transport-cache.test.mjs
git commit -m "fix(transport): key compressed references on content, not file metadata

Workbench builds every reference as input.<ext> in the same millisecond,
so equal-size images shared a fingerprint and could share one cached
compressed copy, sending the wrong picture to a paid render.

Co-Authored-By: <model trailer>"
```

### WP-1D exit

- [ ] `npm run test:workbench` and `node --experimental-strip-types --test tests/image-transport-cache.test.mjs` pass.
- [ ] **Opus review** of `git diff <wp-base>..HEAD`, checking:
  - Every former `structureDirtyRef`/`blobDirtyRef` use maps to `edit`/`begin`/`settle`/`dirty` correctly.
  - `begin()` is captured in the same tick the store is read.
  - `flushPendingSaves` still throws on failure without settling, so `switchGraph` keeps its alert-and-stay path.
  - The `FLUSH_TIMEOUT_MS` race in `switchGraph` still bounds a hung in-flight save.
- [ ] **Optional free browser check.** In `/workbench`, add a node, then within a second move it and switch graphs; reload and switch back. Both edits are present.

---

## Phase 1 exit criteria

- [ ] `node --experimental-strip-types --test --test-reporter=dot tests/*.test.mjs`: 0 failures.
- [ ] `npm run lint`: no new errors against the Phase 0 baseline.
- [ ] `node scripts/typecheck-baseline.mjs` exits 0.
- [ ] Opus phase review of the combined diff before merging Phase 1.
