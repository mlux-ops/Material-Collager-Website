// The reviewer's decisions about a board: the board-level instruction, a note
// per slot, which slot anchors the composition, and the render options.
//
// Kept apart from the project row because it changes on a different clock. A
// project's rows are a reading of the sheet, replaced wholesale by a refresh;
// this is a person's work, and a refresh must not throw it away. Keying on
// (project, board) rather than a row id is what makes that survivable — board
// ids are derived from unit type, room and board kind, so a board that still
// exists after a refresh keeps its notes.

import { env } from "cloudflare:workers";
import {
  SUNBURST_BACKGROUND_OPTIONS,
  SUNBURST_QUALITY_OPTIONS,
} from "./autoboard/render-options.ts";

export type BoardState = {
  boardId: string;
  instruction: string;
  heroItemId: string | null;
  quality: string | null;
  background: string | null;
  notes: Record<string, string>;
  updatedAt: number;
};

type StateRow = {
  project_id: string;
  board_id: string;
  instruction: string;
  hero_item_id: string | null;
  quality: string | null;
  background: string | null;
  notes_json: string;
  updated_at: number;
};

type RuntimeEnv = { DB?: D1Database };

let schemaReady: Promise<D1Database> | null = null;

export function ensureBoardStateStorage(): Promise<D1Database> {
  schemaReady ??= initBoardStateStorage().catch((error) => {
    schemaReady = null;
    throw error;
  });
  return schemaReady;
}

async function initBoardStateStorage(): Promise<D1Database> {
  const { DB } = env as unknown as RuntimeEnv;
  if (!DB) throw new Error("The review board is not configured on this deployment (no D1 binding `DB`).");
  await DB.prepare(`CREATE TABLE IF NOT EXISTS autoboard_board_state (
    project_id TEXT NOT NULL,
    board_id TEXT NOT NULL,
    instruction TEXT NOT NULL DEFAULT '',
    hero_item_id TEXT,
    quality TEXT,
    background TEXT,
    notes_json TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, board_id)
  )`).run();
  return DB;
}

function publicState(row: StateRow): BoardState {
  let notes: Record<string, string> = {};
  try {
    const parsed: unknown = JSON.parse(row.notes_json);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) notes = parsed as Record<string, string>;
  } catch {
    // A note that cannot be parsed is not worth failing a page render over;
    // the board is still usable with none.
  }
  return {
    boardId: row.board_id,
    instruction: row.instruction,
    heroItemId: row.hero_item_id,
    quality: row.quality,
    background: row.background,
    notes,
    updatedAt: row.updated_at,
  };
}

export function emptyBoardState(boardId: string): BoardState {
  return { boardId, instruction: "", heroItemId: null, quality: null, background: null, notes: {}, updatedAt: 0 };
}

export async function listBoardState(projectId: string): Promise<Map<string, BoardState>> {
  const DB = await ensureBoardStateStorage();
  const result = await DB.prepare("SELECT * FROM autoboard_board_state WHERE project_id = ?")
    .bind(projectId)
    .all<StateRow>();
  return new Map(result.results.map((row) => [row.board_id, publicState(row)]));
}

export type BoardStatePatch = {
  instruction?: unknown;
  heroItemId?: unknown;
  quality?: unknown;
  background?: unknown;
  notes?: unknown;
};

function validOption(value: unknown, allowed: string[], field: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value);
  if (!allowed.includes(text)) {
    throw new Error(`${field} must be one of ${allowed.join(", ")}.`);
  }
  return text;
}

// A patch, not a replacement: the UI saves one field at a time, and a partial
// write that blanked the others would lose a reviewer's notes on every
// keystroke elsewhere. So the write names only the columns the patch carries,
// and notes are merged by SQLite itself (json_patch) instead of being read,
// merged here and written back. Two saves that overlap — a dropdown change
// while a typed note is still in flight — must both land, and a
// read-merge-write lets the later one restore the earlier one's stale snapshot.
// The insert and the update run as one batch, which D1 executes atomically.
export async function saveBoardState(
  projectId: string,
  boardId: string,
  patch: BoardStatePatch,
): Promise<BoardState> {
  const DB = await ensureBoardStateStorage();
  const now = Date.now();
  const sets = ["updated_at = ?"];
  const values: (string | number | null)[] = [now];
  if (patch.instruction !== undefined) {
    sets.push("instruction = ?");
    values.push(String(patch.instruction ?? "").trim());
  }
  if (patch.heroItemId !== undefined) {
    sets.push("hero_item_id = ?");
    values.push(String(patch.heroItemId ?? "").trim() || null);
  }
  if (patch.quality !== undefined) {
    sets.push("quality = ?");
    values.push(validOption(patch.quality, SUNBURST_QUALITY_OPTIONS, "quality"));
  }
  if (patch.background !== undefined) {
    sets.push("background = ?");
    values.push(validOption(patch.background, SUNBURST_BACKGROUND_OPTIONS, "background"));
  }
  if (patch.notes !== undefined) {
    // A stored value that is not valid JSON restarts from {} rather than
    // failing every later save, matching publicState, which reads it as none.
    sets.push("notes_json = json_patch(CASE WHEN json_valid(notes_json) THEN notes_json ELSE '{}' END, ?)");
    values.push(JSON.stringify(notesMergePatch(patch.notes)));
  }

  await DB.batch([
    DB.prepare("INSERT OR IGNORE INTO autoboard_board_state (project_id, board_id, updated_at) VALUES (?, ?, ?)")
      .bind(projectId, boardId, now),
    DB.prepare(`UPDATE autoboard_board_state SET ${sets.join(", ")} WHERE project_id = ? AND board_id = ?`)
      .bind(...values, projectId, boardId),
  ]);
  const row = await DB.prepare("SELECT * FROM autoboard_board_state WHERE project_id = ? AND board_id = ?")
    .bind(projectId, boardId)
    .first<StateRow>();
  return row ? publicState(row) : emptyBoardState(boardId);
}

// The notes part of a patch as a JSON merge patch (RFC 7396), which is what
// json_patch applies: a note sets its slot, and an emptied note becomes null,
// which removes the slot. Removing rather than storing blank keeps
// selectionHash seeing the same material it saw before the note existed.
function notesMergePatch(notes: unknown): Record<string, string | null> {
  if (!notes || typeof notes !== "object" || Array.isArray(notes)) {
    throw new Error("notes must be an object of slot id to note.");
  }
  const merge: Record<string, string | null> = {};
  for (const [slotId, note] of Object.entries(notes as Record<string, unknown>)) {
    merge[slotId] = String(note ?? "").trim() || null;
  }
  return merge;
}

export async function deleteProjectBoardState(projectId: string): Promise<void> {
  const DB = await ensureBoardStateStorage();
  await DB.prepare("DELETE FROM autoboard_board_state WHERE project_id = ?").bind(projectId).run();
}
