#!/usr/bin/env node
// Autoboard CLI: autonomous material-collage generation from the Wieland
// Master Library, driving the app's existing /api/generate pipeline.
//
//   npm run autoboard -- plan --offline
//   npm run autoboard -- generate --run <run-id> [--dry-run] [--boards a,b]
//   npm run autoboard -- finalize --run <run-id> <variantId> [<variantId>...]
//
// plan     reads the library (Smartsheet or offline manifest), maps items to
//          the app's preset slots, resolves images, writes plan.json + gaps.md
// generate renders every board x variant at studio quality via the running
//          dev server and writes candidates + review.html for human review
// finalize re-renders chosen candidates at final quality with the candidate
//          as an approved-draft layout reference; those land in the Library.

import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { validateCollageRequest } from "../../app/lib/collage.ts";
import {
  DEFAULT_LIBRARY_ROOT,
  SMARTSHEET_SHEET_ID,
  loadLibraryRows,
} from "./lib/source.mjs";
import { buildBoards, makeDiskImageResolver } from "./lib/match.mjs";
import { indexTileCodes } from "./lib/tiles.mjs";
import { withUploads } from "./lib/uploads.mjs";
import { boardPayload, boardReferenceFiles, variantsFromCount } from "./lib/variants.mjs";
import { uploadFileToOpenAI } from "./lib/openai-upload.mjs";
import { startReviewServer } from "./lib/review-server.mjs";
import { renderReviewPage } from "./lib/review-page.mjs";
import { isStaleCandidate } from "./lib/review-core.mjs";
import { prepareReferenceForUpload } from "./lib/transport.mjs";
import { buildQaRequest, formatQaLine, runQa } from "./lib/qa-client.mjs";
import { annotateReferenceMeta } from "./lib/image-meta.mjs";
import {
  applyNoteOverrides,
  notesFilePath,
  overridesEqual,
  overridesToObject,
  readNoteOverrides,
  scaffoldNotesFile,
} from "./lib/notes.mjs";

const RUNS_ROOT = "autoboard-runs";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const TILE_ASSIGNMENTS_PATH = path.join(SCRIPT_DIR, "tile-assignments.json");

// Hand-editable, tracked config (never per-run state) mapping room -> tile
// codes. See tile-assignments.json's own _readme for provenance: the
// "Wieland Selections Book" v4 tile schedule (Elm Surfaces) — an approved
// design direction, but still release status HOLD pending quotes.
async function loadTileAssignments() {
  try {
    const data = JSON.parse(await readFile(TILE_ASSIGNMENTS_PATH, "utf8"));
    return new Map(Object.entries(data.assignments ?? {}));
  } catch (error) {
    if (error.code === "ENOENT") return new Map();
    throw new Error(`${TILE_ASSIGNMENTS_PATH} is not valid JSON: ${error.message}`);
  }
}

// Finding F12: the app's response carries the real output format (mimeType),
// so the CLI derives a candidate's file extension from THAT rather than
// assuming .png — outputFormat/outputCompression below can make it jpeg/webp.
const EXTENSION_BY_MIME = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" };
function extensionForMime(mimeType) {
  return EXTENSION_BY_MIME[mimeType] ?? ".png";
}

const DRAFT_RESOLUTIONS = new Set(["standard", "studio"]);
// Standing rule (user preference, 2026-08-30): drafts render at the app's
// "standard" canvas (1536x1024) by default — cheaper and faster than the
// old "studio" (2048x1360) default, which stays one flag away.
function resolveDraftResolution(values) {
  const resolution = values.resolution ?? "standard";
  if (!DRAFT_RESOLUTIONS.has(resolution)) {
    throw new Error(`--resolution must be "standard" or "studio" (got "${resolution}").`);
  }
  return resolution;
}

const OUTPUT_FORMATS = new Set(["png", "jpeg", "webp"]);
// Validated once up front (so --dry-run catches a bad flag without ever
// reaching the network), then applied to each payload built in the loop.
// variants.mjs's boardPayload isn't ours to extend, so outputFormat/
// outputCompression are set directly on the payload it returns instead.
function resolveFormatOptions(values) {
  const options = {};
  if (values.format !== undefined) {
    if (!OUTPUT_FORMATS.has(values.format)) {
      throw new Error(`--format must be one of png|jpeg|webp (got "${values.format}").`);
    }
    options.outputFormat = values.format;
  }
  if (values.compression !== undefined) {
    const compression = Number(values.compression);
    if (!Number.isInteger(compression) || compression < 0 || compression > 100) {
      throw new Error(`--compression must be an integer between 0 and 100 (got "${values.compression}").`);
    }
    options.outputCompression = compression;
  }
  return options;
}

function resizeNote(count) {
  return count ? ` (${count} ref${count === 1 ? "" : "s"} resized)` : "";
}

function usage() {
  console.log(`Usage:
  autoboard plan     [--offline] [--unit <name>] [--room <name>] [--variants <n>]
                     [--library-root <path>] [--images-per-item <n>] [--min-slots <n>]
  autoboard generate --run <run-id> [--dry-run] [--boards <id,id>] [--quality <q>]
                     [--resolution standard|studio] [--format png|jpeg|webp]
                     [--compression <0-100>] [--base-url <url>] [--force]
                     [--no-qa] [--qa-model <name>]
                     Drafts render at "standard" (1536x1024) by default; pass
                     --resolution studio for the old 2048x1360 draft canvas.
                     After each saved candidate, calls the app's /api/qa
                     endpoint for an automated accuracy check against its
                     reference photos (never fails the render — pass --no-qa
                     to skip it, or --qa-model to request a specific model).
  autoboard redraft  --run <run-id> <variantId> [<variantId>...] [--quality <q>]
                     [--resolution standard|studio] [--format png|jpeg|webp]
                     [--compression <0-100>] [--base-url <url>]
                     [--no-qa] [--qa-model <name>]
                     Applies that board's notes.json (edit it after reviewing a draft)
                     and re-renders at draft quality so you can review the effect
                     before anything reaches final quality or the Library.
                     Also runs the automated QA accuracy check (see generate).
  autoboard confirm  --run <run-id> <variantId> [<variantId>...] [--quality <q>]
                     [--resolution standard|studio] [--format png|jpeg|webp]
                     [--compression <0-100>] [--base-url <url>] [--dry-run]
                     [--no-qa] [--qa-model <name>]
                     One ~$0.04 medium render of the picked variant before the
                     high-quality final — reuses the approved-draft layout
                     reference and notes.json exactly like redraft, but (unlike
                     redraft) runs even when notes.json is unchanged, and
                     defaults to quality "medium" / resolution "standard".
                     Records candidate.confirmedAt; finalize then picks up
                     whatever revision this produced. Also runs the automated
                     QA accuracy check (see generate).
  autoboard finalize --run <run-id> <variantId> [<variantId>...] [--quality <q>]
                     [--base-url <url>]
                     Refuses to run if notes.json has edits that were never
                     redrafted and reviewed.
  autoboard batch-finalize --run <run-id> <variantId> [<variantId>...] [--base-url <url>]
                     Same final render as finalize, submitted through OpenAI's
                     Batch API for roughly half the price (app's "economy"
                     mode). Not immediate — up to 24h. Same review gate as
                     finalize. Check progress with batch-status.
  autoboard batch-status --run <run-id> [--base-url <url>]
                     Refreshes and reports every batch-finalize submission for
                     this run; downloads a local copy once a job completes
                     (it also becomes visible in the app Library automatically).
  autoboard review   --run <run-id> [--port <n>]
                     Opens a local web page (http://127.0.0.1:<port>) showing
                     every board's slots with their current auto-pick; browse
                     every real item in that room (or every tile) and swap a
                     slot's selection in place. Saves directly into plan.json
                     — no need to re-run plan. Ctrl+C to stop the server.

Environment (shell env, or the repo's git-ignored .dev.vars):
  SMARTSHEET_ACCESS_TOKEN  required unless --offline (live sheet ${SMARTSHEET_SHEET_ID})
  OPENAI_API_KEY           forwarded to the app when the server has no key of its own
                           (unnecessary when --base-url targets the deployed worker,
                            which holds its own OPENAI_API_KEY secret)
  CF_ACCESS_CLIENT_ID /    Cloudflare Access service token for a deployed --base-url
  CF_ACCESS_CLIENT_SECRET  (Zero Trust -> Access -> Service Auth)
  CF_ACCESS_TOKEN          alternative: a user JWT from \`cloudflared access login\``);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runDirFor(runId) {
  return path.join(RUNS_ROOT, runId);
}

// Secrets and tokens resolve from the shell env first, then the repo's
// git-ignored .dev.vars — the same file the developer already uses for local
// overrides. Commented lines and blank values are ignored. Never logged.
const DEV_VARS = (() => {
  try {
    const vars = {};
    for (const line of readFileSync(".dev.vars", "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\r\n]*)"?\s*$/);
      if (match) vars[match[1]] = match[2].trim();
    }
    return vars;
  } catch {
    return {};
  }
})();

function localVar(name) {
  return process.env[name] || DEV_VARS[name] || undefined;
}

// The dev server resolves its OpenAI key from the request payload (the UI's
// Settings field) or its own process env — .dev.vars is not exposed to the
// route in local dev, so the CLI forwards the key in the payload.
function loadOpenAIKey() {
  return localVar("OPENAI_API_KEY");
}

// Cloudflare Access credentials for a deployed --base-url. The deployed
// worker holds its own OPENAI_API_KEY secret, so rendering against it needs
// no local OpenAI key — only a way through Access. Candidates are tried in
// order and the first one Access accepts is locked in for the whole run:
//   CF_ACCESS_CLIENT_ID + CF_ACCESS_CLIENT_SECRET  (an Access service token)
//   CF_ACCESS_TOKEN                                 (an explicit user JWT)
//   cloudflared's cached session                    (`cloudflared access login <url>`)
const CLOUDFLARED_CANDIDATES = [
  "cloudflared",
  "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe",
  "C:\\Program Files\\cloudflared\\cloudflared.exe",
];

function cloudflaredToken(baseUrl) {
  for (const executable of CLOUDFLARED_CANDIDATES) {
    try {
      const token = execFileSync(executable, ["access", "token", `-app=${baseUrl}`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 15_000,
      }).trim();
      if (token.split(".").length === 3) return token;
    } catch {
      // executable missing or no cached session for this app; try the next one
    }
  }
  return undefined;
}

function accessHeaderCandidates(baseUrl) {
  const candidates = [];
  const clientId = localVar("CF_ACCESS_CLIENT_ID");
  const clientSecret = localVar("CF_ACCESS_CLIENT_SECRET");
  if (clientId && clientSecret) {
    candidates.push({
      label: "Access service token",
      headers: { "CF-Access-Client-Id": clientId, "CF-Access-Client-Secret": clientSecret },
    });
  }
  const userToken = localVar("CF_ACCESS_TOKEN");
  if (userToken) candidates.push({ label: "CF_ACCESS_TOKEN", headers: { "cf-access-token": userToken } });
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)/i.test(baseUrl)) {
    const sessionToken = cloudflaredToken(baseUrl);
    if (sessionToken) {
      candidates.push({ label: "cloudflared session", headers: { "cf-access-token": sessionToken } });
    }
  }
  candidates.push({ label: "no Access credentials", headers: {} });
  return candidates;
}

// The credential set waitForServer locked in; postGeneration reuses it.
let activeAccessHeaders = {};

async function waitForServer(baseUrl) {
  const candidates = accessHeaderCandidates(baseUrl);
  let rejectedStatus;
  for (let attempt = 1; attempt <= 10; attempt++) {
    let reachable = false;
    for (const candidate of candidates) {
      let response;
      try {
        response = await fetch(`${baseUrl}/api/library`, {
          headers: candidate.headers,
          redirect: "manual",
          signal: AbortSignal.timeout(8000),
        });
      } catch {
        continue; // server not reachable (yet)
      }
      reachable = true;
      // Access signals rejection with a 302 to the team login page or a 403
      // from the worker's own JWT check.
      if (response.status === 302 || response.status === 403) {
        rejectedStatus = response.status;
        continue;
      }
      activeAccessHeaders = candidate.headers;
      if (Object.keys(candidate.headers).length) console.log(`  authenticated via ${candidate.label}`);
      return;
    }
    if (reachable) break; // reachable but every credential was rejected
    if (attempt === 1) console.log(`  waiting for ${baseUrl} ...`);
    await sleep(3000);
  }
  if (rejectedStatus) {
    throw new Error(
      `${baseUrl} rejected every Access credential (HTTP ${rejectedStatus}). ` +
        `Run \`cloudflared access login ${baseUrl}\` to refresh the session, or fix the service token in .dev.vars.`,
    );
  }
  throw new Error(`No server responded at ${baseUrl}. Start it with \`npm run dev\` (or pass --base-url).`);
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (fallback !== undefined && error.code === "ENOENT") return fallback;
    throw error;
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------

async function commandPlan(values) {
  const libraryRoot = values["library-root"] ?? DEFAULT_LIBRARY_ROOT;
  const { rows, gaps, source } = await loadLibraryRows({
    offline: Boolean(values.offline),
    libraryRoot,
    token: process.env.SMARTSHEET_ACCESS_TOKEN,
  });

  let filtered = rows;
  if (values.unit) {
    filtered = filtered.filter((row) => row.unitType.toLowerCase() === String(values.unit).toLowerCase());
  }
  if (values.room) {
    filtered = filtered.filter((row) => row.roomLabel.toLowerCase() === String(values.room).toLowerCase());
  }

  const resolveImages = withUploads(makeDiskImageResolver(libraryRoot));
  const tileAssignments = await loadTileAssignments();
  const tileIndex = indexTileCodes(libraryRoot);
  const { boards } = buildBoards(filtered, {
    resolveImages,
    imagesPerItem: Number(values["images-per-item"]) || 1,
    minSlots: Number(values["min-slots"]) || 2,
    gaps,
    tileAssignments,
    tileIndex,
  });

  // Finding F2a: flag (never exclude) reference photos below a usable
  // resolution, right after boards are built so plan.json/gaps.md both
  // reflect it.
  await annotateReferenceMeta(boards, gaps);

  const variants = variantsFromCount(values.variants);

  // Fail-early precision check: every board must produce a payload the app's
  // own validator accepts, for every variant, before anything is spent.
  const invalidBoards = [];
  for (const board of boards) {
    for (const variant of variants) {
      try {
        validateCollageRequest(boardPayload(board, variant));
      } catch (error) {
        invalidBoards.push({ boardId: board.id, variant: variant.key, error: error.message });
      }
    }
  }
  if (invalidBoards.length) {
    for (const invalid of invalidBoards) {
      console.error(`INVALID ${invalid.boardId} variant ${invalid.variant}: ${invalid.error}`);
    }
    throw new Error(`${invalidBoards.length} board/variant payload(s) failed the app's validator. Nothing was written.`);
  }

  const now = new Date();
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  const runId = `run-${stamp}`;
  const runDir = runDirFor(runId);
  mkdirSync(runDir, { recursive: true });

  const plan = {
    runId,
    createdAt: now.toISOString(),
    source,
    libraryRoot,
    variants,
    boards,
  };
  await writeFile(path.join(runDir, "plan.json"), JSON.stringify(plan, null, 2), "utf8");
  await writeFile(path.join(runDir, "gaps.md"), gapsMarkdown(runId, source, gaps), "utf8");

  console.log(`Source: ${source}`);
  console.log(`Rows considered: ${filtered.length} (of ${rows.length} usable)`);
  console.log(`\nBoards planned: ${boards.length}`);
  let boardsWithProvisionalTiles = 0;
  for (const board of boards) {
    const slots = board.items.map((item) => item.slotId).join(", ");
    console.log(`  ${board.id}  [${board.items.length} slots: ${slots}]`);
    if (board.items.some((item) => item.slotId === "main_tile" || item.slotId === "accent_tile")) {
      boardsWithProvisionalTiles++;
    }
  }
  if (boardsWithProvisionalTiles) {
    console.log(
      `\n${boardsWithProvisionalTiles} board(s) include a tile pick from the v4 Elm Surfaces schedule (${TILE_ASSIGNMENTS_PATH}) — approved direction, but release status is still HOLD (quote-pending, 9 open items). Review before finalizing.`,
    );
  }
  const gapCounts = Object.entries(gaps)
    .map(([key, list]) => `${key}=${list.length}`)
    .join("  ");
  console.log(`\nGaps: ${gapCounts}`);
  console.log(`\nRun folder: ${runDir}`);
  console.log(`Next: npm run autoboard -- generate --run ${runId} --dry-run`);
}

function gapsMarkdown(runId, source, gaps) {
  const lines = [`# Autoboard gaps — ${runId}`, "", `Source: ${source}`, ""];
  const sections = [
    ["Rows with blank Unit Type (excluded)", gaps.blankUnitRows, (gap) => `- row ${gap.rowId}: ${gap.itemName} (SKU ${gap.sku || "—"})`],
    ["Rows with blank Room Type (excluded)", gaps.blankRoomRows, (gap) => `- row ${gap.rowId}: ${gap.itemName} (SKU ${gap.sku || "—"})`],
    ["Rooms with no board type (skipped)", gaps.skippedRooms, (gap) => `- ${gap.unitType} / ${gap.roomLabel}: ${gap.itemCount} item(s) — ${gap.reason}`],
    ["Boards skipped", gaps.skippedBoards, (gap) => `- ${gap.unitType} / ${gap.roomLabel} / ${gap.collageType}: ${gap.reason}`],
    ["Slot conflicts (first match picked, alternates listed)", gaps.slotConflicts, (gap) =>
      `- ${gap.unitType} / ${gap.roomLabel} / ${gap.collageType} / ${gap.slotId}: picked "${gap.picked.itemName}" (row ${gap.picked.rowId}); alternates: ${gap.alternates.map((alt) => `"${alt.itemName}" (row ${alt.rowId})`).join(", ")}`],
    ["Matched items with no image on disk (excluded from boards)", gaps.imagelessItems, (gap) =>
      `- ${gap.unitType} / ${gap.roomLabel} / ${gap.collageType} / ${gap.slotId}: ${gap.itemName} (row ${gap.rowId}, SKU ${gap.sku || "—"})`],
    ["Preset slots left unfilled", gaps.unfilledSlots, (gap) =>
      `- ${gap.unitType} / ${gap.roomLabel} / ${gap.collageType} / ${gap.slotId}: ${gap.reason}`],
    ["Library items not mapped to any slot", gaps.unmappedItems, (gap) =>
      `- ${gap.unitType} / ${gap.roomLabel}: ${gap.itemName} (row ${gap.rowId}, ${gap.costCode})`],
    ["Low-resolution references (flagged, not excluded)", gaps.lowResolutionReferences ?? [], (gap) =>
      `- ${gap.unitType} / ${gap.roomLabel} / ${gap.collageType} / ${gap.slotId}: ${gap.itemName} — ${gap.width}x${gap.height} (${gap.path})`],
  ];
  for (const [title, list, formatter] of sections) {
    lines.push(`## ${title} (${list.length})`, "");
    if (list.length) {
      lines.push(...list.map(formatter));
    } else {
      lines.push("_none_");
    }
    lines.push("");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// generate
// ---------------------------------------------------------------------------

async function postGeneration(baseUrl, payload, files) {
  const form = new FormData();
  form.append("payload", JSON.stringify(payload));
  // Finding F2b: library photos run 8 KB-3.7 MB / up to 4000 px, while the
  // app's own browser upload path already caps the long edge at 2048 — bring
  // this path to parity instead of shipping raw bytes.
  let resizedReferenceCount = 0;
  for (const file of files) {
    const prepared = await prepareReferenceForUpload(file.path);
    if (prepared.resized) resizedReferenceCount++;
    // Only the extension may change (see transport.mjs) — the caller's
    // "slotId--basename" stem is preserved.
    const stem = file.name.slice(0, file.name.length - path.extname(file.name).length);
    const uploadName = `${stem}${path.extname(prepared.filename)}`;
    form.append("image[]", new Blob([prepared.bytes], { type: prepared.mime }), uploadName);
  }
  const response = await fetch(`${baseUrl}/api/generate`, {
    method: "POST",
    body: form,
    headers: activeAccessHeaders,
    redirect: "manual",
  });
  if (response.status === 302 || response.status === 403) {
    throw Object.assign(
      new Error(`Cloudflare Access rejected the render request (HTTP ${response.status}) — the session may have expired. Run \`cloudflared access login ${baseUrl}\`.`),
      { status: response.status },
    );
  }
  let json;
  try {
    json = await response.json();
  } catch {
    throw Object.assign(new Error(`Non-JSON response (HTTP ${response.status}) from ${baseUrl}/api/generate`), {
      status: response.status,
    });
  }
  if (!response.ok || !json.ok) {
    throw Object.assign(new Error(json.error ?? json.message ?? `HTTP ${response.status}`), {
      status: response.status,
    });
  }
  json.resizedReferenceCount = resizedReferenceCount;
  return json;
}

async function postWithRetry(baseUrl, payload, files) {
  try {
    return await postGeneration(baseUrl, payload, files);
  } catch (error) {
    const retryable = error.status === undefined || error.status === 429 || error.status >= 500;
    if (!retryable) throw error;
    console.log(`    retrying once after error: ${error.message}`);
    await sleep(5000);
    return postGeneration(baseUrl, payload, files);
  }
}

// QA (see lib/qa-client.mjs) — after a candidate is saved, asks the app's
// /api/qa endpoint how well the render matches its reference photos. Must
// NEVER fail or slow-fail a render: any error at all — including a 404
// because the route isn't deployed yet, a network error, or a non-JSON
// response — is caught here, reported once per run via `qaState.disabled`,
// and QA is skipped (silently) for the rest of that command's run.
async function runQaForCandidate({ baseUrl, values, payload, files, savedPath, jobId, qaState }) {
  if (values["no-qa"] || qaState.disabled) return null;
  try {
    const request = await buildQaRequest({ payload, referenceFiles: files, outputPath: savedPath, jobId });
    if (values["qa-model"]) request.model = values["qa-model"];
    const { qa } = await runQa(baseUrl, activeAccessHeaders, request);
    console.log(`    ${formatQaLine(qa)}`);
    return {
      model: qa.model,
      checkedAt: qa.checkedAt,
      flagCount: qa.flagCount,
      summary: qa.summary,
      items: qa.items,
      extraObjects: qa.extraObjects,
    };
  } catch (error) {
    qaState.disabled = true;
    const detail = error.status !== undefined ? `HTTP ${error.status}` : error.message;
    console.log(`    QA unavailable (${detail}) — renders saved without accuracy review`);
    return null;
  }
}

async function commandGenerate(values) {
  if (!values.run) throw new Error("Pass --run <run-id> (from a previous `plan`).");
  const runDir = runDirFor(values.run);
  const plan = await readJson(path.join(runDir, "plan.json"));
  const resultsPath = path.join(runDir, "results.json");
  const results = await readJson(resultsPath, { candidates: {}, finals: {} });
  const baseUrl = (values["base-url"] ?? "http://localhost:3000").replace(/\/+$/, "");
  // Standing rule (user preference, 2026-08-30): every draft render uses the
  // cheapest quality tier by default. Only finalize/batch-finalize stay at
  // high quality, since those are the actual deliverable.
  const quality = values.quality ?? "low";
  // Finding F12: drafts render at the app's "standard" canvas (1536x1024) by
  // default now, not the pricier "studio" (2048x1360) — --resolution studio
  // restores the old behavior.
  const outputResolution = resolveDraftResolution(values);
  const formatOptions = resolveFormatOptions(values);
  const apiKey = loadOpenAIKey();

  const selectedIds = values.boards
    ? new Set(String(values.boards).split(",").map((id) => id.trim()).filter(Boolean))
    : null;
  const boards = plan.boards.filter((board) => !selectedIds || selectedIds.has(board.id));
  if (!boards.length) throw new Error("No boards matched the --boards filter.");
  const variants = values.variants
    ? plan.variants.slice(0, Math.max(1, Number(values.variants) || plan.variants.length))
    : plan.variants;

  // A board's items can change after a candidate was rendered — most often
  // via the review UI swapping a slot's image directly in plan.json. Skip
  // only when the candidate is BOTH ok and at least as new as the board's
  // last edit; otherwise it's stale and needs a fresh render even without
  // --force, since the existing PNG no longer reflects what's selected.
  const work = [];
  for (const board of boards) {
    for (const variant of variants) {
      const variantId = `${board.id}--${variant.key}`;
      const existing = results.candidates[variantId];
      const isStale = isStaleCandidate(board, existing);
      if (existing?.status === "ok" && !values.force && !isStale) continue;
      work.push({ board, variant, variantId, stale: isStale && !values.force });
    }
  }

  if (values["dry-run"]) {
    console.log(`DRY RUN — ${work.length} render call(s) would be made against ${baseUrl}:`);
    for (const entry of work) {
      const referenceCount = boardReferenceFiles(entry.board).length;
      const reason = entry.stale ? ", STALE — a slot changed since this was last drafted" : "";
      console.log(
        `  ${entry.variantId}  (${entry.board.items.length} items, ${referenceCount} reference image(s), quality ${quality}, resolution ${outputResolution}${reason})`,
      );
    }
    const skipped = boards.length * plan.variants.length - work.length;
    if (skipped) console.log(`  (${skipped} already completed and unchanged; use --force to re-render anyway)`);
    if (!values["no-qa"]) {
      console.log(`  QA: would run against ${baseUrl}/api/qa${values["qa-model"] ? ` (model ${values["qa-model"]})` : ""}`);
    }
    return;
  }

  console.log(`Generating ${work.length} candidate(s) against ${baseUrl} at quality "${quality}"...`);
  await waitForServer(baseUrl);
  let failures = 0;
  const scaffoldedNotes = new Set();
  const qaState = { disabled: false };
  for (const { board, variant, variantId, stale } of work) {
    const payload = boardPayload(board, variant, { quality, apiKey, outputResolution });
    Object.assign(payload, formatOptions);
    const files = boardReferenceFiles(board);
    process.stdout.write(`  ${variantId} ${stale ? "(stale, re-rendering) " : ""}... `);
    try {
      validateCollageRequest(payload);
      const startedAt = Date.now();
      const json = await postWithRetry(baseUrl, payload, files);
      const boardDir = path.join(runDir, "boards", board.id);
      mkdirSync(boardDir, { recursive: true });
      const savedPath = path.join(boardDir, `${variant.key}${extensionForMime(json.mimeType)}`);
      await writeFile(savedPath, Buffer.from(json.imageBase64, "base64"));
      const notesPath = scaffoldNotesFile(runDir, board);
      results.candidates[variantId] = {
        status: "ok",
        savedPath,
        mimeType: json.mimeType ?? "image/png",
        jobId: json.jobId ?? null,
        renderKind: json.renderKind,
        notice: json.notice ?? null,
        notesPath,
        revision: 1,
        appliedNotes: {}, // the initial draft never applies notes.json — see `redraft`
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
      };
      console.log(`ok (${Math.round((Date.now() - startedAt) / 1000)}s)${resizeNote(json.resizedReferenceCount)}`);
      results.candidates[variantId].qa = await runQaForCandidate({
        baseUrl, values, payload, files, savedPath, jobId: json.jobId, qaState,
      });
      if (!scaffoldedNotes.has(board.id)) {
        scaffoldedNotes.add(board.id);
        console.log(`    notes: ${notesPath}`);
      }
    } catch (error) {
      failures++;
      results.candidates[variantId] = {
        status: "error",
        error: error.message,
        failedAt: new Date().toISOString(),
      };
      console.log(`FAILED: ${error.message}`);
    }
    await writeFile(resultsPath, JSON.stringify(results, null, 2), "utf8");
    await sleep(1000);
  }

  const reviewPath = path.join(runDir, "review.html");
  await writeFile(reviewPath, reviewHtml(plan, results), "utf8");
  const okCount = Object.values(results.candidates).filter((entry) => entry.status === "ok").length;
  console.log(`\nDone. ${okCount} candidate(s) ready, ${failures} failure(s) this pass.`);
  console.log(`Review sheet: ${path.resolve(reviewPath)}`);
  console.log("Edit a board's notes.json to guide its final render, then:");
  console.log(`  npm run autoboard -- finalize --run ${plan.runId} <variantId> [...]`);
  if (failures) process.exitCode = 1;
}

// Renders candidate.qa (see lib/qa-client.mjs / runQaForCandidate) as a
// compact block under a card: a flagCount badge, the model's summary, and a
// bulleted list of per-item issues plus anything extra it spotted that isn't
// in the reference set. Every piece of model-authored text goes through
// escapeHtml — qa.summary and item.issues/extraObjects are LLM output, not
// trusted markup.
function qaHtml(qa) {
  if (!qa) return "";
  const clean = !qa.flagCount;
  const badge = clean
    ? `<span class="qa-badge qa-clean">QA clean</span>`
    : `<span class="qa-badge qa-flagged">QA: ${qa.flagCount} flag${qa.flagCount === 1 ? "" : "s"}</span>`;
  const bullets = [];
  for (const item of qa.items ?? []) {
    for (const issue of item.issues ?? []) bullets.push(`${item.id}: ${issue}`);
  }
  for (const extra of qa.extraObjects ?? []) bullets.push(`extra: ${extra}`);
  const list = bullets.length
    ? `<ul class="qa-list">${bullets.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>`
    : "";
  const summary = qa.summary ? `<div class="qa-summary">${escapeHtml(qa.summary)}</div>` : "";
  return `<div class="qa">${badge}${summary}${list}</div>`;
}

function reviewHtml(plan, results) {
  const groups = [];
  for (const board of plan.boards) {
    const cards = [];
    for (const variant of plan.variants) {
      const variantId = `${board.id}--${variant.key}`;
      const result = results.candidates[variantId];
      if (result?.status !== "ok") continue;
      const finalized = results.finals?.[variantId];
      // The live image is whatever revision was last drafted, not necessarily
      // the original "<key>.<ext>" — a redraft/confirm overwrites savedPath
      // with a "<key>-r<N>.<ext>" file, and the extension itself tracks
      // whatever format that render actually came back as (see mimeType).
      const imageSrc = path.relative(path.join(RUNS_ROOT, plan.runId), result.savedPath).replaceAll("\\", "/");
      const revision = result.revision ?? 1;
      const noteEntries = Object.entries(result.appliedNotes ?? {});
      const notesLine = noteEntries.length
        ? `<div class="notes">notes applied (rev ${revision}): ${noteEntries.map(([slotId, note]) => `<b>${escapeHtml(slotId)}</b>: ${escapeHtml(note)}`).join("; ")}</div>`
        : "";
      cards.push(`
      <figure class="card">
        <img src="${escapeHtml(imageSrc)}" alt="${escapeHtml(variantId)}" loading="lazy">
        <figcaption>
          <strong>${escapeHtml(variant.key)}</strong> — ${escapeHtml(variant.composition)} / ${escapeHtml(variant.density)} / ${escapeHtml(variant.styling)} / ${escapeHtml(variant.lighting)}
          ${revision > 1 ? `<span class="rev">revision ${revision}</span>` : ""}
          ${finalized ? `<span class="final">FINALIZED (job ${escapeHtml(finalized.jobId ?? "?")})</span>` : ""}
          ${notesLine}
          ${qaHtml(result.qa)}
          <code>Edit notes.json, then: npm run autoboard -- redraft --run ${escapeHtml(plan.runId)} ${escapeHtml(variantId)}</code>
          <code>npm run autoboard -- finalize --run ${escapeHtml(plan.runId)} ${escapeHtml(variantId)}</code>
        </figcaption>
      </figure>`);
    }
    if (!cards.length) continue;
    const slots = board.items.map((item) => `${item.slotId}: ${escapeHtml(item.name)}`).join("<br>");
    const notesPath = path.relative(path.join(RUNS_ROOT, plan.runId), notesFilePath(runDirFor(plan.runId), board.id)).replaceAll("\\", "/");
    groups.push(`
    <section>
      <h2>${escapeHtml(board.title)}</h2>
      <details><summary>${board.items.length} items · ${escapeHtml(notesPath)}</summary><p>${slots}</p></details>
      <div class="grid">${cards.join("\n")}</div>
    </section>`);
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Autoboard review — ${escapeHtml(plan.runId)}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem; background: #fafaf8; color: #1a1a1a; }
  h1 { font-size: 1.4rem; } h2 { font-size: 1.1rem; margin-top: 2.5rem; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(420px, 1fr)); gap: 1.5rem; }
  .card { margin: 0; border: 1px solid #ddd; border-radius: 8px; overflow: hidden; background: #fff; }
  .card img { width: 100%; display: block; }
  .card figcaption { padding: 0.75rem; font-size: 0.85rem; line-height: 1.5; }
  .card code { display: block; margin-top: 0.5rem; padding: 0.4rem; background: #f0f0ec; border-radius: 4px; font-size: 0.75rem; user-select: all; overflow-x: auto; }
  .final { display: inline-block; margin-left: 0.5rem; padding: 0.1rem 0.4rem; background: #14532d; color: #fff; border-radius: 4px; font-size: 0.7rem; }
  .rev { display: inline-block; margin-left: 0.5rem; padding: 0.1rem 0.4rem; background: #7c4a03; color: #fff; border-radius: 4px; font-size: 0.7rem; }
  .notes { margin-top: 0.4rem; padding: 0.4rem; background: #fff8e6; border-radius: 4px; font-size: 0.78rem; }
  .qa { margin-top: 0.4rem; font-size: 0.78rem; }
  .qa-badge { display: inline-block; padding: 0.1rem 0.4rem; border-radius: 4px; font-size: 0.7rem; color: #fff; }
  .qa-badge.qa-clean { background: #14532d; }
  .qa-badge.qa-flagged { background: #92400e; }
  .qa-summary { margin-top: 0.3rem; color: #444; }
  .qa-list { margin: 0.3rem 0 0; padding-left: 1.1rem; color: #555; }
  details { margin: 0.5rem 0 1rem; font-size: 0.85rem; color: #555; }
</style>
</head>
<body>
<h1>Autoboard review — ${escapeHtml(plan.runId)}</h1>
<p>Source: ${escapeHtml(plan.source)} · Generated ${escapeHtml(new Date().toISOString())}. To guide a board's final render: edit its notes.json (path shown under each board's item list), run <code>redraft</code>, review the new image here, then run <code>finalize</code>. Finalize refuses to run if notes.json has edits that were never redrafted and reviewed.</p>
${groups.join("\n")}
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// redraft — apply notes.json and re-render at cheap studio quality so the
// effect of hand-authored notes can be reviewed BEFORE anything reaches
// final quality or the Library. This is the only path that applies notes.json;
// `finalize` only ever locks in whatever a redraft (or the original generate)
// already produced and the applied notes it recorded.
// ---------------------------------------------------------------------------

async function commandRedraft(values, variantIds) {
  if (!values.run) throw new Error("Pass --run <run-id>.");
  if (!variantIds.length) throw new Error("Pass at least one variantId (e.g. penthouse-kitchen-material--A).");
  const runDir = runDirFor(values.run);
  const plan = await readJson(path.join(runDir, "plan.json"));
  const resultsPath = path.join(runDir, "results.json");
  const results = await readJson(resultsPath, { candidates: {}, finals: {} });
  const baseUrl = (values["base-url"] ?? "http://localhost:3000").replace(/\/+$/, "");
  // Standing rule (user preference, 2026-08-30): every draft render uses the
  // cheapest quality tier by default. Only finalize/batch-finalize stay at
  // high quality, since those are the actual deliverable.
  const quality = values.quality ?? "low";
  // Finding F12: drafts render at "standard" (1536x1024) by default now, not
  // "studio" (2048x1360) — --resolution studio restores the old behavior.
  const outputResolution = resolveDraftResolution(values);
  const formatOptions = resolveFormatOptions(values);
  const apiKey = loadOpenAIKey();
  await waitForServer(baseUrl);
  const qaState = { disabled: false };

  for (const variantId of variantIds) {
    const separator = variantId.lastIndexOf("--");
    if (separator === -1) throw new Error(`"${variantId}" is not a valid variantId (expected <boardId>--<variantKey>).`);
    const boardId = variantId.slice(0, separator);
    const variantKey = variantId.slice(separator + 2);
    const board = plan.boards.find((entry) => entry.id === boardId);
    const variant = plan.variants.find((entry) => entry.key === variantKey);
    if (!board || !variant) throw new Error(`"${variantId}" does not match any board/variant in run ${plan.runId}.`);
    const candidate = results.candidates[variantId];
    if (candidate?.status !== "ok" || !existsSync(candidate.savedPath)) {
      throw new Error(`Candidate ${variantId} has no rendered draft yet. Run \`generate\` first.`);
    }

    const overrides = readNoteOverrides(runDir, boardId);
    const knownSlotIds = new Set(board.items.map((item) => item.slotId));
    const unknownSlotIds = [...overrides.keys()].filter((slotId) => !knownSlotIds.has(slotId));
    if (unknownSlotIds.length) {
      throw new Error(
        `${notesFilePath(runDir, boardId)} has a note for unknown slot(s) [${unknownSlotIds.join(", ")}]. ` +
          `This board's slots are: [${[...knownSlotIds].join(", ")}].`,
      );
    }
    if (overridesEqual(overrides, candidate.appliedNotes)) {
      console.log(`  ${variantId}: notes.json matches what's already drafted (revision ${candidate.revision ?? 1}) — nothing to redraft.`);
      continue;
    }
    const { items: notedItems, appliedSlotIds } = applyNoteOverrides(board.items, overrides);
    const boardForDraft = { ...board, items: notedItems };

    const payload = boardPayload(boardForDraft, variant, {
      quality,
      outputResolution,
      renderKind: "studio",
      layoutReference: true,
      apiKey,
    });
    Object.assign(payload, formatOptions);
    validateCollageRequest(payload);
    const referenceFiles = boardReferenceFiles(boardForDraft);
    const files = [{ path: candidate.savedPath, name: "approved-draft.png" }, ...referenceFiles];

    process.stdout.write(`  redrafting ${variantId} (notes: [${appliedSlotIds.join(", ") || "none"}]) ... `);
    const startedAt = Date.now();
    const json = await postWithRetry(baseUrl, payload, files);
    const nextRevision = (candidate.revision ?? 1) + 1;
    const savedPath = path.join(runDir, "boards", boardId, `${variant.key}-r${nextRevision}${extensionForMime(json.mimeType)}`);
    await writeFile(savedPath, Buffer.from(json.imageBase64, "base64"));
    results.candidates[variantId] = {
      ...candidate,
      savedPath,
      mimeType: json.mimeType ?? "image/png",
      jobId: json.jobId ?? null,
      renderKind: json.renderKind,
      notice: json.notice ?? null,
      revision: nextRevision,
      appliedNotes: overridesToObject(overrides),
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
    };
    console.log(`ok (${Math.round((Date.now() - startedAt) / 1000)}s)${resizeNote(json.resizedReferenceCount)}, now revision ${nextRevision}`);
    // QA compares against the item's own reference photos, not the approved-
    // draft layout reference prepended to `files` above — so it gets the
    // plain per-item file list (referenceFiles), same as generate's `files`.
    results.candidates[variantId].qa = await runQaForCandidate({
      baseUrl, values, payload, files: referenceFiles, savedPath, jobId: json.jobId, qaState,
    });
    await writeFile(resultsPath, JSON.stringify(results, null, 2), "utf8");
  }

  const reviewPath = path.join(runDir, "review.html");
  await writeFile(reviewPath, reviewHtml(plan, results), "utf8");
  console.log(`\nReview the redraft(s) before finalizing: ${path.resolve(reviewPath)}`);
}

// ---------------------------------------------------------------------------
// confirm — finding F8: one ~$0.04 medium render of the picked variant before
// the high-quality final, to lock in composition at a better tier. Reuses
// exactly what redraft does to attach the approved draft as Image 1 and
// apply the board's notes.json, but — unlike redraft — never refuses or
// skips when notes.json is unchanged; confirming a composition that's
// already right (no notes edits at all) is the common case, not an error.
// ---------------------------------------------------------------------------

async function commandConfirm(values, variantIds) {
  if (!values.run) throw new Error("Pass --run <run-id>.");
  if (!variantIds.length) throw new Error("Pass at least one variantId (e.g. penthouse-kitchen-material--A).");
  const runDir = runDirFor(values.run);
  const plan = await readJson(path.join(runDir, "plan.json"));
  const resultsPath = path.join(runDir, "results.json");
  const results = await readJson(resultsPath, { candidates: {}, finals: {} });
  const baseUrl = (values["base-url"] ?? "http://localhost:3000").replace(/\/+$/, "");
  // Unlike a draft's "low", confirm defaults to "medium" — a step up to lock
  // composition in before paying for the high-quality final.
  const quality = values.quality ?? "medium";
  const outputResolution = resolveDraftResolution(values);
  const formatOptions = resolveFormatOptions(values);
  const apiKey = loadOpenAIKey();

  // Resolved up front so --dry-run needs no network call and reports exactly
  // what a real run would do.
  const jobs = [];
  for (const variantId of variantIds) {
    const separator = variantId.lastIndexOf("--");
    if (separator === -1) throw new Error(`"${variantId}" is not a valid variantId (expected <boardId>--<variantKey>).`);
    const boardId = variantId.slice(0, separator);
    const variantKey = variantId.slice(separator + 2);
    const board = plan.boards.find((entry) => entry.id === boardId);
    const variant = plan.variants.find((entry) => entry.key === variantKey);
    if (!board || !variant) throw new Error(`"${variantId}" does not match any board/variant in run ${plan.runId}.`);
    const candidate = results.candidates[variantId];
    if (candidate?.status !== "ok" || !existsSync(candidate.savedPath)) {
      throw new Error(`Candidate ${variantId} has no rendered draft yet. Run \`generate\` first.`);
    }

    const overrides = readNoteOverrides(runDir, boardId);
    const knownSlotIds = new Set(board.items.map((item) => item.slotId));
    const unknownSlotIds = [...overrides.keys()].filter((slotId) => !knownSlotIds.has(slotId));
    if (unknownSlotIds.length) {
      throw new Error(
        `${notesFilePath(runDir, boardId)} has a note for unknown slot(s) [${unknownSlotIds.join(", ")}]. ` +
          `This board's slots are: [${[...knownSlotIds].join(", ")}].`,
      );
    }
    // No overridesEqual gate here (unlike redraft) — confirm's whole purpose
    // is locking in a tier bump, which is worth doing even with zero notes
    // changes since the last draft.
    const { items: notedItems, appliedSlotIds } = applyNoteOverrides(board.items, overrides);
    const boardForDraft = { ...board, items: notedItems };
    jobs.push({ variantId, boardId, variant, candidate, boardForDraft, overrides, appliedSlotIds });
  }

  if (values["dry-run"]) {
    console.log(`DRY RUN — ${jobs.length} confirm render(s) would be made against ${baseUrl} at quality "${quality}", resolution "${outputResolution}":`);
    for (const job of jobs) {
      const referenceCount = boardReferenceFiles(job.boardForDraft).length + 1; // +1 for the approved draft as Image 1
      const nextRevision = (job.candidate.revision ?? 1) + 1;
      console.log(
        `  ${job.variantId}  (revision ${job.candidate.revision ?? 1} -> ${nextRevision}, ${referenceCount} reference image(s), notes: [${job.appliedSlotIds.join(", ") || "none"}])`,
      );
    }
    if (!values["no-qa"]) {
      console.log(`  QA: would run against ${baseUrl}/api/qa${values["qa-model"] ? ` (model ${values["qa-model"]})` : ""}`);
    }
    return;
  }

  console.log(`Confirming ${jobs.length} candidate(s) against ${baseUrl} at quality "${quality}"...`);
  await waitForServer(baseUrl);
  const qaState = { disabled: false };

  for (const job of jobs) {
    const { variantId, boardId, variant, candidate, boardForDraft, overrides, appliedSlotIds } = job;
    const payload = boardPayload(boardForDraft, variant, {
      quality,
      outputResolution,
      renderKind: "studio",
      layoutReference: true,
      apiKey,
    });
    Object.assign(payload, formatOptions);
    validateCollageRequest(payload);
    const referenceFiles = boardReferenceFiles(boardForDraft);
    const files = [{ path: candidate.savedPath, name: "approved-draft.png" }, ...referenceFiles];

    process.stdout.write(`  confirming ${variantId} at quality "${quality}" (notes: [${appliedSlotIds.join(", ") || "none"}]) ... `);
    const startedAt = Date.now();
    const json = await postWithRetry(baseUrl, payload, files);
    const nextRevision = (candidate.revision ?? 1) + 1;
    const savedPath = path.join(runDir, "boards", boardId, `${variant.key}-r${nextRevision}${extensionForMime(json.mimeType)}`);
    await writeFile(savedPath, Buffer.from(json.imageBase64, "base64"));
    results.candidates[variantId] = {
      ...candidate,
      savedPath,
      mimeType: json.mimeType ?? "image/png",
      jobId: json.jobId ?? null,
      renderKind: json.renderKind,
      notice: json.notice ?? null,
      revision: nextRevision,
      appliedNotes: overridesToObject(overrides),
      confirmedAt: new Date().toISOString(),
      quality,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
    };
    console.log(`ok (${Math.round((Date.now() - startedAt) / 1000)}s)${resizeNote(json.resizedReferenceCount)}, now revision ${nextRevision}`);
    // Same reasoning as redraft: QA gets the plain per-item reference files,
    // not `files` (which has the approved-draft layout reference prepended).
    results.candidates[variantId].qa = await runQaForCandidate({
      baseUrl, values, payload, files: referenceFiles, savedPath, jobId: json.jobId, qaState,
    });
    await writeFile(resultsPath, JSON.stringify(results, null, 2), "utf8");
  }

  const reviewPath = path.join(runDir, "review.html");
  await writeFile(reviewPath, reviewHtml(plan, results), "utf8");
  console.log(
    `\nConfirmed ${jobs.length} candidate(s) at quality "${quality}". Finalize when ready: npm run autoboard -- finalize --run ${plan.runId} <variantId> [...]`,
  );
}

// ---------------------------------------------------------------------------
// Shared by finalize and batch-finalize: resolve a variantId to its board,
// with the same review-gate enforced either way — finalize (immediate) and
// batch-finalize (economy) both only ever lock in what a reviewed redraft
// already produced, never a live, possibly-unreviewed notes.json edit.
// ---------------------------------------------------------------------------

function resolveApprovedBoard(plan, runDir, results, variantId) {
  const separator = variantId.lastIndexOf("--");
  if (separator === -1) throw new Error(`"${variantId}" is not a valid variantId (expected <boardId>--<variantKey>).`);
  const boardId = variantId.slice(0, separator);
  const variantKey = variantId.slice(separator + 2);
  const board = plan.boards.find((entry) => entry.id === boardId);
  const variant = plan.variants.find((entry) => entry.key === variantKey);
  if (!board || !variant) throw new Error(`"${variantId}" does not match any board/variant in run ${plan.runId}.`);
  const candidate = results.candidates[variantId];
  if (candidate?.status !== "ok" || !existsSync(candidate.savedPath)) {
    throw new Error(`Candidate ${variantId} has no rendered draft. Run \`generate\` first.`);
  }

  // Never read notes.json's live content here — only what a reviewed redraft
  // already recorded as `appliedNotes` on this candidate. If notes.json has
  // since diverged (edited but not redrafted and reviewed), refuse: the user
  // must see a draft with those notes before anything gets finalized.
  const liveOverrides = readNoteOverrides(runDir, board.id);
  if (!overridesEqual(liveOverrides, candidate.appliedNotes)) {
    throw new Error(
      `${notesFilePath(runDir, board.id)} has edits that were never drafted and reviewed. ` +
        `Run \`npm run autoboard -- redraft --run ${plan.runId} ${variantId}\`, review the result, then finalize.`,
    );
  }
  const appliedOverrides = new Map(Object.entries(candidate.appliedNotes ?? {}));
  const { items: notedItems, appliedSlotIds } = applyNoteOverrides(board.items, appliedOverrides);
  const boardForFinal = { ...board, items: notedItems };
  return { board, variant, candidate, boardForFinal, appliedSlotIds };
}

// ---------------------------------------------------------------------------
// finalize
// ---------------------------------------------------------------------------

async function commandFinalize(values, variantIds) {
  if (!values.run) throw new Error("Pass --run <run-id>.");
  if (!variantIds.length) throw new Error("Pass at least one variantId (e.g. penthouse-kitchen-material--A).");
  const runDir = runDirFor(values.run);
  const plan = await readJson(path.join(runDir, "plan.json"));
  const resultsPath = path.join(runDir, "results.json");
  const results = await readJson(resultsPath, { candidates: {}, finals: {} });
  results.finals ??= {};
  const baseUrl = (values["base-url"] ?? "http://localhost:3000").replace(/\/+$/, "");
  const quality = values.quality ?? "high";
  const apiKey = loadOpenAIKey();
  await waitForServer(baseUrl);

  for (const variantId of variantIds) {
    const { board, variant, candidate, boardForFinal, appliedSlotIds } = resolveApprovedBoard(plan, runDir, results, variantId);

    const payload = boardPayload(boardForFinal, variant, {
      quality,
      outputResolution: "final",
      renderKind: "final",
      layoutReference: true,
      apiKey,
    });
    validateCollageRequest(payload);
    // The approved draft must be the FIRST multipart image; product
    // references follow in item order (see app/api/generate/route.ts).
    const files = [{ path: candidate.savedPath, name: "approved-draft.png" }, ...boardReferenceFiles(boardForFinal)];

    process.stdout.write(`  finalizing ${variantId} (revision ${candidate.revision ?? 1}) ... `);
    if (appliedSlotIds.length) console.log(`\n    reviewed notes carried into final: [${appliedSlotIds.join(", ")}]`);
    const startedAt = Date.now();
    const json = await postWithRetry(baseUrl, payload, files);
    const finalPath = path.join(runDir, "boards", board.id, `${variant.key}-final.png`);
    await writeFile(finalPath, Buffer.from(json.imageBase64, "base64"));
    results.finals[variantId] = {
      jobId: json.jobId ?? null,
      savedPath: finalPath,
      libraryVisible: json.libraryVisible ?? false,
      notice: json.notice ?? null,
      appliedNoteSlotIds: appliedSlotIds,
      completedAt: new Date().toISOString(),
    };
    await writeFile(resultsPath, JSON.stringify(results, null, 2), "utf8");
    console.log(`  ok (${Math.round((Date.now() - startedAt) / 1000)}s)${resizeNote(json.resizedReferenceCount)} — job ${json.jobId ?? "?"}${json.libraryVisible ? ", visible in Library" : ""}`);
  }

  const reviewPath = path.join(runDir, "review.html");
  await writeFile(reviewPath, reviewHtml(plan, results), "utf8");
  console.log(`\nFinalized ${variantIds.length} board(s). Check the app Library (/api/library or the Library page).`);
}

// ---------------------------------------------------------------------------
// batch-finalize / batch-status — the app's "economy" mode: the same final
// render, submitted through OpenAI's Batch API for roughly half the price
// (see app/api/economy/route.ts), at the cost of not being immediate — a
// batch can take up to 24h, so submission and collection are separate steps.
// Same review gate as finalize: only ever submits what a reviewed redraft
// already produced.
// ---------------------------------------------------------------------------

async function commandBatchFinalize(values, variantIds) {
  if (!values.run) throw new Error("Pass --run <run-id>.");
  if (!variantIds.length) throw new Error("Pass at least one variantId (e.g. penthouse-kitchen-material--A).");
  const runDir = runDirFor(values.run);
  const plan = await readJson(path.join(runDir, "plan.json"));
  const resultsPath = path.join(runDir, "results.json");
  const results = await readJson(resultsPath, { candidates: {}, finals: {}, economy: {} });
  results.economy ??= {};
  const baseUrl = (values["base-url"] ?? "http://localhost:3000").replace(/\/+$/, "");
  const apiKey = loadOpenAIKey();
  await waitForServer(baseUrl);

  for (const variantId of variantIds) {
    const { board, variant, candidate, boardForFinal, appliedSlotIds } = resolveApprovedBoard(plan, runDir, results, variantId);

    process.stdout.write(`  uploading references for ${variantId} ... `);
    const uploadStarted = Date.now();
    const layoutReferenceFileId = await uploadFileToOpenAI(baseUrl, activeAccessHeaders, candidate.savedPath, apiKey);
    const fileIdsBySlot = new Map();
    for (const item of boardForFinal.items) {
      const fileIds = [];
      for (const imagePath of item.images) {
        fileIds.push(await uploadFileToOpenAI(baseUrl, activeAccessHeaders, imagePath, apiKey));
      }
      fileIdsBySlot.set(item.slotId, fileIds);
    }
    console.log(`ok (${Math.round((Date.now() - uploadStarted) / 1000)}s, ${fileIdsBySlot.size + 1} file(s))`);

    const payload = boardPayload(boardForFinal, variant, {
      quality: "high",
      outputResolution: "final",
      renderKind: "final",
      layoutReference: true,
      layoutReferenceFileId,
      fileIdsBySlot,
      apiKey,
    });
    validateCollageRequest(payload);

    process.stdout.write(`  submitting ${variantId} to the batch queue ... `);
    if (appliedSlotIds.length) console.log(`\n    reviewed notes carried into final: [${appliedSlotIds.join(", ")}]`);
    const response = await fetch(`${baseUrl}/api/economy`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...activeAccessHeaders },
      body: JSON.stringify({ payload }),
    });
    const json = await response.json().catch(() => null);
    if (!response.ok || !json?.ok) {
      throw new Error(json?.error ?? json?.message ?? `HTTP ${response.status} from /api/economy`);
    }
    results.economy[variantId] = {
      jobId: json.jobId,
      status: json.status,
      estimatedUsd: json.estimatedUsd,
      appliedNoteSlotIds: appliedSlotIds,
      submittedAt: new Date().toISOString(),
      savedPath: null,
    };
    await writeFile(resultsPath, JSON.stringify(results, null, 2), "utf8");
    console.log(`ok — job ${json.jobId} (${json.status}, ~$${json.estimatedUsd?.toFixed?.(2) ?? json.estimatedUsd})`);
  }

  console.log(
    `\nSubmitted ${variantIds.length} board(s) to the batch queue (up to 24h). ` +
      `Check progress with: npm run autoboard -- batch-status --run ${plan.runId}`,
  );
}

// ---------------------------------------------------------------------------
// review — local web page for browsing/swapping each slot's pick before
// generating anything. Saves directly into plan.json; no --base-url or
// Access credentials needed since it never touches the deployed app.
// ---------------------------------------------------------------------------

async function commandReview(values) {
  if (!values.run) throw new Error("Pass --run <run-id>.");
  const runDir = runDirFor(values.run);
  const planPath = path.join(runDir, "plan.json");
  if (!existsSync(planPath)) throw new Error(`${planPath} does not exist. Run \`plan\` first.`);
  const port = Number(values.port) || 4790;
  await startReviewServer({ runDir, planPath, port, renderReviewPage });
  console.log(`Review UI running at http://127.0.0.1:${port} — open it in a browser.`);
  console.log("Changes save directly into plan.json as you make them. Press Ctrl+C to stop.");
}

async function commandBatchStatus(values) {
  if (!values.run) throw new Error("Pass --run <run-id>.");
  const runDir = runDirFor(values.run);
  const plan = await readJson(path.join(runDir, "plan.json"));
  const resultsPath = path.join(runDir, "results.json");
  const results = await readJson(resultsPath, { candidates: {}, finals: {}, economy: {} });
  results.economy ??= {};
  const entries = Object.entries(results.economy);
  if (!entries.length) {
    console.log("No batch (economy) submissions recorded for this run yet — use `batch-finalize` first.");
    return;
  }

  const baseUrl = (values["base-url"] ?? "http://localhost:3000").replace(/\/+$/, "");
  await waitForServer(baseUrl);
  // GET /api/economy refreshes every pending economy job server-side before
  // returning the list — this call is what actually advances a batch's
  // status, not just reads it.
  const response = await fetch(`${baseUrl}/api/economy`, { headers: activeAccessHeaders });
  const json = await response.json().catch(() => null);
  if (!response.ok || !json?.ok) throw new Error(json?.error ?? `HTTP ${response.status} from /api/economy`);
  const jobsById = new Map(json.jobs.map((job) => [job.id, job]));

  let changed = false;
  for (const [variantId, submission] of entries) {
    const job = jobsById.get(submission.jobId);
    if (!job) {
      console.log(`  ${variantId}: job ${submission.jobId} not found (may have expired — six-month retention)`);
      continue;
    }
    if (job.status === "completed" && !submission.savedPath) {
      const separator = variantId.lastIndexOf("--");
      const boardId = variantId.slice(0, separator);
      const variantKey = variantId.slice(separator + 2);
      const imageResponse = await fetch(`${baseUrl}/api/economy/output/${encodeURIComponent(submission.jobId)}`, {
        headers: activeAccessHeaders,
      });
      if (imageResponse.ok) {
        const savedPath = path.join(runDir, "boards", boardId, `${variantKey}-batch.png`);
        mkdirSync(path.dirname(savedPath), { recursive: true });
        await writeFile(savedPath, Buffer.from(await imageResponse.arrayBuffer()));
        results.economy[variantId] = { ...submission, status: job.status, savedPath, libraryVisible: job.libraryVisible };
        changed = true;
        console.log(`  ${variantId}: completed — saved ${savedPath}${job.libraryVisible ? " (visible in Library)" : ""}`);
        continue;
      }
    }
    if (job.status !== submission.status) {
      results.economy[variantId] = { ...submission, status: job.status, error: job.error ?? null };
      changed = true;
    }
    console.log(`  ${variantId}: ${job.status}${job.error ? ` — ${job.error}` : ""}`);
  }
  if (changed) await writeFile(resultsPath, JSON.stringify(results, null, 2), "utf8");
}

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------

const { values, positionals } = parseArgs({
  options: {
    offline: { type: "boolean" },
    unit: { type: "string" },
    room: { type: "string" },
    run: { type: "string" },
    boards: { type: "string" },
    "dry-run": { type: "boolean" },
    variants: { type: "string" },
    quality: { type: "string" },
    resolution: { type: "string" },
    format: { type: "string" },
    compression: { type: "string" },
    "base-url": { type: "string" },
    "library-root": { type: "string" },
    "images-per-item": { type: "string" },
    "min-slots": { type: "string" },
    port: { type: "string" },
    force: { type: "boolean" },
    "no-qa": { type: "boolean" },
    "qa-model": { type: "string" },
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: true,
});

const command = positionals[0];
try {
  if (values.help || !command) {
    usage();
  } else if (command === "plan") {
    await commandPlan(values);
  } else if (command === "generate") {
    await commandGenerate(values);
  } else if (command === "redraft") {
    await commandRedraft(values, positionals.slice(1));
  } else if (command === "confirm") {
    await commandConfirm(values, positionals.slice(1));
  } else if (command === "finalize") {
    await commandFinalize(values, positionals.slice(1));
  } else if (command === "batch-finalize") {
    await commandBatchFinalize(values, positionals.slice(1));
  } else if (command === "batch-status") {
    await commandBatchStatus(values);
  } else if (command === "review") {
    await commandReview(values);
  } else {
    usage();
    process.exitCode = 2;
  }
} catch (error) {
  console.error(`\nautoboard ${command ?? ""} failed: ${error.message}`);
  process.exitCode = 1;
}
