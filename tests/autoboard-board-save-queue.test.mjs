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
