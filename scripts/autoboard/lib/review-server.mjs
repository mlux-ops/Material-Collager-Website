// Local HTTP server for the review UI (see review-page.mjs for the client,
// review-core.mjs for the pure selection logic). Localhost-only, single
// user, direct filesystem access — this is a developer tool, not a deployed
// service, so it's kept dependency-free (plain node:http, no framework).

import { createReadStream, existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";

import { addSlot, applySelection, buildRoomIndex, CUSTOM_ID_PREFIX, libraryOptionsForSlot, removeSlot, replaceItemImage, resetSelection, roomKeyFor, slotKind } from "./review-core.mjs";
import { makeDiskImageResolver } from "./match.mjs";
import { readNoteOverrides } from "./notes.mjs";
import { resolveAccessHeaders } from "./access.mjs";
import { backfillRenderSizes, COST_PER_IMAGE, estimateStageOutputUsd, SUNBURST_BACKGROUND_OPTIONS, SUNBURST_QUALITY_OPTIONS, approveConfirmed, ensureRenders, pickDraft, removeRender, renderRecordIsStale, renderSource, resetNonFinalRenders, resolveRenderOptions, runRenderJob, savedRenderOptions, selectionHash } from "./render.mjs";
import { RenderQueue } from "./render-queue.mjs";
import { indexTileCodes, resolveTileCode } from "./tiles.mjs";
import { loadLibraryRows } from "./source.mjs";
import { heroFor } from "./variants.mjs";
import {
  customItemsForRoom,
  customItemsRootDir,
  decodeUploadedImage,
  isValidTileCode,
  replaceCustomItemPhoto,
  replaceTileImage,
  saveCustomItem,
  saveUploadedRowImage,
  saveUploadedTileImage,
  uploadsRootDir,
  withUploads,
} from "./uploads.mjs";

const IMAGE_MIME = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };

// The render-workflow endpoints this feature introduced (see the
// Content-Type guard in the request handler below) — the money-spending one
// is /api/render, but all six get the same cross-origin protection for
// consistency. Pre-existing endpoints (/api/select etc.) are deliberately
// not in this list; they predate this feature and are out of scope here.
const RENDER_WORKFLOW_ENDPOINTS = new Set([
  "/api/instruction", "/api/item-note", "/api/pick-draft",
  "/api/approve-confirmed", "/api/render-options", "/api/render", "/api/render-cancel",
  "/api/render-remove", "/api/render-reset",
]);

function readBody(request) {
  return new Promise((resolve, reject) => {
    let data = "";
    request.on("data", (chunk) => { data += chunk; });
    request.on("end", () => resolve(data));
    request.on("error", reject);
  });
}

function sendJson(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

export async function startReviewServer({
  runDir, planPath, port, renderReviewPage,
  baseUrl = "http://localhost:3000", apiKey,
  resolveAccess = resolveAccessHeaders, executeJob = runRenderJob,
}) {
  const plan = JSON.parse(await readFile(planPath, "utf8"));
  const resultsPath = path.join(runDir, "results.json");
  const results = existsSync(resultsPath) ? JSON.parse(await readFile(resultsPath, "utf8")) : { candidates: {}, finals: {} };
  results.renders ??= {};
  // Renders from before `size` was recorded still hold usable observations;
  // recover the size from the saved image so the learned output-token table
  // starts populated instead of empty.
  const backfilled = await backfillRenderSizes(results, runDir);
  if (backfilled) {
    await writeFile(resultsPath, JSON.stringify(results, null, 2), "utf8");
    console.log(`  recovered the render size for ${backfilled} earlier render(s) so their output-token cost is known`);
  }
  async function persistResults() {
    await writeFile(resultsPath, JSON.stringify(results, null, 2), "utf8");
  }
  const libraryRoot = plan.libraryRoot;
  const offline = plan.source === "offline-manifest";
  const { rows } = await loadLibraryRows({ offline, libraryRoot, token: process.env.SMARTSHEET_ACCESS_TOKEN });
  const roomIndex = buildRoomIndex(rows);
  const tileIndex = indexTileCodes(libraryRoot);
  const resolveImages = withUploads(makeDiskImageResolver(libraryRoot));

  const allowedRoots = [
    path.resolve(libraryRoot),
    path.resolve(runDir),
    path.resolve(uploadsRootDir()),
    path.resolve(customItemsRootDir()),
  ];
  function isAllowedPath(candidate) {
    const resolved = path.resolve(candidate);
    return allowedRoots.some((root) => resolved === root || resolved.startsWith(root + path.sep));
  }

  async function persistPlan() {
    await writeFile(planPath, JSON.stringify(plan, null, 2), "utf8");
  }

  // One-time import of the legacy per-board notes.json into item.note. Only
  // items that have never had a note (undefined) are filled, so clearing a
  // note in the UI sticks across restarts.
  let importedNotes = false;
  for (const board of plan.boards) {
    const overrides = readNoteOverrides(runDir, board.id);
    for (const item of board.items) {
      if (item.note === undefined) {
        item.note = overrides.get(item.slotId) ?? "";
        importedNotes = true;
      }
    }
  }
  if (importedNotes) await persistPlan();

  // Access credentials: resolved once at startup and again on the next
  // render click after a failure, so a fresh `cloudflared access login` is
  // picked up without restarting the server. Headers never leave this closure.
  let access = { headers: {}, error: null };
  async function refreshAccess() {
    try {
      const resolved = await resolveAccess(baseUrl);
      access = { headers: resolved.headers, error: null };
    } catch (error) {
      access = { headers: {}, error: error.message };
    }
  }
  await refreshAccess();

  const queue = new RenderQueue({
    execute: (job, { signal, onProgress }) => executeJob(job, {
      plan, results, runDir, baseUrl, apiKey,
      accessHeaders: access.headers,
      signal, onProgress, persist: persistResults,
    }),
  });

  const boardsRoot = path.resolve(runDir, "boards");
  function renderImagePath(relative) {
    if (typeof relative !== "string" || !relative) return null;
    const resolved = path.resolve(runDir, relative);
    if (!resolved.startsWith(boardsRoot + path.sep)) return null;
    return existsSync(resolved) ? resolved : null;
  }

  const MAX_TEXT_CHARS = 2000;
  function cleanText(value, label) {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    if (text.length > MAX_TEXT_CHARS) throw Object.assign(new Error(`${label} must be under ${MAX_TEXT_CHARS} characters.`), { status: 400 });
    return text;
  }
  function findItem(board, slotId) {
    const item = board.items.find((entry) => entry.slotId === slotId);
    if (!item) throw Object.assign(new Error(`Board "${board.id}" has no slot "${slotId}".`), { status: 404 });
    return item;
  }

  const VARIANT_KEYS = new Set(plan.variants.map((variant) => variant.key));
  function validateRenderRequest({ boardId, kind, variant, count, force }) {
    const board = findBoard(boardId);
    if (!["draft", "confirm", "final"].includes(kind)) throw Object.assign(new Error(`Unknown render kind "${kind}".`), { status: 400 });
    const record = ensureRenders(results, board.id);
    if (kind === "draft") {
      if (!VARIANT_KEYS.has(variant)) throw Object.assign(new Error(`Pick a variant: ${[...VARIANT_KEYS].join(", ")}.`), { status: 400 });
      const n = Number(count);
      if (!Number.isInteger(n) || n < 1 || n > 10) throw Object.assign(new Error("Count must be a whole number from 1 to 10."), { status: 400 });
      return board;
    }
    const source = renderSource(results, board.id, kind);
    if (!source) {
      // Confirm can only ever be satisfied by a picked draft (see
      // renderSource); only Final may also be satisfied by an approved
      // confirmed render.
      const hint = kind === "confirm" ? "Pick a draft" : "Pick a draft or approve a confirmed render";
      throw Object.assign(new Error(`${hint} first.`), { status: 400 });
    }
    // force:true (from the panel's stronger confirm dialog) is the user
    // explicitly acknowledging the staleness and choosing to finalize the
    // outdated source anyway — never applies to draft/confirm, only final.
    if (kind === "final" && !force && renderRecordIsStale(board, source.record, source.kind, record.instruction)) {
      throw Object.assign(new Error("The picked render is stale — the selection or render options changed since it was rendered. Draft again first."), { status: 409 });
    }
    return board;
  }

  function renderStatus() {
    const renders = {};
    const selectionHashes = {};
    // Output-token cost per board and stage, learned from what this run has
    // already rendered. Null wherever that (size, quality) has never run.
    const outputCosts = {};
    for (const board of plan.boards) {
      const record = ensureRenders(results, board.id);
      const currentHash = selectionHash(board, record.instruction);
      selectionHashes[board.id] = currentHash;
      const decorate = (entry, kind) => ({
        ...entry,
        stale: entry.selectionHash !== currentHash || renderRecordIsStale(board, entry, kind, record.instruction),
        url: `/render-image?path=${encodeURIComponent(entry.path)}`,
      });
      outputCosts[board.id] = {
        draft: estimateStageOutputUsd(results, board, "draft"),
        confirm: estimateStageOutputUsd(results, board, "confirm"),
        final: estimateStageOutputUsd(results, board, "final"),
      };
      renders[board.id] = { ...record, drafts: record.drafts.map((entry) => decorate(entry, "draft")), confirmed: record.confirmed.map((entry) => decorate(entry, "confirm")), finals: record.finals.map((entry) => decorate(entry, "final")) };
    }
    return { accessError: access.error, baseUrl, queue: queue.snapshot(), renders, costs: COST_PER_IMAGE, outputCosts, selectionHashes };
  }

  function findBoard(boardId) {
    const board = plan.boards.find((entry) => entry.id === boardId);
    if (!board) throw Object.assign(new Error(`Unknown board "${boardId}".`), { status: 404 });
    return board;
  }

  function serializeItem(item) {
    return { ...item, kind: slotKind(item.slotId) };
  }

  function customItemsForBoard(board) {
    return customItemsForRoom(roomKeyFor(board.unitType, board.roomLabel));
  }

  // Finding F3a: exposes both the manual hero override (if any) and what
  // heroFor would pick on its own, so the review UI can label the default
  // and offer a way back to it.
  function serializeBoard(board) {
    return {
      id: board.id,
      title: board.title,
      unitType: board.unitType,
      roomLabel: board.roomLabel,
      collageType: board.collageType,
      items: board.items.map(serializeItem),
      heroItemId: board.heroItemId ?? null,
      defaultHeroItemId: heroFor(board.collageType, board.items.map((item) => item.slotId)),
      renderOptions: board.renderOptions ? savedRenderOptions(board) : null,
    };
  }

  function serializePlan() {
    return {
      runId: plan.runId,
      source: plan.source,
      boards: plan.boards.map(serializeBoard),
    };
  }

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");

      // These 7 endpoints run the render workflow (the render endpoint spends real
      // money) and the client never sets Content-Type, so a plain cross-origin
      // fetch()/form POST from any other page open in the user's browser could
      // otherwise hit them while this local server is running. Requiring JSON
      // forces a CORS preflight for a cross-origin request, which this server
      // doesn't answer — the browser blocks it before it reaches us. The
      // older endpoints below predate this plan and are intentionally left
      // alone (out of scope for this fix).
      if (request.method === "POST" && RENDER_WORKFLOW_ENDPOINTS.has(url.pathname)) {
        const contentType = (request.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
        if (contentType !== "application/json") {
          sendJson(response, 400, { error: "Expected Content-Type: application/json." });
          return;
        }
      }

      if (request.method === "GET" && url.pathname === "/") {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(renderReviewPage());
        return;
      }

      // Browsers request this automatically; a quiet empty response keeps
      // local Review QA free of a misleading 404 console error.
      if (request.method === "GET" && url.pathname === "/favicon.ico") {
        response.writeHead(204);
        response.end();
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/plan") {
        sendJson(response, 200, serializePlan());
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/library") {
        const board = findBoard(url.searchParams.get("boardId"));
        const slotId = url.searchParams.get("slotId");
        const options = libraryOptionsForSlot({
          board, slotId, roomIndex, tileIndex, resolveImages,
          customItems: customItemsForBoard(board),
        });
        sendJson(response, 200, { slotKind: slotKind(slotId), options });
        return;
      }

      if (request.method === "GET" && url.pathname === "/image") {
        const filePath = url.searchParams.get("path");
        if (!filePath || !isAllowedPath(filePath) || !existsSync(filePath)) {
          response.writeHead(404);
          response.end("Not found");
          return;
        }
        const mime = IMAGE_MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
        response.writeHead(200, { "Content-Type": mime, "Cache-Control": "private, max-age=60" });
        createReadStream(filePath).pipe(response);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/select") {
        const { boardId, slotId, choice } = JSON.parse(await readBody(request));
        const board = findBoard(boardId);
        const item = applySelection({
          board, slotId, choice, roomIndex, tileIndex, resolveImages,
          customItems: customItemsForBoard(board),
        });
        await persistPlan();
        sendJson(response, 200, { item: serializeItem(item) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/reset") {
        const { boardId, slotId } = JSON.parse(await readBody(request));
        const board = findBoard(boardId);
        const item = resetSelection({ board, slotId });
        await persistPlan();
        sendJson(response, 200, { item: serializeItem(item) });
        return;
      }

      // Finding F3a: manually pin (or clear) which slot anchors the board's
      // composition. Setting board.overriddenAt is what marks any existing
      // candidate stale so the next `generate` re-renders it.
      if (request.method === "POST" && url.pathname === "/api/set-hero") {
        const { boardId, slotId } = JSON.parse(await readBody(request));
        const board = findBoard(boardId);
        if (slotId === null) {
          delete board.heroItemId;
        } else if (typeof slotId === "string" && board.items.some((item) => item.slotId === slotId)) {
          board.heroItemId = slotId;
        } else {
          throw Object.assign(new Error(`Board "${boardId}" has no slot "${slotId}".`), { status: 400 });
        }
        board.overriddenAt = new Date().toISOString();
        await persistPlan();
        sendJson(response, 200, { board: serializeBoard(board) });
        return;
      }

      // Uploads a photo for a fixture item that has none (or a replacement),
      // into autoboard's own overlay — never into the machine-generated
      // Master_Library_Build tree — then selects it for this slot.
      if (request.method === "POST" && url.pathname === "/api/upload-row-image") {
        const { boardId, slotId, rowId, mimeType, dataBase64 } = JSON.parse(await readBody(request));
        const board = findBoard(boardId);
        const rows = roomIndex.get(roomKeyFor(board.unitType, board.roomLabel)) ?? [];
        if (!rows.some((row) => row.rowId === rowId)) {
          throw Object.assign(new Error("That item is not in this board's room."), { status: 400 });
        }
        const { buffer, ext } = decodeUploadedImage({ mimeType, dataBase64 });
        await saveUploadedRowImage(rowId, buffer, ext);
        const item = applySelection({ board, slotId, choice: { kind: "row", rowId }, roomIndex, tileIndex, resolveImages });
        await persistPlan();
        sendJson(response, 200, { item: serializeItem(item) });
        return;
      }

      // Adds a brand-new tile to the real Tile/tiles/ pool (extending the
      // actual palette, not an overlay) and selects it for this slot. Never
      // overwrites — a code or filename collision is rejected.
      if (request.method === "POST" && url.pathname === "/api/upload-tile") {
        const { boardId, slotId, code: rawCode, materialName, mimeType, dataBase64 } = JSON.parse(await readBody(request));
        const board = findBoard(boardId);
        const code = String(rawCode ?? "").trim().toUpperCase();
        if (!isValidTileCode(code)) {
          throw Object.assign(new Error('Tile code must look like "WT14", "AT3", "FT5", etc.'), { status: 400 });
        }
        if (tileIndex.has(code)) {
          throw Object.assign(new Error(`Tile code "${code}" already exists — pick a different one.`), { status: 400 });
        }
        if (!materialName || !materialName.trim()) {
          throw Object.assign(new Error("Material name is required."), { status: 400 });
        }
        const { buffer, ext } = decodeUploadedImage({ mimeType, dataBase64 });
        const filePath = await saveUploadedTileImage(libraryRoot, code, materialName, buffer, ext);
        tileIndex.set(code, { code, materialName: materialName.trim(), filePath });
        const item = applySelection({ board, slotId, choice: { kind: "tile", code }, roomIndex, tileIndex, resolveImages });
        await persistPlan();
        sendJson(response, 200, { item: serializeItem(item) });
        return;
      }

      // Replaces the photo of an existing item in place — no new item, no
      // re-typing name/brand/notes. Two shapes:
      //  - no `target`: swap the photo of whatever currently occupies
      //    `slotId` (the main-page card's "Replace image" control).
      //  - `target: { kind: "tile", code }` or `{ kind: "row", rowId }`:
      //    swap that SPECIFIC library option's stored photo (the picker's
      //    per-option "Replace photo" control), which may not be the slot's
      //    current pick at all. If it happens to be, the slot is refreshed
      //    too and `item` comes back; otherwise only `imagePath` comes back
      //    so the picker can update just that option's thumbnail.
      if (request.method === "POST" && url.pathname === "/api/replace-image") {
        const { boardId, slotId, mimeType, dataBase64, target } = JSON.parse(await readBody(request));
        const board = findBoard(boardId);
        const item = board.items.find((entry) => entry.slotId === slotId);
        if (!item) throw Object.assign(new Error(`Board "${boardId}" has no slot "${slotId}".`), { status: 404 });
        const { buffer, ext } = decodeUploadedImage({ mimeType, dataBase64 });

        const kind = target?.kind ?? slotKind(slotId);
        let imagePath;
        let matchesCurrentItem;

        if (kind === "tile") {
          const code = String(target?.code ?? item.sku ?? "").trim().toUpperCase();
          const tile = resolveTileCode(tileIndex, code);
          if (!tile) throw Object.assign(new Error(`Unknown tile code "${code}".`), { status: 404 });
          imagePath = await replaceTileImage(libraryRoot, tile.code, tile.materialName, buffer, ext);
          tileIndex.set(tile.code, { code: tile.code, materialName: tile.materialName, filePath: imagePath });
          matchesCurrentItem = slotKind(slotId) === "tile" && item.sku === tile.code;
        } else {
          const rowId = String(target?.rowId ?? item.rowId ?? "");
          if (!rowId) throw Object.assign(new Error("No item to replace a photo for."), { status: 400 });
          if (rowId.startsWith(CUSTOM_ID_PREFIX)) {
            const customId = rowId.slice(CUSTOM_ID_PREFIX.length);
            imagePath = await replaceCustomItemPhoto(roomKeyFor(board.unitType, board.roomLabel), customId, buffer, ext);
          } else {
            const rows = roomIndex.get(roomKeyFor(board.unitType, board.roomLabel)) ?? [];
            if (!rows.some((row) => row.rowId === rowId)) {
              throw Object.assign(new Error("That item is not in this board's room."), { status: 400 });
            }
            imagePath = await saveUploadedRowImage(rowId, buffer, ext);
          }
          matchesCurrentItem = item.rowId === rowId;
        }

        if (matchesCurrentItem) {
          const updated = replaceItemImage({ board, slotId, imagePath });
          await persistPlan();
          sendJson(response, 200, { item: serializeItem(updated) });
        } else {
          sendJson(response, 200, { imagePath });
        }
        return;
      }

      // Adds a brand-new fixture item that has no Smartsheet row at all — the
      // row-slot equivalent of "Add a new tile" — into a small local library
      // scoped to this board's room, then selects it for this slot.
      if (request.method === "POST" && url.pathname === "/api/add-custom-item") {
        const { boardId, slotId, name, brand, notes, mimeType, dataBase64 } = JSON.parse(await readBody(request));
        const board = findBoard(boardId);
        if (!name || !String(name).trim()) {
          throw Object.assign(new Error("Item name is required."), { status: 400 });
        }
        const { buffer, ext } = decodeUploadedImage({ mimeType, dataBase64 });
        const saved = await saveCustomItem(
          roomKeyFor(board.unitType, board.roomLabel),
          { name: String(name).trim(), brand, notes },
          buffer,
          ext,
        );
        const item = applySelection({
          board, slotId, choice: { kind: "row", rowId: `custom:${saved.id}` },
          roomIndex, tileIndex, resolveImages, customItems: customItemsForBoard(board),
        });
        await persistPlan();
        sendJson(response, 200, { item: serializeItem(item) });
        return;
      }

      // Adds an entirely new slot to a board — not one of its preset slots,
      // just an extra item to render. Requires an image up front (same
      // storage as add-custom-item); there's no "auto-pick" for a slot that
      // never existed at plan time.
      if (request.method === "POST" && url.pathname === "/api/add-slot") {
        const { boardId, slotId, role, required, name, brand, notes, mimeType, dataBase64 } = JSON.parse(await readBody(request));
        const board = findBoard(boardId);
        const { buffer, ext } = decodeUploadedImage({ mimeType, dataBase64 });
        const saved = await saveCustomItem(
          roomKeyFor(board.unitType, board.roomLabel),
          { name: name || slotId, brand, notes },
          buffer,
          ext,
        );
        const item = addSlot(board, { slotId, role, required, name, brand, notes, imagePath: saved.imagePath });
        await persistPlan();
        sendJson(response, 200, { item: serializeItem(item) });
        return;
      }

      // Removes a slot entirely (real deletion — see removeSlot's own note).
      if (request.method === "POST" && url.pathname === "/api/remove-slot") {
        const { boardId, slotId } = JSON.parse(await readBody(request));
        const board = findBoard(boardId);
        removeSlot(board, slotId);
        await persistPlan();
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "GET" && url.pathname === "/render-image") {
        const filePath = renderImagePath(url.searchParams.get("path"));
        if (!filePath) { response.writeHead(404); response.end("Not found"); return; }
        response.writeHead(200, { "Content-Type": IMAGE_MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream", "Cache-Control": "private, max-age=3600" });
        createReadStream(filePath).pipe(response);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/render-status") {
        sendJson(response, 200, renderStatus());
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/instruction") {
        const { boardId, instruction } = JSON.parse(await readBody(request));
        const board = findBoard(boardId);
        ensureRenders(results, board.id).instruction = cleanText(instruction, "The board instruction");
        await persistResults();
        sendJson(response, 200, { instruction: ensureRenders(results, board.id).instruction });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/item-note") {
        const { boardId, slotId, note } = JSON.parse(await readBody(request));
        const board = findBoard(boardId);
        const item = findItem(board, slotId);
        item.note = cleanText(note, "An item note");
        await persistPlan();
        sendJson(response, 200, { item: serializeItem(item) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/render-options") {
        const body = JSON.parse(await readBody(request));
        const { boardId, quality, background } = body;
        const board = findBoard(boardId);
        if (quality !== null && quality !== undefined && !SUNBURST_QUALITY_OPTIONS.includes(quality)) {
          throw Object.assign(new Error(`Quality must be one of: ${SUNBURST_QUALITY_OPTIONS.join(", ")}.`), { status: 400 });
        }
        if (background !== null && background !== undefined && !SUNBURST_BACKGROUND_OPTIONS.includes(background)) {
          throw Object.assign(new Error(`Background must be one of: ${SUNBURST_BACKGROUND_OPTIONS.join(", ")}.`), { status: 400 });
        }
        const next = { ...(board.renderOptions ?? {}) };
        if (Object.prototype.hasOwnProperty.call(body, "quality")) {
          if (quality) next.quality = quality;
          else delete next.quality;
        }
        if (Object.prototype.hasOwnProperty.call(body, "background")) {
          if (background) next.background = background;
          else delete next.background;
        }
        if (Object.keys(next).length) board.renderOptions = next;
        else delete board.renderOptions;
        await persistPlan();
        sendJson(response, 200, { renderOptions: board.renderOptions ? savedRenderOptions(board) : null });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/pick-draft") {
        const { boardId, draftId } = JSON.parse(await readBody(request));
        const board = findBoard(boardId);
        const draft = pickDraft(results, runDir, board.id, draftId);
        await persistResults();
        sendJson(response, 200, { pickedDraftId: draft.id });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/approve-confirmed") {
        const { boardId, confirmedId } = JSON.parse(await readBody(request));
        const board = findBoard(boardId);
        approveConfirmed(results, board.id, confirmedId ?? null);
        await persistResults();
        sendJson(response, 200, { approvedConfirmedId: ensureRenders(results, board.id).approvedConfirmedId });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/render-remove") {
        const { boardId, kind, id } = JSON.parse(await readBody(request));
        const board = findBoard(boardId);
        const removed = await removeRender(results, runDir, board.id, kind, id);
        await persistResults();
        sendJson(response, 200, { removed: removed.id });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/render-reset") {
        const { boardId } = JSON.parse(await readBody(request));
        const board = findBoard(boardId);
        const removed = await resetNonFinalRenders(results, runDir, board.id);
        await persistResults();
        sendJson(response, 200, { removed });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/render") {
        const body = JSON.parse(await readBody(request));
        if (body.quality !== null && body.quality !== undefined && !SUNBURST_QUALITY_OPTIONS.includes(body.quality)) {
          throw Object.assign(new Error(`Quality must be one of: ${SUNBURST_QUALITY_OPTIONS.join(", ")}.`), { status: 400 });
        }
        if (body.background !== null && body.background !== undefined && !SUNBURST_BACKGROUND_OPTIONS.includes(body.background)) {
          throw Object.assign(new Error(`Background must be one of: ${SUNBURST_BACKGROUND_OPTIONS.join(", ")}.`), { status: 400 });
        }
        const board = validateRenderRequest(body);
        if (access.error) await refreshAccess();
        const record = ensureRenders(results, board.id);
        const options = resolveRenderOptions(board, body.kind, { quality: body.quality, background: body.background });
        const source = body.kind === "draft" ? null : renderSource(results, board.id, body.kind);
        const sourceIdentity = source ? { kind: source.kind, id: source.record.id } : null;
        const dedupeKey = JSON.stringify({
          boardId: board.id,
          kind: body.kind,
          variant: body.variant ?? null,
          count: body.kind === "draft" ? Number(body.count) : null,
          instruction: record.instruction,
          selectionHash: selectionHash(board, record.instruction),
          options,
          source: sourceIdentity,
          force: body.kind === "final" ? Boolean(body.force) : false,
        });
        const { jobId, position, duplicate } = queue.enqueue({
          boardId: board.id, kind: body.kind, variant: body.variant ?? null,
          count: body.kind === "draft" ? Number(body.count) : null,
          instructionSnapshot: record.instruction, selectionHash: selectionHash(board, record.instruction),
          renderOptionsSnapshot: options, dedupeKey,
          force: Boolean(body.force),
        });
        sendJson(response, 200, { jobId, position, duplicate, accessError: access.error });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/render-cancel") {
        const { jobId } = JSON.parse(await readBody(request));
        sendJson(response, 200, { cancelled: queue.cancel(jobId) });
        return;
      }

      response.writeHead(404);
      response.end("Not found");
    } catch (error) {
      sendJson(response, error.status ?? 500, { error: error.message });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
}
