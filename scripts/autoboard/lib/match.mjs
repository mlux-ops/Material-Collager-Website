// Autoboard image resolution from the library on disk, plus the CLI's stable
// import surface for the shared analysis core.
//
// The slot rules and board building moved to app/lib/autoboard/match.ts so the
// web review board runs the same code; everything they exported is re-exported
// below, so every existing `from "./match.mjs"` import keeps working unchanged.
// What stays here is what genuinely needs a filesystem: reading _BUILD_LOG.csv
// and turning it into the injected resolveImages function buildBoards takes.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";

import { csvObjects } from "./source.mjs";

export {
  BOARD_KIND_LABELS,
  LIGHTING_SCOPE_LABEL,
  MAX_PRODUCT_REFERENCES,
  applyBoardMerges,
  assignSlots,
  boardTypesForRoom,
  buildBoards,
  extractBrand,
  extractTier,
  groupRowsByUnit,
  isLightFixture,
  isSubstitute,
  lightingFixtures,
  lightingSlotId,
  slugify,
} from "../../../app/lib/autoboard/match.ts";

// ---------------------------------------------------------------------------
// Image resolution from the already-built library on disk. _BUILD_LOG.csv is
// the authoritative row_id -> folder join (the manifest's own folder_path
// column predates the actual build layout and does not match it).
// ---------------------------------------------------------------------------

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tif", ".tiff"]);

function normalizedName(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Smartsheet exports sometimes coerce a text SKU through a numeric column,
// appending a trailing ".0" (e.g. "12345.0"). Strip that along with the usual
// trim/lowercase so SKU comparisons aren't defeated by export formatting.
function normalizeSku(value) {
  return String(value ?? "").trim().toLowerCase().replace(/\.0$/, "");
}

// Reads the build log's row_id -> folder join. Row ids in the live Smartsheet
// get reused across unrelated products over time, so a row-id lookup alone can
// resolve to the wrong product's photos (see match.mjs header comment for the
// GROHE-valve-turned-Hansgrohe-hand-shower case observed 2026-09-06). The
// `bySku` index lets callers fall back to a same-SKU entry elsewhere in the
// log when the row-id entry looks stale or is missing.
export function loadBuildLog(libraryRoot) {
  const logPath = path.join(libraryRoot, "Master_Library_Build", "_BUILD_LOG.csv");
  if (!existsSync(logPath)) {
    throw new Error(`Build log not found at ${logPath}. Run build_library.py in the Master Library first.`);
  }
  const records = csvObjects(readFileSync(logPath, "utf8"));
  const byRowId = new Map();
  const bySku = new Map();
  for (const record of records) {
    const matchedFiles = (record.matched_files ?? "").split(";").map((name) => name.trim()).filter(Boolean);
    const sku = normalizeSku(record.sku);
    const entry = {
      folder: record.folder ?? "",
      matchedFiles,
      sku,
    };
    byRowId.set(String(record.row_id), entry);
    if (sku && matchedFiles.length && !bySku.has(sku)) {
      bySku.set(sku, entry);
    }
  }
  byRowId.bySku = bySku;
  return byRowId;
}

export function makeDiskImageResolver(libraryRoot, buildLog = loadBuildLog(libraryRoot)) {
  const bySku = buildLog.bySku ?? new Map();

  function readFolder(entry) {
    if (!entry?.folder) return [];
    const folder = path.join(libraryRoot, ...entry.folder.split(/[\\/]/));
    if (!existsSync(folder)) return [];
    const files = readdirSync(folder).filter((name) => IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase()));
    const preferredOrder = entry.matchedFiles.map(normalizedName);
    files.sort((a, b) => {
      const aIndex = preferredOrder.indexOf(normalizedName(a));
      const bIndex = preferredOrder.indexOf(normalizedName(b));
      const aRank = aIndex === -1 ? preferredOrder.length : aIndex;
      const bRank = bIndex === -1 ? preferredOrder.length : bIndex;
      return aRank - bRank || a.localeCompare(b);
    });
    return files.map((name) => path.join(folder, name));
  }

  return function resolveImages(rowId, sku) {
    const normalizedSku = sku === undefined ? undefined : normalizeSku(sku);
    const rowEntry = buildLog.get(String(rowId));
    if (rowEntry && (normalizedSku === undefined || !normalizedSku || rowEntry.sku === normalizedSku)) {
      return readFolder(rowEntry);
    }
    // Either there's no row-id entry (new row) or its SKU doesn't match what
    // the caller expects (row id was reused for a different product) — fall
    // back to the first build-log entry for the requested SKU, if any.
    if (normalizedSku) {
      const skuEntry = bySku.get(normalizedSku);
      if (skuEntry) return readFolder(skuEntry);
    }
    return [];
  };
}
