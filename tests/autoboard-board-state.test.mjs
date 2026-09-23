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
