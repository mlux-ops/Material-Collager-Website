// scripts/autoboard/lib/render.mjs
// The render pipeline shared by the CLI (generate/redraft/confirm/finalize)
// and the review server's render queue: build the exact payload the app's
// /api/generate expects, post it, save the PNG, record the result.

import { createHash } from "node:crypto";
import sharp from "sharp";
import { copyFileSync, mkdirSync } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolvedSize, validateCollageRequest } from "../../../app/lib/collage.ts";
import {
  estimateOutputUsd,
  outputTokensFromUsage,
  recordOutputTokens,
} from "../../../app/lib/output-tokens.ts";
import { calculateSunburstUsageCost, SUNBURST_MODEL } from "../../../app/lib/sunburst.ts";
import { AccessError, accessLoginHint, isAccessRejection } from "./access.mjs";
import { isStaleCandidate } from "./review-core.mjs";
import { prepareReferenceForUpload } from "./transport.mjs";
import { boardPayload, boardReferenceFiles, modelNotes, orderedBoardItems } from "./variants.mjs";

// Sunburst usage is returned by the Worker after a request completes. There is
// still no pre-render estimate of the TOTAL: image input dominates the bill and
// depends on the reference set's tile coverage, which is not known here. Output
// tokens, though, are exactly deterministic per (model, size, quality) and are
// learned from completed renders -- see app/lib/output-tokens.ts.
export const COST_PER_IMAGE = Object.freeze({ draft: null, confirm: null, final: null });

export function estimateCost(kind, count = 1) {
  if (!(kind in COST_PER_IMAGE)) throw new Error(`Unknown render kind "${kind}".`);
  void count;
  return null;
}

export function formatCost(amount) {
  void amount;
  return "cost unavailable until completion";
}

// The size a given stage renders at, mirroring what buildDraftPayload,
// buildConfirmPayload and buildFinalPayload produce, so a lookup keys on the
// same string the render will actually report.
export function stageSize(kind) {
  return resolvedSize({
    orientation: "default",
    outputResolution: kind === "final" ? "final" : "standard",
    renderKind: kind === "final" ? "final" : "studio",
  });
}

/**
 * One-time repair for renders written before `size` was recorded.
 *
 * The saved PNG is exactly the size that was requested -- OpenAI returns the
 * requested dimensions -- so the missing key part is recoverable from the file
 * without spending anything. Additive and idempotent: a record that already
 * has a size, or whose file is gone, is left alone. Returns how many records
 * were repaired so the caller can decide whether to persist.
 */
export async function backfillRenderSizes(results, runDir) {
  let repaired = 0;
  for (const renders of Object.values(results?.renders ?? {})) {
    for (const list of ["drafts", "confirmed", "finals"]) {
      for (const record of renders?.[list] ?? []) {
        if (record?.size || !record?.path) continue;
        try {
          const { width, height } = await sharp(path.join(runDir, record.path)).metadata();
          if (!width || !height) continue;
          record.size = `${width}x${height}`;
          repaired++;
        } catch {
          // Deleted or unreadable render: nothing to recover, and not an error.
        }
      }
    }
  }
  return repaired;
}

/**
 * Build the learned output-token table from everything this run has rendered.
 *
 * Purely passive: records written before size was captured simply contribute
 * nothing, and each new render adds its combination.
 */
export function outputTokenTableFrom(results) {
  const table = {};
  for (const renders of Object.values(results?.renders ?? {})) {
    for (const list of ["drafts", "confirmed", "finals"]) {
      for (const record of renders?.[list] ?? []) {
        recordOutputTokens(table, {
          model: record?.model,
          size: record?.size,
          quality: record?.quality,
          outputTokens: outputTokensFromUsage(record?.usage),
        });
      }
    }
  }
  return table;
}

/**
 * Output-token cost for a planned stage render, or null when that combination
 * has never been rendered. Output only -- never present it as a total.
 */
export function estimateStageOutputUsd(results, board, kind, count = 1) {
  const { quality } = resolveRenderOptions(board, kind);
  return estimateOutputUsd(outputTokenTableFrom(results), {
    model: SUNBURST_MODEL,
    size: stageSize(kind),
    quality,
    count,
  });
}

export const SUNBURST_QUALITY_OPTIONS = ["low", "medium", "high", "xhigh", "max", "auto"];
export const SUNBURST_BACKGROUND_OPTIONS = ["opaque", "transparent"];
const DEFAULT_STAGE_QUALITY = { draft: "low", confirm: "medium", final: "high" };

function validQuality(value) {
  return typeof value === "string" && SUNBURST_QUALITY_OPTIONS.includes(value) ? value : undefined;
}

function validBackground(value) {
  return typeof value === "string" && SUNBURST_BACKGROUND_OPTIONS.includes(value) ? value : undefined;
}

// Saved options are intentionally sparse. A plan written before the options
// UI has no renderOptions field and therefore remains opaque, with the stage's
// historical quality default. Reading this helper never mutates that plan.
export function savedRenderOptions(board) {
  const saved = board?.renderOptions && typeof board.renderOptions === "object" ? board.renderOptions : {};
  return {
    quality: validQuality(saved.quality),
    background: validBackground(saved.background) ?? "opaque",
  };
}

// Explicit command/panel overrides win over a saved board option, which wins
// over the established draft/confirm/final default. Finals retain the Task 1
// minimum of high: low, medium, and auto are upgraded while xhigh/max remain
// explicit choices.
export function resolveRenderOptions(board, kind, overrides = {}) {
  const saved = savedRenderOptions(board);
  const stageDefault = DEFAULT_STAGE_QUALITY[kind];
  if (!stageDefault) throw new Error(`Unknown render kind "${kind}".`);
  const requestedQuality = validQuality(overrides.quality) ?? saved.quality ?? stageDefault;
  const quality = kind === "final" && ["low", "medium", "auto"].includes(requestedQuality)
    ? "high"
    : requestedQuality;
  return {
    quality,
    background: validBackground(overrides.background) ?? saved.background,
  };
}

export function renderOptionsHash(options) {
  return createHash("sha1").update(JSON.stringify({ quality: options.quality, background: options.background })).digest("hex");
}

function actualCost(json) {
  if (typeof json?.costUsd === "number" && Number.isFinite(json.costUsd) && json.costUsd >= 0) return json.costUsd;
  return calculateSunburstUsageCost(json?.usage);
}

export function recordMetadata(payload, json) {
  const options = { quality: payload.quality, background: payload.background ?? "opaque" };
  return {
    model: json?.model ?? SUNBURST_MODEL,
    // Recorded so the learned output-token table can key on it. Derived from
    // the payload rather than the response, which does not report a size.
    size: resolvedSize(payload),
    quality: options.quality,
    background: options.background,
    outputFormat: json?.outputFormat ?? "png",
    usage: json?.usage ?? null,
    costUsd: actualCost(json),
    renderOptionsHash: renderOptionsHash(options),
  };
}

export function renderRecordIsStale(board, record, kind, instruction = "") {
  if (!record) return true;
  if (record.selectionHash !== selectionHash(board, instruction)) return true;
  // Historical records predate renderOptionsHash. Keep them unchanged and
  // compatible while marking them stale as soon as a board explicitly gains
  // saved options.
  if (record.renderOptionsHash || board?.renderOptions) {
    const current = resolveRenderOptions(board, kind);
    if (record.renderOptionsHash !== renderOptionsHash(current)) return true;
  }
  return false;
}

// Direct CLI finalize and batch-finalize share the same review gate. When a
// plan has saved render options (or the operator supplies an explicit CLI
// override), compare the candidate's effective draft settings before either
// path consumes its source. Plans and candidates predating render metadata
// remain compatible when no option selection is in force.
export function candidateIsStaleForFinalize(board, candidate, overrides = {}) {
  if (!candidate) return true;
  const hasExplicitOptionSelection = overrides.quality !== undefined || overrides.background !== undefined;
  if (!board?.renderOptions && !hasExplicitOptionSelection) return false;
  const draftRenderOptions = resolveRenderOptions(board, "draft", overrides);
  const draftCandidate = {
    ...candidate,
    quality: candidate.draftQuality ?? (candidate.confirmedAt ? undefined : candidate.quality),
    background: candidate.draftBackground ?? (candidate.confirmedAt ? undefined : candidate.background),
  };
  return isStaleCandidate(board, draftCandidate, draftRenderOptions);
}

// Hash of everything the model actually sees for this board: which images
// fill each slot, each slot's note, and the board instruction. Used for
// stale detection and revision bumps. Bookkeeping fields (overriddenAt,
// title, provenance, imageMeta) deliberately excluded.
export function selectionHash(board, instruction = "") {
  const material = {
    instruction: String(instruction ?? "").trim(),
    // item.notes goes through modelNotes so an edit to a legacy provenance
    // sentence it strips anyway (see modelNotes/LEGACY_NOTE_PATTERNS in
    // variants.mjs) doesn't mark an otherwise-unchanged draft stale.
    items: orderedBoardItems(board).map((item) => [item.slotId, item.images ?? [], modelNotes(item.notes) ?? "", String(item.note ?? "").trim()]),
  };
  return createHash("sha1").update(JSON.stringify(material)).digest("hex");
}

// The collage request has no board-level notes field (app/lib/collage.ts),
// only per-item notes, so the board instruction rides on the hero item —
// the first item in payload order — prefixed so the model can tell it apart
// from that item's own note. Returns a copy; never mutates the plan board.
export function boardForRender(board, instruction = "") {
  const heroSlotId = orderedBoardItems(board)[0]?.slotId;
  const cleanInstruction = String(instruction ?? "").trim();
  return {
    ...board,
    items: board.items.map((item) => {
      const parts = [modelNotes(item.notes) ?? "", String(item.note ?? "").trim()];
      if (cleanInstruction && item.slotId === heroSlotId) parts.push(`Board instruction: ${cleanInstruction}`);
      return { ...item, notes: parts.filter(Boolean).join(" ") };
    }),
  };
}

function finish(payload, files) {
  validateCollageRequest(payload);
  return { payload, files };
}

export function buildDraftPayload(board, variant, { apiKey, instruction, quality = "low", background = "opaque", outputResolution = "standard" } = {}) {
  const prepared = boardForRender(board, instruction);
  return finish(boardPayload(prepared, variant, { quality, background, outputResolution, renderKind: "studio", apiKey }), boardReferenceFiles(prepared));
}

// The source render must be the FIRST multipart image; product references
// follow in item order (see app/api/generate/route.ts).
export function buildConfirmPayload(board, variant, sourcePath, { apiKey, instruction, quality = "medium", background = "opaque", outputResolution = "standard" } = {}) {
  const prepared = boardForRender(board, instruction);
  const payload = boardPayload(prepared, variant, { quality, background, outputResolution, renderKind: "studio", layoutReference: true, apiKey });
  return finish(payload, [{ path: sourcePath, name: "approved-draft.png" }, ...boardReferenceFiles(prepared)]);
}

export function buildFinalPayload(board, variant, sourcePath, { apiKey, instruction, quality = "high", background = "opaque" } = {}) {
  const prepared = boardForRender(board, instruction);
  const payload = boardPayload(prepared, variant, { quality, background, outputResolution: "final", renderKind: "final", layoutReference: true, apiKey });
  return finish(payload, [{ path: sourcePath, name: "approved-draft.png" }, ...boardReferenceFiles(prepared)]);
}

// ---------------------------------------------------------------------------
// Worker call. Library photos run 8 KB-3.7 MB / up to 4000 px, while the
// app's own browser upload path caps the long edge at 2048 — bring this path
// to parity instead of shipping raw bytes (transport.mjs).
// ---------------------------------------------------------------------------

export async function postGeneration(baseUrl, payload, files, { accessHeaders = {}, signal } = {}) {
  const form = new FormData();
  form.append("payload", JSON.stringify(payload));
  let resizedReferenceCount = 0;
  for (const file of files) {
    signal?.throwIfAborted();
    const prepared = await prepareReferenceForUpload(file.path);
    if (prepared.resized) resizedReferenceCount++;
    // Only the extension may change — the caller's "slotId--basename" stem is preserved.
    const stem = file.name.slice(0, file.name.length - path.extname(file.name).length);
    form.append("image[]", new Blob([prepared.bytes], { type: prepared.mime }), `${stem}${path.extname(prepared.filename)}`);
  }
  const response = await fetch(`${baseUrl}/api/generate`, { method: "POST", body: form, headers: accessHeaders, redirect: "manual", signal });
  if (isAccessRejection(response.status)) {
    throw new AccessError(
      `Cloudflare Access rejected the render request (HTTP ${response.status}) — the session may have expired. ${accessLoginHint(baseUrl)}`,
      "access-rejected",
      response.status,
    );
  }
  let json;
  try {
    json = await response.json();
  } catch {
    throw Object.assign(new Error(`Non-JSON response (HTTP ${response.status}) from ${baseUrl}/api/generate`), { status: response.status });
  }
  if (!response.ok || !json.ok) {
    throw Object.assign(new Error(json.error ?? json.message ?? `HTTP ${response.status}`), {
      status: response.status,
      code: json.code,
      retryAfterMs: typeof json.retryAfterMs === "number" ? json.retryAfterMs : undefined,
      diagnostics: json.diagnostics,
    });
  }
  json.resizedReferenceCount = resizedReferenceCount;
  return json;
}

// ---------------------------------------------------------------------------
// results.json `renders` records
// ---------------------------------------------------------------------------

export function ensureRenders(results, boardId) {
  results.renders ??= {};
  results.renders[boardId] ??= { instruction: "", pickedDraftId: null, approvedConfirmedId: null, drafts: [], confirmed: [], finals: [] };
  return results.renders[boardId];
}

const LIST_FOR_PREFIX = { d: "drafts", c: "confirmed", f: "finals" };
const DIR_FOR_KIND = { draft: "drafts", confirm: "confirmed", final: "finals" };

export function nextRenderId(renders, prefix) {
  return `${prefix}-${String(renders[LIST_FOR_PREFIX[prefix]].length + 1).padStart(4, "0")}`;
}

export function renderFilePath(runDir, boardId, kind, id) {
  return path.join(runDir, "boards", boardId, DIR_FOR_KIND[kind], `${id}.png`);
}

export async function saveRenderImage(runDir, boardId, kind, id, imageBase64) {
  const filePath = renderFilePath(runDir, boardId, kind, id);
  mkdirSync(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, Buffer.from(imageBase64, "base64"));
  return path.relative(runDir, filePath).split(path.sep).join("/");
}

function currentRevision(renders, hash) {
  const latest = renders.drafts.at(-1);
  if (!latest) return 1;
  return latest.selectionHash === hash ? latest.revision : latest.revision + 1;
}

// `record.id`, when given (see runRenderJob, which computes the id once to
// name the saved image file and passes that same id through here), is used
// verbatim instead of computing a second one — nextRenderId is only called
// as a fallback for callers (tests, mainly) that don't pass an id.
export function recordDraft(results, boardId, record) {
  const renders = ensureRenders(results, boardId);
  const draft = { revision: currentRevision(renders, record.selectionHash), createdAt: new Date().toISOString(), ...record, id: record.id ?? nextRenderId(renders, "d") };
  renders.drafts.push(draft);
  return draft;
}

export function recordConfirmed(results, boardId, record) {
  const renders = ensureRenders(results, boardId);
  const confirmed = { createdAt: new Date().toISOString(), ...record, id: record.id ?? nextRenderId(renders, "c") };
  renders.confirmed.push(confirmed);
  return confirmed;
}

export function recordFinal(results, boardId, record) {
  const renders = ensureRenders(results, boardId);
  const final = { createdAt: new Date().toISOString(), ...record, id: record.id ?? nextRenderId(renders, "f") };
  renders.finals.push(final);
  return final;
}

function findRender(renders, list, id) {
  const record = renders[list].find((entry) => entry.id === id);
  if (!record) throw Object.assign(new Error(`No ${list} render "${id}".`), { status: 404 });
  return record;
}

// Picking mirrors the draft into the legacy candidate slot and the legacy
// file name so the CLI's confirm/finalize keep working on the same picture.
// `appliedNotes` defaults to the draft's own recorded `itemNotes` — the
// per-item notes actually baked into THIS render at execute time (see
// runRenderJob's itemNotesOf) — not whatever the legacy notes.json file
// happens to hold right now. Pass an explicit `appliedNotes` to override.
export function pickDraft(results, runDir, boardId, draftId, { appliedNotes } = {}) {
  const renders = ensureRenders(results, boardId);
  const draft = findRender(renders, "drafts", draftId);
  const notes = appliedNotes ?? draft.itemNotes ?? {};
  renders.pickedDraftId = draftId;
  const legacyPath = path.join(runDir, "boards", boardId, `${draft.variant}.png`);
  const source = path.join(runDir, draft.path);
  if (source !== legacyPath) {
    mkdirSync(path.dirname(legacyPath), { recursive: true });
    copyFileSync(source, legacyPath);
  }
  results.candidates ??= {};
  const key = `${boardId}--${draft.variant}`;
  results.candidates[key] = {
    ...(results.candidates[key] ?? {}),
    status: "ok",
    savedPath: legacyPath,
    mimeType: "image/png",
    jobId: draft.jobId ?? null,
    renderKind: "studio",
    revision: draft.revision,
    appliedNotes: notes,
    completedAt: draft.createdAt,
    durationMs: draft.durationMs,
    pickedDraftId: draftId,
    model: draft.model ?? null,
    quality: draft.quality ?? null,
    background: draft.background ?? "opaque",
    draftQuality: draft.quality ?? null,
    draftBackground: draft.background ?? "opaque",
    outputFormat: draft.outputFormat ?? draft.mimeType?.replace(/^image\//, "") ?? "png",
    usage: draft.usage ?? null,
    costUsd: draft.costUsd ?? null,
    renderOptionsHash: draft.renderOptionsHash ?? null,
  };
  return draft;
}

export function approveConfirmed(results, boardId, confirmedId) {
  const renders = ensureRenders(results, boardId);
  if (confirmedId !== null) findRender(renders, "confirmed", confirmedId);
  renders.approvedConfirmedId = confirmedId;
}

// Which render a Confirm/Final job sources its layout reference from.
// Final may source from either the picked draft or an approved confirmed
// render (approved confirmed wins). Confirm always sources the picked draft
// specifically — confirming an already-confirmed render would be a
// confirm-of-a-confirm, which the panel's own Confirm button never offers.
export function renderSource(results, boardId, kind = "final") {
  const renders = ensureRenders(results, boardId);
  if (kind === "confirm") {
    if (!renders.pickedDraftId) return null;
    return { kind: "draft", record: findRender(renders, "drafts", renders.pickedDraftId) };
  }
  if (renders.approvedConfirmedId) return { kind: "confirm", record: findRender(renders, "confirmed", renders.approvedConfirmedId) };
  if (renders.pickedDraftId) return { kind: "draft", record: findRender(renders, "drafts", renders.pickedDraftId) };
  return null;
}

async function deleteRenderFile(runDir, relativePath) {
  try {
    await unlink(path.join(runDir, relativePath));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

// The picked draft mirrors itself into results.candidates (see pickDraft) so
// the legacy CLI confirm/finalize commands keep working on the same file.
// Deleting that draft must drop the mirror too, or the legacy path is left
// pointing at a file that no longer exists.
function dropCandidatesFor(results, boardId, draftId) {
  if (!results.candidates) return;
  for (const [key, candidate] of Object.entries(results.candidates)) {
    if (key.startsWith(`${boardId}--`) && candidate.pickedDraftId === draftId) delete results.candidates[key];
  }
}

// Removes one draft/confirmed/final render: deletes its saved image and its
// results.json record. Unpicking/unapproving happens automatically if the
// removed render was the board's current pick or approval.
export async function removeRender(results, runDir, boardId, kind, id) {
  const renders = ensureRenders(results, boardId);
  const list = DIR_FOR_KIND[kind];
  if (!list) throw Object.assign(new Error(`Unknown render kind "${kind}".`), { status: 400 });
  const index = renders[list].findIndex((entry) => entry.id === id);
  if (index === -1) throw Object.assign(new Error(`No ${list} render "${id}".`), { status: 404 });
  const [record] = renders[list].splice(index, 1);
  await deleteRenderFile(runDir, record.path);
  if (kind === "draft" && renders.pickedDraftId === id) {
    renders.pickedDraftId = null;
    dropCandidatesFor(results, boardId, id);
  }
  if (kind === "confirm" && renders.approvedConfirmedId === id) {
    renders.approvedConfirmedId = null;
  }
  return record;
}

// "Reset drafts" — clears every draft and confirmed render for a board
// (never finals, which the app Library already shows) so the operator can
// start a fresh round without re-planning the board.
export async function resetNonFinalRenders(results, runDir, boardId) {
  const renders = ensureRenders(results, boardId);
  const removed = { drafts: renders.drafts.length, confirmed: renders.confirmed.length };
  for (const record of [...renders.drafts, ...renders.confirmed]) {
    await deleteRenderFile(runDir, record.path);
  }
  renders.drafts = [];
  renders.confirmed = [];
  renders.pickedDraftId = null;
  renders.approvedConfirmedId = null;
  if (results.candidates) {
    for (const key of Object.keys(results.candidates)) {
      if (key.startsWith(`${boardId}--`)) delete results.candidates[key];
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Job execution — one queue job = one board action (N drafts, or one confirm,
// or one final). Progress text is what the panel's status line shows.
// ---------------------------------------------------------------------------

function itemNotesOf(board) {
  return Object.fromEntries(board.items.filter((item) => String(item.note ?? "").trim()).map((item) => [item.slotId, String(item.note).trim()]));
}

export async function runRenderJob(job, ctx) {
  const { plan, results, runDir } = ctx;
  const board = plan.boards.find((entry) => entry.id === job.boardId);
  if (!board) throw Object.assign(new Error(`Unknown board "${job.boardId}".`), { status: 404 });
  const instruction = job.instructionSnapshot ?? ensureRenders(results, board.id).instruction ?? "";
  const renderOptions = job.renderOptionsSnapshot ?? resolveRenderOptions(board, job.kind, {
    quality: job.qualityOverride,
    background: job.backgroundOverride,
  });
  const itemNotes = itemNotesOf(board);
  const post = (payload, files) => postGeneration(ctx.baseUrl, payload, files, { accessHeaders: ctx.accessHeaders, signal: ctx.signal });
  // Recorded on the finished render so it reflects the board state actually
  // rendered — NOT job.selectionHash, which is only the state at enqueue
  // time and may be stale by the time a queued job actually executes. The
  // Final pre-check below also compares against this same execute-time
  // value (not job.selectionHash) so a board edit made while a Final job
  // waits in the queue is still caught, not just an edit made before it was
  // enqueued.
  const executedSelectionHash = selectionHash(board, instruction);
  const common = { selectionHash: executedSelectionHash, instruction, itemNotes };

  if (job.kind === "draft") {
    const variant = plan.variants.find((entry) => entry.key === job.variant);
    if (!variant) throw Object.assign(new Error(`Unknown variant "${job.variant}".`), { status: 400 });
    const count = Math.max(1, Math.min(10, Number(job.count) || 1));
    const { payload, files } = buildDraftPayload(board, variant, { apiKey: ctx.apiKey, instruction, ...renderOptions });
    for (let index = 1; index <= count; index++) {
      ctx.signal?.throwIfAborted();
      const startedAt = Date.now();
      const json = await post(payload, files);
      const id = nextRenderId(ensureRenders(results, board.id), "d");
      const rel = await saveRenderImage(runDir, board.id, "draft", id, json.imageBase64);
      recordDraft(results, board.id, { id, variant: variant.key, index, path: rel, jobId: json.jobId ?? null, durationMs: Date.now() - startedAt, ...common, ...recordMetadata(payload, json) });
      await ctx.persist();
      ctx.onProgress(`${index}/${count}`);
    }
    return;
  }

  const source = renderSource(results, board.id, job.kind);
  if (!source) {
    // Confirm can only ever be satisfied by a picked draft (see renderSource);
    // only Final may also be satisfied by an approved confirmed render.
    const hint = job.kind === "confirm" ? "Pick a draft" : "Pick a draft or approve a confirmed render";
    throw Object.assign(new Error(`${hint} before rendering this step.`), { status: 400 });
  }
  // job.force is the user explicitly acknowledging staleness (via the
  // panel's stronger confirm dialog) and choosing to finalize anyway.
  if (job.kind === "final" && !job.force && renderRecordIsStale(board, source.record, source.kind, instruction)) {
    throw Object.assign(new Error("The picked render is stale — the board's selection or render options changed since it was rendered. Draft again first."), { status: 409 });
  }
  const variant = plan.variants.find((entry) => entry.key === source.record.variant);
  const sourcePath = path.join(runDir, source.record.path);
  const startedAt = Date.now();

  if (job.kind === "confirm") {
    const { payload, files } = buildConfirmPayload(board, variant, sourcePath, { apiKey: ctx.apiKey, instruction, ...renderOptions });
    const json = await post(payload, files);
    const id = nextRenderId(ensureRenders(results, board.id), "c");
    const rel = await saveRenderImage(runDir, board.id, "confirm", id, json.imageBase64);
    recordConfirmed(results, board.id, { id, variant: variant.key, fromDraftId: source.record.id, path: rel, jobId: json.jobId ?? null, durationMs: Date.now() - startedAt, ...common, ...recordMetadata(payload, json) });
    const candidate = results.candidates?.[`${board.id}--${variant.key}`];
    const sourceDraftQuality = candidate?.draftQuality ?? candidate?.quality ?? source.record.quality;
    const sourceDraftBackground = candidate?.draftBackground ?? candidate?.background ?? source.record.background ?? "opaque";
    if (candidate) Object.assign(candidate, {
      confirmedAt: new Date().toISOString(),
      draftQuality: sourceDraftQuality,
      draftBackground: sourceDraftBackground,
      ...recordMetadata(payload, json),
    });
    await ctx.persist();
    ctx.onProgress("1/1");
    return;
  }

  if (job.kind === "final") {
    const { payload, files } = buildFinalPayload(board, variant, sourcePath, { apiKey: ctx.apiKey, instruction, ...renderOptions });
    const json = await post(payload, files);
    const id = nextRenderId(ensureRenders(results, board.id), "f");
    const rel = await saveRenderImage(runDir, board.id, "final", id, json.imageBase64);
    recordFinal(results, board.id, { id, variant: variant.key, fromRenderId: source.record.id, path: rel, jobId: json.jobId ?? null, libraryJobId: json.jobId ?? null, libraryVisible: json.libraryVisible ?? false, durationMs: Date.now() - startedAt, ...common, ...recordMetadata(payload, json) });
    results.finals ??= {};
    results.finals[`${board.id}--${variant.key}`] = { jobId: json.jobId ?? null, savedPath: path.join(runDir, rel), libraryVisible: json.libraryVisible ?? false, notice: json.notice ?? null, appliedNoteSlotIds: Object.keys(itemNotes), completedAt: new Date().toISOString(), ...recordMetadata(payload, json) };
    await ctx.persist();
    ctx.onProgress("1/1");
    return;
  }

  throw Object.assign(new Error(`Unknown render kind "${job.kind}".`), { status: 400 });
}
