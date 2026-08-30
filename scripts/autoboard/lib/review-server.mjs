// Local HTTP server for the review UI (see review-page.mjs for the client,
// review-core.mjs for the pure selection logic). Localhost-only, single
// user, direct filesystem access — this is a developer tool, not a deployed
// service, so it's kept dependency-free (plain node:http, no framework).

import { createReadStream, existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";

import { buildRoomIndex, libraryOptionsForSlot, applySelection, resetSelection, roomKeyFor, slotKind } from "./review-core.mjs";
import { makeDiskImageResolver } from "./match.mjs";
import { indexTileCodes } from "./tiles.mjs";
import { loadLibraryRows } from "./source.mjs";
import { decodeUploadedImage, isValidTileCode, saveUploadedRowImage, saveUploadedTileImage, uploadsRootDir, withUploads } from "./uploads.mjs";

const IMAGE_MIME = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };

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

export async function startReviewServer({ runDir, planPath, port, renderReviewPage }) {
  const plan = JSON.parse(await readFile(planPath, "utf8"));
  const libraryRoot = plan.libraryRoot;
  const offline = plan.source === "offline-manifest";
  const { rows } = await loadLibraryRows({ offline, libraryRoot, token: process.env.SMARTSHEET_ACCESS_TOKEN });
  const roomIndex = buildRoomIndex(rows);
  const tileIndex = indexTileCodes(libraryRoot);
  const resolveImages = withUploads(makeDiskImageResolver(libraryRoot));

  const allowedRoots = [path.resolve(libraryRoot), path.resolve(runDir), path.resolve(uploadsRootDir())];
  function isAllowedPath(candidate) {
    const resolved = path.resolve(candidate);
    return allowedRoots.some((root) => resolved === root || resolved.startsWith(root + path.sep));
  }

  async function persistPlan() {
    await writeFile(planPath, JSON.stringify(plan, null, 2), "utf8");
  }

  function findBoard(boardId) {
    const board = plan.boards.find((entry) => entry.id === boardId);
    if (!board) throw Object.assign(new Error(`Unknown board "${boardId}".`), { status: 404 });
    return board;
  }

  function serializeItem(item) {
    return { ...item, kind: slotKind(item.slotId) };
  }

  function serializePlan() {
    return {
      runId: plan.runId,
      source: plan.source,
      boards: plan.boards.map((board) => ({
        id: board.id,
        title: board.title,
        unitType: board.unitType,
        roomLabel: board.roomLabel,
        collageType: board.collageType,
        items: board.items.map(serializeItem),
      })),
    };
  }

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");

      if (request.method === "GET" && url.pathname === "/") {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(renderReviewPage());
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/plan") {
        sendJson(response, 200, serializePlan());
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/library") {
        const board = findBoard(url.searchParams.get("boardId"));
        const slotId = url.searchParams.get("slotId");
        const options = libraryOptionsForSlot({ board, slotId, roomIndex, tileIndex, resolveImages });
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
        const item = applySelection({ board, slotId, choice, roomIndex, tileIndex, resolveImages });
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
