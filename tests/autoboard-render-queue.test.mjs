import assert from "node:assert/strict";
import { test } from "node:test";

import { RenderQueue } from "../scripts/autoboard/lib/render-queue.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));

function controllable() {
  const started = [];
  const resolvers = new Map();
  const execute = (job, { signal, onProgress }) => new Promise((resolve, reject) => {
    started.push(job.jobId);
    resolvers.set(job.jobId, { resolve, reject, onProgress });
    signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")));
  });
  return { execute, started, resolvers };
}

test("jobs run strictly one at a time in enqueue order", async () => {
  const { execute, started, resolvers } = controllable();
  const queue = new RenderQueue({ execute });
  const a = queue.enqueue({ boardId: "a", kind: "draft", variant: "A", count: 2 });
  const b = queue.enqueue({ boardId: "b", kind: "confirm" });
  assert.deepEqual([a.position, b.position], [1, 2]);
  await tick();
  assert.deepEqual(started, [a.jobId]);
  resolvers.get(a.jobId).onProgress("1/2");
  assert.equal(queue.snapshot()[0].progress, "1/2");
  resolvers.get(a.jobId).resolve();
  await tick(); await tick();
  assert.deepEqual(started, [a.jobId, b.jobId]);
  assert.equal(queue.snapshot()[0].state, "done");
  resolvers.get(b.jobId).resolve();
  await queue.idle;
  assert.equal(queue.snapshot()[1].state, "done");
});

test("a failure records the error fields and the queue moves on", async () => {
  const { execute, resolvers } = controllable();
  const queue = new RenderQueue({ execute });
  const a = queue.enqueue({ boardId: "a", kind: "draft", variant: "A", count: 1 });
  const b = queue.enqueue({ boardId: "b", kind: "draft", variant: "A", count: 1 });
  await tick();
  resolvers.get(a.jobId).reject(Object.assign(new Error("Busy"), { status: 429, retryAfterMs: 120000, code: "rate_limited" }));
  await tick(); await tick();
  const [ja, jb] = queue.snapshot();
  assert.equal(ja.state, "failed");
  assert.equal(ja.error.message, "Busy");
  assert.equal(ja.error.status, 429);
  assert.equal(ja.error.code, "rate_limited");
  assert.equal(ja.error.retryAfterMs, 120000);
  assert.equal(jb.state, "running");
  resolvers.get(b.jobId).resolve();
  await queue.idle;
});

test("cancel removes a queued job and aborts a running one, keeping its progress", async () => {
  const { execute, resolvers } = controllable();
  const queue = new RenderQueue({ execute });
  const a = queue.enqueue({ boardId: "a", kind: "draft", variant: "A", count: 3 });
  const b = queue.enqueue({ boardId: "b", kind: "draft", variant: "A", count: 1 });
  await tick();
  assert.equal(queue.cancel(b.jobId), true);
  assert.equal(queue.snapshot()[1].state, "cancelled");
  resolvers.get(a.jobId).onProgress("2/3");
  assert.equal(queue.cancel(a.jobId), true);
  await tick(); await tick();
  assert.equal(queue.snapshot()[0].state, "cancelled");
  assert.equal(queue.snapshot()[0].progress, "2/3");
  assert.equal(queue.cancel("nope"), false);
  assert.equal(queue.cancel(a.jobId), false);
  await queue.idle;
});
