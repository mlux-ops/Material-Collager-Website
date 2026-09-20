// Storage for a person's row edits: hand-added rows, removals and pins.
//
// Kept apart from the project row for the same reason board state is: the
// project's rows are a reading of the sheet, replaced wholesale by a refresh,
// and these are the reviewer's work. Keyed by (project, row, kind), so a row
// can be both pinned and later removed, and restoring it brings the pin back.
//
// The rules for what an edit means live in app/lib/autoboard/row-edits.ts
// (pure); this module only persists them.

import { env } from "cloudflare:workers";
import { emptyRowEdits, manualRow, validatePin, type RowEdits } from "./autoboard/row-edits.ts";
import type { LibraryRow, SlotPin } from "./autoboard/types.ts";

type EditRow = {
  project_id: string;
  row_id: string;
  kind: string;
  payload_json: string;
  created_at: number;
};

type RuntimeEnv = { DB?: D1Database };

let schemaReady: Promise<D1Database> | null = null;

export function ensureRowEditStorage(): Promise<D1Database> {
  schemaReady ??= initRowEditStorage().catch((error) => {
    schemaReady = null;
    throw error;
  });
  return schemaReady;
}

async function initRowEditStorage(): Promise<D1Database> {
  const { DB } = env as unknown as RuntimeEnv;
  if (!DB) throw new Error("The review board is not configured on this deployment (no D1 binding `DB`).");
  await DB.prepare(`CREATE TABLE IF NOT EXISTS autoboard_row_edits (
    project_id TEXT NOT NULL,
    row_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, row_id, kind)
  )`).run();
  await DB.prepare(
    "CREATE INDEX IF NOT EXISTS autoboard_row_edits_project ON autoboard_row_edits (project_id, created_at)",
  ).run();
  return DB;
}

function parse<T>(json: string): T | null {
  try {
    return JSON.parse(json) as T;
  } catch {
    // One unreadable edit is not worth failing the whole project over; it is
    // skipped, and the row it described falls back to what the sheet says.
    return null;
  }
}

// Rows arrive ordered by created_at, so manual rows keep the order they were
// added in — the order applyRowEdits appends them in.
function fold(rows: EditRow[]): RowEdits {
  const edits = emptyRowEdits();
  for (const row of rows) {
    if (row.kind === "manual") {
      const parsed = parse<LibraryRow>(row.payload_json);
      if (parsed) edits.manual.push(parsed);
    } else if (row.kind === "excluded") {
      const parsed = parse<LibraryRow>(row.payload_json);
      if (parsed) edits.excluded.set(row.row_id, parsed);
    } else if (row.kind === "pin") {
      const parsed = parse<SlotPin>(row.payload_json);
      if (parsed) edits.pins.set(row.row_id, parsed);
    }
  }
  return edits;
}

export async function listRowEdits(projectId: string): Promise<RowEdits> {
  const DB = await ensureRowEditStorage();
  const result = await DB.prepare("SELECT * FROM autoboard_row_edits WHERE project_id = ? ORDER BY created_at")
    .bind(projectId)
    .all<EditRow>();
  return fold(result.results);
}

// Every project's edits in one query, for the project list: a list of twenty
// projects should not cost twenty round trips to say how many boards each has.
export async function listAllRowEdits(): Promise<Map<string, RowEdits>> {
  const DB = await ensureRowEditStorage();
  const result = await DB.prepare("SELECT * FROM autoboard_row_edits ORDER BY created_at").all<EditRow>();
  const byProject = new Map<string, EditRow[]>();
  for (const row of result.results) {
    if (!byProject.has(row.project_id)) byProject.set(row.project_id, []);
    byProject.get(row.project_id)!.push(row);
  }
  return new Map([...byProject].map(([projectId, rows]) => [projectId, fold(rows)]));
}

async function put(projectId: string, rowId: string, kind: string, payload: unknown): Promise<void> {
  const DB = await ensureRowEditStorage();
  await DB.prepare(
    `INSERT INTO autoboard_row_edits (project_id, row_id, kind, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(project_id, row_id, kind) DO UPDATE SET payload_json = excluded.payload_json`,
  )
    .bind(projectId, rowId, kind, JSON.stringify(payload), Date.now())
    .run();
}

async function drop(projectId: string, rowId: string, kind: string): Promise<void> {
  const DB = await ensureRowEditStorage();
  await DB.prepare("DELETE FROM autoboard_row_edits WHERE project_id = ? AND row_id = ? AND kind = ?")
    .bind(projectId, rowId, kind)
    .run();
}

export async function addManualRow(projectId: string, input: Record<string, unknown>): Promise<LibraryRow> {
  const row = manualRow(input);
  await put(projectId, row.rowId, "manual", row);
  return row;
}

// Removing stores the row as it was, so the Removed list can show it after a
// refresh has replaced the rows; restoring is forgetting the exclusion.
export async function setRowExcluded(projectId: string, rowId: string, snapshot: LibraryRow | null): Promise<void> {
  if (snapshot) await put(projectId, rowId, "excluded", snapshot);
  else await drop(projectId, rowId, "excluded");
}

export async function setRowPin(projectId: string, rowId: string, pin: unknown | null): Promise<SlotPin | null> {
  if (pin === null || pin === undefined || pin === "") {
    await drop(projectId, rowId, "pin");
    return null;
  }
  const valid = validatePin(pin);
  await put(projectId, rowId, "pin", valid);
  return valid;
}

export async function deleteProjectRowEdits(projectId: string): Promise<void> {
  const DB = await ensureRowEditStorage();
  await DB.prepare("DELETE FROM autoboard_row_edits WHERE project_id = ?").bind(projectId).run();
}
