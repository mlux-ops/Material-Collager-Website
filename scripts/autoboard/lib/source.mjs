// Autoboard data ingestion — the CLI's disk-backed source, plus the stable
// import surface for the shared ingestion core.
//
// CSV parsing, room-label normalization, row normalization and the Smartsheet
// reader moved to app/lib/autoboard/source.ts so the web review board can read
// a project sheet with the same code. They are re-exported below, so every
// existing `from "./source.mjs"` import keeps working unchanged. What stays
// here is the offline manifest reader, which reads a path on disk.

import { readFile } from "node:fs/promises";
import path from "node:path";

import { collectRows, csvObjects, emptyGaps, loadSmartsheetRows } from "../../../app/lib/autoboard/source.ts";

export {
  SMARTSHEET_SHEET_ID,
  collectRows,
  csvObjects,
  emptyGaps,
  loadSmartsheetRows,
  normalizeRoomLabel,
  normalizedRow,
  parseCsv,
  resolveColumnIds,
  roomKey,
} from "../../../app/lib/autoboard/source.ts";

export const DEFAULT_LIBRARY_ROOT = "H:\\Games\\1529 Wieland - Master Library";

// ---------------------------------------------------------------------------
// Offline source: build_manifest_v2.csv
// ---------------------------------------------------------------------------

export async function loadOfflineRows(libraryRoot) {
  const manifestPath = path.join(libraryRoot, "build_manifest_v2.csv");
  const text = await readFile(manifestPath, "utf8");
  const records = csvObjects(text);
  const required = ["row_id", "unit_type", "room_type", "cost_code", "item_name", "sku"];
  const headers = records.length ? Object.keys(records[0]) : [];
  const missing = required.filter((column) => !headers.includes(column));
  if (missing.length) {
    throw new Error(
      `Manifest ${manifestPath} is missing expected columns [${missing.join(", ")}]. Found: [${headers.join(", ")}].`,
    );
  }
  const gaps = emptyGaps();
  const rows = collectRows(
    records.map((record) => ({
      rowId: record.row_id,
      unitType: record.unit_type,
      roomType: record.room_type,
      costCode: record.cost_code,
      itemName: record.item_name,
      sku: record.sku,
      qty: record.qty,
      reference: record.reference,
      status: record.status,
    })),
    gaps,
  );
  return { rows, gaps, source: "offline-manifest" };
}

export async function loadLibraryRows({ offline, libraryRoot, token, sheetId }) {
  if (offline) return loadOfflineRows(libraryRoot);
  return loadSmartsheetRows({ token, sheetId });
}
