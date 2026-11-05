import assert from "node:assert/strict";
import test from "node:test";
import { createFakeD1, createFakeR2, installWorkerEnv } from "./helpers/fake-worker-env.mjs";

const DB = createFakeD1();
const OUTPUTS = createFakeR2();
installWorkerEnv({ DB, OUTPUTS });
const { GET: listJobs } = await import("../app/api/jobs/route.ts");
const { GET: jobOutput } = await import("../app/api/jobs/[id]/output/route.ts");
const { ensureJobStorage } = await import("../app/lib/generation-jobs.ts");

function insertJob({ id, mode = "immediate", status = "completed", outputKey = null, createdAt, expiresAt = Date.now() + 1e9 }) {
  return DB.prepare(`INSERT INTO generation_jobs
      (id, mode, status, openai_batch_id, output_key, filename, format, prompt, payload_json, reference_ids_json, created_at, updated_at, expires_at)
      VALUES (?, ?, ?, NULL, ?, 'f.png', '1536x1024', 'p', '{}', '[]', ?, ?, ?)`)
    .bind(id, mode, status, outputKey, createdAt, createdAt, expiresAt).run();
}

test("History lists the newest 30 jobs of every kind and calls nothing upstream", async (t) => {
  await ensureJobStorage();
  await DB.prepare("DELETE FROM generation_jobs").run();
  const now = Date.now();
  for (let n = 0; n < 32; n++) await insertJob({ id: `job-${n}`, createdAt: now + n });
  // A non-terminal row left by the retired Economy mode is never refreshed, so
  // it lists as cancelled instead of pending forever; the stored row is untouched.
  await insertJob({ id: "job-legacy", mode: "economy", status: "in_progress", createdAt: now + 100 });
  await insertJob({ id: "job-legacy-done", mode: "economy", status: "completed", createdAt: now - 1 });
  let fetched = 0;
  t.mock.method(globalThis, "fetch", async () => { fetched += 1; return Response.json({}); });
  const response = await listJobs();
  assert.equal(response.status, 200);
  const { jobs } = await response.json();
  assert.equal(jobs.length, 30);
  assert.equal(jobs[0].id, "job-legacy");
  assert.equal(jobs[0].status, "cancelled");
  assert.match(jobs[0].error, /Economy mode was removed/);
  assert.equal(jobs[1].id, "job-31");
  assert.equal(fetched, 0);
  const stored = await DB.prepare("SELECT status FROM generation_jobs WHERE id = 'job-legacy'").first();
  assert.equal(stored.status, "in_progress");
  const { publicJob } = await import("../app/lib/generation-jobs.ts");
  const done = await DB.prepare("SELECT * FROM generation_jobs WHERE id = 'job-legacy-done'").first();
  assert.equal(publicJob(done).status, "completed");
});

test("a job's output is served from R2 while it is within retention", async () => {
  await ensureJobStorage();
  await DB.prepare("DELETE FROM generation_jobs").run();
  await OUTPUTS.put("generation-outputs/job-out.png", new Uint8Array([1, 2, 3]), { httpMetadata: { contentType: "image/png" } });
  await insertJob({ id: "job-out", outputKey: "generation-outputs/job-out.png", createdAt: Date.now() });
  await insertJob({ id: "job-pending", status: "submitting", createdAt: Date.now() });
  await insertJob({ id: "job-expired", outputKey: "generation-outputs/job-out.png", createdAt: Date.now(), expiresAt: Date.now() - 1 });
  const params = (id) => ({ params: Promise.resolve({ id }) });

  const ok = await jobOutput(new Request("http://localhost/api/jobs/job-out/output"), params("job-out"));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("Content-Type"), "image/png");
  assert.deepEqual([...new Uint8Array(await ok.arrayBuffer())], [1, 2, 3]);
  assert.equal((await jobOutput(new Request("http://localhost/x"), params("job-pending"))).status, 404);
  assert.equal((await jobOutput(new Request("http://localhost/x"), params("job-expired"))).status, 404);
  assert.equal((await jobOutput(new Request("http://localhost/x"), params("job-missing"))).status, 404);
});
