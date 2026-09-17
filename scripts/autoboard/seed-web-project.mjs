#!/usr/bin/env node
// Seeds a running review board (/review-boards) from a tracked project
// definition and the library root that `autoboard:scaffold --fetch-images`
// already built.
//
// The web board stores projects, photos and renders in D1 and R2, which are
// per-machine under .wrangler/state — so a fresh checkout starts empty and the
// first draft is an hour of collecting photos for rows whose photos are already
// sitting on disk. This does that part.
//
// Reads only. It uploads copies of the library's photos through the app's own
// API; nothing in the library root is written or moved.
//
//   npm run autoboard:seed-web -- --project 651-belmont
//   npm run autoboard:seed-web -- --project 651-belmont --rooms "Bath 2" --select
//
// Defaults to http://localhost:3000, and to the library root named in the
// project definition. Run `npm run dev` first.

import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import path from "node:path";

import { loadBuildLog, makeDiskImageResolver } from "./lib/match.mjs";

const MIME_BY_EXTENSION = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

// The photo endpoint caps a single image at 20 MB, and base64 inflates by a
// third on the way there — so anything near the cap is skipped with a reason
// rather than sent to be rejected.
const MAX_UPLOAD_BYTES = 14 * 1024 * 1024;

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

function loadDefinition(projectId) {
  const file = path.join(import.meta.dirname, "projects", `${projectId}.json`);
  if (!existsSync(file)) {
    fail(`No project definition at ${file}. Tracked definitions live in scripts/autoboard/projects/.`);
  }
  return JSON.parse(readFileSync(file, "utf8"));
}

// A definition's rooms carry `room` and items carry `name`; a source row carries
// `roomType` and `itemName`. Emitted RAW, in the shape the Smartsheet reader
// hands to collectRows — the server normalizes and gap-checks with that same
// function, so normalizing here would only give it a second, differently-shaped
// input to get wrong. (It did: an already-normalized row has no `roomType`, so
// every row failed the blank-room check.)
export function rowsFromDefinition(definition, { rooms = [] } = {}) {
  const wanted = new Set(rooms.map((room) => room.toLowerCase()));
  const rows = [];
  for (const room of definition.rooms ?? []) {
    if (wanted.size && !wanted.has(String(room.room).toLowerCase())) continue;
    for (const item of room.items ?? []) {
      rows.push({
        rowId: item.rowId,
        unitType: definition.unitType,
        roomType: room.room,
        costCode: item.costCode,
        itemName: item.name,
        sku: item.sku,
        qty: item.qty ?? 1,
        reference: item.reference,
        status: item.status,
      });
    }
  }
  return rows;
}

async function api(baseUrl, route, init) {
  const response = await fetch(`${baseUrl}${route}`, init);
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) {
    const detail = payload?.error ?? `HTTP ${response.status}`;
    if (response.status === 403) {
      throw new Error(
        `${detail}\n\nA 403 from local dev is the Cloudflare Access gate: blank CF_ACCESS_TEAM_DOMAIN ` +
          "and CF_ACCESS_AUD in .dev.vars and restart `npm run dev` (see .dev.vars.example).",
      );
    }
    throw new Error(detail);
  }
  return payload;
}

async function main() {
  const { values } = parseArgs({
    options: {
      project: { type: "string" },
      root: { type: "string" },
      "base-url": { type: "string", default: "http://localhost:3000" },
      name: { type: "string" },
      rooms: { type: "string", multiple: true, default: [] },
      into: { type: "string" },
      select: { type: "boolean", default: false },
      "per-row": { type: "string", default: "2" },
      "dry-run": { type: "boolean", default: false },
    },
  });

  if (!values.project) {
    fail("Which project? e.g. --project 651-belmont (see scripts/autoboard/projects/).");
  }
  const definition = loadDefinition(values.project);
  const libraryRoot = values.root ?? definition.libraryRoot;
  if (!libraryRoot) fail("This definition has no libraryRoot; pass --root <path to the Master Library>.");
  if (!existsSync(libraryRoot)) {
    fail(
      `Library root not found: ${libraryRoot}\n` +
        `Build it first: npm run autoboard:scaffold -- --project ${values.project} --fetch-images`,
    );
  }

  const baseUrl = values["base-url"].replace(/\/+$/, "");
  const perRow = Math.max(1, Number(values["per-row"]) || 2);
  const rows = rowsFromDefinition(definition, { rooms: values.rooms });
  if (!rows.length) fail(`No rows matched. Rooms in this definition: ${(definition.rooms ?? []).map((r) => r.room).join(", ")}`);

  // The same disk resolver `plan --offline` uses, so a row resolves to exactly
  // the photos the CLI would put on its board.
  const resolveImages = makeDiskImageResolver(libraryRoot, loadBuildLog(libraryRoot));
  const withPhotos = rows
    .map((row) => ({ row, images: resolveImages(row.rowId).slice(0, perRow) }))
    .filter((entry) => entry.images.length);

  console.log(`${definition.name ?? values.project}: ${rows.length} rows, ${withPhotos.length} with photos on disk`);
  if (values["dry-run"]) {
    for (const { row, images } of withPhotos) {
      console.log(`  ${row.rowId.padEnd(8)} ${row.itemName.slice(0, 54).padEnd(56)} ${images.length} photo(s)`);
    }
    const missing = rows.length - withPhotos.length;
    if (missing) console.log(`\n${missing} row(s) have no photo in the library and will need one collected in the UI.`);
    return;
  }

  let projectId = values.into;
  if (projectId) {
    console.log(`Adding photos to existing project ${projectId}`);
  } else {
    const created = await api(baseUrl, "/api/autoboard/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: values.name ?? definition.name ?? values.project,
        rows,
        source: `seeded from scripts/autoboard/projects/${values.project}.json`,
      }),
    });
    projectId = created.project.id;
    console.log(`Created project ${projectId} — ${created.project.boardCount} boards`);
  }

  let uploaded = 0;
  let selected = 0;
  let skipped = 0;
  for (const { row, images } of withPhotos) {
    for (const [index, imagePath] of images.entries()) {
      const mimeType = MIME_BY_EXTENSION[path.extname(imagePath).toLowerCase()];
      if (!mimeType) {
        console.warn(`  skip ${row.rowId}: ${path.basename(imagePath)} is not a JPEG, PNG or WebP`);
        skipped++;
        continue;
      }
      const bytes = readFileSync(imagePath);
      if (bytes.length > MAX_UPLOAD_BYTES) {
        console.warn(`  skip ${row.rowId}: ${path.basename(imagePath)} is ${Math.round(bytes.length / 1e6)} MB`);
        skipped++;
        continue;
      }
      try {
        const result = await api(baseUrl, `/api/autoboard/projects/${encodeURIComponent(projectId)}/photos`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ rowId: row.rowId, mimeType, dataBase64: bytes.toString("base64") }),
        });
        uploaded++;
        // Only the first photo per row is selected, and only when asked: a
        // selection is a person's decision, and the whole point of the review
        // grid is that nothing reaches a render because a script chose it.
        if (values.select && index === 0) {
          await api(baseUrl, `/api/autoboard/photos/${encodeURIComponent(result.photo.id)}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ status: "selected" }),
          });
          selected++;
        }
      } catch (error) {
        console.warn(`  skip ${row.rowId}: ${error.message}`);
        skipped++;
      }
    }
  }

  console.log(`\nUploaded ${uploaded} photo(s)${values.select ? `, selected ${selected}` : ""}${skipped ? `, skipped ${skipped}` : ""}.`);
  console.log(`Open ${baseUrl}/review-boards`);
  if (!values.select) {
    console.log("Photos are candidates — pick one per slot in the grid, or re-run with --select to auto-pick the first.");
  }
}

// Guarded so the row builder above can be imported by a test without the CLI
// running and talking to a dev server.
if (process.argv[1] && import.meta.filename === path.resolve(process.argv[1])) {
  main().catch((error) => fail(error.message));
}
