import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { IPM_WINDOW_MS, IpmLimiter, sharedIpmLimiter } from "../app/components/workbench/nodes/ipm-limiter.ts";
import {
  buildMultiRunRun,
  classifyChunkError,
  emptyTotals,
  addUsage,
  multiRunPayload,
  multiRunSettings,
  nextCandidateIndex,
  partialRunMessage,
  planChunks,
  resumeStateFor,
  runChunks,
} from "../app/components/workbench/nodes/multiRun.core.ts";
import { draftOverrideMap, MANIFESTS, NODE_KINDS, auditPaidNodeCoverage, paidMap } from "../app/components/workbench/nodes/manifests.ts";
import { runIsComplete, signatureFor } from "../app/components/workbench/signature.ts";
import { rehydrateRun } from "../app/components/workbench/persistence.ts";
import { ApiResponseError } from "../app/lib/api-client.ts";

// ---------------------------------------------------------------------------
// Helpers: a hand-driven clock, stubbed fetch responses in the exact shapes
// /api/workbench/edit returns, and a microtask flush.
// ---------------------------------------------------------------------------

const flush = () => new Promise((resolve) => setImmediate(resolve));

function fakeClock(start = 1_000_000) {
  let now = start;
  const timers = [];
  return {
    now: () => now,
    sleep(ms, signal) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        const timer = { due: now + ms, resolve };
        timers.push(timer);
        signal?.addEventListener("abort", () => {
          const index = timers.indexOf(timer);
          if (index >= 0) timers.splice(index, 1);
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      });
    },
    async advance(ms) {
      now += ms;
      for (const timer of [...timers]) {
        if (timer.due <= now) {
          timers.splice(timers.indexOf(timer), 1);
          timer.resolve();
        }
      }
      await flush();
    },
    pending: () => timers.length,
  };
}

const ok = (count, usage = { input_tokens: 100, output_tokens: 50, total_tokens: 150 }) =>
  Response.json({ ok: true, images: Array.from({ length: count }, () => "aGk="), mimeType: "image/png", usage, retryable: false });
const rateLimited = (retryAfterMs = 2000) =>
  Response.json({ ok: false, error: "Rate limit reached for images per min.", code: "rate_limit_exceeded", retryAfterMs, retryable: true }, { status: 429 });
const quota = () =>
  Response.json({ ok: false, error: "You exceeded your current quota, please check your plan and billing details.", code: "insufficient_quota", retryable: false }, { status: 429 });
const serverError = () => Response.json({ ok: false, error: "Upstream failed.", retryable: true }, { status: 500 });

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

// A stubbed fetch that answers each call with the next scripted reply (a
// Response, a function of (init, callIndex), or an Error to throw), and
// records the `n` each call asked for.
function scriptedFetch(replies) {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    const index = calls.length;
    calls.push({ n: JSON.parse(init.body.get("payload")).n, signal: init.signal });
    const reply = typeof replies === "function" ? replies(index, init) : replies[index];
    const value = typeof reply === "function" ? await reply(init, index) : await reply;
    if (value instanceof Error) throw value;
    return value;
  };
  return { fetchImpl, calls };
}

const payload = { prompt: "a tiled bathroom", size: "1024x1024", quality: "low", model: "gpt-image-2.6-sunburst", background: "opaque", outputFormat: "png" };
const buildForm = (n) => {
  const form = new FormData();
  form.append("payload", JSON.stringify({ ...payload, n }));
  return form;
};

function depsFor(fetchImpl, overrides = {}) {
  const clock = overrides.clock ?? fakeClock();
  const delivered = [];
  const sleeps = [];
  return {
    delivered,
    sleeps,
    clock,
    deps: {
      fetchImpl,
      buildForm,
      limiter: overrides.limiter ?? new IpmLimiter(clock),
      ipm: overrides.ipm ?? 150,
      signal: overrides.signal ?? new AbortController().signal,
      sleep: async (ms) => { sleeps.push(ms); },
      onChunk: (chunk, response) => delivered.push({ chunk, count: response.images.length }),
      ...overrides.deps,
    },
  };
}

// ---------------------------------------------------------------------------
// Limiter
// ---------------------------------------------------------------------------

test("limiter: a request reserves n image slots, and the window slides 60 s after each reservation", async () => {
  const clock = fakeClock();
  const limiter = new IpmLimiter(clock);
  await limiter.acquire(6, 10);
  assert.equal(limiter.used(), 6);

  let admitted = false;
  const second = limiter.acquire(6, 10).then(() => { admitted = true; });
  await flush();
  assert.equal(admitted, false, "6 + 6 images exceed a cap of 10");

  await clock.advance(IPM_WINDOW_MS - 1);
  assert.equal(admitted, false, "the first reservation is still inside the window 1 ms before it slides out");
  await clock.advance(1);
  await second;
  assert.equal(admitted, true);
  assert.equal(limiter.used(), 6, "the first reservation left the window; only the second counts");
});

test("limiter: it counts images, not requests -- one n=10 call fills a cap of 10", async () => {
  const clock = fakeClock();
  const limiter = new IpmLimiter(clock);
  await limiter.acquire(10, 10);
  let admitted = false;
  void limiter.acquire(1, 10).then(() => { admitted = true; });
  await flush();
  assert.equal(admitted, false);
  await clock.advance(IPM_WINDOW_MS);
  assert.equal(admitted, true);
});

test("limiter: a slides-in-order window admits a waiter as soon as ENOUGH old reservations expire", async () => {
  const clock = fakeClock();
  const limiter = new IpmLimiter(clock);
  await limiter.acquire(4, 10); // t0
  await clock.advance(10_000);
  await limiter.acquire(4, 10); // t0 + 10 s
  let admitted = false;
  void limiter.acquire(5, 10).then(() => { admitted = true; }); // needs the first 4 back
  await flush();
  await clock.advance(IPM_WINDOW_MS - 10_000 - 1);
  assert.equal(admitted, false);
  await clock.advance(1);
  assert.equal(admitted, true, "admitted at t0 + 60 s, without waiting for the second reservation");
});

test("limiter: an aborted waiter reserves nothing and does not block the waiter behind it", async () => {
  const clock = fakeClock();
  const limiter = new IpmLimiter(clock);
  await limiter.acquire(10, 10);
  const controller = new AbortController();
  const aborted = limiter.acquire(5, 10, controller.signal);
  let secondAdmitted = false;
  void limiter.acquire(5, 10).then(() => { secondAdmitted = true; });
  await flush();
  controller.abort();
  await assert.rejects(aborted, (error) => error instanceof DOMException && error.name === "AbortError");
  await clock.advance(IPM_WINDOW_MS);
  assert.equal(secondAdmitted, true);
  assert.equal(limiter.used(), 5, "only the surviving waiter's slots are reserved");
});

test("limiter: waiters are first come, first served -- a big chunk at the head is never starved by small ones", async () => {
  const clock = fakeClock();
  const limiter = new IpmLimiter(clock);
  await limiter.acquire(8, 10);
  const order = [];
  void limiter.acquire(10, 10).then(() => order.push("big"));
  void limiter.acquire(1, 10).then(() => order.push("small"));
  await flush();
  assert.deepEqual(order, [], "the small request fits now but must not jump the queue");
  await clock.advance(IPM_WINDOW_MS);
  assert.deepEqual(order, ["big"]);
  await clock.advance(IPM_WINDOW_MS);
  assert.deepEqual(order, ["big", "small"]);
});

test("limiter: a request larger than the cap is refused outright, and a released reservation frees its slots", async () => {
  const limiter = new IpmLimiter(fakeClock());
  await assert.rejects(limiter.acquire(5, 4), RangeError);
  const release = await limiter.acquire(4, 4);
  assert.equal(limiter.used(), 4);
  release();
  assert.equal(limiter.used(), 0);
});

test("limiter: every Multi-Run node shares one module-level budget", () => {
  assert.equal(sharedIpmLimiter(), sharedIpmLimiter());
  assert.notEqual(sharedIpmLimiter("other"), sharedIpmLimiter());
});

// ---------------------------------------------------------------------------
// Settings and chunk planning
// ---------------------------------------------------------------------------

test("settings: defaults 20 images, 10 per call, 150 a minute; out-of-range values clamp", () => {
  assert.deepEqual(multiRunSettings({}), { total: 20, perCall: 10, ipm: 150 });
  assert.deepEqual(multiRunSettings({ total: 999, perCall: 50, ipm: 999 }), { total: 150, perCall: 10, ipm: 150 });
  assert.deepEqual(multiRunSettings({ total: 0, perCall: 0, ipm: 0 }), { total: 1, perCall: 1, ipm: 1 });
});

test("settings: images per call is clamped to the cap, so no chunk can ever exceed it", () => {
  assert.equal(multiRunSettings({ perCall: 10, ipm: 4 }).perCall, 4);
});

test("planning: ceil(total / perCall) calls, each n = min(perCall, remaining), with fixed offsets", () => {
  assert.deepEqual(planChunks(20, 10), [{ index: 0, offset: 0, n: 10 }, { index: 1, offset: 10, n: 10 }]);
  assert.deepEqual(planChunks(25, 10).map((chunk) => [chunk.offset, chunk.n]), [[0, 10], [10, 10], [20, 5]]);
  assert.equal(planChunks(150, 10).length, 15);
  assert.equal(planChunks(150, 7).length, Math.ceil(150 / 7));
  assert.deepEqual(planChunks(3, 1).map((chunk) => chunk.n), [1, 1, 1], "only perCall=1 splits into single-image calls");
  assert.deepEqual(planChunks(0, 10), []);
});

test("payload: PNG or WebP only -- JPEG, SVG and GIF fall back to PNG", () => {
  const prompt = [{ kind: "text", text: "a kitchen" }];
  assert.equal(multiRunPayload({ outputFormat: "webp" }, prompt).outputFormat, "webp");
  for (const format of ["jpeg", "svg", "gif", undefined]) {
    assert.equal(multiRunPayload({ outputFormat: format }, prompt).outputFormat, "png", String(format));
  }
  assert.throws(() => multiRunPayload({}, []), /prompt/i);
});

test("resume: the same signature with fewer images than the total renders only the remainder", () => {
  const run = { runId: "r1", signature: "sig", at: 1, values: [[image("n:a:0"), image("n:a:1"), image("n:a:2")]], target: 10 };
  assert.deepEqual(
    (({ existing, remaining }) => ({ existing: existing.length, remaining }))(resumeStateFor(run, "sig", 10)),
    { existing: 3, remaining: 7 },
  );
  assert.equal(resumeStateFor(run, "other-sig", 10).remaining, 10, "a changed signature starts over");
  assert.equal(resumeStateFor(undefined, "sig", 10).remaining, 10);
  assert.equal(nextCandidateIndex(run.values[0]), 3);
  assert.equal(nextCandidateIndex([image("n:a:0"), image("n:b:24")]), 25);
});

function image(cacheKey) {
  return { kind: "image", url: `blob:${cacheKey}`, cacheKey, mimeType: "image/png" };
}

// ---------------------------------------------------------------------------
// Failure policy, through the real runner with a stubbed fetch
// ---------------------------------------------------------------------------

test("failure policy: a non-quota 429 is retried after its Retry-After, then succeeds", async () => {
  const { fetchImpl, calls } = scriptedFetch([rateLimited(2000), ok(10)]);
  const { deps, sleeps, delivered } = depsFor(fetchImpl);
  const outcome = await runChunks(planChunks(10, 10), deps);
  assert.equal(outcome.stopReason, undefined);
  assert.equal(outcome.delivered, 10);
  assert.deepEqual(sleeps, [2000], "waited exactly the Retry-After the route forwarded");
  assert.equal(calls.length, 2);
  assert.deepEqual(delivered.map((entry) => entry.count), [10]);
});

test("failure policy: a retryable 429 is retried at most three times, then the press stops", async () => {
  const { fetchImpl, calls } = scriptedFetch(() => rateLimited(500));
  const { deps } = depsFor(fetchImpl);
  const outcome = await runChunks(planChunks(10, 10), deps);
  assert.equal(calls.length, 4, "one attempt plus three retries");
  assert.match(outcome.stopReason, /rate-limiting/);
});

test("failure policy: a quota 429 stops new calls, lets in-flight calls finish, and keeps what they paid for", async () => {
  const clock = fakeClock();
  const inFlight = deferred();
  const { fetchImpl, calls } = scriptedFetch([quota(), () => inFlight.promise]);
  // A cap of 2 single-image calls: two launch, three wait in the limiter.
  const { deps, delivered } = depsFor(fetchImpl, { clock, ipm: 2 });
  const running = runChunks(planChunks(5, 1), deps);
  await flush();
  await flush();
  assert.equal(calls.length, 2);
  inFlight.resolve(ok(1));
  const outcome = await running;
  assert.equal(deps.limiter.used(), 2, "queued chunks reserved nothing");
  assert.equal(calls.length, 2, "nothing launched after the quota error");
  await clock.advance(IPM_WINDOW_MS * 2);
  assert.equal(calls.length, 2, "nor once the window would have room");
  assert.match(outcome.stopReason, /quota or billing/);
  assert.equal(outcome.delivered, 1, "the call already in flight was recorded");
  assert.deepEqual(delivered.map((entry) => entry.count), [1]);
});

test("failure policy: a network TypeError is never retried (it may have been billed)", async () => {
  const { fetchImpl, calls } = scriptedFetch([new TypeError("Failed to fetch")]);
  const { deps, sleeps } = depsFor(fetchImpl);
  const outcome = await runChunks(planChunks(10, 10), deps);
  assert.equal(calls.length, 1);
  assert.deepEqual(sleeps, []);
  assert.match(outcome.stopReason, /network/);
});

test("failure policy: a 5xx stops the press even though the route marks it retryable (only a 429 is safe to repeat)", async () => {
  const { fetchImpl, calls } = scriptedFetch([serverError()]);
  const { deps } = depsFor(fetchImpl);
  const outcome = await runChunks(planChunks(10, 10), deps);
  assert.equal(calls.length, 1);
  assert.equal(outcome.stopReason, "Upstream failed.");
});

test("cancel: nothing new launches, but calls already sent finish and their paid images are kept", async () => {
  const controller = new AbortController();
  const clock = fakeClock();
  const inFlight = deferred();
  const { fetchImpl, calls } = scriptedFetch(() => () => inFlight.promise);
  const waits = [];
  // A cap of 10: one 10-image call launches, the second waits in the limiter.
  const { deps, delivered } = depsFor(fetchImpl, { clock, ipm: 10, signal: controller.signal, deps: { onCancelWait: (count) => waits.push(count) } });
  const running = runChunks(planChunks(20, 10), deps);
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].signal, undefined, "a sent call is never aborted client-side: OpenAI bills it regardless");
  controller.abort();
  await flush();
  assert.deepEqual(waits, [1], "the card says it is waiting for the one call already sent");
  inFlight.resolve(ok(10));
  const outcome = await running;
  await clock.advance(IPM_WINDOW_MS * 2);
  assert.equal(calls.length, 1, "the queued call never launched");
  assert.equal(outcome.aborted, true);
  assert.equal(outcome.stopReason, undefined);
  assert.equal(outcome.delivered, 10);
  assert.deepEqual(delivered.map((entry) => entry.count), [10]);
});

test("cancel: a retryable 429 that comes back after cancel is not retried", async () => {
  const controller = new AbortController();
  const reply = deferred();
  const { fetchImpl, calls } = scriptedFetch([() => reply.promise]);
  const { deps, sleeps } = depsFor(fetchImpl, { signal: controller.signal });
  const running = runChunks(planChunks(10, 10), deps);
  await flush();
  controller.abort();
  reply.resolve(rateLimited(100));
  const outcome = await running;
  assert.equal(calls.length, 1);
  assert.deepEqual(sleeps, []);
  assert.equal(outcome.aborted, true);
});

test("classifyChunkError reads the route's envelope: retryable 429 -> retry, quota 429 / 5xx / TypeError -> stop", () => {
  const signal = new AbortController().signal;
  const envelope = (status, extra) => new ApiResponseError("x", { status, ...extra });
  assert.deepEqual(classifyChunkError(envelope(429, { retryable: true, retryAfterMs: 1500 }), signal, 0), { kind: "retry", waitMs: 1500 });
  assert.deepEqual(classifyChunkError(envelope(429, { retryable: true }), signal, 2), { kind: "retry", waitMs: 8000 });
  assert.equal(classifyChunkError(envelope(429, { retryable: false }), signal, 0).kind, "stop");
  assert.equal(classifyChunkError(envelope(503, { retryable: true }), signal, 0).kind, "stop");
  assert.equal(classifyChunkError(new TypeError("Failed to fetch"), signal, 0).kind, "stop");
  assert.equal(classifyChunkError(new DOMException("Aborted", "AbortError"), signal, 0).kind, "abort");
});

// ---------------------------------------------------------------------------
// Partial apply and resume
// ---------------------------------------------------------------------------

async function press({ run, signature, total, perCall, replies, burstId }) {
  const { existing, remaining } = resumeStateFor(run, signature, total);
  const firstIndex = nextCandidateIndex(existing);
  const added = [];
  let totals = emptyTotals();
  const { fetchImpl, calls } = scriptedFetch(replies);
  const { deps } = depsFor(fetchImpl, {
    deps: {
      onChunk: (chunk, response) => {
        response.images.forEach((_base64, offset) => added.push(image(`node:${burstId}:${firstIndex + chunk.offset + offset}`)));
        totals = addUsage(totals, response.usage, response.images.length);
      },
    },
  });
  const outcome = await runChunks(planChunks(remaining, perCall), deps);
  const next = buildMultiRunRun({ runId: run?.runId ?? "run-1", signature, existing, added, total, totals, at: 1 });
  return { outcome, next, calls };
}

test("partial apply: a stopped press keeps every paid image as a partial run that is not a cache hit", async () => {
  const { outcome, next } = await press({ signature: "sig", total: 25, perCall: 10, burstId: "b1", replies: [ok(10), quota(), ok(5)] });
  assert.match(outcome.stopReason, /quota/);
  assert.equal(next.values[0].length, 15);
  assert.equal(next.target, 25);
  assert.equal(runIsComplete(next), false, "the executor must re-execute it");
  assert.equal(next.usage.output_tokens, undefined, "burst totals never reach the shared output-token table");
  assert.equal(next.usage.multiRun.images, 15);
  assert.equal(next.usage.multiRun.requests, 2);
  assert.match(partialRunMessage(15, 25, outcome.stopReason), /^Saved 15 of 25 images; stopped because .*quota.*remaining 10\.$/);
});

test("resume: the next press renders ONLY the remainder and merges it into the same run", async () => {
  const first = await press({ signature: "sig", total: 25, perCall: 10, burstId: "b1", replies: [ok(10), quota(), ok(5)] });
  const second = await press({ run: first.next, signature: "sig", total: 25, perCall: 10, burstId: "b2", replies: [ok(10)] });
  assert.deepEqual(second.calls.map((call) => call.n), [10], "one call for the 10 missing images");
  const keys = second.next.values[0].map((value) => value.cacheKey);
  assert.equal(keys.length, 25);
  assert.equal(new Set(keys).size, 25, "no cache key collides with the first press's");
  assert.deepEqual(keys.slice(0, 15), first.next.values[0].map((value) => value.cacheKey), "existing images and their order are kept");
  assert.equal(second.next.runId, first.next.runId);
  assert.equal(runIsComplete(second.next), true);
});

test("an empty press applies nothing rather than replacing the run with a fake result", () => {
  assert.equal(buildMultiRunRun({ runId: "r", signature: "s", existing: [], added: [], total: 5, totals: emptyTotals(), at: 0 }), null);
});

test("runIsComplete: runs without a target (every other node) are always complete", () => {
  assert.equal(runIsComplete({ runId: "r", signature: "s", at: 0, values: [[]] }), true);
  assert.equal(runIsComplete({ runId: "r", signature: "s", at: 0, values: [[image("a:b:0")]], target: 2 }), false);
  assert.equal(runIsComplete({ runId: "r", signature: "s", at: 0, values: [[image("a:b:0"), image("a:b:1")]], target: 2 }), true);
});

test("executor: both cache-hit checks and the Cached badge require a complete run", async () => {
  const executor = await readFile(new URL("../app/components/workbench/executor.ts", import.meta.url), "utf8");
  const hits = executor.match(/cached && cached\.signature === signature && node\.data\.status !== "error" && runIsComplete\(cached\)/g) ?? [];
  assert.equal(hits.length, 2, "runNodes and estimateStaleCost");
  const shared = await readFile(new URL("../app/components/workbench/nodes/shared.tsx", import.meta.url), "utf8");
  assert.match(shared, /active\.signature === signature && runIsComplete\(active\)/);
});

test("picking a candidate keeps the run's target (selectCandidate spreads the run before reordering)", async () => {
  const variations = await readFile(new URL("../app/components/workbench/nodes/variations.tsx", import.meta.url), "utf8");
  assert.match(variations, /applyRun\(id, \{\s*\.\.\.run,\s*runId: createSelectionRunId\(\)/);
  const multiRun = await readFile(new URL("../app/components/workbench/nodes/multiRun.tsx", import.meta.url), "utf8");
  assert.match(multiRun, /useCandidatePicker\(id, data\)/, "Multi-Run reuses Variations' picker");
  assert.match(multiRun, /\} finally \{[\s\S]*ctx\.applyRun\(run\)/, "partial results are applied in finally");
});

test("persistence: a reloaded partial run keeps its target, so it reloads as partial", () => {
  const run = { runId: "r", signature: "s", at: 0, values: [[image("n:r:0")]], target: 20 };
  const restored = rehydrateRun(run, new Map([["n:r:0", "blob:fresh"]]));
  assert.equal(restored.target, 20);
  assert.equal(restored.values[0][0].url, "blob:fresh");
  assert.equal(runIsComplete(restored), false);
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

test("registration: multiRun is a paid, registered node kind with the Image Generation inputs", async () => {
  assert.ok(NODE_KINDS.includes("multiRun"));
  const manifest = MANIFESTS.multiRun;
  assert.equal(manifest.spec.title, "Multi-Run");
  assert.equal(paidMap.multiRun, true);
  assert.deepEqual(auditPaidNodeCoverage(), []);
  assert.equal(manifest.estimateCost({ params: {}, inputImages: 0 }), null);
  assert.deepEqual(manifest.spec.inputs.map((port) => [port.id, port.required ?? false]), [["prompt", true], ["references", false]]);
  assert.deepEqual(manifest.spec.outputs.map((port) => port.id), ["image"]);
  assert.deepEqual(
    { total: manifest.defaultParams.total, perCall: manifest.defaultParams.perCall, ipm: manifest.defaultParams.ipm },
    { total: 20, perCall: 10, ipm: 150 },
  );

  const source = (path) => readFile(new URL(path, import.meta.url), "utf8");
  const index = await source("../app/components/workbench/nodes/index.ts");
  assert.match(index, /multiRun: MultiRunComponent/);
  assert.match(index, /multiRun: multiRunExecute/);
  assert.match(await source("../app/components/workbench/types.ts"), /\| "multiRun"/);
});

test("signature: total and perCall are part of it; the images-per-minute cap is not", () => {
  const node = (params) => ({ id: "m", type: "multiRun", position: { x: 0, y: 0 }, data: { kind: "multiRun", params: { ...MANIFESTS.multiRun.defaultParams, ...params }, status: "idle", runs: [], activeRun: 0 } });
  const context = { incoming: new Map(), liveNode: () => undefined, draft: false };
  const base = signatureFor(context, node({}));
  assert.equal(signatureFor(context, node({ ipm: 30 })), base);
  assert.notEqual(signatureFor(context, node({ total: 21 })), base);
  assert.notEqual(signatureFor(context, node({ perCall: 5 })), base);
  const draft = draftOverrideMap.multiRun({ total: 40, perCall: 4, quality: "high" });
  assert.equal(draft.total, 40);
  assert.equal(draft.perCall, 4);
  assert.equal(draft.quality, "low");
});

test("import rules: PNG/WebP only, burst settings range-checked", async () => {
  const { EXPORT_FORMAT, EXPORT_VERSION, validateImport } = await import("../app/components/workbench/export-import.ts");
  const imported = (params) => validateImport({
    format: EXPORT_FORMAT, version: EXPORT_VERSION, exportedAt: 0, graphOnly: true, images: {}, edges: [],
    nodes: [{ id: "n1", kind: "multiRun", params, position: { x: 0, y: 0 } }],
  }).nodes[0].params;
  assert.equal(imported({ outputFormat: "webp" }).outputFormat, "webp");
  assert.equal(imported({ outputFormat: "jpeg" }).outputFormat, "png");
  assert.equal(imported({ outputFormat: "gif" }).outputFormat, "png");
  assert.equal(imported({ total: 150, perCall: 1, ipm: 60 }).total, 150);
  assert.equal(imported({ ipm: 60 }).ipm, 60);
  assert.equal(imported({ total: 151 }).total, 20);
  assert.equal(imported({ perCall: 11 }).perCall, 10);
  assert.equal(imported({ complexity: "medium" }).complexity, "medium");
});
