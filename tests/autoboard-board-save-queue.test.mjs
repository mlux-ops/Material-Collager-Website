import assert from "node:assert/strict";
import test from "node:test";
import { createBoardSaveQueue, mergeBoardPatch } from "../app/lib/board-save-queue.ts";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// A regression like fix round 1's missing `throw` (or fix round 2's wedged
// `inFlight`) hangs the whole suite rather than failing one test. Every test
// here gets a bound, so that failure mode reports as a timeout instead.
const TIMEOUT = { timeout: 5000 };
// Polls instead of sleeping a fixed duration, so a slow CI run fails loudly
// (past `timeoutMs`) rather than the test flaking on a margin a stall could
// eat into.
async function waitFor(predicate, { timeoutMs = 3000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`waitFor: condition still false after ${timeoutMs}ms`);
    await sleep(intervalMs);
  }
}

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

test("two notes typed inside one debounce window are both sent (R05)", TIMEOUT, async () => {
  const server = recorder();
  const queue = createBoardSaveQueue({ send: server.send, debounceMs: 5 });
  queue.saveSoon({ notes: { faucet: "brushed brass" } });
  queue.saveSoon({ notes: { tile: "cool grey" } });
  await queue.flush();
  assert.deepEqual(server.sent, [{ notes: { faucet: "brushed brass", tile: "cool grey" } }]);
});

test("clearing a note survives coalescing as an explicit empty value", TIMEOUT, async () => {
  const server = recorder();
  const queue = createBoardSaveQueue({ send: server.send, debounceMs: 5 });
  queue.saveSoon({ notes: { faucet: "brushed brass", tile: "cool grey" } });
  queue.saveSoon({ notes: { faucet: "" } });
  await queue.flush();
  assert.deepEqual(server.sent, [{ notes: { faucet: "", tile: "cool grey" } }]);
});

test("flush sends a still-debouncing instruction before it resolves, so a render sees it (R07)", TIMEOUT, async () => {
  const server = recorder();
  const queue = createBoardSaveQueue({ send: server.send, debounceMs: 60_000 });
  queue.saveSoon({ instruction: "warm oak" });
  await queue.flush();
  assert.deepEqual(server.sent, [{ instruction: "warm oak" }]);
});

test("flush waits for a write that is already in flight", TIMEOUT, async () => {
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

test("a failed save makes flush reject — so no render goes out — and keeps the edit for the next attempt", TIMEOUT, async () => {
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

test("writes reach the server one at a time, in order", TIMEOUT, async () => {
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

test("takePending hands over what has not been sent and cancels its timer", TIMEOUT, async () => {
  const server = recorder();
  const queue = createBoardSaveQueue({ send: server.send, debounceMs: 5 });
  queue.saveSoon({ instruction: "left mid-sentence" });
  assert.deepEqual(queue.takePending(), { instruction: "left mid-sentence" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(server.sent, []);
});

test("mergeBoardPatch keeps the newer scalar values and merges notes per slot", TIMEOUT, () => {
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
test("flush waits for a debounced edit whose timer fires during the wait, so a render never sees stale text (R07)", TIMEOUT, async () => {
  const events = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  let n = 0;
  const send = async () => {
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
test("a later edit to the same field survives a failed write, not an earlier one restored (R07)", TIMEOUT, async () => {
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
test("a cleared note is not resurrected by an earlier failed write's stale value (R07)", TIMEOUT, async () => {
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
  // On a loaded runner the clear can go out on its own before the later edit
  // is queued, so assert what the server ends up holding, not how many writes
  // carried it.
  const stored = sent.reduce((acc, patch) => ({ ...acc, ...patch, notes: { ...acc.notes, ...patch.notes } }), { notes: {} });
  assert.equal(stored.notes.faucet, "");
  assert.equal(stored.instruction, "later edit");
  assert.ok(!sent.some((patch) => patch.notes?.faucet === "brushed brass"), "the cleared note's old value never reached the server");
});

// Minor 1: a failed dropdown save must not be re-sent — the dropdown itself
// reverts to the last saved value and shows the error, so resending its
// stale value later could apply it to an unrelated save. A failed text
// field (instruction/notes) is different: the input still shows the edit,
// so it is kept and goes out with the next save or flush.
test("a failed save keeps its text fields but drops its dropdown fields (Minor 1)", TIMEOUT, async () => {
  const server = recorder({ fail: () => true });
  const queue = createBoardSaveQueue({ send: server.send, debounceMs: 60_000, onError: () => {} });
  queue.saveSoon({ instruction: "warm oak", notes: { tile: "grey" } });
  const ok = await queue.saveNow({ quality: "medium" });
  assert.equal(ok, false);
  assert.deepEqual(queue.takePending(), { instruction: "warm oak", notes: { tile: "grey" } });
});

test("a failed dropdown-only save is not re-sent on a later, unrelated save (Minor 1)", TIMEOUT, async () => {
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
test("flush after an all-dropdown failure resolves cleanly, without resending an empty patch (Minor 1)", TIMEOUT, async () => {
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

// --- Fix round 2: probes 4-8 from the re-review. --------------------------

// Probe 4 (Important 1): the round-1 success handler drained `pending`
// unconditionally, so a steady typist's own debounce timer never got a
// chance to matter — every write finishing immediately sent whatever had
// accumulated so far, one PATCH per write instead of one per pause.
test("typing through an in-flight write does not defeat the debounce (Important 1)", TIMEOUT, async () => {
  const sent = [];
  const send = async (patch) => {
    await sleep(30);
    sent.push(patch.instruction);
  };
  const queue = createBoardSaveQueue({ send, debounceMs: 50 });
  let text = "warm";
  queue.saveSoon({ instruction: text });
  await sleep(60); // pause: the debounce fires, write 1 ("warm") goes out and is in flight
  for (let i = 0; i < 10; i++) {
    text += "x";
    queue.saveSoon({ instruction: text }); // each keystroke resets the 50 ms debounce
    await sleep(10); // steady typing, well inside the debounce window
  }
  assert.deepEqual(sent, ["warm"]); // typing alone never triggered a second write
  // Typing has stopped; the last-armed debounce fires on its own schedule
  // once free of CPU contention, then the write itself takes another 30 ms —
  // poll for it rather than sleeping a fixed duration a CI stall could eat.
  await waitFor(() => sent.length === 2);
  assert.deepEqual(sent, ["warm", text]); // exactly one more write, with the latest text
});

// Probes 5 and 6 (Important 2, and Minor 3): a dropdown save's failure
// drops the value (keepEditedFields keeps nothing), so a drain that only
// waited on that write — never making an attempt of its own — used to see
// `pending === null` and read that as success. "A save that failed stops
// the render" (the test above, at the top of this file) is the rule this
// restores for the case where nothing is left to retry.
test("a dropdown save that fails while flush only waits on it still makes flush reject (Important 2)", TIMEOUT, async () => {
  const events = [];
  const send = async (patch) => {
    await sleep(20);
    events.push(`send ${JSON.stringify(patch)} -> 503`);
    throw new Error("HTTP 503");
  };
  const queue = createBoardSaveQueue({ send, debounceMs: 5, onError: () => {} });
  void queue.saveNow({ quality: "low" }); // dropdown: write goes out at once
  await assert.rejects(queue.flush(), /HTTP 503/); // Render clicked while it is out
  assert.deepEqual(events, ['send {"quality":"low"} -> 503']);
});

test("saveNow resolves false when the write it only rode along on fails (Minor 3)", TIMEOUT, async () => {
  let calls = 0;
  const errors = [];
  const send = async () => {
    calls += 1;
    const call = calls;
    await sleep(20);
    if (call === 2) throw new Error("HTTP 503");
  };
  const queue = createBoardSaveQueue({ send, debounceMs: 5, onError: (error) => errors.push(error.message) });
  queue.saveSoon({ instruction: "warm oak" });
  await sleep(10); // write 1 (the instruction) is out
  const ok = await queue.saveNow({ quality: "high" }); // write 2 carries it, and fails
  assert.equal(ok, false); // was `true` before Important 2's fix
  assert.deepEqual(errors, ["HTTP 503"]);
  assert.equal(calls, 2);
});

// Minor 1: an onError that itself throws used to leave `inFlight` pointing
// at an already-settled promise forever (the assignment that clears it sat
// after onError/String(cause), so the throw skipped it) — every later
// `while (inFlight) await inFlight` then spun on that settled promise
// without end. `inFlight` is now cleared in a finally.
test("an onError that throws does not wedge the queue (Minor 1)", TIMEOUT, async () => {
  const sent = [];
  let failing = true;
  const queue = createBoardSaveQueue({
    send: async (patch) => {
      if (failing) throw new Error("HTTP 503");
      sent.push(structuredClone(patch));
    },
    debounceMs: 5,
    onError: () => { throw new Error("onError threw"); },
  });
  const ok = await queue.saveNow({ instruction: "typed" });
  assert.equal(ok, false);
  failing = false;
  queue.saveSoon({ instruction: "typed more" });
  await queue.flush().catch(() => {}); // must return, not spin forever
  // Not just "didn't hang": the follow-up edit actually reached the server,
  // so a regression that silently drops writes instead of wedging also fails.
  assert.deepEqual(sent, [{ instruction: "typed more" }]);
});

// Minor 2: `pending = null` ran before the (possibly synchronously throwing)
// call to send(), so a non-async send — or one that throws before its first
// await — lost the patch outright: nothing was left to retry, and the
// throw would have escaped uncaught entirely from the plain setTimeout
// callback a debounce tick calls pump() from.
test("a send that throws synchronously still keeps its patch for the next attempt (Minor 2)", TIMEOUT, async () => {
  const queue = createBoardSaveQueue({
    send: () => { throw new Error("sync boom"); },
    debounceMs: 5,
    onError: () => {},
  });
  const ok = await queue.saveNow({ instruction: "typed text" });
  assert.equal(ok, false);
  assert.deepEqual(queue.takePending(), { instruction: "typed text" });
});

// --- Fix round 3: re-review findings on the round-2 fix. ------------------

// Minor 1 (this round, probe 10): the reviewer picks "high", then "low"
// while "high" is still out. "high" fails, but a newer value for the SAME
// field already replaced it — that field's failure must not make a drain
// that only waited on it reject, because "low" (not "high") is what a
// drain goes on to attempt, and it succeeds.
test("a dropdown value replaced before its own failure does not make saveNow or flush reject (probe 10)", TIMEOUT, async () => {
  const stored = [];
  let calls = 0;
  const send = async (patch) => {
    calls += 1;
    const call = calls;
    await sleep(20);
    if (call === 1) throw new Error("HTTP 503"); // "high", the first write, fails
    stored.push(structuredClone(patch));
  };
  const queue = createBoardSaveQueue({ send, debounceMs: 5, onError: () => {} });
  const high = queue.saveNow({ quality: "high" });
  await sleep(5); // "high" is out
  const low = queue.saveNow({ quality: "low" }); // the newer choice replaces "high"
  assert.equal(await high, false); // "high" itself did fail
  assert.equal(await low, true); // "low" replaced it and was stored instead
  await queue.flush(); // must resolve — nothing "high"-shaped is left unresolved
  assert.deepEqual(stored, [{ quality: "low" }]);
});

// Minor 2 (this round, probe 9): a rejection value String() cannot convert
// (Object.create(null) has no toString) used to skip both the pending
// restore and the dropped-counter update. Flushing while only WAITING on
// the write (not making the attempt itself, so its only signal is `pending`
// and the dropped counter) used to see neither updated and resolve
// silently, losing the typed text outright. The message is now built with
// a fallback that cannot throw, ahead of both those updates.
test("a rejection value that cannot be stringified still restores pending and reports the failure (probe 9)", TIMEOUT, async () => {
  const queue = createBoardSaveQueue({
    send: async () => {
      await sleep(10);
      throw Object.create(null); // String(Object.create(null)) throws
    },
    debounceMs: 5,
    onError: () => {},
  });
  queue.saveSoon({ instruction: "typed" });
  await sleep(8); // the debounce fires; flush() below only waits, it does not attempt
  await assert.rejects(queue.flush(), /could not be converted/);
  assert.deepEqual(queue.takePending(), { instruction: "typed" });
});
