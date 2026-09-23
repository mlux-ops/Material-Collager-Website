# Review Remediation — Phase 2: Paid Work and Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Never buy work that isn't recorded, never pay for a request the person already abandoned, never auto-retry a paid call, and never fetch a user-supplied URL (or a redirect from it) that points inside the perimeter, or read an unbounded body from one: R09, P06, the Python retry policy, R10 and R11.

**Architecture:** Two work packages.
- **WP-2A:** Paid attempts.
  - Economy writes its job row *before* the paid batch call and marks it failed with a traceable message when the call fails.
  - The board render threads the request's abort signal through and checks it before any work.
  - Economy history refreshes a bounded slice per request.
  - The Python SDK clients are built with `max_retries=0`.
- **WP-2B:** Outbound fetch.
  - One new module, `app/lib/guarded-fetch.ts`. Its `fetchPublic` follows redirects manually and validates every hop with the existing `assertFetchableUrl`. Its `readCapped` streams against a byte cap and cancels on overflow.
  - All four server-side fetch sites move to it: autoboard photos (two callers), reference import, and reference matches (two helpers).
  - The base64 upload is size-checked before decoding.

**Tech Stack:** `node:test` + `tests/helpers/fake-worker-env.mjs`; Python `unittest` for the legacy client.

**Inherits:** every rule in `2026-09-22-review-remediation-00-overview.md → Global Constraints`. **Requires Phases 0 and 1.** Task 2A.2 appends to `tests/autoboard-renders.test.mjs`, created in WP-1B.

**Model routing:** implementer Sonnet 5 for both WPs; Task 2A.4 can go to Haiku 4.5. **Opus review at the end of each WP**: ordering around a paid call in 2A, and SSRF in 2B.

## Global Constraints

- Every network call in tests is mocked (`t.mock.method(globalThis, "fetch", …)`); no test sets a real key. `process.env.OPENAI_API_KEY = "test-only"` is the existing convention.
- Nothing retries a paid call: no loops, no SDK retries, no "try again" inside a handler.
- Keep what the review says already works: Economy's `Promise.allSettled` polling, the atomic claim with stale-lease recovery in `refreshJob`, bounded `finalize_attempts`, and the disabled automatic QA.
- `app/lib/guarded-fetch.ts` imports only `./autoboard/photo-sources.ts`. The guard is hostname-based by design: a Worker has no DNS API.

## File Structure

| File | WP | Change |
|---|---|---|
| `app/api/economy/route.ts` | 2A | Record-before-submit in `POST`; bounded, batch-id-only refresh in `GET` |
| `app/lib/autoboard-renders.ts` | 2A | `RenderDeps.signal`; `throwIfAborted` before work; the signal on the internal `Request` |
| `app/api/autoboard/projects/[id]/boards/[boardId]/renders/route.ts` | 2A | Passes `request.signal` |
| `src/material_collager/client.py`, `src/material_collager/qa.py` | 2A | `OpenAI(max_retries=0)` |
| `tests/storage-economy-submit.test.mjs` (new), `tests/autoboard-renders.test.mjs`, `tests/test_client.py` | 2A | |
| `app/lib/guarded-fetch.ts` (new) | 2B | `fetchPublic`, `readCapped`, `MAX_REDIRECTS` |
| `app/lib/autoboard-photos.ts` | 2B | Uses `fetchPublic`/`readCapped`; base64 pre-check |
| `app/api/references/import/route.ts` | 2B | Uses `fetchPublic`/`readCapped`; drops `safeRemoteUrl` and its local reader |
| `app/api/references/matches/route.ts` | 2B | `safeHttps` delegates to `assertFetchableUrl`; both fetch helpers use `fetchPublic`/`readCapped` |
| `tests/storage-guarded-fetch.test.mjs`, `tests/autoboard-photos.test.mjs` (new) | 2B | |

---

## WP-2A — Paid attempts

### Task 2A.1: Economy records the job before buying the batch (R09)

**Files:**
- Modify: `app/api/economy/route.ts:41-77` (inside `POST`, from `const apiKey = resolveOpenAIKey();` through the `return Response.json(...)`)
- Test: `tests/storage-economy-submit.test.mjs` (new)

**Interfaces:**
- Produces: the `POST /api/economy` response shape is unchanged. The row now exists before the paid call:
  - `status 'submitting'` and `openai_batch_id NULL` while the batch call is in flight.
  - Then the batch's status and id on success.
  - Then `status 'failed'` with an error naming `material_collager_job = <jobId>` (the batch metadata key already sent in `submitEconomyBatch`) on failure.

- [ ] **Step 1: Write the failing tests**

Create `tests/storage-economy-submit.test.mjs`:
```js
import assert from "node:assert/strict";
import test from "node:test";
import { createFakeD1, createFakeR2, installWorkerEnv } from "./helpers/fake-worker-env.mjs";

let failJobInsert = false;
const DB = createFakeD1({
  beforeStatement: (_kind, sql) => {
    if (failJobInsert && /^\s*INSERT INTO generation_jobs/i.test(sql)) throw new Error("D1 unavailable");
  },
});
installWorkerEnv({ DB, OUTPUTS: createFakeR2() });
process.env.OPENAI_API_KEY = "test-only";
const { GET, POST } = await import("../app/api/economy/route.ts");

const payload = {
  collageType: "bathroom_fixture_collage",
  orientation: "landscape",
  quality: "high",
  background: "opaque",
  outputResolution: "final",
  layoutReference: true,
  layoutReferenceFileId: "file-layout",
  items: [{ id: "faucet", role: "faucet", imageFileIds: ["file-product"] }],
};
const submit = () => POST(new Request("http://localhost/api/economy", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ payload }),
}));

// OpenAI's two submission endpoints: the JSONL upload, then the batch itself.
function mockOpenAI(t, { failBatch = false } = {}) {
  const calls = { files: 0, batches: 0 };
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).endsWith("/v1/files")) {
      calls.files += 1;
      return Response.json({ id: `file_input_${calls.files}` });
    }
    if (String(url).endsWith("/v1/batches")) {
      calls.batches += 1;
      if (failBatch) return Response.json({ error: { message: "upstream unavailable" } }, { status: 503 });
      return Response.json({ id: `batch_${calls.batches}`, status: "validating" });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  return calls;
}

test("if the job can't be recorded, no batch is bought (R09)", async (t) => {
  const calls = mockOpenAI(t);
  failJobInsert = true;
  const response = await submit();
  failJobInsert = false;
  assert.notEqual(response.status, 200);
  assert.equal(calls.batches, 0);
});

test("an accepted batch is recorded with its provider id (R09)", async (t) => {
  mockOpenAI(t);
  const response = await submit();
  assert.equal(response.status, 200);
  const { jobId } = await response.json();
  const row = await DB.prepare("SELECT status, openai_batch_id FROM generation_jobs WHERE id = ?").bind(jobId).first();
  assert.deepEqual(row, { status: "validating", openai_batch_id: "batch_1" });
});

test("a failed submission leaves a failed row that says how to check before paying again", async (t) => {
  mockOpenAI(t, { failBatch: true });
  const response = await submit();
  assert.notEqual(response.status, 200);
  const row = await DB.prepare("SELECT id, status, error, openai_batch_id FROM generation_jobs WHERE mode = 'economy' ORDER BY rowid DESC LIMIT 1").first();
  assert.equal(row.status, "failed");
  assert.equal(row.openai_batch_id, null);
  assert.match(row.error, new RegExp(`material_collager_job = ${row.id}`));
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --experimental-strip-types --test tests/storage-economy-submit.test.mjs`

Expected: the first test fails (`calls.batches` is 1: the batch was bought, then the insert failed). The third fails because no row exists.

- [ ] **Step 3: Implement**

In `app/api/economy/route.ts`, replace everything in `POST` from `    const jobId = crypto.randomUUID();` through `    return Response.json({ ok: true, jobId, status: batch.status, estimatedUsd: null });` with:
```ts
    const jobId = crypto.randomUUID();
    const now = Date.now();
    const DB = await ensureJobStorage();
    // Recorded BEFORE the paid call. A batch OpenAI accepted must never exist
    // without a row here — nothing would ever poll, finalize or show it — and
    // storage that is down right now means no batch is bought at all.
    await DB.prepare(`INSERT INTO generation_jobs
      (id, mode, status, openai_batch_id, output_key, filename, format, prompt, payload_json, reference_ids_json,
       render_kind, collage_type, library_visible, title, estimated_usd, usage_json, qa_json, error,
       model, quality, background, output_format, cost_usd, created_at, updated_at, expires_at)
      VALUES (?, 'economy', 'submitting', NULL, NULL, ?, ?, ?, ?, ?, 'final', ?, 1, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, NULL, ?, ?, ?)`)
      .bind(
        jobId,
        finalFilename(payload.outputFilename),
        resolvedSize(payload),
        prompt,
        JSON.stringify({
          ...payload,
          model: SUNBURST_MODEL,
          outputFormat: resolvedOutputFormat(payload),
        }),
        JSON.stringify(referenceIds),
        payload.collageType,
        displayTitle(payload.outputFilename, payload.collageType),
        SUNBURST_MODEL,
        payload.quality,
        resolvedBackground(payload),
        resolvedOutputFormat(payload),
        now,
        now,
        now + RETENTION_MS,
      ).run();

    let batch: BatchResponse;
    try {
      batch = await submitEconomyBatch(apiKey, jobId, prompt, allImageIds, resolvedSize(payload), payload.quality, resolvedBackground(payload));
    } catch (error) {
      // Terminal, so history stops polling it. The request may still have
      // reached OpenAI before the error (a timeout, a dropped connection), so
      // the record says how to check before paying for another. The batch
      // carries this id as metadata (submitEconomyBatch).
      const message = error instanceof Error ? error.message : String(error);
      await DB.prepare("UPDATE generation_jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
        .bind(
          `Submission did not complete (${message}). Before resubmitting, check OpenAI's Batches page for metadata material_collager_job = ${jobId}.`,
          Date.now(),
          jobId,
        )
        .run()
        .catch(() => undefined);
      throw error;
    }
    await DB.prepare("UPDATE generation_jobs SET status = ?, openai_batch_id = ?, updated_at = ? WHERE id = ?")
      .bind(batch.status || "validating", batch.id, Date.now(), jobId)
      .run();
    return Response.json({ ok: true, jobId, status: batch.status, estimatedUsd: null });
```
The old code declared `const now` and `const DB` after the batch call. Both are now declared above, so delete the old declarations; there must be exactly one of each in `POST`.

- [ ] **Step 4: Run the new and the existing Economy tests**

Run: `node --experimental-strip-types --test tests/storage-economy-submit.test.mjs tests/image-routes.test.mjs`

Expected: all pass. The existing `"Economy submission sends Sunburst…"` still finds an `INSERT INTO generation_jobs` whose args include model, quality and background.

- [ ] **Step 5: Commit**

```bash
git add app/api/economy/route.ts tests/storage-economy-submit.test.mjs
git commit -m "fix(economy): record the job before buying the batch

Economy submitted the paid batch and only then inserted its row, so a
failed insert left an accepted, untracked batch and a retry bought a
second one. Write a 'submitting' row first, then the batch id; a failed
submission is marked failed with the metadata id to check.

Co-Authored-By: <model trailer>"
```

### Task 2A.2: A board render stops when its request is abandoned (R09, web)

**Files:**
- Modify: `app/lib/autoboard-renders.ts` (`RenderDeps`; the start of `renderBoardDraft`; the `options.generate(new Request(...))` call)
- Modify: `app/api/autoboard/projects/[id]/boards/[boardId]/renders/route.ts` (the `renderBoardDraft(...)` call)
- Test: `tests/autoboard-renders.test.mjs` (append)

**Interfaces:**
- Produces: `RenderDeps.signal?: AbortSignal`. `renderBoardDraft` throws the signal's `AbortError` before any storage read or generation when it is already aborted. After dispatch, `/api/generate` receives the same signal on its `Request`; that route already calls `throwIfAborted()` and threads the signal into `createImageEdit`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/autoboard-renders.test.mjs`:
```js
const { renderBoardDraft } = await import("../app/lib/autoboard-renders.ts");

function abortBoard() {
  return {
    id: "b", unitType: "Penthouse", roomLabel: "Bath 2", collageType: "bathroom_fixture_collage",
    kindLabel: "Fixture Collage", title: "Bath",
    items: [{ slotId: "vanity_faucet", role: "vanity faucet", required: true, rowId: "1", sku: "A", brand: "Brizo", name: "Odin Faucet", notes: "", images: [] }],
  };
}

test("a board render whose request was already abandoned never reaches generation (R09)", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(
    renderBoardDraft("p-abort", abortBoard(), "", {
      origin: "http://localhost",
      signal: controller.signal,
      generate: async () => { calls += 1; return Response.json({}); },
    }),
    { name: "AbortError" },
  );
  assert.equal(calls, 0);
});

test("the incoming request's signal reaches the generation request", async () => {
  const controller = new AbortController();
  let forwarded;
  await assert.rejects(renderBoardDraft("p-abort", abortBoard(), "", {
    origin: "http://localhost",
    signal: controller.signal,
    generate: async (request) => {
      controller.abort();
      forwarded = request.signal.aborted;
      return Response.json({ ok: false, error: "cancelled" }, { status: 499 });
    },
  }));
  assert.equal(forwarded, true);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --experimental-strip-types --test tests/autoboard-renders.test.mjs`

Expected: both new tests fail. `calls` is 1 because generation ran, and `forwarded` is `false`.

- [ ] **Step 3: Implement**

In `app/lib/autoboard-renders.ts`, inside `export type RenderDeps = { … }`, after the `origin: string;` member and its comment, add:
```ts
  /**
   * The incoming request's signal. A render the reviewer has already abandoned
   * stops before anything is read or paid for; once dispatched, the generate
   * route passes it on to the image API. Aborting cannot un-bill a request
   * OpenAI already accepted.
   */
  signal?: AbortSignal;
```
At the top of `renderBoardDraft`'s body, replace:
```ts
  const DB = await ensureRenderStorage();
  const kind = options.kind ?? "draft";
```
with:
```ts
  options.signal?.throwIfAborted();
  const DB = await ensureRenderStorage();
  const kind = options.kind ?? "draft";
```
And replace:
```ts
  const response = await options.generate(
    new Request(`${options.origin}/api/generate`, { method: "POST", body: form }),
  );
```
with:
```ts
  const response = await options.generate(
    new Request(`${options.origin}/api/generate`, { method: "POST", body: form, signal: options.signal }),
  );
```
In `app/api/autoboard/projects/[id]/boards/[boardId]/renders/route.ts`, replace:
```ts
    const render = await renderBoardDraft(id, board, board.state.instruction, {
      variant,
      generate,
      origin: new URL(request.url).origin,
    });
```
with:
```ts
    const render = await renderBoardDraft(id, board, board.state.instruction, {
      variant,
      generate,
      origin: new URL(request.url).origin,
      signal: request.signal,
    });
```

- [ ] **Step 4: Run the tests and the gate**

Run: `npm run test:autoboard && node scripts/typecheck-baseline.mjs`

Expected: all pass; the gate exits 0.

- [ ] **Step 5: Commit**

```bash
git add app/lib/autoboard-renders.ts "app/api/autoboard/projects/[id]/boards/[boardId]/renders/route.ts" tests/autoboard-renders.test.mjs
git commit -m "fix(review-boards): honour an abandoned render request

The board render built its internal /api/generate request without the
incoming signal, so an already-aborted request still reached the paid
call. Check the signal before any work and pass it through.

Co-Authored-By: <model trailer>"
```

### Task 2A.3: Economy history answers without waiting on every pending batch (P06)

**Files:**
- Modify: `app/api/economy/route.ts` (the `pending` query in `GET`)
- Test: `tests/storage-economy-submit.test.mjs` (append)

**Interfaces:**
- Produces: `GET /api/economy` refreshes at most 2 pending jobs per call, least recently updated first. It only refreshes rows that have a batch id. The response shape is unchanged.

- [ ] **Step 1: Write the failing test**

Append to `tests/storage-economy-submit.test.mjs`:
```js
test("history refreshes at most two pending batches per request, oldest first, and skips rows with no batch", async (t) => {
  await DB.prepare("DELETE FROM generation_jobs").run();
  const now = Date.now();
  const insert = (id, status, batchId, updatedAt) => DB.prepare(`INSERT INTO generation_jobs
      (id, mode, status, openai_batch_id, filename, format, prompt, payload_json, reference_ids_json, created_at, updated_at, expires_at)
      VALUES (?, 'economy', ?, ?, 'f.png', '1536x1024', 'p', '{}', '[]', ?, ?, ?)`)
    .bind(id, status, batchId, now, updatedAt, now + 1e9).run();
  await insert("job-unsent", "submitting", null, now - 10);
  for (let n = 0; n < 5; n++) await insert(`job-${n}`, "in_progress", `batch-${n}`, now + n);
  const polled = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    polled.push(String(url).split("/").pop());
    return Response.json({ id: "x", status: "in_progress" });
  });
  const response = await GET();
  assert.equal(response.status, 200);
  assert.deepEqual(polled, ["batch-0", "batch-1"]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --experimental-strip-types --test --test-name-pattern="at most two" tests/storage-economy-submit.test.mjs`

Expected: FAIL. `polled` holds all five batch ids.

- [ ] **Step 3: Implement**

In `GET`, replace:
```ts
    const pending = await DB.prepare("SELECT * FROM generation_jobs WHERE mode = 'economy' AND output_key IS NULL AND status NOT IN ('failed', 'expired', 'cancelled') ORDER BY updated_at ASC LIMIT 8")
      .all<JobRow>();
```
with:
```ts
    // Two per request: each refresh can wait on OpenAI (a status check, then
    // possibly a result download) before history can answer. The page polls
    // every 30 s while anything is pending, and a refreshed row's updated_at
    // moves it to the back, so every pending job still gets its turn. A row
    // with no batch id has nothing to check (see POST).
    const pending = await DB.prepare("SELECT * FROM generation_jobs WHERE mode = 'economy' AND output_key IS NULL AND openai_batch_id IS NOT NULL AND status NOT IN ('failed', 'expired', 'cancelled') ORDER BY updated_at ASC LIMIT 2")
      .all<JobRow>();
```

- [ ] **Step 4: Run the Economy tests**

Run: `node --experimental-strip-types --test tests/storage-economy-submit.test.mjs tests/image-routes.test.mjs`

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add app/api/economy/route.ts tests/storage-economy-submit.test.mjs
git commit -m "perf(economy): bound the provider checks a history request waits on

GET refreshed up to eight pending batches, each able to wait on OpenAI
and a result download, before listing history. Refresh the two least
recently updated jobs that have a batch id; the 30 s poll covers the rest.

Co-Authored-By: <model trailer>"
```

### Task 2A.4: The Python CLI never auto-retries a paid call

**Files:**
- Modify: `src/material_collager/client.py:89`, `src/material_collager/qa.py:162`
- Test: `tests/test_client.py`

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_client.py`, before any `if __name__ == "__main__":` block (or at the end if there is none):
```python
class OpenAIClientConstructionTests(unittest.TestCase):
    """The SDK retries twice by default; an accepted-but-timed-out paid call would be billed again."""

    def _construct(self, factory):
        import sys
        from unittest import mock

        created = {}

        class FakeOpenAI:
            def __init__(self, **kwargs):
                created.update(kwargs)

        with mock.patch.dict(sys.modules, {"openai": mock.Mock(OpenAI=FakeOpenAI)}), mock.patch.dict(
            os.environ, {"OPENAI_API_KEY": "test-only"}
        ):
            factory()
        return created

    def test_image_client_never_retries_a_paid_call(self):
        from material_collager.client import _make_openai_client

        self.assertEqual(self._construct(_make_openai_client).get("max_retries"), 0)

    def test_qa_client_never_retries_a_paid_call(self):
        from material_collager.qa import _make_openai_client

        self.assertEqual(self._construct(_make_openai_client).get("max_retries"), 0)
```

- [ ] **Step 2: Run them to verify they fail**

Run: `PYTHONPATH=src python -m unittest discover -s tests -p "test_client.py" -v`

Expected: 2 failures; `max_retries` is `None` (not passed).

- [ ] **Step 3: Implement**

In `src/material_collager/client.py`, replace the final `    return OpenAI()` of `_make_openai_client` with:
```python
    # Never retry a paid image call automatically. The SDK retries twice by
    # default on timeouts and dropped connections, and an edit OpenAI already
    # accepted is billed again on each retry. A failure goes back to the person,
    # who decides whether to spend on another attempt.
    return OpenAI(max_retries=0)
```
In `src/material_collager/qa.py`, replace the final `    return OpenAI()` of `_make_openai_client` with:
```python
    # QA review calls are paid too: same rule as the image client (client.py).
    return OpenAI(max_retries=0)
```

- [ ] **Step 4: Run the Python suite**

Run: `PYTHONPATH=src python -m unittest discover -s tests -p "test_*.py"`

Expected: `OK`, with the Phase 0 Python count (22, if Task 0.1 recorded it) plus 2.

- [ ] **Step 5: Commit**

```bash
git add src/material_collager/client.py src/material_collager/qa.py tests/test_client.py
git commit -m "fix(cli): don't let the OpenAI SDK retry paid calls

OpenAI() retries twice by default, so a timed-out edit that OpenAI had
already accepted could be billed again. Build both clients with
max_retries=0, matching the web path's single paid attempt.

Co-Authored-By: <model trailer>"
```

### WP-2A exit

- [ ] `npm run test:storage`, `npm run test:autoboard` and the Python suite pass.
- [ ] **Opus review** of `git diff <wp-base>..HEAD`, checking:
  - No path in `POST /api/economy` reaches `submitEconomyBatch` without a committed row.
  - The failure UPDATE can't mask the original error.
  - A `submitting` row with no batch id is terminal-or-invisible to the poller (excluded by `openai_batch_id IS NOT NULL`).
  - The history UI's handling of an unknown status string. Grep `app/generator/page.tsx` for how Economy statuses are rendered. `submitting` must display as in-progress text, not crash or poll forever. The poller never sees `submitting` rows, and the page polls on "pending": confirm the page's pending test won't spin on a stuck `submitting` row. If it would, the fix is to have the page treat `submitting` older than 5 minutes as failed. Record the finding and fix it in this WP if needed.

---

## WP-2B — Outbound fetch

### Task 2B.1: One guarded fetch and one capped reader

**Files:**
- Create: `app/lib/guarded-fetch.ts`
- Test: `tests/storage-guarded-fetch.test.mjs` (new)

**Interfaces:**
- Produces:
```ts
export const MAX_REDIRECTS = 5;
export function fetchPublic(url: URL | string, init: { headers?: HeadersInit; timeoutMs: number }): Promise<{ response: Response; url: URL }>;
export function readCapped(response: Response, limit: number, options?: { tooLarge?: string; onOverflow?: "throw" | "truncate" }): Promise<Uint8Array>;
```
- `fetchPublic` throws `assertFetchableUrl`'s message for a refused URL or hop, `"<host> redirected more than 5 times."`, or `"<host> answered a redirect with no destination."`.
- The returned `url` is the final hop. Response status checks stay with each caller.

- [ ] **Step 1: Write the failing tests**

Create `tests/storage-guarded-fetch.test.mjs`:
```js
import assert from "node:assert/strict";
import test from "node:test";
import { MAX_REDIRECTS, fetchPublic, readCapped } from "../app/lib/guarded-fetch.ts";

test("a redirect to a private host is refused before it is requested (R11)", async (t) => {
  const requested = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requested.push({ url: String(url), redirect: init.redirect });
    return new Response(null, { status: 302, headers: { location: "https://127.0.0.1/admin" } });
  });
  await assert.rejects(fetchPublic("https://vendor.example/photo.jpg", { timeoutMs: 1000 }), /private address/);
  assert.deepEqual(requested, [{ url: "https://vendor.example/photo.jpg", redirect: "manual" }]);
});

test("public redirects are followed hop by hop, resolving relative locations", async (t) => {
  const requested = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    requested.push(String(url));
    if (String(url) === "https://a.example/start") return new Response(null, { status: 301, headers: { location: "https://b.example/next" } });
    if (String(url) === "https://b.example/next") return new Response(null, { status: 302, headers: { location: "/final.jpg" } });
    return new Response("ok", { status: 200, headers: { "content-type": "image/jpeg" } });
  });
  const { response, url } = await fetchPublic("https://a.example/start", { timeoutMs: 1000 });
  assert.equal(response.status, 200);
  assert.equal(url.toString(), "https://b.example/final.jpg");
  assert.deepEqual(requested, ["https://a.example/start", "https://b.example/next", "https://b.example/final.jpg"]);
});

test("a redirect chain longer than the cap is refused", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return new Response(null, { status: 302, headers: { location: `https://hop${calls}.example/` } });
  });
  await assert.rejects(fetchPublic("https://start.example/", { timeoutMs: 1000 }), /redirected more than/);
  assert.equal(calls, MAX_REDIRECTS + 1);
});

test("hosts the old reference-import regex let through are refused without a request", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls += 1; return new Response("x"); });
  for (const url of ["https://[::1]/x.png", "https://0.0.0.0/x.png", "https://metadata.google.internal/x.png", "http://vendor.example/x.png"]) {
    await assert.rejects(fetchPublic(url, { timeoutMs: 1000 }), Error, url);
  }
  assert.equal(calls, 0);
});

// A body the test controls chunk by chunk; highWaterMark 0 so nothing is
// pulled before the reader asks.
function stream(chunks, counters) {
  return new ReadableStream({
    pull(controller) {
      if (counters.reads >= chunks.length) return controller.close();
      controller.enqueue(chunks[counters.reads]);
      counters.reads += 1;
    },
    cancel() {
      counters.cancelled = true;
    },
  }, { highWaterMark: 0 });
}

test("an oversized body with no Content-Length is cancelled as soon as it passes the cap (R10)", async () => {
  const counters = { reads: 0, cancelled: false };
  const mib = new Uint8Array(1024 * 1024);
  await assert.rejects(readCapped(new Response(stream([mib, mib, mib, mib], counters)), 2 * 1024 * 1024 - 1), /over the size limit/);
  assert.equal(counters.cancelled, true);
  assert.ok(counters.reads < 4, `read ${counters.reads} of 4 chunks`);
});

test("a declared Content-Length over the cap is refused without reading the body", async () => {
  const counters = { reads: 0, cancelled: false };
  const response = new Response(stream([new Uint8Array(10)], counters), { headers: { "content-length": String(10 * 1024 * 1024) } });
  await assert.rejects(readCapped(response, 1024, { tooLarge: "too big" }), /too big/);
  assert.equal(counters.cancelled, true);
});

test("a Content-Length that understates the body does not let it through", async () => {
  const counters = { reads: 0, cancelled: false };
  const chunk = new Uint8Array(1024);
  const response = new Response(stream([chunk, chunk, chunk], counters), { headers: { "content-length": "10" } });
  await assert.rejects(readCapped(response, 2048), /over the size limit/);
});

test("truncate mode keeps the first bytes of an oversized page and stops reading", async () => {
  const counters = { reads: 0, cancelled: false };
  const response = new Response(stream([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])], counters));
  assert.deepEqual(await readCapped(response, 4, { onOverflow: "truncate" }), new Uint8Array([1, 2, 3, 4]));
  assert.equal(counters.cancelled, true);
});

test("a body under the cap is returned whole", async () => {
  assert.deepEqual(await readCapped(new Response(new Uint8Array([7, 8, 9])), 3), new Uint8Array([7, 8, 9]));
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm run test:storage`

Expected: `tests/storage-guarded-fetch.test.mjs` fails with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Write the module**

Create `app/lib/guarded-fetch.ts`:
```ts
// Server-side fetches of URLs a person supplied: sheet cells, pasted links,
// model-suggested product pages. Every such fetch follows two rules.
//
// - Every hop is checked BEFORE it is requested. `redirect: "follow"` would
//   already have contacted a private host by the time its final URL could be
//   checked, so redirects are followed here one at a time, each Location run
//   through assertFetchableUrl first, at most MAX_REDIRECTS hops.
// - A body is read against a byte cap and the download is cancelled the moment
//   it goes over, rather than buffered whole (Content-Length can be absent or
//   wrong) just to be rejected.
//
// The guard is hostname-based: a Worker has no DNS API, so a public name that
// resolves to a private address is not caught here. Production egress cannot
// reach private networks; local dev, where Miniflare runs on a developer's
// machine, is the case the literal-host checks exist for.

import { assertFetchableUrl } from "./autoboard/photo-sources.ts";

export const MAX_REDIRECTS = 5;

export async function fetchPublic(
  url: URL | string,
  init: { headers?: HeadersInit; timeoutMs: number },
): Promise<{ response: Response; url: URL }> {
  const signal = AbortSignal.timeout(init.timeoutMs);
  let current = assertFetchableUrl(String(url));
  for (let hop = 0; ; hop++) {
    const response = await fetch(current.toString(), { headers: init.headers, redirect: "manual", signal });
    if (response.status < 300 || response.status > 399) return { response, url: current };
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location) throw new Error(`${current.hostname} answered a redirect with no destination.`);
    if (hop >= MAX_REDIRECTS) throw new Error(`${current.hostname} redirected more than ${MAX_REDIRECTS} times.`);
    current = assertFetchableUrl(new URL(location, current).toString());
  }
}

/**
 * Reads at most `limit` bytes of `response`, cancelling the download as soon as
 * it goes over. The default refuses an oversized body; `onOverflow: "truncate"`
 * keeps the first `limit` bytes instead (an HTML page whose metadata sits near
 * the top).
 */
export async function readCapped(
  response: Response,
  limit: number,
  options: { tooLarge?: string; onOverflow?: "throw" | "truncate" } = {},
): Promise<Uint8Array> {
  const tooLarge = options.tooLarge ?? "That file is over the size limit.";
  const truncate = options.onOverflow === "truncate";
  const declared = Number(response.headers.get("content-length") ?? "");
  if (!truncate && Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel();
    throw new Error(tooLarge);
  }
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > limit) {
      await reader.cancel();
      if (!truncate) throw new Error(tooLarge);
      chunks.push(value.subarray(0, limit - total));
      total = limit;
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
```

- [ ] **Step 4: Run the tests**

Run: `npm run test:storage`

Expected: PASS, including 9 new tests.

- [ ] **Step 5: Commit**

```bash
git add app/lib/guarded-fetch.ts tests/storage-guarded-fetch.test.mjs
git commit -m "feat: add a guarded fetch that validates every redirect hop

fetchPublic follows redirects manually and runs each hop through
assertFetchableUrl before requesting it; readCapped streams against a
byte cap and cancels on overflow. Shared by every server-side fetch of
a user-supplied URL.

Co-Authored-By: <model trailer>"
```

### Task 2B.2: Autoboard photo collection uses the guarded fetch (R10, R11)

**Files:**
- Modify: `app/lib/autoboard-photos.ts` (imports; replace `fetchGuarded` and `readCapped`, lines ~205–234; `discoverPhotoUrls`; `ingestPhotoFromUrl`; `ingestUploadedPhoto`)
- Test: `tests/autoboard-photos.test.mjs` (new)

**Interfaces:**
- Consumes: `fetchPublic` and `readCapped` from Task 2B.1.
- Produces: the same exports and signatures (`discoverPhotoUrls`, `ingestPhotoFromUrl`, `ingestUploadedPhoto`).

- [ ] **Step 1: Write the failing tests**

Create `tests/autoboard-photos.test.mjs`:
```js
import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { createFakeD1, createFakeR2, installWorkerEnv } from "./helpers/fake-worker-env.mjs";

const OUTPUTS = createFakeR2();
installWorkerEnv({ DB: createFakeD1(), OUTPUTS });
const { MAX_PHOTO_BYTES, ingestPhotoFromUrl, ingestUploadedPhoto } = await import("../app/lib/autoboard-photos.ts");

test("a sheet URL that redirects to the metadata endpoint is refused before that hop is requested (R11)", async (t) => {
  const requested = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requested.push([String(url), init.redirect]);
    return new Response(null, { status: 302, headers: { location: "https://169.254.169.254/latest/meta-data/" } });
  });
  await assert.rejects(ingestPhotoFromUrl("p", "row-1", "https://vendor.example/faucet.jpg"), /private address/);
  assert.deepEqual(requested, [["https://vendor.example/faucet.jpg", "manual"]]);
});

test("a public image URL is still collected and stored", async (t) => {
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#808080" } }).png().toBuffer();
  t.mock.method(globalThis, "fetch", async () => new Response(png, { headers: { "content-type": "image/png" } }));
  const before = OUTPUTS.puts.length;
  const photo = await ingestPhotoFromUrl("p-ok", "row-1", "https://vendor.example/faucet.png");
  assert.ok(photo);
  assert.equal(OUTPUTS.puts.length, before + 1);
});

test("an oversized base64 upload is refused before it is decoded (R10)", async (t) => {
  const decode = t.mock.method(globalThis, "atob");
  const tooBig = "A".repeat(Math.ceil(((MAX_PHOTO_BYTES + 4) * 4) / 3));
  await assert.rejects(ingestUploadedPhoto("p", "row-1", { mimeType: "image/png", dataBase64: tooBig }), /must be under/);
  assert.equal(decode.mock.callCount(), 0);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --experimental-strip-types --test tests/autoboard-photos.test.mjs`

Expected: the first test fails, because the request used `redirect: "follow"`. The third fails because `atob` was called once.

- [ ] **Step 3: Implement**

In `app/lib/autoboard-photos.ts`:

(a) Add after the `./autoboard/image-size.ts` import:
```ts
import { fetchPublic, readCapped } from "./guarded-fetch.ts";
```

(b) Replace the whole `fetchGuarded` function and the whole `readCapped` function (from `async function fetchGuarded(url: URL, accept: string): Promise<Response> {` through the closing `}` of `readCapped`) with:
```ts
// Each hop is validated before it is requested (guarded-fetch.ts); a
// redirect can no longer land somewhere the guard would have refused.
async function fetchGuarded(url: URL, accept: string): Promise<{ response: Response; url: URL }> {
  const fetched = await fetchPublic(url, {
    headers: {
      accept,
      // Some vendor sites serve a bot-blocking page to a default agent. Named
      // honestly rather than impersonating a browser.
      "user-agent": "MaterialCollager/1.0 (+design reference collection)",
    },
    timeoutMs: FETCH_TIMEOUT_MS,
  });
  if (!fetched.response.ok) {
    await fetched.response.body?.cancel();
    throw new Error(`${fetched.url.hostname} answered HTTP ${fetched.response.status}.`);
  }
  return fetched;
}

const PHOTO_TOO_LARGE = `Images must be under ${Math.round(MAX_PHOTO_BYTES / 1024 / 1024)} MB.`;
```

(c) Replace the body of `discoverPhotoUrls`:
```ts
  const url = assertFetchableUrl(rawUrl);
  const response = await fetchGuarded(url, "image/*,text/html;q=0.9,*/*;q=0.5");
  const contentType = response.headers.get("content-type");

  if (isImageContentType(contentType)) {
    return { kind: "image", urls: [response.url || url.toString()] };
  }
  const html = new TextDecoder().decode(await readCapped(response, MAX_HTML_BYTES));
  const urls = extractImageUrls(html, response.url || url.toString());
```
with:
```ts
  const url = assertFetchableUrl(rawUrl);
  const { response, url: landed } = await fetchGuarded(url, "image/*,text/html;q=0.9,*/*;q=0.5");
  const contentType = response.headers.get("content-type");

  if (isImageContentType(contentType)) {
    await response.body?.cancel();
    return { kind: "image", urls: [landed.toString()] };
  }
  const html = new TextDecoder().decode(await readCapped(response, MAX_HTML_BYTES, { tooLarge: "That page is too large to read." }));
  const urls = extractImageUrls(html, landed.toString());
```
(leave the `if (!urls.length) { … }` block and the `return` that follow unchanged).

(d) Replace the body of `ingestPhotoFromUrl`:
```ts
  const url = assertFetchableUrl(rawUrl);
  const response = await fetchGuarded(url, "image/*");
  const bytes = await readCapped(response, MAX_PHOTO_BYTES);
  return storePhoto({ projectId, rowId, bytes, source: "url", sourceUrl: response.url || url.toString() });
```
with:
```ts
  const url = assertFetchableUrl(rawUrl);
  const { response, url: landed } = await fetchGuarded(url, "image/*");
  const bytes = await readCapped(response, MAX_PHOTO_BYTES, { tooLarge: PHOTO_TOO_LARGE });
  return storePhoto({ projectId, rowId, bytes, source: "url", sourceUrl: landed.toString() });
```

(e) In `ingestUploadedPhoto`, replace:
```ts
  if (!data) throw new Error("No image data received.");
  let binary: string;
```
with:
```ts
  if (!data) throw new Error("No image data received.");
  // Checked on the encoded length, before atob allocates the decoded copy:
  // base64 carries 3 bytes in every 4 characters.
  if (Math.floor((data.length * 3) / 4) > MAX_PHOTO_BYTES) throw new Error(PHOTO_TOO_LARGE);
  let binary: string;
```

- [ ] **Step 4: Run the tests, the suite and the gate**

Run: `node --experimental-strip-types --test tests/autoboard-photos.test.mjs && npm run test:autoboard && node scripts/typecheck-baseline.mjs`

Expected: all pass; the gate exits 0. `tests/autoboard-photo-sources.test.mjs` is unchanged and still passes, because `assertFetchableUrl` is untouched.

- [ ] **Step 5: Commit**

```bash
git add app/lib/autoboard-photos.ts tests/autoboard-photos.test.mjs
git commit -m "fix(review-boards): validate photo redirects before following them

Photo collection fetched with redirect: 'follow' and checked the final
URL afterwards, and buffered whole bodies before checking their size.
Use fetchPublic/readCapped, and size-check base64 uploads before
decoding.

Co-Authored-By: <model trailer>"
```

### Task 2B.3: Reference import and match discovery use the same guard (R11)

**Files:**
- Modify: `app/api/references/import/route.ts` (whole file)
- Modify: `app/api/references/matches/route.ts` (imports; `safeHttps`; `isRemoteImage`; `discoverProductImage`; delete `readCappedText`)
- Test: `tests/storage-guarded-fetch.test.mjs` (append)

- [ ] **Step 1: Write the failing test**

Append to `tests/storage-guarded-fetch.test.mjs`:
```js
// The route imports "@/…" modules; the helper's resolve hook maps the alias.
await import("./helpers/fake-worker-env.mjs");
const { POST: importReference } = await import("../app/api/references/import/route.ts");

test("reference import refuses a redirect to loopback without requesting it (R11)", async (t) => {
  const requested = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requested.push([String(url), init.redirect]);
    return new Response(null, { status: 302, headers: { location: "https://[::1]/secret" } });
  });
  const response = await importReference(new Request("http://localhost/api/references/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ imageUrl: "https://vendor.example/p.jpg" }),
  }));
  assert.notEqual(response.status, 200);
  assert.deepEqual(requested, [["https://vendor.example/p.jpg", "manual"]]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:storage`

Expected: the new test fails. The request used `redirect: "follow"`, and the old regex let `[::1]` through, so the call chain differs.

- [ ] **Step 3: Rewrite the import route**

Replace the whole of `app/api/references/import/route.ts` with:
```ts
import { fetchPublic, readCapped } from "@/app/lib/guarded-fetch";
import { errorResponse } from "@/app/lib/openai-server";

export const runtime = "edge";

const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export async function POST(request: Request) {
  try {
    const body = await request.json() as { imageUrl?: string };
    // fetchPublic validates the URL and every redirect hop before requesting
    // it (https only, no private, loopback or metadata hosts).
    const { response } = await fetchPublic(body.imageUrl ?? "", {
      headers: { Accept: "image/png,image/jpeg,image/webp" },
      timeoutMs: 15_000,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("The suggested image could not be downloaded.");
    }
    const contentType = (response.headers.get("content-type") || "").split(";")[0].trim();
    if (!IMAGE_TYPES.has(contentType)) {
      await response.body?.cancel();
      throw new Error("The suggested source did not return a supported image.");
    }
    const bytes = await readCapped(response, MAX_IMPORT_BYTES, { tooLarge: "The suggested image is too large." });
    if (!bytes.byteLength) throw new Error("The suggested image is empty.");
    return new Response(bytes, { headers: { "Content-Type": contentType, "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
```

- [ ] **Step 4: Update the matches route**

In `app/api/references/matches/route.ts`:

(a) Add to the imports:
```ts
import { assertFetchableUrl } from "@/app/lib/autoboard/photo-sources";
import { fetchPublic, readCapped } from "@/app/lib/guarded-fetch";
```

(b) Replace `safeHttps`:
```ts
function safeHttps(value: unknown) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:" || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(url.hostname)) return "";
    return url.toString();
  } catch {
    return "";
  }
}
```
with:
```ts
// One guard for every server-side fetch (app/lib/autoboard/photo-sources.ts).
// The regex this replaced let [::1], 0.0.0.0 and metadata hosts through.
function safeHttps(value: unknown) {
  try {
    return assertFetchableUrl(value).toString();
  } catch {
    return "";
  }
}
```

(c) Replace `isRemoteImage` and `discoverProductImage` (both whole functions) with:
```ts
async function isRemoteImage(url: string) {
  try {
    const { response } = await fetchPublic(url, {
      headers: { Accept: "image/png,image/jpeg,image/webp", Range: "bytes=0-0" },
      timeoutMs: 8_000,
    });
    const contentType = (response.headers.get("content-type") || "").split(";")[0].trim();
    await response.body?.cancel();
    return Boolean(response.ok && ["image/png", "image/jpeg", "image/webp"].includes(contentType));
  } catch {
    return false;
  }
}

async function discoverProductImage(pageUrl: string) {
  try {
    const { response, url } = await fetchPublic(pageUrl, {
      headers: { Accept: "text/html,application/xhtml+xml" },
      timeoutMs: 10_000,
    });
    const contentType = response.headers.get("content-type") || "";
    if (!response.ok || !contentType.includes("text/html")) {
      await response.body?.cancel();
      return "";
    }
    // Content-Length is often absent on chunked/compressed responses, so the
    // read itself is capped; metadata tags live near the top of the document.
    const html = new TextDecoder().decode(await readCapped(response, 5 * 1024 * 1024, { onOverflow: "truncate" }));
    const metadataImage = extractOpenGraphImage(html) || extractJsonLdImage(html);
    return metadataImage ? safeHttps(new URL(metadataImage, url).toString()) : "";
  } catch {
    return "";
  }
}
```

(d) Delete the whole `readCappedText` function and the comment block above it (`// Reads at most \`limit\` bytes of text, cancelling the stream once reached —` and the line that follows).

(e) Run: `grep -n "redirect: \"follow\"\|readCappedText\|172\\\\.(1" app/api/references/matches/route.ts app/api/references/import/route.ts app/lib/autoboard-photos.ts`

Expected: no matches.

- [ ] **Step 5: Run the tests, lint and the gate**

Run: `npm run test:storage && npx eslint app/api/references app/lib/guarded-fetch.ts app/lib/autoboard-photos.ts && node scripts/typecheck-baseline.mjs`

Expected: all pass, no new lint errors, and the gate exits 0.

- [ ] **Step 6: Commit**

```bash
git add app/api/references/import/route.ts app/api/references/matches/route.ts tests/storage-guarded-fetch.test.mjs
git commit -m "fix(references): validate every redirect hop and use one host guard

Reference import and match discovery followed redirects before checking
them, and their regex guard let loopback and metadata hosts through.
Both now go through fetchPublic and assertFetchableUrl.

Co-Authored-By: <model trailer>"
```

### WP-2B exit

- [ ] `npm run test:storage` and `npm run test:autoboard` pass.
- [ ] Run: `grep -rn "redirect: \"follow\"" app --include=*.ts`. Expected: no matches, or only fetches of fixed first-party URLs such as `api.openai.com`, and each of those must be listed in the review note.
- [ ] **Opus review** of `git diff <wp-base>..HEAD` for SSRF, checking:
  - Every fetch of a user-supplied URL goes through `fetchPublic`.
  - A 3xx body is always cancelled.
  - The timeout covers the whole chain.
  - Error messages don't echo internal addresses beyond what `assertFetchableUrl` already says.
- [ ] **One free smoke check** in `npm run dev` that Workers' `redirect: "manual"` exposes `Location`. In `/review-boards`, collect a photo from a URL known to redirect: any `http→https` or vendor short link. It must still work, or fail with a clear message.

---

## Phase 2 exit criteria

- [ ] `node --experimental-strip-types --test --test-reporter=dot tests/*.test.mjs`: 0 failures. Python suite: OK.
- [ ] `npm run lint`: no new errors. `node scripts/typecheck-baseline.mjs` exits 0.
- [ ] Opus phase review before merge.
