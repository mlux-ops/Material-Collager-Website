// Storage for the web review board's projects.
//
// A project is one Smartsheet, narrowed to the subsection a person picked, with
// the rows as they read at build time and the slot preview those rows produce.
// The rows are stored rather than re-fetched on every view: a board is a record
// of what the sheet said when it was built, and a live sheet changes under you.
// `refreshProject` is the explicit way to take a new reading.
//
// Tables are created lazily, matching generation-jobs.ts, so a fresh deployment
// needs no separate migration step.

import { env } from "cloudflare:workers";
import { buildGenerationPrompt } from "./collage.ts";
import { buildBoards } from "./autoboard/match.ts";
import { DEFAULT_VARIANTS, boardPayload } from "./autoboard/variants.ts";
import {
  boardForRender,
  renderOptionsHash,
  resolveRenderOptions,
  selectionHash,
} from "./autoboard/render-options.ts";
import { deleteProjectBoardState, emptyBoardState, listBoardState, type BoardState } from "./autoboard-board-state.ts";
import { deleteProjectRenders } from "./autoboard-renders.ts";
import { previewBoards, filterRows, type BoardsPreview, type SubsectionFilter } from "./autoboard/preview.ts";
import { emptyGaps, loadSmartsheetRows } from "./autoboard/source.ts";
import type { Board, Gaps, LibraryRow } from "./autoboard/types.ts";
import { deleteProjectPhotos, selectedImagesByRow } from "./autoboard-photos.ts";

export type AutoboardProject = {
  id: string;
  name: string;
  sheetId: string;
  source: string;
  filter: SubsectionFilter;
  rowCount: number;
  boardCount: number;
  createdAt: number;
  updatedAt: number;
};

export type AutoboardProjectDetail = AutoboardProject & {
  rows: LibraryRow[];
  preview: BoardsPreview;
};

type ProjectRow = {
  id: string;
  name: string;
  sheet_id: string;
  source: string;
  filter_json: string;
  rows_json: string;
  preview_json: string;
  created_at: number;
  updated_at: number;
};

type RuntimeEnv = { DB?: D1Database; SMARTSHEET_ACCESS_TOKEN?: string };

function runtime(): RuntimeEnv {
  return env as unknown as RuntimeEnv;
}

// A D1 TEXT value is capped at 1 MB and a whole row at 2 MB. A filtered
// subsection is a few dozen rows, but an unfiltered sheet of several thousand
// would silently blow past it, so the write refuses early with a message that
// says what to do instead.
const MAX_STORED_JSON_BYTES = 800_000;

let schemaReady: Promise<D1Database> | null = null;

export function ensureProjectStorage(): Promise<D1Database> {
  schemaReady ??= initProjectStorage().catch((error) => {
    schemaReady = null;
    throw error;
  });
  return schemaReady;
}

async function initProjectStorage(): Promise<D1Database> {
  const { DB } = runtime();
  if (!DB) throw new Error("The review board is not configured on this deployment (no D1 binding `DB`).");
  await DB.prepare(`CREATE TABLE IF NOT EXISTS autoboard_projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    sheet_id TEXT NOT NULL,
    source TEXT NOT NULL,
    filter_json TEXT NOT NULL,
    rows_json TEXT NOT NULL,
    preview_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`).run();
  await DB.prepare(
    "CREATE INDEX IF NOT EXISTS autoboard_projects_updated ON autoboard_projects (updated_at DESC)",
  ).run();
  return DB;
}

export function smartsheetToken(): string {
  const token = runtime().SMARTSHEET_ACCESS_TOKEN;
  if (!token) {
    throw new Error(
      "SMARTSHEET_ACCESS_TOKEN is not set. Add it with `wrangler secret put SMARTSHEET_ACCESS_TOKEN`, " +
        "or to .dev.vars for local development.",
    );
  }
  return token;
}

export function projectId(): string {
  return `proj-${crypto.randomUUID()}`;
}

function publicProject(row: ProjectRow): AutoboardProject {
  const preview = JSON.parse(row.preview_json) as BoardsPreview;
  return {
    id: row.id,
    name: row.name,
    sheetId: row.sheet_id,
    source: row.source,
    filter: JSON.parse(row.filter_json) as SubsectionFilter,
    rowCount: (JSON.parse(row.rows_json) as LibraryRow[]).length,
    boardCount: preview.boards.length,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function detailFrom(row: ProjectRow): AutoboardProjectDetail {
  return {
    ...publicProject(row),
    rows: JSON.parse(row.rows_json) as LibraryRow[],
    preview: JSON.parse(row.preview_json) as BoardsPreview,
  };
}

// Reads a sheet and narrows it, without touching storage. The sheet picker uses
// this to show what is in a sheet before anyone commits to a project.
export async function readSheet(sheetId: string, filter: SubsectionFilter = {}) {
  const { rows, gaps, source } = await loadSmartsheetRows({ token: smartsheetToken(), sheetId });
  const selected = filterRows(rows, filter);
  return { rows: selected, allRows: rows, gaps, source };
}

function assertStorable(rowsJson: string, previewJson: string) {
  const bytes = rowsJson.length + previewJson.length;
  if (bytes > MAX_STORED_JSON_BYTES) {
    throw new Error(
      `This selection is ${Math.round(bytes / 1000)} KB, over the ${Math.round(MAX_STORED_JSON_BYTES / 1000)} KB a ` +
        "project row can hold. Narrow it to fewer unit types or rooms and build one project per subsection.",
    );
  }
}

export async function createProject(input: {
  name: string;
  sheetId: string;
  filter?: SubsectionFilter;
}): Promise<AutoboardProjectDetail> {
  const DB = await ensureProjectStorage();
  const filter = input.filter ?? {};
  const { rows, source } = await readSheet(input.sheetId, filter);
  const preview = previewBoards(rows);

  const rowsJson = JSON.stringify(rows);
  const previewJson = JSON.stringify(preview);
  assertStorable(rowsJson, previewJson);

  const now = Date.now();
  const row: ProjectRow = {
    id: projectId(),
    name: input.name.trim() || `Sheet ${input.sheetId}`,
    sheet_id: input.sheetId,
    source,
    filter_json: JSON.stringify(filter),
    rows_json: rowsJson,
    preview_json: previewJson,
    created_at: now,
    updated_at: now,
  };
  await DB.prepare(
    `INSERT INTO autoboard_projects
       (id, name, sheet_id, source, filter_json, rows_json, preview_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      row.id,
      row.name,
      row.sheet_id,
      row.source,
      row.filter_json,
      row.rows_json,
      row.preview_json,
      row.created_at,
      row.updated_at,
    )
    .run();
  return detailFrom(row);
}

export async function listProjects(): Promise<AutoboardProject[]> {
  const DB = await ensureProjectStorage();
  const result = await DB.prepare(
    "SELECT * FROM autoboard_projects ORDER BY updated_at DESC",
  ).all<ProjectRow>();
  return result.results.map(publicProject);
}

export async function getProject(id: string): Promise<AutoboardProjectDetail | null> {
  const DB = await ensureProjectStorage();
  const row = await DB.prepare("SELECT * FROM autoboard_projects WHERE id = ?").bind(id).first<ProjectRow>();
  return row ? detailFrom(row) : null;
}

export async function deleteProject(id: string): Promise<boolean> {
  const DB = await ensureProjectStorage();
  // Photos first: a project row deleted while its photos remain leaves R2
  // objects nothing will ever reference again.
  await deleteProjectPhotos(id);
  await deleteProjectBoardState(id);
  await deleteProjectRenders(id);
  const result = await DB.prepare("DELETE FROM autoboard_projects WHERE id = ?").bind(id).run();
  return Boolean(result.meta?.changes);
}

/**
 * The real boards, built from the photos a person selected.
 *
 * This is the payoff of the preview step and the edge half of buildBoards'
 * injected-resolver contract: the resolver must be SYNCHRONOUS, so the async
 * lookup happens once, up front, and what buildBoards receives is a plain Map
 * read. A row with no selected photo yields no images, so buildBoards records it
 * in gaps.imagelessItems and leaves the slot empty — exactly as it does on the
 * CLI when a library folder is empty.
 */
export type BuiltBoard = Board & {
  state: BoardState;
  /** Hash of everything the model sees. A render is current only while it matches. */
  selectionHash: string;
  renderOptions: { quality: string; background: string };
  /** Recorded on every render, so a board can say which of its renders are stale. */
  renderOptionsHash: string;
  /** The prompt this board would send, from the app's own builder. */
  prompt: string;
  referenceCount: number;
};

// Reference images here are /api/autoboard/photos/<id> urls, never filesystem
// paths, so the last path segment IS the name. The CLI injects node:path's
// basename instead, because its locations are Windows paths.
const urlBasename = (location: string) => location.split("/").pop() ?? location;

export async function buildProjectBoards(
  project: AutoboardProjectDetail,
): Promise<{ boards: BuiltBoard[]; gaps: Gaps }> {
  const [byRow, state] = await Promise.all([selectedImagesByRow(project.id), listBoardState(project.id)]);
  const gaps = emptyGaps();
  const { boards } = buildBoards(project.rows, {
    resolveImages: (rowId) => byRow.get(rowId) ?? [],
    gaps,
  });

  return {
    gaps,
    boards: boards.map((board) => {
      const boardState = state.get(board.id) ?? emptyBoardState(board.id);
      // The reviewer's decisions are applied to a COPY. They are stored per
      // board and survive a sheet refresh, so they must not be written back
      // into the rows a refresh replaces.
      const withState: Board = {
        ...board,
        heroItemId: boardState.heroItemId ?? undefined,
        renderOptions: {
          ...(boardState.quality ? { quality: boardState.quality } : {}),
          ...(boardState.background ? { background: boardState.background } : {}),
        },
        items: board.items.map((item) => ({ ...item, note: boardState.notes[item.slotId] ?? undefined })),
      };
      const renderOptions = resolveRenderOptions(withState, "draft");
      // boardForRender is what the model actually receives: it folds each
      // slot's note in and hangs the board instruction off the hero item.
      const payload = boardPayload(boardForRender(withState, boardState.instruction), DEFAULT_VARIANTS[0], {
        ...renderOptions,
        basename: urlBasename,
      });
      return {
        ...withState,
        state: boardState,
        selectionHash: selectionHash(withState, boardState.instruction),
        renderOptions,
        renderOptionsHash: renderOptionsHash(renderOptions),
        prompt: buildGenerationPrompt(payload as never),
        referenceCount: withState.items.reduce((sum, item) => sum + item.images.length, 0),
      };
    }),
  };
}

export async function refreshProject(id: string): Promise<AutoboardProjectDetail | null> {
  const DB = await ensureProjectStorage();
  const existing = await DB.prepare("SELECT * FROM autoboard_projects WHERE id = ?").bind(id).first<ProjectRow>();
  if (!existing) return null;

  const filter = JSON.parse(existing.filter_json) as SubsectionFilter;
  const { rows, source } = await readSheet(existing.sheet_id, filter);
  const preview = previewBoards(rows);
  const rowsJson = JSON.stringify(rows);
  const previewJson = JSON.stringify(preview);
  assertStorable(rowsJson, previewJson);

  const updated: ProjectRow = {
    ...existing,
    source,
    rows_json: rowsJson,
    preview_json: previewJson,
    updated_at: Date.now(),
  };
  await DB.prepare(
    "UPDATE autoboard_projects SET source = ?, rows_json = ?, preview_json = ?, updated_at = ? WHERE id = ?",
  )
    .bind(updated.source, updated.rows_json, updated.preview_json, updated.updated_at, id)
    .run();
  return detailFrom(updated);
}

export async function renameProject(id: string, name: string): Promise<boolean> {
  const DB = await ensureProjectStorage();
  const trimmed = name.trim();
  if (!trimmed) throw new Error("A project needs a name.");
  const result = await DB.prepare("UPDATE autoboard_projects SET name = ?, updated_at = ? WHERE id = ?")
    .bind(trimmed, Date.now(), id)
    .run();
  return Boolean(result.meta?.changes);
}
