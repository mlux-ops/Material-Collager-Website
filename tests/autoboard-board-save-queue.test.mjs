import assert from "node:assert/strict";
import test from "node:test";
import { createBoardSaveQueue, mergeBoardPatch } from "../app/lib/board-save-queue.ts";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

// --- Fix round 1: probes 1-3 from the review, plus Minor 1. ---------------
//
// At most one write may be in flight. A dropdown save (saveNow) starting
// while a debounced instruction is still waiting, followed immediately by
// flush(), used to let the debounce timer fire DURING flush's wait — taking
// `pending` out from under it — so flush() resolved before that write ever
// went out. flush() must now force it out itself and wait for the whole
// chain, however many writes that takes.
test("flush waits for a debounced edit whose timer fires during the wait, so a render never sees stale text (R07)", async () => {
  const events = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  let n = 0;
  const send = async (patch) => {
    const id = ++n;
    events.push(`send#${id} start`);
    if (id === 1) await firstGate;
    else await sleep(50);
    events.push(`send#${id} stored`);
  };
  const queue = createBoardSaveQueue({ send, debounceMs: 20 });
  void queue.saveNow({ quality: "medium" }); // dropdown change, in flight
  queue.saveSoon({ instruction: "warm oak" }); // typed, then Render clicked
  const flushed = queue.flush().then(() => events.push("flush resolved"));
  await sleep(40); // the instruction's debounce timer fires during this wait
  releaseFirst();
  await flushed;
  assert.deepEqual(events, ["send#1 start", "send#1 stored", "send#2 start", "send#2 stored", "flush resolved"]);
});

// Two writes to the same field both fail while chained; a read-then-restore
// of `pending` let the FIRST write's stale patch land on top of the SECOND,
// later one once both failures had run. Only one write is ever in flight
// now, so there is no second failure handler racing to misread `pending`.
test("a later edit to the same field survives a failed write, not an earlier one restored (R07)", async () => {
  let failing = true;
  const sent = [];
  const send = async (patch) => {
    await sleep(15); // fresh per call, so this can't tie with the debounce timer below
    if (failing) throw new Error("HTTP 503");
    sent.push(structuredClone(patch));
  };
  const queue = createBoardSaveQueue({ send, debounceMs: 5, onError: () => {} });
  queue.saveSoon({ instruction: "warm o" });
  await sleep(10); // write 1 (debounced at ~5ms) is in flight, resolves at ~20ms
  queue.saveSoon({ instruction: "warm oak" }); // typed more while it is in flight
  await sleep(30); // write 1 fails at ~20ms; nothing auto-resends
  failing = false;
  await queue.flush();
  assert.deepEqual(sent, [{ instruction: "warm oak" }]);
});

// A note cleared while an earlier write for the SAME slot is failing used to
// be resurrected once that earlier write's failure handler ran and restored
// its own (now stale) patch on top of the clear.
test("a cleared note is not resurrected by an earlier failed write's stale value (R07)", async () => {
  let calls = 0;
  const sent = [];
  const send = async (patch) => {
    calls += 1;
    const call = calls;
    await sleep(15); // fresh per call, so this can't tie with the debounce timer below
    if (call === 1) throw new Error("HTTP 503");
    sent.push(structuredClone(patch));
  };
  const queue = createBoardSaveQueue({ send, debounceMs: 5, onError: () => {} });
  queue.saveSoon({ notes: { faucet: "brushed brass" } });
  await sleep(10); // write 1 in flight, resolves at ~20ms
  queue.saveSoon({ notes: { faucet: "" } }); // reviewer clears the note
  await sleep(30); // write 1 fails at ~20ms; the clear stays pending, nothing auto-resends
  queue.saveSoon({ instruction: "later edit" });
  await queue.flush();
  assert.deepEqual(sent, [{ notes: { faucet: "" }, instruction: "later edit" }]);
});

// Minor 1: a failed dropdown save must not be re-sent — the dropdown itself
// reverts to the last saved value and shows the error, so resending its
// stale value later could apply it to an unrelated save. A failed text
// field (instruction/notes) is different: the input still shows the edit,
// so it is kept and goes out with the next save or flush.
test("a failed save keeps its text fields but drops its dropdown fields (Minor 1)", async () => {
  const server = recorder({ fail: () => true });
  const queue = createBoardSaveQueue({ send: server.send, debounceMs: 60_000, onError: () => {} });
  queue.saveSoon({ instruction: "warm oak", notes: { tile: "grey" } });
  const ok = await queue.saveNow({ quality: "medium" });
  assert.equal(ok, false);
  assert.deepEqual(queue.takePending(), { instruction: "warm oak", notes: { tile: "grey" } });
});

test("a failed dropdown-only save is not re-sent on a later, unrelated save (Minor 1)", async () => {
  let failing = true;
  const server = recorder({ fail: () => failing });
  const queue = createBoardSaveQueue({ send: server.send, debounceMs: 5, onError: () => {} });
  const ok = await queue.saveNow({ quality: "medium" });
  assert.equal(ok, false);
  failing = false;
  queue.saveSoon({ instruction: "unrelated" });
  await queue.flush();
  assert.deepEqual(server.sent, [{ instruction: "unrelated" }]);
});

// keepEditedFields drops every field of an all-dropdown patch, so a failed
// attempt keeps nothing at all — `pending` must land back on null, not on a
// leftover `{}`. saveNow must still report the failure correctly (its
// success signal comes from the attempt itself, not from whether `pending`
// is empty afterward: those are no longer the same thing once a failure can
// legitimately keep nothing), and a flush with nothing else queued must
// resolve immediately rather than resending an empty patch.
test("flush after an all-dropdown failure resolves cleanly, without resending an empty patch (Minor 1)", async () => {
  const sent = [];
  let failing = true;
  const send = async (patch) => {
    if (failing) throw new Error("HTTP 503");
    sent.push(structuredClone(patch));
  };
  const queue = createBoardSaveQueue({ send, debounceMs: 5, onError: () => {} });
  const ok = await queue.saveNow({ quality: "medium" });
  assert.equal(ok, false);
  await queue.flush(); // nothing left to send; must resolve, not hang or resend {}
  assert.deepEqual(sent, []);
});
