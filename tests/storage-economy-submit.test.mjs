import assert from "node:assert/strict";
import test from "node:test";
import { createFakeD1, createFakeR2, installWorkerEnv } from "./helpers/fake-worker-env.mjs";

let failJobInsert = false;
// Counts down from N to 0, throwing on each of the next N matching writes.
// Lets a test ask for exactly one write failure (the original fails, the
// retry succeeds) or two (the retry fails too, both attempts exhausted).
let failBatchIdUpdate = 0;
const BATCH_ID_UPDATE = /^\s*UPDATE generation_jobs SET status = \?, openai_batch_id = \?/i;
// The most parameters any one statement has bound. Real D1 refuses more than
// 100 per statement; the in-memory SQLite behind this double does not.
let maxBoundArgs = 0;
const DB = createFakeD1({
  beforeStatement: (_kind, sql, args) => {
    maxBoundArgs = Math.max(maxBoundArgs, args.length);
    if (failJobInsert && /^\s*INSERT INTO generation_jobs/i.test(sql)) throw new Error("D1 unavailable");
    if (failBatchIdUpdate > 0 && BATCH_ID_UPDATE.test(sql)) {
      failBatchIdUpdate -= 1;
      throw new Error("D1 unavailable");
    }
  },
});
installWorkerEnv({ DB, OUTPUTS: createFakeR2() });
process.env["OPENAI_API_KEY"] = "test-only";
const { GET, POST } = await import("../app/api/economy/route.ts");
const { ensureJobStorage } = await import("../app/lib/generation-jobs.ts");
// batch-finalize (scripts/autoboard/cli.mjs) won't resubmit a job whose error
// matches this, so every message saying a batch exists or may exist must.
const { RESUBMIT_WARNING } = await import("../app/lib/economy-submission-status.ts");

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
// onBatchCall runs while the batch POST is in flight — exactly the window
// where the row is committed as 'submitting' but not yet updated with a
// result — so a test can observe that mid-flight state directly.
function mockOpenAI(t, { failBatch = false, onBatchCall } = {}) {
  const calls = { files: 0, batches: 0 };
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).endsWith("/v1/files")) {
      calls.files += 1;
      return Response.json({ id: `file_input_${calls.files}` });
    }
    if (String(url).endsWith("/v1/batches")) {
      calls.batches += 1;
      await onBatchCall?.();
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
  try {
    const response = await submit();
    assert.notEqual(response.status, 200);
    assert.equal(calls.batches, 0);
  } finally {
    failJobInsert = false;
  }
});

test("an accepted batch is recorded with its provider id (R09)", async (t) => {
  let midFlight;
  mockOpenAI(t, {
    // The insert already ran (submitEconomyBatch is called after it); the
    // update that will set the real status/batch id has not, because that
    // only happens once this very call returns.
    onBatchCall: async () => {
      midFlight = await DB.prepare("SELECT status, openai_batch_id FROM generation_jobs WHERE mode = 'economy' ORDER BY rowid DESC LIMIT 1").first();
    },
  });
  const response = await submit();
  assert.deepEqual(midFlight, { status: "submitting", openai_batch_id: null });
  assert.equal(response.status, 200);
  const { jobId } = await response.json();
  const row = await DB.prepare("SELECT status, openai_batch_id FROM generation_jobs WHERE id = ?").bind(jobId).first();
  assert.deepEqual(row, { status: "validating", openai_batch_id: "batch_1" });
});

test("a failed submission leaves a failed row that says how to check before paying again", async (t) => {
  const calls = mockOpenAI(t, { failBatch: true });
  const response = await submit();
  assert.notEqual(response.status, 200);
  assert.equal(calls.batches, 1);
  // Consumed before the DB lookup below: the row's id names this exact
  // submission, and the response body must carry the same guidance the row
  // does, not just the bare provider message — an ambiguous failure (a
  // timeout, a dropped connection) may mean OpenAI already accepted the
  // batch, and the person deciding whether to resubmit is looking at this
  // response right now, not the history row.
  const body = await response.json();
  const row = await DB.prepare("SELECT id, status, error, openai_batch_id FROM generation_jobs WHERE mode = 'economy' ORDER BY rowid DESC LIMIT 1").first();
  assert.equal(row.status, "failed");
  assert.equal(row.openai_batch_id, null);
  assert.match(row.error, new RegExp(`material_collager_job = ${row.id}`));
  assert.match(body.error, new RegExp(`material_collager_job = ${row.id}`));
  assert.match(row.error, RESUBMIT_WARNING);
  assert.match(body.error, RESUBMIT_WARNING);
});

test("a timed-out batch create still carries the guidance, and is never retried (R09)", async (t) => {
  // AbortSignal.timeout rejects with a DOMException, not an OpenAIRequestError
  // — readOpenAIResponse never runs, since the fetch itself never resolves.
  // A DOMException passes `instanceof Error` but its `message` is read-only
  // (verified against both Node and this repo's workerd/Miniflare — see
  // dom-exception-message-check.mjs / workerd-dom-exception-check.mjs in the
  // scratchpad); assigning it must not throw a TypeError that replaces the
  // guidance with a raw "read only property" message.
  const calls = { files: 0, batches: 0 };
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).endsWith("/v1/files")) {
      calls.files += 1;
      return Response.json({ id: `file_input_${calls.files}` });
    }
    if (String(url).endsWith("/v1/batches")) {
      calls.batches += 1;
      throw new DOMException("The operation timed out.", "TimeoutError");
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  const response = await submit();
  assert.notEqual(response.status, 200);
  assert.equal(calls.batches, 1, "the paid call itself must never be retried");
  const body = await response.json();
  const row = await DB.prepare("SELECT id, status, error, openai_batch_id FROM generation_jobs WHERE mode = 'economy' ORDER BY rowid DESC LIMIT 1").first();
  assert.equal(row.status, "failed");
  assert.match(row.error, new RegExp(`material_collager_job = ${row.id}`));
  assert.match(body.error, new RegExp(`material_collager_job = ${row.id}`));
  assert.match(body.error, RESUBMIT_WARNING);
});

test("the batch id write is retried once before giving up (R09)", async (t) => {
  failBatchIdUpdate = 1;
  try {
    const calls = mockOpenAI(t);
    const response = await submit();
    assert.equal(response.status, 200);
    assert.equal(calls.batches, 1, "the paid call itself must never be retried");
    const { jobId } = await response.json();
    const row = await DB.prepare("SELECT status, openai_batch_id FROM generation_jobs WHERE id = ?").bind(jobId).first();
    assert.deepEqual(row, { status: "validating", openai_batch_id: "batch_1" });
  } finally {
    failBatchIdUpdate = 0;
  }
});

test("a batch id write that fails twice reports the batch as already created, not a plain failure (R09)", async (t) => {
  failBatchIdUpdate = 2;
  try {
    const calls = mockOpenAI(t);
    const response = await submit();
    assert.notEqual(response.status, 200);
    assert.equal(calls.batches, 1, "the paid call itself must never be retried");
    const body = await response.json();
    assert.match(body.error, /batch_1/);
    assert.match(body.error, /do not resubmit/i);
    assert.match(body.error, RESUBMIT_WARNING);
    // batch-finalize reads the job id from this, to keep tracking the job.
    assert.match(body.error, /material_collager_job = [\w-]+/);
    // No mechanism retries the D1 write again later on its own — saying so
    // beside "do not resubmit" would invite exactly the wrong reading.
    assert.doesNotMatch(body.error, /retry recording/i);
  } finally {
    failBatchIdUpdate = 0;
  }
});

test("history refreshes at most two pending batches per request, oldest first, and skips rows with no batch", async (t) => {
  await ensureJobStorage();
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

test("a status check that keeps failing doesn't starve another pending job (R09)", async (t) => {
  await ensureJobStorage();
  await DB.prepare("DELETE FROM generation_jobs").run();
  const now = Date.now();
  const insert = (id, batchId, updatedAt) => DB.prepare(`INSERT INTO generation_jobs
      (id, mode, status, openai_batch_id, filename, format, prompt, payload_json, reference_ids_json, created_at, updated_at, expires_at)
      VALUES (?, 'economy', 'in_progress', ?, 'f.png', '1536x1024', 'p', '{}', '[]', ?, ?, ?)`)
    .bind(id, batchId, now, updatedAt, now + 1e9).run();
  // The two oldest rows always sort first under LIMIT 2; both permanently
  // 404 (a moved key, a batch OpenAI can no longer find), which throws
  // before any UPDATE runs. Without a fix their updated_at never moves, so
  // they would keep sorting first forever and job-ok would never be reached.
  await insert("job-fail-1", "batch-fail-1", now - 30);
  await insert("job-fail-2", "batch-fail-2", now - 20);
  await insert("job-ok", "batch-ok", now - 10);
  let polled = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    const id = String(url).split("/").pop();
    polled.push(id);
    if (id === "batch-fail-1" || id === "batch-fail-2") return Response.json({ error: { message: "not found" } }, { status: 404 });
    return Response.json({ id, status: "in_progress" });
  });
  assert.equal((await GET()).status, 200);
  assert.deepEqual(polled, ["batch-fail-1", "batch-fail-2"]);
  polled = [];
  assert.equal((await GET()).status, 200);
  assert.ok(polled.includes("batch-ok"), "a status check that keeps failing must not starve the other pending job");
});

test("a fresh submitting row is still reported as pending, not failed (R09)", async (t) => {
  await ensureJobStorage();
  await DB.prepare("DELETE FROM generation_jobs").run();
  const now = Date.now();
  await DB.prepare(`INSERT INTO generation_jobs
      (id, mode, status, openai_batch_id, filename, format, prompt, payload_json, reference_ids_json, created_at, updated_at, expires_at)
      VALUES ('job-fresh', 'economy', 'submitting', NULL, 'f.png', '1536x1024', 'p', '{}', '[]', ?, ?, ?)`)
    .bind(now, now, now + 1e9).run();
  // No batch id yet, so nothing should ever be fetched for this row.
  t.mock.method(globalThis, "fetch", async (url) => { throw new Error(`unexpected fetch ${url}`); });
  const { jobs } = await (await GET()).json();
  const job = jobs.find((entry) => entry.id === "job-fresh");
  assert.equal(job.status, "submitting");
  assert.equal(job.error, null);
});

test("a submitting row stuck past the stale threshold reads as failed, with guidance (R09)", async (t) => {
  await ensureJobStorage();
  await DB.prepare("DELETE FROM generation_jobs").run();
  const now = Date.now();
  const staleUpdatedAt = now - 6 * 60 * 1000;
  await DB.prepare(`INSERT INTO generation_jobs
      (id, mode, status, openai_batch_id, filename, format, prompt, payload_json, reference_ids_json, created_at, updated_at, expires_at)
      VALUES ('job-stale', 'economy', 'submitting', NULL, 'f.png', '1536x1024', 'p', '{}', '[]', ?, ?, ?)`)
    .bind(staleUpdatedAt, staleUpdatedAt, now + 1e9).run();
  t.mock.method(globalThis, "fetch", async (url) => { throw new Error(`unexpected fetch ${url}`); });
  const { jobs } = await (await GET()).json();
  const job = jobs.find((entry) => entry.id === "job-stale");
  assert.equal(job.status, "failed");
  assert.match(job.error, /material_collager_job = job-stale/);
  assert.match(job.error, RESUBMIT_WARNING);
});

test("a bump never clobbers a row that became 'finalizing' since it was selected (R09)", async (t) => {
  await ensureJobStorage();
  await DB.prepare("DELETE FROM generation_jobs").run();
  const now = Date.now();
  const leaseUpdatedAt = now - 30;
  await DB.prepare(`INSERT INTO generation_jobs
      (id, mode, status, openai_batch_id, filename, format, prompt, payload_json, reference_ids_json, created_at, updated_at, expires_at)
      VALUES ('job-race', 'economy', 'in_progress', 'batch-race', 'f.png', '1536x1024', 'p', '{}', '[]', ?, ?, ?)`)
    .bind(now, leaseUpdatedAt, now + 1e9).run();
  t.mock.method(globalThis, "fetch", async () => {
    // Simulate another concurrent poll claiming this row for finalizing
    // between when THIS GET selected it (status was 'in_progress' then) and
    // when its own status check settles — the row's CURRENT state, not the
    // stale in-memory snapshot from the SELECT, must gate the bump.
    await DB.prepare("UPDATE generation_jobs SET status = 'finalizing' WHERE id = 'job-race'").run();
    return Response.json({ error: { message: "not found" } }, { status: 404 });
  });
  assert.equal((await GET()).status, 200);
  const row = await DB.prepare("SELECT status, updated_at FROM generation_jobs WHERE id = 'job-race'").first();
  assert.equal(row.status, "finalizing");
  assert.equal(row.updated_at, leaseUpdatedAt, "a row claimed as finalizing mid-check must keep its stale-claim lease timestamp");
});

function insertJob({ id, mode = "economy", status, batchId = null, updatedAt, finalizeAttempts = 0 }) {
  return DB.prepare(`INSERT INTO generation_jobs
      (id, mode, status, openai_batch_id, filename, format, prompt, payload_json, reference_ids_json, finalize_attempts, created_at, updated_at, expires_at)
      VALUES (?, ?, ?, ?, 'f.png', '1536x1024', 'p', '{}', '[]', ?, ?, ?, ?)`)
    .bind(id, mode, status, batchId, finalizeAttempts, updatedAt, updatedAt, Date.now() + 1e9).run();
}

test("history looks tracked Economy jobs up by id, even after 30 newer renders push them out of the listing", async (t) => {
  await ensureJobStorage();
  await DB.prepare("DELETE FROM generation_jobs").run();
  const now = Date.now();
  await insertJob({ id: "job-tracked", status: "in_progress", batchId: "batch-tracked", updatedAt: now - 60_000 });
  // Drafts share the table, and the listing is the newest 30 rows of every kind.
  for (let n = 0; n < 30; n++) await insertJob({ id: `draft-${n}`, mode: "immediate", status: "completed", updatedAt: now + n });
  t.mock.method(globalThis, "fetch", async () => Response.json({ id: "batch-tracked", status: "in_progress" }));
  const listing = await (await GET()).json();
  assert.ok(!listing.jobs.some((job) => job.id === "job-tracked"), "setup: the tracked job must have fallen out of the listing");
  assert.equal(listing.tracked, undefined, "the history page's own request is answered as before");
  const body = await (await GET(new Request("http://localhost/api/economy?ids=job-tracked,job-unknown"))).json();
  assert.deepEqual(body.tracked?.map((job) => job.id), ["job-tracked"]);
  assert.equal(body.tracked[0].status, "in_progress");
});

test("an id lookup never binds more parameters than D1 allows in one statement", async (t) => {
  await ensureJobStorage();
  await DB.prepare("DELETE FROM generation_jobs").run();
  await insertJob({ id: "job-last", status: "completed", updatedAt: Date.now() });
  t.mock.method(globalThis, "fetch", async (url) => { throw new Error(`unexpected fetch ${url}`); });
  const ids = [...Array.from({ length: 149 }, (_, n) => `job-missing-${n}`), "job-last"];
  maxBoundArgs = 0;
  const body = await (await GET(new Request(`http://localhost/api/economy?ids=${ids.join(",")}`))).json();
  assert.deepEqual(body.tracked?.map((job) => job.id), ["job-last"]);
  assert.ok(maxBoundArgs <= 100, `one statement bound ${maxBoundArgs} parameters; D1 allows 100`);
});

test("a malformed or oversized id list is refused before any job is refreshed", async (t) => {
  await ensureJobStorage();
  await DB.prepare("DELETE FROM generation_jobs").run();
  await insertJob({ id: "job-pending", status: "in_progress", batchId: "batch-pending", updatedAt: Date.now() - 60_000 });
  let refreshed = 0;
  t.mock.method(globalThis, "fetch", async () => {
    refreshed += 1;
    return Response.json({ id: "batch-pending", status: "in_progress" });
  });
  const malformed = await GET(new Request("http://localhost/api/economy?ids=job-pending,job%3Bdrop"));
  assert.equal(malformed.status, 400);
  const oversized = await GET(new Request(`http://localhost/api/economy?ids=${Array.from({ length: 201 }, (_, n) => `job-${n}`).join(",")}`));
  assert.equal(oversized.status, 400);
  assert.equal(refreshed, 0);
});

test("a completed batch that can't be saved fails naming its batch and job, and says not to resubmit", async (t) => {
  await ensureJobStorage();
  await DB.prepare("DELETE FROM generation_jobs").run();
  // Three finalize attempts already spent and the last claim gone stale: this
  // poll's claim is the fourth, past the cap.
  await insertJob({ id: "job-cap", status: "finalizing", batchId: "batch-cap", updatedAt: Date.now() - 6 * 60 * 1000, finalizeAttempts: 3 });
  const downloads = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).endsWith("/v1/batches/batch-cap")) return Response.json({ id: "batch-cap", status: "completed", output_file_id: "file-out" });
    downloads.push(String(url));
    throw new Error(`unexpected fetch ${url}`);
  });
  assert.equal((await GET()).status, 200);
  const row = await DB.prepare("SELECT status, error FROM generation_jobs WHERE id = 'job-cap'").first();
  assert.equal(row.status, "failed");
  assert.match(row.error, /batch-cap/);
  assert.match(row.error, /material_collager_job = job-cap/);
  assert.match(row.error, /do not resubmit/i);
  assert.match(row.error, RESUBMIT_WARNING);
  assert.deepEqual(downloads, [], "past the cap, the output is not downloaded again");
});
