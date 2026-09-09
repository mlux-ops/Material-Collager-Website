// tests/autoboard-render.test.mjs
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { AccessError } from "../scripts/autoboard/lib/access.mjs";
import {
  approveConfirmed,
  boardForRender,
  buildConfirmPayload,
  buildDraftPayload,
  buildFinalPayload,
  candidateIsStaleForFinalize,
  ensureRenders,
  estimateCost,
  formatCost,
  nextRenderId,
  pickDraft,
  postGeneration,
  recordConfirmed,
  recordDraft,
  recordFinal,
  removeRender,
  renderOptionsHash,
  renderRecordIsStale,
  resetNonFinalRenders,
  resolveRenderOptions,
  savedRenderOptions,
  renderSource,
  runRenderJob,
  saveRenderImage,
  selectionHash,
} from "../scripts/autoboard/lib/render.mjs";
import { DEFAULT_VARIANTS } from "../scripts/autoboard/lib/variants.mjs";
import { uploadFileToOpenAI } from "../scripts/autoboard/lib/openai-upload.mjs";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const A = DEFAULT_VARIANTS[0];

function board(overrides = {}) {
  return {
    id: "penthouse-bath-2-fixture",
    title: "Penthouse Bath 2 Fixture Collage",
    unitType: "Penthouse",
    roomLabel: "Bath 2",
    collageType: "bathroom_fixture_collage",
    items: [
      { slotId: "vanity_faucet", role: "vanity faucet", required: true, name: "Croma Select S", brand: "Hansgrohe", notes: "", images: ["E:/lib/faucet.png"] },
      { slotId: "main_tile", role: "main tile", required: true, name: "Green Terrazzo", brand: "", notes: "", images: ["E:/lib/tile.png"], note: "keep the terrazzo chips visible" },
    ],
    ...overrides,
  };
}

function scratchRun() {
  const runDir = mkdtempSync(path.join(tmpdir(), "autoboard-render-"));
  const lib = path.join(runDir, "lib");
  mkdirSync(lib, { recursive: true });
  writeFileSync(path.join(lib, "faucet.png"), PNG);
  writeFileSync(path.join(lib, "tile.png"), PNG);
  const plan = {
    runId: "run-test",
    variants: DEFAULT_VARIANTS,
    boards: [board({ items: [
      { slotId: "vanity_faucet", role: "vanity faucet", required: true, name: "Croma", brand: "Hansgrohe", notes: "", images: [path.join(lib, "faucet.png")] },
      { slotId: "main_tile", role: "main tile", required: true, name: "Terrazzo", brand: "", notes: "", images: [path.join(lib, "tile.png")] },
    ] })],
  };
  return { runDir, plan, results: { candidates: {}, finals: {} } };
}

test("pre-render costs stay unavailable until usage completes", () => {
  assert.equal(estimateCost("draft", 3), null);
  assert.equal(estimateCost("confirm"), null);
  assert.equal(estimateCost("final"), null);
  assert.equal(formatCost(null), "cost unavailable until completion");
  assert.throws(() => estimateCost("bogus"), /Unknown render kind/);
});

test("render options use explicit CLI/UI values before saved board values and stage defaults", () => {
  const oldPlan = board();
  assert.deepEqual(savedRenderOptions(oldPlan), { quality: undefined, background: "opaque" });
  assert.deepEqual(resolveRenderOptions(oldPlan, "draft"), { quality: "low", background: "opaque" });
  assert.deepEqual(resolveRenderOptions(oldPlan, "confirm"), { quality: "medium", background: "opaque" });
  assert.deepEqual(resolveRenderOptions(oldPlan, "final"), { quality: "high", background: "opaque" });
  const saved = board({ renderOptions: { quality: "medium", background: "transparent" } });
  assert.deepEqual(resolveRenderOptions(saved, "draft"), { quality: "medium", background: "transparent" });
  assert.deepEqual(resolveRenderOptions(saved, "final"), { quality: "high", background: "transparent" });
  assert.deepEqual(resolveRenderOptions(saved, "final", { quality: "xhigh", background: "opaque" }), { quality: "xhigh", background: "opaque" });
  assert.deepEqual(resolveRenderOptions(saved, "final", { quality: "max" }), { quality: "max", background: "transparent" });
});

test("option changes stale new records while historical records stay unchanged", () => {
  const oldPlan = board();
  const historical = { selectionHash: selectionHash(oldPlan), instruction: "", quality: undefined, background: undefined };
  assert.equal(renderRecordIsStale(oldPlan, historical, "draft"), false);
  const changed = board({ renderOptions: { quality: "xhigh", background: "transparent" } });
  assert.equal(renderRecordIsStale(changed, historical, "draft"), true);
  const fresh = { ...historical, quality: "xhigh", background: "transparent", renderOptionsHash: renderOptionsHash({ quality: "xhigh", background: "transparent" }) };
  assert.equal(renderRecordIsStale(changed, fresh, "draft"), false);
});

test("immediate and Batch finalize gates reject changed saved options, honor matching CLI overrides, and preserve old plans", () => {
  const saved = board({ renderOptions: { quality: "xhigh", background: "transparent" } });
  const staleCandidate = {
    status: "ok",
    selectionHash: selectionHash(saved),
    quality: "low",
    background: "opaque",
  };
  // Both direct finalize paths call this shared gate before consuming a
  // candidate; a saved-option change must force a fresh draft.
  assert.equal(candidateIsStaleForFinalize(saved, staleCandidate), true);
  // An explicit CLI selection is the effective option set and can match the
  // reviewed candidate even when the board's saved defaults differ.
  assert.equal(candidateIsStaleForFinalize(saved, staleCandidate, { quality: "low", background: "opaque" }), false);
  const confirmed = {
    ...staleCandidate,
    confirmedAt: "2026-09-08T00:00:00Z",
    draftQuality: "xhigh",
    draftBackground: "transparent",
    quality: "medium",
    background: "transparent",
  };
  assert.equal(candidateIsStaleForFinalize(saved, confirmed), false);
  // A pre-migration plan with no saved options remains compatible; its
  // historical candidate has no new settings to compare.
  const oldPlan = board();
  assert.equal(candidateIsStaleForFinalize(oldPlan, { status: "ok", selectionHash: selectionHash(oldPlan) }), false);
});

test("selectionHash is stable for the same selection and changes with images, notes or instruction", () => {
  const base = selectionHash(board());
  assert.equal(selectionHash(board()), base);
  assert.match(base, /^[0-9a-f]{40}$/);
  const swapped = board();
  swapped.items[0].images = ["E:/lib/other-faucet.png"];
  assert.notEqual(selectionHash(swapped), base);
  const noted = board();
  noted.items[0].note = "no mirroring";
  assert.notEqual(selectionHash(noted), base);
  assert.notEqual(selectionHash(board(), "more breathing room"), base);
  const relabelled = board();
  relabelled.items[0].overriddenAt = "2026-09-07T00:00:00Z";
  relabelled.title = "Renamed";
  assert.equal(selectionHash(relabelled), base);
});

test("boardForRender turns item.note into model notes and pins the board instruction on the hero item", () => {
  const prepared = boardForRender(board(), "more breathing room");
  const faucet = prepared.items.find((item) => item.slotId === "vanity_faucet");
  const tile = prepared.items.find((item) => item.slotId === "main_tile");
  assert.equal(faucet.notes, "Board instruction: more breathing room");
  assert.equal(tile.notes, "keep the terrazzo chips visible");
  assert.equal(board().items[0].notes, "");
});

test("boardForRender joins an existing item note and the instruction on the hero", () => {
  const source = board();
  source.items[0].note = "do not mirror";
  assert.equal(boardForRender(source, "tile lower-left").items[0].notes, "do not mirror Board instruction: tile lower-left");
});

test("buildDraftPayload renders low/standard studio drafts with reference files in item order", () => {
  const { payload, files } = buildDraftPayload(board(), A, { apiKey: "k", instruction: "airy" });
  assert.equal(payload.quality, "low");
  assert.equal(payload.background, "opaque");
  assert.equal(payload.outputResolution, "standard");
  assert.equal(payload.renderKind, "studio");
  assert.equal(payload.layoutReference, undefined);
  assert.equal(payload.apiKey, "k");
  assert.deepEqual(payload.items.map((item) => item.id), ["vanity_faucet", "main_tile"]);
  assert.equal(payload.items[0].notes, "Board instruction: airy");
  assert.deepEqual(files.map((file) => file.name), ["vanity_faucet--faucet.png", "main_tile--tile.png"]);
});

test("buildConfirmPayload is medium quality with the source draft first as the approved-draft layout reference", () => {
  const { payload, files } = buildConfirmPayload(board(), A, "E:/run/boards/b/drafts/d-0001.png", {});
  assert.equal(payload.quality, "medium");
  assert.equal(payload.background, "opaque");
  assert.equal(payload.outputResolution, "standard");
  assert.equal(payload.renderKind, "studio");
  assert.equal(payload.layoutReference, true);
  assert.equal(payload.layoutReferenceMode, "approved-draft");
  assert.deepEqual(files[0], { path: "E:/run/boards/b/drafts/d-0001.png", name: "approved-draft.png" });
  assert.equal(files.length, 3);
});

test("buildFinalPayload is high/final with the source render as layout reference", () => {
  const { payload, files } = buildFinalPayload(board(), A, "E:/run/boards/b/confirmed/c-0001.png", {});
  assert.equal(payload.quality, "high");
  assert.equal(payload.background, "opaque");
  assert.equal(payload.outputResolution, "final");
  assert.equal(payload.renderKind, "final");
  assert.equal(payload.layoutReference, true);
  assert.equal(files[0].name, "approved-draft.png");
});

test("payload builders reject a board the app would refuse", () => {
  assert.throws(() => buildDraftPayload(board({ items: [] }), A), /item/i);
});

test("postGeneration posts multipart with Access headers and returns the JSON body", async (t) => {
  let received;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    received = { url, headers: init.headers, images: init.body.getAll("image[]").length };
    return Response.json({ ok: true, imageBase64: PNG.toString("base64"), mimeType: "image/png", jobId: "job-1" });
  });
  const { runDir } = scratchRun();
  const json = await postGeneration("https://w.example", { collageType: "x" }, [{ path: path.join(runDir, "lib", "faucet.png"), name: "vanity_faucet--faucet.png" }], { accessHeaders: { "cf-access-token": "t" } });
  assert.equal(received.url, "https://w.example/api/generate");
  assert.equal(received.headers["cf-access-token"], "t");
  assert.equal(received.images, 1);
  assert.equal(json.jobId, "job-1");
  assert.equal(json.resizedReferenceCount, 0);
  rmSync(runDir, { recursive: true, force: true });
});

test("postGeneration turns an Access 302/403 into AccessError and surfaces Worker error fields", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("", { status: 302 }));
  await assert.rejects(postGeneration("https://w.example", {}, []), (error) => error instanceof AccessError && error.code === "access-rejected");
  t.mock.method(globalThis, "fetch", async () => Response.json({ ok: false, error: "Busy", code: "rate_limited", retryAfterMs: 120000, diagnostics: { attempts: [] } }, { status: 429 }));
  await assert.rejects(postGeneration("https://w.example", {}, []), (error) => error.status === 429 && error.retryAfterMs === 120000 && error.code === "rate_limited" && Array.isArray(error.diagnostics.attempts));
});

test("postGeneration honours an AbortSignal", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url, init) => { init.signal.throwIfAborted(); return Response.json({ ok: true }); });
  await assert.rejects(postGeneration("https://w.example", {}, [], { signal: AbortSignal.abort() }), (error) => error.name === "AbortError");
});

test("Batch reference uploads preserve structured failure diagnostics without retrying", async (t) => {
  const { runDir } = scratchRun();
  const filePath = path.join(runDir, "lib", "faucet.png");
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json({
      ok: false,
      error: "Busy",
      code: "rate_limited",
      retryAfterMs: 120000,
      diagnostics: { attempts: [{ stage: "upload", outcome: "ambiguous" }] },
    }, { status: 429 });
  });
  await assert.rejects(
    uploadFileToOpenAI("https://w.example", {}, filePath, "test-key"),
    (error) => error.status === 429 && error.code === "rate_limited" && error.retryAfterMs === 120000 && error.diagnostics.attempts.length === 1,
  );
  assert.equal(calls, 1);
  rmSync(runDir, { recursive: true, force: true });
});

test("ensureRenders creates the per-board record once and nextRenderId zero-pads per kind", () => {
  const results = { candidates: {}, finals: {} };
  const renders = ensureRenders(results, "b");
  assert.deepEqual(renders, { instruction: "", pickedDraftId: null, approvedConfirmedId: null, drafts: [], confirmed: [], finals: [] });
  assert.equal(ensureRenders(results, "b"), renders);
  assert.equal(nextRenderId(renders, "d"), "d-0001");
  renders.drafts.push({ id: "d-0001" }, { id: "d-0002" });
  assert.equal(nextRenderId(renders, "d"), "d-0003");
  assert.equal(nextRenderId(renders, "c"), "c-0001");
});

test("saveRenderImage writes under boards/<board>/<kind dir> and returns a run-relative forward-slash path", async () => {
  const { runDir } = scratchRun();
  assert.equal(await saveRenderImage(runDir, "b", "draft", "d-0001", PNG.toString("base64")), "boards/b/drafts/d-0001.png");
  assert.ok(existsSync(path.join(runDir, "boards", "b", "drafts", "d-0001.png")));
  assert.equal(await saveRenderImage(runDir, "b", "confirm", "c-0001", PNG.toString("base64")), "boards/b/confirmed/c-0001.png");
  assert.equal(await saveRenderImage(runDir, "b", "final", "f-0001", PNG.toString("base64")), "boards/b/finals/f-0001.png");
  rmSync(runDir, { recursive: true, force: true });
});

test("recordDraft bumps the revision only when the selection hash changes", () => {
  const results = { candidates: {}, finals: {} };
  const rec = (variant, hash, index) => recordDraft(results, "b", { variant, index, path: "p", jobId: "j", durationMs: 1, selectionHash: hash, instruction: "", itemNotes: {} });
  const first = rec("A", "h1", 1);
  const second = rec("A", "h1", 2);
  const third = rec("B", "h2", 1);
  assert.equal(first.id, "d-0001");
  assert.equal(first.revision, 1);
  assert.equal(second.revision, 1);
  assert.equal(third.revision, 2);
  assert.ok(third.createdAt);
});

test("pickDraft mirrors the draft into the legacy candidate and copies the PNG to boards/<board>/<variant>.png", async () => {
  const { runDir, results } = scratchRun();
  const boardId = "penthouse-bath-2-fixture";
  const rel = await saveRenderImage(runDir, boardId, "draft", "d-0001", PNG.toString("base64"));
  recordDraft(results, boardId, { variant: "A", index: 1, path: rel, jobId: "j1", durationMs: 1, selectionHash: "h", instruction: "", itemNotes: {} });
  const picked = pickDraft(results, runDir, boardId, "d-0001", { appliedNotes: { main_tile: "x" } });
  assert.equal(picked.id, "d-0001");
  assert.equal(results.renders[boardId].pickedDraftId, "d-0001");
  const candidate = results.candidates[`${boardId}--A`];
  assert.equal(candidate.status, "ok");
  assert.equal(candidate.renderKind, "studio");
  assert.equal(candidate.jobId, "j1");
  assert.deepEqual(candidate.appliedNotes, { main_tile: "x" });
  assert.equal(candidate.savedPath, path.join(runDir, "boards", boardId, "A.png"));
  assert.ok(existsSync(candidate.savedPath));
  assert.throws(() => pickDraft(results, runDir, boardId, "d-9999"), (error) => error.status === 404);
  rmSync(runDir, { recursive: true, force: true });
});

test("removeRender deletes the file and record, and unpicks/unapproves if it was the current pick or approval", async () => {
  const { runDir, results } = scratchRun();
  const boardId = "penthouse-bath-2-fixture";
  const draftRel = await saveRenderImage(runDir, boardId, "draft", "d-0001", PNG.toString("base64"));
  recordDraft(results, boardId, { variant: "A", index: 1, path: draftRel, jobId: "j1", durationMs: 1, selectionHash: "h", instruction: "", itemNotes: {} });
  pickDraft(results, runDir, boardId, "d-0001");
  const confirmRel = await saveRenderImage(runDir, boardId, "confirm", "c-0001", PNG.toString("base64"));
  recordConfirmed(results, boardId, { variant: "A", fromDraftId: "d-0001", path: confirmRel, jobId: "j2", durationMs: 1, selectionHash: "h", instruction: "", itemNotes: {} });
  approveConfirmed(results, boardId, "c-0001");

  const draftPath = path.join(runDir, draftRel);
  assert.ok(existsSync(draftPath));
  const removedDraft = await removeRender(results, runDir, boardId, "draft", "d-0001");
  assert.equal(removedDraft.id, "d-0001");
  assert.equal(existsSync(draftPath), false);
  assert.equal(results.renders[boardId].drafts.length, 0);
  assert.equal(results.renders[boardId].pickedDraftId, null);
  assert.equal(results.candidates[`${boardId}--A`], undefined);

  const confirmPath = path.join(runDir, confirmRel);
  await removeRender(results, runDir, boardId, "confirm", "c-0001");
  assert.equal(existsSync(confirmPath), false);
  assert.equal(results.renders[boardId].confirmed.length, 0);
  assert.equal(results.renders[boardId].approvedConfirmedId, null);

  await assert.rejects(removeRender(results, runDir, boardId, "draft", "d-9999"), (error) => error.status === 404);
  await assert.rejects(removeRender(results, runDir, boardId, "bogus", "x"), (error) => error.status === 400);
  rmSync(runDir, { recursive: true, force: true });
});

test("removeRender tolerates a render file that's already gone from disk", async () => {
  const { runDir, results } = scratchRun();
  const boardId = "penthouse-bath-2-fixture";
  const rel = await saveRenderImage(runDir, boardId, "draft", "d-0001", PNG.toString("base64"));
  recordDraft(results, boardId, { variant: "A", index: 1, path: rel, jobId: "j1", durationMs: 1, selectionHash: "h", instruction: "", itemNotes: {} });
  rmSync(path.join(runDir, rel));
  const removed = await removeRender(results, runDir, boardId, "draft", "d-0001");
  assert.equal(removed.id, "d-0001");
  rmSync(runDir, { recursive: true, force: true });
});

test("resetNonFinalRenders clears every draft and confirmed render but keeps finals, and reports counts removed", async () => {
  const { runDir, results } = scratchRun();
  const boardId = "penthouse-bath-2-fixture";
  const draftRel = await saveRenderImage(runDir, boardId, "draft", "d-0001", PNG.toString("base64"));
  recordDraft(results, boardId, { variant: "A", index: 1, path: draftRel, jobId: "j1", durationMs: 1, selectionHash: "h", instruction: "", itemNotes: {} });
  pickDraft(results, runDir, boardId, "d-0001");
  const confirmRel = await saveRenderImage(runDir, boardId, "confirm", "c-0001", PNG.toString("base64"));
  recordConfirmed(results, boardId, { variant: "A", fromDraftId: "d-0001", path: confirmRel, jobId: "j2", durationMs: 1, selectionHash: "h", instruction: "", itemNotes: {} });
  approveConfirmed(results, boardId, "c-0001");
  const finalRel = await saveRenderImage(runDir, boardId, "final", "f-0001", PNG.toString("base64"));
  recordFinal(results, boardId, { variant: "A", fromRenderId: "c-0001", path: finalRel, jobId: "j3", durationMs: 1, selectionHash: "h", instruction: "", itemNotes: {} });

  const removed = await resetNonFinalRenders(results, runDir, boardId);
  assert.deepEqual(removed, { drafts: 1, confirmed: 1 });
  assert.equal(existsSync(path.join(runDir, draftRel)), false);
  assert.equal(existsSync(path.join(runDir, confirmRel)), false);
  assert.equal(existsSync(path.join(runDir, finalRel)), true);
  const record = results.renders[boardId];
  assert.deepEqual(record.drafts, []);
  assert.deepEqual(record.confirmed, []);
  assert.equal(record.pickedDraftId, null);
  assert.equal(record.approvedConfirmedId, null);
  assert.equal(record.finals.length, 1);
  assert.equal(results.candidates[`${boardId}--A`], undefined);
  rmSync(runDir, { recursive: true, force: true });
});

test("renderSource prefers an approved confirmed render over the picked draft", () => {
  const results = { candidates: {}, finals: {} };
  assert.equal(renderSource(results, "b"), null);
  recordDraft(results, "b", { variant: "A", index: 1, path: "p1", jobId: "j", durationMs: 1, selectionHash: "h", instruction: "", itemNotes: {} });
  ensureRenders(results, "b").pickedDraftId = "d-0001";
  assert.equal(renderSource(results, "b").kind, "draft");
  recordConfirmed(results, "b", { variant: "A", fromDraftId: "d-0001", path: "p2", jobId: "j2", durationMs: 1, selectionHash: "h", instruction: "", itemNotes: {} });
  approveConfirmed(results, "b", "c-0001");
  assert.equal(renderSource(results, "b").kind, "confirm");
  approveConfirmed(results, "b", null);
  assert.equal(renderSource(results, "b").kind, "draft");
  assert.throws(() => approveConfirmed(results, "b", "c-0042"), (error) => error.status === 404);
});

test("renderSource with kind \"confirm\" always uses the picked draft, even after a confirmed render is approved", () => {
  const results = { candidates: {}, finals: {} };
  recordDraft(results, "b", { variant: "A", index: 1, path: "p1", jobId: "j", durationMs: 1, selectionHash: "h", instruction: "", itemNotes: {} });
  ensureRenders(results, "b").pickedDraftId = "d-0001";
  recordConfirmed(results, "b", { variant: "A", fromDraftId: "d-0001", path: "p2", jobId: "j2", durationMs: 1, selectionHash: "h", instruction: "", itemNotes: {} });
  approveConfirmed(results, "b", "c-0001");
  const confirmSource = renderSource(results, "b", "confirm");
  assert.equal(confirmSource.kind, "draft");
  assert.equal(confirmSource.record.id, "d-0001");
  // Final, unaffected, still prefers the approved confirmed render.
  assert.equal(renderSource(results, "b", "final").kind, "confirm");
});

test("runRenderJob renders N drafts sequentially, reporting progress and recording each as it lands", async (t) => {
  const { runDir, plan, results } = scratchRun();
  const boardId = plan.boards[0].id;
  const qualities = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    qualities.push(JSON.parse(init.body.get("payload")).quality);
    return Response.json({ ok: true, imageBase64: PNG.toString("base64"), mimeType: "image/png", jobId: `job-${qualities.length}` });
  });
  const progress = [];
  let persisted = 0;
  await runRenderJob(
    { jobId: "q1", boardId, kind: "draft", variant: "A", count: 2, instructionSnapshot: "airy", selectionHash: "h" },
    { plan, results, runDir, baseUrl: "https://w.example", accessHeaders: {}, apiKey: undefined, signal: new AbortController().signal, onProgress: (text) => progress.push(text), persist: async () => { persisted++; } },
  );
  assert.deepEqual(qualities, ["low", "low"]);
  assert.deepEqual(progress, ["1/2", "2/2"]);
  assert.equal(results.renders[boardId].drafts.length, 2);
  assert.equal(results.renders[boardId].drafts[1].instruction, "airy");
  assert.equal(persisted, 2);
  rmSync(runDir, { recursive: true, force: true });
});

test("runRenderJob carries selected quality/background and completed usage metadata", async (t) => {
  const { runDir, plan, results } = scratchRun();
  const boardId = plan.boards[0].id;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const payload = JSON.parse(init.body.get("payload"));
    assert.equal(payload.quality, "xhigh");
    assert.equal(payload.background, "transparent");
    return Response.json({
      ok: true,
      imageBase64: PNG.toString("base64"),
      mimeType: "image/png",
      model: "gpt-image-2.5-sunburst",
      usage: { input_tokens: 1000, input_tokens_details: { image_tokens: 200, text_tokens: 800 }, output_tokens: 300 },
      jobId: "job-options",
    });
  });
  await runRenderJob({
    jobId: "q-options", boardId, kind: "draft", variant: "A", count: 1,
    renderOptionsSnapshot: { quality: "xhigh", background: "transparent" },
  }, {
    plan, results, runDir, baseUrl: "https://w.example", accessHeaders: {}, apiKey: undefined,
    signal: new AbortController().signal, onProgress: () => {}, persist: async () => {},
  });
  const record = results.renders[boardId].drafts[0];
  assert.equal(record.model, "gpt-image-2.5-sunburst");
  assert.equal(record.quality, "xhigh");
  assert.equal(record.background, "transparent");
  assert.equal(record.outputFormat, "png");
  assert.deepEqual(record.usage.input_tokens_details, { image_tokens: 200, text_tokens: 800 });
  assert.equal(typeof record.costUsd, "number");
  rmSync(runDir, { recursive: true, force: true });
});

test("draft then confirm preserves source draft options for immediate and Batch finalize gates", async (t) => {
  const { runDir, plan, results } = scratchRun();
  const boardId = plan.boards[0].id;
  const currentBoard = plan.boards[0];
  currentBoard.renderOptions = { background: "transparent" };
  let requestCount = 0;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const payload = JSON.parse(init.body.get("payload"));
    requestCount++;
    assert.equal(payload.background, "transparent");
    assert.equal(payload.quality, requestCount === 1 ? "low" : "medium");
    return Response.json({ ok: true, imageBase64: PNG.toString("base64"), mimeType: "image/png", jobId: `job-stage-${requestCount}` });
  });
  const ctx = {
    plan, results, runDir, baseUrl: "https://w.example", accessHeaders: {}, apiKey: undefined,
    signal: new AbortController().signal, onProgress: () => {}, persist: async () => {},
  };
  await runRenderJob({ jobId: "q-draft", boardId, kind: "draft", variant: "A", count: 1 }, ctx);
  pickDraft(results, runDir, boardId, "d-0001");
  await runRenderJob({ jobId: "q-confirm", boardId, kind: "confirm" }, ctx);
  const candidate = results.candidates[`${boardId}--A`];
  assert.equal(candidate.quality, "medium");
  assert.equal(candidate.background, "transparent");
  assert.equal(candidate.draftQuality, "low");
  assert.equal(candidate.draftBackground, "transparent");
  for (const mode of ["finalize", "batch-finalize"]) {
    assert.equal(candidateIsStaleForFinalize(currentBoard, candidate), false, `${mode} should accept the reviewed source`);
  }
  rmSync(runDir, { recursive: true, force: true });
});

test("runRenderJob confirm and final use the current source render and mirror into the legacy records", async (t) => {
  const { runDir, plan, results } = scratchRun();
  const boardId = plan.boards[0].id;
  const rel = await saveRenderImage(runDir, boardId, "draft", "d-0001", PNG.toString("base64"));
  recordDraft(results, boardId, { variant: "A", index: 1, path: rel, jobId: "j1", durationMs: 1, selectionHash: "h", instruction: "", itemNotes: {} });
  pickDraft(results, runDir, boardId, "d-0001");
  const seen = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const payload = JSON.parse(init.body.get("payload"));
    seen.push([payload.quality, payload.renderKind, init.body.getAll("image[]")[0].name]);
    return Response.json({ ok: true, imageBase64: PNG.toString("base64"), mimeType: "image/png", jobId: `job-${seen.length}`, libraryVisible: payload.renderKind === "final" });
  });
  const ctx = { plan, results, runDir, baseUrl: "https://w.example", accessHeaders: {}, signal: new AbortController().signal, onProgress: () => {}, persist: async () => {} };
  await runRenderJob({ jobId: "q2", boardId, kind: "confirm", instructionSnapshot: "", selectionHash: "h" }, ctx);
  assert.equal(results.renders[boardId].confirmed.length, 1);
  assert.ok(results.candidates[`${boardId}--A`].confirmedAt);
  approveConfirmed(results, boardId, "c-0001");
  // Fix 5: a record's selectionHash now reflects the board state actually
  // rendered (computed fresh in runRenderJob), not job.selectionHash at
  // enqueue time — so the confirmed record above was saved with the real
  // hash of this board/instruction, not the fixture "h" used above. The
  // Final job's own selectionHash must match that real state to pass the
  // pre-check (job.selectionHash still models "board state when clicked").
  await runRenderJob({ jobId: "q3", boardId, kind: "final", instructionSnapshot: "", selectionHash: selectionHash(plan.boards[0], "") }, ctx);
  assert.deepEqual(seen, [["medium", "studio", "approved-draft.png"], ["high", "final", "approved-draft.png"]]);
  assert.equal(results.renders[boardId].finals[0].fromRenderId, "c-0001");
  assert.equal(results.renders[boardId].finals[0].libraryJobId, "job-2");
  assert.equal(results.finals[`${boardId}--A`].jobId, "job-2");
  rmSync(runDir, { recursive: true, force: true });
});

test("runRenderJob rejects confirm/final without a source and final with a stale source", async () => {
  const { runDir, plan, results } = scratchRun();
  const boardId = plan.boards[0].id;
  const ctx = { plan, results, runDir, baseUrl: "https://w.example", accessHeaders: {}, signal: new AbortController().signal, onProgress: () => {}, persist: async () => {} };
  await assert.rejects(runRenderJob({ jobId: "q", boardId, kind: "confirm", selectionHash: "h" }, ctx), /pick a draft/i);
  recordDraft(results, boardId, { variant: "A", index: 1, path: "x", jobId: "j", durationMs: 1, selectionHash: "old", instruction: "", itemNotes: {} });
  ensureRenders(results, boardId).pickedDraftId = "d-0001";
  await assert.rejects(runRenderJob({ jobId: "q", boardId, kind: "final", selectionHash: "new" }, ctx), /stale/i);
  rmSync(runDir, { recursive: true, force: true });
});

test("runRenderJob renders a stale final anyway when job.force is true", async (t) => {
  const { runDir, plan, results } = scratchRun();
  const boardId = plan.boards[0].id;
  const rel = await saveRenderImage(runDir, boardId, "draft", "d-0001", PNG.toString("base64"));
  recordDraft(results, boardId, { variant: "A", index: 1, path: rel, jobId: "j", durationMs: 1, selectionHash: "old", instruction: "", itemNotes: {} });
  ensureRenders(results, boardId).pickedDraftId = "d-0001";
  t.mock.method(globalThis, "fetch", async () => Response.json({ ok: true, imageBase64: PNG.toString("base64"), mimeType: "image/png", jobId: "job-force", libraryVisible: true }));
  const ctx = { plan, results, runDir, baseUrl: "https://w.example", accessHeaders: {}, signal: new AbortController().signal, onProgress: () => {}, persist: async () => {} };
  // Without force, the same stale source still rejects.
  await assert.rejects(runRenderJob({ jobId: "q1", boardId, kind: "final", selectionHash: "new" }, ctx), /stale/i);
  // With force:true, the stale source renders anyway.
  await runRenderJob({ jobId: "q2", boardId, kind: "final", selectionHash: "new", force: true }, ctx);
  assert.equal(results.renders[boardId].finals.length, 1);
  assert.equal(results.finals[`${boardId}--A`].jobId, "job-force");
  rmSync(runDir, { recursive: true, force: true });
});
