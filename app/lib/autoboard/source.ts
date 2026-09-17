// Autoboard data ingestion — the half that needs no filesystem.
//
// CSV parsing, room-label normalization, row normalization and the Smartsheet
// reader all live here so the web review board can read a project sheet with
// the same code the CLI uses. The offline manifest reader stays in
// scripts/autoboard/lib/source.mjs, because it reads a path on disk.
//
// Precision rule (unchanged): trust the Unit Type / Room Type COLUMNS, never
// the sheet's row hierarchy, and report every ambiguous or unusable row as a
// gap instead of guessing.

import type { Gaps, LibraryRow } from "./types.ts";

export const SMARTSHEET_SHEET_ID = "8569278453206916";

// ---------------------------------------------------------------------------
// CSV parsing (RFC-4180 style: quoted fields, embedded commas/newlines, "").
// ---------------------------------------------------------------------------

export function parseCsv(text: string): string[][] {
  const clean = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
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

export function csvObjects(text: string): Record<string, string>[] {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const headers = rows[0].map((header) => header.trim());
  return rows.slice(1).map((cells) => {
    const record: Record<string, string> = {};
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

export function normalizeRoomLabel(label: unknown): string {
  const clean = String(label ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const alias = ROOM_ALIASES.get(clean.toLowerCase());
  if (alias) return alias;
  return clean.replace(/^bathroom\b/i, "Bath");
}

export function roomKey(unitType: unknown, roomLabel: unknown): string {
  return `${String(unitType).trim().toLowerCase()}::${normalizeRoomLabel(roomLabel).toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// Normalized row shape shared by both sources.
// ---------------------------------------------------------------------------

// A project definition marks each row `preferred`, `alternative` or `pending`
// (see scripts/autoboard/projects/). Only `alternative` changes behaviour: it
// means "a substitute for another row", never an additional material, so
// match.ts keeps it out of automatic slot assignment. Anything else, including
// a blank from a source that has no such column, is treated as a normal row.
function normalizedStatus(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

type RawRow = Record<string, unknown>;

export function normalizedRow(raw: RawRow): LibraryRow {
  return {
    rowId: String(raw.rowId ?? "").trim(),
    status: normalizedStatus(raw.status),
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

export function collectRows(rawRows: RawRow[], gaps: Gaps): LibraryRow[] {
  const rows: LibraryRow[] = [];
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

export function emptyGaps(): Gaps {
  return {
    blankUnitRows: [],
    blankRoomRows: [],
    substituteCandidates: [],
    unmappedItems: [],
    imagelessItems: [],
    skippedRooms: [],
    slotConflicts: [],
    unfilledSlots: [],
    skippedBoards: [],
    lowResolutionReferences: [],
    mergedBoards: [],
  };
}

// ---------------------------------------------------------------------------
// Live source: Smartsheet REST API. Columns are resolved BY TITLE; if a
// required title cannot be found the loader fails loudly and lists the
// sheet's actual column titles so the alternates table below can be fixed.
// ---------------------------------------------------------------------------

const COLUMN_TITLE_ALTERNATES: Record<string, string[]> = {
  unitType: ["unit type", "unit"],
  roomType: ["room type", "room"],
  costCode: ["cost code", "cost codes"],
  itemName: ["product name", "item name", "item", "product", "description"],
  sku: ["sku", "model", "model number", "model #"],
  qty: ["qty", "quantity"],
  reference: ["reference", "reference url", "link", "url"],
};

const REQUIRED_COLUMNS = ["unitType", "roomType", "costCode", "itemName", "sku"];

export type SheetColumn = { id: number | string; title: string };

export type SheetCell = {
  columnId: number | string;
  displayValue?: string;
  value?: string | number;
};

export type SheetRow = { id: number | string; cells?: SheetCell[] };

export type SheetResponse = {
  columns?: SheetColumn[];
  rows?: SheetRow[];
  version?: number | string;
};

export function resolveColumnIds(columns: SheetColumn[]): Record<string, number | string> {
  const byTitle = new Map(columns.map((column) => [String(column.title).trim().toLowerCase(), column.id]));
  const resolved: Record<string, number | string> = {};
  for (const [field, alternates] of Object.entries(COLUMN_TITLE_ALTERNATES)) {
    for (const title of alternates) {
      if (byTitle.has(title)) {
        resolved[field] = byTitle.get(title)!;
        break;
      }
    }
  }
  const missing = REQUIRED_COLUMNS.filter((field) => !(field in resolved));
  if (missing.length) {
    const actual = columns.map((column) => `"${column.title}"`).join(", ");
    // The pointer below names source.mjs deliberately: it is the message this
    // has always printed, and COLUMN_TITLE_ALTERNATES moving here does not make
    // an operator's saved runbook wrong overnight. It is re-exported from that
    // path, so the file the message names still leads here.
    throw new Error(
      `Smartsheet columns for [${missing.join(", ")}] were not found by title. ` +
        `The sheet's columns are: ${actual}. Update COLUMN_TITLE_ALTERNATES in scripts/autoboard/lib/source.mjs.`,
    );
  }
  return resolved;
}

export type SmartsheetOptions = {
  token: string;
  sheetId?: string;
  fetchImpl?: typeof fetch;
};

export async function loadSmartsheetRows({
  token,
  sheetId = SMARTSHEET_SHEET_ID,
  fetchImpl = fetch,
}: SmartsheetOptions): Promise<{ rows: LibraryRow[]; gaps: Gaps; source: string }> {
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
  const sheet = (await response.json()) as SheetResponse;
  const columnIds = resolveColumnIds(sheet.columns ?? []);
  const gaps = emptyGaps();
  const rawRows = (sheet.rows ?? []).map((row: SheetRow) => {
    const cells = new Map((row.cells ?? []).map((cell) => [cell.columnId, cell]));
    const valueOf = (field: string) => {
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
