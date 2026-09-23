import assert from "node:assert/strict";
import test from "node:test";
import { createFakeD1, createFakeR2, installWorkerEnv } from "./helpers/fake-worker-env.mjs";

const TARGET = /UPDATE autoboard_renders SET status = \? WHERE id = \?/;
let failTarget = false;
// Both picks read their row before either writes: the interleaving that let
// two renders end up picked.
let raceActive = false;
let reads = 0;
let bothRead;
const readBarrier = new Promise((resolve) => { bothRead = resolve; });

const DB = createFakeD1({
  beforeStatement: async (kind, sql) => {
    if (failTarget && kind !== "batch" && TARGET.test(sql)) throw new Error("injected");
    if (!raceActive) return;
    if (/^\s*SELECT \* FROM autoboard_renders WHERE id = \?/i.test(sql)) {
      reads += 1;
      if (reads === 2) bothRead();
      return;
    }
    if (kind === "batch" || /^\s*UPDATE/i.test(sql)) await readBarrier;
  },
  onBatchStatement: (sql) => {
    if (failTarget && TARGET.test(sql)) throw new Error("injected");
  },
});
installWorkerEnv({ DB, OUTPUTS: createFakeR2() });
const { ensureRenderStorage, setRenderStatus } = await import("../app/lib/autoboard-renders.ts");

async function seed(projectId, renders) {
  const storage = await ensureRenderStorage();
  // id is the table's own primary key (global, not scoped per project), and
  // every test in this file reuses the literal ids "r-a"/"r-b" against the
  // one module-scope fake D1 above — so without a wipe here, the second and
  // third tests' seed() collide on rows the first test already inserted.
  // exec() bypasses the beforeStatement/onBatchStatement hooks entirely, so
  // this cleanup can never trip the race/failure gates those hooks set up.
  await storage.exec("DELETE FROM autoboard_renders");
  for (const [id, status] of renders) {
    await storage.prepare(`INSERT INTO autoboard_renders
      (id, project_id, board_id, kind, variant, status, r2_key, selection_hash, render_options_hash, quality, background, cost_usd, created_at)
      VALUES (?, ?, 'b', 'draft', 'A', ?, ?, 'h', 'o', 'low', 'opaque', NULL, ?)`)
      .bind(id, projectId, status, `autoboard/renders/${projectId}/b/${id}.png`, Date.now())
      .run();
  }
}

async function statuses(projectId) {
  const { results } = await DB.prepare("SELECT id, status FROM autoboard_renders WHERE project_id = ? ORDER BY id").bind(projectId).all();
  return Object.fromEntries(results.map((row) => [row.id, row.status]));
}

test("two picks made at the same time leave exactly one picked render (R08)", async () => {
  await seed("p-race", [["r-a", "candidate"], ["r-b", "candidate"]]);
  raceActive = true;
  await Promise.all([setRenderStatus("r-a", "picked"), setRenderStatus("r-b", "picked")]);
  raceActive = false;
  const picked = Object.values(await statuses("p-race")).filter((status) => status === "picked");
  assert.equal(picked.length, 1);
});

test("a pick that fails part-way keeps the previous pick (R08)", async () => {
  await seed("p-fail", [["r-a", "picked"], ["r-b", "candidate"]]);
  failTarget = true;
  await assert.rejects(setRenderStatus("r-b", "picked"), /injected/);
  failTarget = false;
  assert.deepEqual(await statuses("p-fail"), { "r-a": "picked", "r-b": "candidate" });
});

test("setting a render back to candidate leaves the others alone", async () => {
  await seed("p-cand", [["r-a", "picked"], ["r-b", "approved"]]);
  await setRenderStatus("r-a", "candidate");
  assert.deepEqual(await statuses("p-cand"), { "r-a": "candidate", "r-b": "approved" });
});

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
