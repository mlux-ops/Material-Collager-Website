// Autoboard data ingestion: reads unit/room/item rows from the Wieland Master
// Library, either live from Smartsheet or offline from build_manifest_v2.csv.
// Precision rule: trust the Unit Type / Room Type COLUMNS, never the sheet's
// row hierarchy (see Presentation/HANDOFF_1529_Wieland_2026-08-26.md §2), and
// report every ambiguous or unusable row as a gap instead of guessing.

import { readFile } from "node:fs/promises";
import path from "node:path";

export const SMARTSHEET_SHEET_ID = "8569278453206916";
export const DEFAULT_LIBRARY_ROOT = "H:\\Games\\1529 Wieland - Master Library";

// ---------------------------------------------------------------------------
// CSV parsing (RFC-4180 style: quoted fields, embedded commas/newlines, "").
// ---------------------------------------------------------------------------

export function parseCsv(text) {
  const clean = text.replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < clean.length; i++) {
    const character = clean[i];
    if (inQuotes) {
      if (character === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += character;
      }
    } else if (character === '"') {
      inQuotes = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else if (character !== "\r") {
      field += character;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
}

export function csvObjects(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const headers = rows[0].map((header) => header.trim());
  return rows.slice(1).map((cells) => {
    const record = {};
    headers.forEach((header, index) => {
      record[header] = (cells[index] ?? "").trim();
    });
    return record;
  });
}

// ---------------------------------------------------------------------------
// Room label normalization. The library uses inconsistent labels for the same
// room ("Bath 2" vs "Bathroom 2", "Primary Bath" vs "Primary Bathroom").
// Aliases merge labels that are demonstrably the same room in this dataset.
// ---------------------------------------------------------------------------

const ROOM_ALIASES = new Map([
  ["kitchen pendant", "Kitchen"], // pendant lights tagged as their own "room"
  ["primary bathroom", "Primary Bath"],
]);

export function normalizeRoomLabel(label) {
  const clean = String(label ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const alias = ROOM_ALIASES.get(clean.toLowerCase());
  if (alias) return alias;
  return clean.replace(/^bathroom\b/i, "Bath");
}

export function roomKey(unitType, roomLabel) {
  return `${String(unitType).trim().toLowerCase()}::${normalizeRoomLabel(roomLabel).toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// Normalized row shape shared by both sources:
// { rowId, unitType, roomLabel (normalized), roomOriginal, costCode,
//   itemName, sku, qty, reference }
// ---------------------------------------------------------------------------

function normalizedRow(raw) {
  return {
    rowId: String(raw.rowId ?? "").trim(),
    unitType: String(raw.unitType ?? "").replace(/\s+/g, " ").trim(),
    roomLabel: normalizeRoomLabel(raw.roomType),
    roomOriginal: String(raw.roomType ?? "").replace(/\s+/g, " ").trim(),
    costCode: String(raw.costCode ?? "").replace(/\s+/g, " ").trim(),
    itemName: String(raw.itemName ?? "").replace(/\s+/g, " ").trim(),
    sku: String(raw.sku ?? "").trim(),
    qty: Number.parseFloat(String(raw.qty ?? "")) || 1,
    reference: String(raw.reference ?? "").trim(),
  };
}

function collectRows(rawRows, gaps) {
  const rows = [];
  for (const raw of rawRows) {
    const row = normalizedRow(raw);
    if (!row.itemName) continue; // parent/blank rows carry no item
    if (!row.unitType) {
      gaps.blankUnitRows.push({ rowId: row.rowId, itemName: row.itemName, sku: row.sku });
      continue;
    }
    if (!row.roomLabel) {
      gaps.blankRoomRows.push({ rowId: row.rowId, itemName: row.itemName, sku: row.sku });
      continue;
    }
    rows.push(row);
  }
  return rows;
}

export function emptyGaps() {
  return {
    blankUnitRows: [],
    blankRoomRows: [],
    unmappedItems: [],
    imagelessItems: [],
    skippedRooms: [],
    slotConflicts: [],
    unfilledSlots: [],
    skippedBoards: [],
  };
}

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
    })),
    gaps,
  );
  return { rows, gaps, source: "offline-manifest" };
}

// ---------------------------------------------------------------------------
// Live source: Smartsheet REST API. Columns are resolved BY TITLE; if a
// required title cannot be found the loader fails loudly and lists the
// sheet's actual column titles so the alternates table below can be fixed.
// ---------------------------------------------------------------------------

const COLUMN_TITLE_ALTERNATES = {
  unitType: ["unit type", "unit"],
  roomType: ["room type", "room"],
  costCode: ["cost code", "cost codes"],
  itemName: ["product name", "item name", "item", "product", "description"],
  sku: ["sku", "model", "model number", "model #"],
  qty: ["qty", "quantity"],
  reference: ["reference", "reference url", "link", "url"],
};

const REQUIRED_COLUMNS = ["unitType", "roomType", "costCode", "itemName", "sku"];

export function resolveColumnIds(columns) {
  const byTitle = new Map(columns.map((column) => [String(column.title).trim().toLowerCase(), column.id]));
  const resolved = {};
  for (const [field, alternates] of Object.entries(COLUMN_TITLE_ALTERNATES)) {
    for (const title of alternates) {
      if (byTitle.has(title)) {
        resolved[field] = byTitle.get(title);
        break;
      }
    }
  }
  const missing = REQUIRED_COLUMNS.filter((field) => !(field in resolved));
  if (missing.length) {
    const actual = columns.map((column) => `"${column.title}"`).join(", ");
    throw new Error(
      `Smartsheet columns for [${missing.join(", ")}] were not found by title. ` +
        `The sheet's columns are: ${actual}. Update COLUMN_TITLE_ALTERNATES in scripts/autoboard/lib/source.mjs.`,
    );
  }
  return resolved;
}

export async function loadSmartsheetRows({ token, sheetId = SMARTSHEET_SHEET_ID, fetchImpl = fetch }) {
  if (!token) {
    throw new Error(
      "Set SMARTSHEET_ACCESS_TOKEN to read the live sheet, or pass --offline to use build_manifest_v2.csv.",
    );
  }
  const response = await fetchImpl(
    `https://api.smartsheet.com/2.0/sheets/${encodeURIComponent(sheetId)}?pageSize=10000`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Smartsheet request failed with HTTP ${response.status}: ${body.slice(0, 300)}`);
  }
  const sheet = await response.json();
  const columnIds = resolveColumnIds(sheet.columns ?? []);
  const gaps = emptyGaps();
  const rawRows = (sheet.rows ?? []).map((row) => {
    const cells = new Map((row.cells ?? []).map((cell) => [cell.columnId, cell]));
    const valueOf = (field) => {
      const cell = cells.get(columnIds[field]);
      if (!cell) return "";
      return cell.displayValue ?? cell.value ?? "";
    };
    return {
      rowId: row.id,
      unitType: valueOf("unitType"),
      roomType: valueOf("roomType"),
      costCode: valueOf("costCode"),
      itemName: valueOf("itemName"),
      sku: valueOf("sku"),
      qty: columnIds.qty ? valueOf("qty") : "",
      reference: columnIds.reference ? valueOf("reference") : "",
    };
  });
  const rows = collectRows(rawRows, gaps);
  return { rows, gaps, source: `smartsheet:${sheetId} (version ${sheet.version ?? "unknown"})` };
}

export async function loadLibraryRows({ offline, libraryRoot, token, sheetId }) {
  if (offline) return loadOfflineRows(libraryRoot);
  return loadSmartsheetRows({ token, sheetId });
}
