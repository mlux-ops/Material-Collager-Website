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
process.env["OPENAI_API_KEY"] = "test-only";
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
