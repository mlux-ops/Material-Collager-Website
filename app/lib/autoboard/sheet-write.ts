// Writing a row INTO a project's Smartsheet.
//
// The review board reads a sheet; this is the one place it writes one. A
// project that has a sheet behind it keeps the sheet as its single record, so
// an item added in the app becomes a row in the sheet — filed under the
// section its Unit Type and Room Type put it in — and then reaches the project
// the way every other row does: by re-reading the sheet. Nothing here touches
// an existing row.
//
// Filing: Smartsheet has no "insert under the right heading" call, so the new
// row is placed as a sibling directly below the LAST existing row whose Unit
// Type and Room Type match the new one (falling back to the last row of the
// same Unit Type, then to the bottom of the sheet). A sheet kept in sections
// therefore grows in the right section without the writer knowing how the
// sections are arranged.
//
// Pure where it can be: sheetSchema and fileNewRow take a fetched sheet and
// return a decision; only fetchSheet and addSheetRow talk to the API.

import { normalizeRoomLabel, resolveColumnIds } from "./source.ts";
import type { SheetColumn, SheetResponse, SheetRow } from "./source.ts";

const API = "https://api.smartsheet.com/2.0";

// Column types a person can type into. Everything else the sheet fills in
// itself — auto-numbers, created/modified stamps, formulas — so those columns
// are left out of the form rather than shown as fields whose values would be
// rejected.
const SYSTEM_TYPES = new Set(["AUTO_NUMBER", "CREATED_BY", "CREATED_DATE", "MODIFIED_BY", "MODIFIED_DATE"]);

export type FieldKind = "text" | "select" | "checkbox";

// One field of the row form, in sheet column order. `field` is the reader's
// name for the column when it is one the reader uses (unitType, roomType,
// itemName, ...), so the form can mark those required and pre-fill them.
export type RowField = {
  key: string;
  label: string;
  kind: FieldKind;
  required: boolean;
  options: string[];
  suggestions: string[];
  field: string | null;
  /** A line under the field, for what a value does that the label cannot say. */
  hint?: string;
};

const REQUIRED_FIELDS = new Set(["itemName", "unitType", "roomType"]);

// How many distinct values a free-text column may have before suggestions stop
// being a help and become the whole column: past this, the field is plain text.
const MAX_SUGGESTIONS = 60;

export function sheetSchema(sheet: SheetResponse): RowField[] {
  const columns = sheet.columns ?? [];
  const rows = sheet.rows ?? [];
  const columnIds = safeColumnIds(columns);
  const fieldByColumn = new Map<string, string>();
  for (const [field, id] of Object.entries(columnIds)) fieldByColumn.set(String(id), field);

  const fields: RowField[] = [];
  for (const column of columns) {
    if (column.systemColumnType && SYSTEM_TYPES.has(column.systemColumnType)) continue;
    if (column.formula) continue;
    const key = String(column.id);
    const field = fieldByColumn.get(key) ?? null;
    const type = column.type ?? "TEXT_NUMBER";
    const kind: FieldKind = type === "CHECKBOX" ? "checkbox" : type === "PICKLIST" ? "select" : "text";
    const options = kind === "select" ? (column.options ?? []).map(String) : [];
    fields.push({
      key,
      label: column.title,
      kind,
      // The reader needs these three to place a row on any board; the sheet
      // itself only insists on the primary column.
      required: Boolean(column.primary) || (field !== null && REQUIRED_FIELDS.has(field)),
      options,
      suggestions: kind === "text" ? distinctValues(rows, column) : [],
      field,
    });
  }
  return fields;
}

// resolveColumnIds throws when a required column is missing. For the form that
// is not fatal — the sheet can still take a row — so the failure degrades to
// "no field is marked as the reader's".
function safeColumnIds(columns: SheetColumn[]): Record<string, number | string> {
  try {
    return resolveColumnIds(columns);
  } catch {
    return {};
  }
}

function distinctValues(rows: SheetRow[], column: SheetColumn): string[] {
  const seen = new Map<string, string>();
  for (const row of rows) {
    const cell = (row.cells ?? []).find((entry) => entry.columnId === column.id);
    const text = String(cell?.displayValue ?? cell?.value ?? "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (!seen.has(key)) seen.set(key, text);
    if (seen.size > MAX_SUGGESTIONS) return [];
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

export type Placement = { siblingId?: number | string; toBottom?: true; after: { rowNumber: number; itemName: string } | null; reason: string };

// Where a new row goes. See the file comment: below the last row that shares
// its Unit Type and Room Type, else the last row of its Unit Type, else the
// bottom of the sheet.
export function fileNewRow(sheet: SheetResponse, values: Record<string, unknown>): Placement {
  const columns = sheet.columns ?? [];
  const columnIds = safeColumnIds(columns);
  const unitId = columnIds.unitType;
  const roomId = columnIds.roomType;
  const nameId = columnIds.itemName;
  const wantedUnit = norm(values[String(unitId)]);
  const wantedRoom = normRoom(values[String(roomId)]);
  if (unitId === undefined || !wantedUnit) return { toBottom: true, after: null, reason: "no unit type to file under" };

  const cellText = (row: SheetRow, columnId: number | string | undefined) => {
    if (columnId === undefined) return "";
    const cell = (row.cells ?? []).find((entry) => entry.columnId === columnId);
    return String(cell?.displayValue ?? cell?.value ?? "");
  };
  const rows = (sheet.rows ?? []).filter((row) => typeof row.rowNumber === "number");
  const sameUnit = rows.filter((row) => norm(cellText(row, unitId)) === wantedUnit);
  const sameRoom = wantedRoom ? sameUnit.filter((row) => normRoom(cellText(row, roomId)) === wantedRoom) : [];
  const pick = (candidates: SheetRow[], reason: string): Placement | null => {
    if (!candidates.length) return null;
    const last = candidates.reduce((best, row) => ((row.rowNumber ?? 0) > (best.rowNumber ?? 0) ? row : best));
    return {
      siblingId: last.id,
      after: { rowNumber: last.rowNumber ?? 0, itemName: cellText(last, nameId) },
      reason,
    };
  };
  return (
    pick(sameRoom, "below the last row of the same unit type and room") ??
    pick(sameUnit, "below the last row of the same unit type; no row of that room exists yet") ??
    { toBottom: true, after: null, reason: "no row of that unit type exists yet" }
  );
}

function norm(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function normRoom(value: unknown): string {
  return normalizeRoomLabel(value).toLowerCase();
}

// What goes on the wire for one cell. Blank text is no cell at all (the sheet
// would store an empty string where it had nothing), an unticked checkbox
// likewise, and a number typed as text is sent as a number so a numeric
// column sums. `strict: false` lets a picklist take a value that is not one
// of its options, the way typing into the cell would.
export function cellValue(kind: FieldKind, raw: unknown): { value: string | number | boolean } | null {
  if (kind === "checkbox") return raw === true || String(raw).toLowerCase() === "true" ? { value: true } : null;
  const text = String(raw ?? "").trim();
  if (!text) return null;
  if (/^-?\d+(\.\d+)?$/.test(text)) return { value: Number(text) };
  return { value: text };
}

export type SheetWriteOptions = { token: string; sheetId: string; fetchImpl?: typeof fetch };

export async function fetchSheet({ token, sheetId, fetchImpl = fetch }: SheetWriteOptions): Promise<SheetResponse> {
  const response = await fetchImpl(`${API}/sheets/${encodeURIComponent(sheetId)}?pageSize=10000`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Smartsheet request failed with HTTP ${response.status}: ${body.slice(0, 300)}`);
  }
  return (await response.json()) as SheetResponse;
}

export type AddedRow = { rowId: string; rowNumber: number | null; placement: Placement };

// Adds one row. `values` is keyed by column id (the form's field keys); fields
// the form did not offer, or left blank, are not sent.
export async function addSheetRow(
  options: SheetWriteOptions & { values: Record<string, unknown> },
): Promise<AddedRow> {
  const { token, sheetId, values, fetchImpl = fetch } = options;
  const sheet = await fetchSheet({ token, sheetId, fetchImpl });
  const fields = sheetSchema(sheet);
  const cells: { columnId: number; value: string | number | boolean; strict: false }[] = [];
  for (const field of fields) {
    const cell = cellValue(field.kind, values[field.key]);
    if (cell) cells.push({ columnId: Number(field.key), ...cell, strict: false });
  }
  const primary = fields.find((field) => field.required && field.field === "itemName") ?? fields.find((field) => field.required);
  if (primary && !cells.some((cell) => String(cell.columnId) === primary.key)) {
    throw new Error(`Give the row a value for "${primary.label}".`);
  }
  if (!cells.length) throw new Error("Nothing to add: every field is blank.");

  const placement = fileNewRow(sheet, values);
  const body: Record<string, unknown> = { cells };
  if (placement.siblingId !== undefined) body.siblingId = placement.siblingId;
  else body.toBottom = true;

  const response = await fetchImpl(`${API}/sheets/${encodeURIComponent(sheetId)}/rows`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify([body]),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Smartsheet refused the new row with HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  const payload = (await response.json()) as { result?: { id?: number | string; rowNumber?: number } | { id?: number | string; rowNumber?: number }[] };
  const result = Array.isArray(payload.result) ? payload.result[0] : payload.result;
  if (!result?.id) throw new Error("Smartsheet accepted the row but returned no row id.");
  return { rowId: String(result.id), rowNumber: typeof result.rowNumber === "number" ? result.rowNumber : null, placement };
}
