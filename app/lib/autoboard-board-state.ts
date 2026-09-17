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
// keystroke elsewhere.
export async function saveBoardState(
  projectId: string,
  boardId: string,
  patch: BoardStatePatch,
): Promise<BoardState> {
  const DB = await ensureBoardStateStorage();
  const existing =
    (await DB.prepare("SELECT * FROM autoboard_board_state WHERE project_id = ? AND board_id = ?")
      .bind(projectId, boardId)
      .first<StateRow>()) ?? null;
  const current = existing ? publicState(existing) : emptyBoardState(boardId);

  const notes = { ...current.notes };
  if (patch.notes !== undefined) {
    if (!patch.notes || typeof patch.notes !== "object" || Array.isArray(patch.notes)) {
      throw new Error("notes must be an object of slot id to note.");
    }
    for (const [slotId, note] of Object.entries(patch.notes as Record<string, unknown>)) {
      const text = String(note ?? "").trim();
      // An emptied note is removed rather than stored blank, so selectionHash
      // sees the same material it saw before the note existed.
      if (text) notes[slotId] = text;
      else delete notes[slotId];
    }
  }

  const next: BoardState = {
    boardId,
    instruction: patch.instruction === undefined ? current.instruction : String(patch.instruction ?? "").trim(),
    heroItemId:
      patch.heroItemId === undefined
        ? current.heroItemId
        : String(patch.heroItemId ?? "").trim() || null,
    quality: patch.quality === undefined ? current.quality : validOption(patch.quality, SUNBURST_QUALITY_OPTIONS, "quality"),
    background:
      patch.background === undefined
        ? current.background
        : validOption(patch.background, SUNBURST_BACKGROUND_OPTIONS, "background"),
    notes,
    updatedAt: Date.now(),
  };

  await DB.prepare(
    `INSERT INTO autoboard_board_state
       (project_id, board_id, instruction, hero_item_id, quality, background, notes_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, board_id) DO UPDATE SET
       instruction = excluded.instruction,
       hero_item_id = excluded.hero_item_id,
       quality = excluded.quality,
       background = excluded.background,
       notes_json = excluded.notes_json,
       updated_at = excluded.updated_at`,
  )
    .bind(
      projectId,
      boardId,
      next.instruction,
      next.heroItemId,
      next.quality,
      next.background,
      JSON.stringify(next.notes),
      next.updatedAt,
    )
    .run();
  return next;
}

export async function deleteProjectBoardState(projectId: string): Promise<void> {
  const DB = await ensureBoardStateStorage();
  await DB.prepare("DELETE FROM autoboard_board_state WHERE project_id = ?").bind(projectId).run();
}
