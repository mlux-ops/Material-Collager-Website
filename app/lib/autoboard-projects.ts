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
import { applyRowEdits, emptyRowEdits, excludeBoards, type RemovedBoardSnapshot, type RowEdits } from "./autoboard/row-edits.ts";
import { addSheetRow, fetchSheet, sheetSchema, type RowField } from "./autoboard/sheet-write.ts";
import { collectRows, emptyGaps, loadSmartsheetRows } from "./autoboard/source.ts";
import type { Board, Gaps, LibraryRow, SlotPin } from "./autoboard/types.ts";
import { deleteProjectPhotos, selectedImagesByRow } from "./autoboard-photos.ts";
import {
  addManualRow,
  deleteProjectRowEdits,
  listAllRowEdits,
  listRowEdits,
  setBoardExcluded,
  setRowExcluded,
  setRowPin,
} from "./autoboard-row-edits.ts";

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

// The reviewer's edits as the UI sees them: what was removed (as it was when
// removed, so it can be shown and restored after a refresh), which rows are
// pinned where, and which rows were added by hand.
export type ProjectEdits = {
  removed: LibraryRow[];
  removedBoards: RemovedBoardSnapshot[];
  pins: Record<string, SlotPin>;
  manualRowIds: string[];
};

export type AutoboardProjectDetail = AutoboardProject & {
  /** The rows the boards are built from: the stored reading plus the edits. */
  rows: LibraryRow[];
  preview: BoardsPreview;
  edits: ProjectEdits;
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

type RuntimeEnv = {
  DB?: D1Database;
  // In production this is a Secrets Store binding (wrangler.jsonc
  // `secrets_store_secrets`), which arrives as an object with an async get(),
  // not a string. It is a plain string when set as a Worker secret or in
  // .dev.vars. The reader takes either shape.
  SMARTSHEET_ACCESS_TOKEN?: string | SecretsStoreSecret;
};

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

// Reads the token from whichever place holds it: the Secrets Store binding
// (production), a plain string binding (a Worker secret, or .dev.vars in local
// dev), or process.env, which nodejs_compat fills from string bindings and is
// the path OPENAI_API_KEY already uses. When none has it, the error says which
// step failed and lists the bindings the Worker DOES see — a secret that is in
// the wrong store, under a misspelt name, or without the Workers scope each
// shows up as a specific message rather than a bare "not set".
export async function smartsheetToken(): Promise<string> {
  const bound = runtime().SMARTSHEET_ACCESS_TOKEN;
  let storeProblem = "";
  if (bound && typeof bound === "object") {
    try {
      const value = (await bound.get()).trim();
      if (value) return value;
      storeProblem = "the Secrets Store entry is empty";
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      storeProblem = `the Secrets Store binding could not be read (${detail})`;
    }
  }
  const plain = (typeof bound === "string" ? bound.trim() : "") || process.env.SMARTSHEET_ACCESS_TOKEN?.trim();
  if (plain) return plain;
  if (storeProblem) {
    throw new Error(
      `SMARTSHEET_ACCESS_TOKEN is bound to the Secrets Store, but ${storeProblem}. In the Cloudflare dashboard ` +
        "(Storage & databases → Secrets Store) check that a secret named SMARTSHEET_ACCESS_TOKEN exists in the " +
        "store wrangler.jsonc names, with the Workers scope. For local dev, create a local copy: " +
        "`npx wrangler secrets-store secret create <store-id> --name SMARTSHEET_ACCESS_TOKEN --scopes workers`, " +
        "or put it in .dev.vars.",
    );
  }
  const visible = Object.keys(runtime()).sort();
  throw new Error(
    "SMARTSHEET_ACCESS_TOKEN is not set on this Worker" +
      (visible.length ? ` (it sees: ${visible.join(", ")})` : " (it sees no bindings at all)") +
      ". wrangler.jsonc should bind it from the Secrets Store (`secrets_store_secrets`); failing that, add it as a " +
      "Worker secret with `npx wrangler secret put SMARTSHEET_ACCESS_TOKEN`. For local dev, put it in .dev.vars.",
  );
}

export function projectId(): string {
  return `proj-${crypto.randomUUID()}`;
}

// The preview is derived on every read rather than read back from
// preview_json: from the stored rows — the record of what the sheet said at
// build time, which stay fixed — with the reviewer's edits applied on top
// (app/lib/autoboard/row-edits.ts). Both are pure functions of stored data, so
// a change to the slot rules reaches every existing project, and an edit shows
// the moment it is saved. preview_json is still written, for older readers and
// as a record of what the picker showed when the project was created.
function storedPreview(row: ProjectRow, edits: RowEdits): { rows: LibraryRow[]; preview: BoardsPreview } {
  const stored = JSON.parse(row.rows_json) as LibraryRow[];
  const rows = applyRowEdits(stored, edits);
  const preview = previewBoards(rows, { pins: edits.pins });
  return { rows, preview: { ...preview, boards: excludeBoards(preview.boards, edits.excludedBoards.keys()) } };
}

function publicProject(row: ProjectRow, edits: RowEdits): AutoboardProject {
  const { rows, preview } = storedPreview(row, edits);
  return {
    id: row.id,
    name: row.name,
    sheetId: row.sheet_id,
    source: row.source,
    filter: JSON.parse(row.filter_json) as SubsectionFilter,
    rowCount: rows.length,
    boardCount: preview.boards.length,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function detailFrom(row: ProjectRow, edits: RowEdits): AutoboardProjectDetail {
  return {
    ...publicProject(row, edits),
    ...storedPreview(row, edits),
    edits: {
      removed: [...edits.excluded.values()],
      removedBoards: [...edits.excludedBoards.values()],
      pins: Object.fromEntries(edits.pins),
      manualRowIds: edits.manual.map((manual) => manual.rowId),
    },
  };
}

async function detailFor(row: ProjectRow): Promise<AutoboardProjectDetail> {
  return detailFrom(row, await listRowEdits(row.id));
}

async function projectRow(id: string): Promise<ProjectRow | null> {
  const DB = await ensureProjectStorage();
  return (await DB.prepare("SELECT * FROM autoboard_projects WHERE id = ?").bind(id).first<ProjectRow>()) ?? null;
}

// Reads a sheet and narrows it, without touching storage. The sheet picker uses
// this to show what is in a sheet before anyone commits to a project.
export async function readSheet(sheetId: string, filter: SubsectionFilter = {}) {
  const { rows, gaps, source } = await loadSmartsheetRows({ token: await smartsheetToken(), sheetId });
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
  return detailFrom(row, emptyRowEdits());
}

/**
 * A project from rows supplied directly, rather than read from a sheet.
 *
 * This is how a tracked project definition (scripts/autoboard/projects/) gets
 * onto the web board: those projects have no Smartsheet of their own, which is
 * the whole reason they exist as files. The rows are normalized and gap-checked
 * by the SAME collectRows the sheet reader uses, so a hand-supplied row cannot
 * enter in a shape the sheet path would have rejected.
 *
 * `source` is recorded verbatim so a stored project always says where it came
 * from; refreshProject deliberately does not work on one of these, because
 * there is no sheet to re-read.
 */
export async function createProjectFromRows(input: {
  name: string;
  rows: unknown[];
  source?: string;
}): Promise<AutoboardProjectDetail> {
  const DB = await ensureProjectStorage();
  if (!Array.isArray(input.rows) || !input.rows.length) throw new Error("Give at least one row.");

  const gaps = emptyGaps();
  const rows = collectRows(input.rows as Record<string, unknown>[], gaps);
  if (!rows.length) {
    throw new Error(
      "None of those rows were usable — each needs an item name, a unit type and a room type.",
    );
  }
  const preview = previewBoards(rows);
  const rowsJson = JSON.stringify(rows);
  const previewJson = JSON.stringify(preview);
  assertStorable(rowsJson, previewJson);

  const now = Date.now();
  const row: ProjectRow = {
    id: projectId(),
    name: input.name.trim() || "Imported project",
    // No sheet to refresh from. Stored empty rather than faked, so a refresh
    // fails loudly instead of silently reading someone else's sheet.
    sheet_id: "",
    source: input.source?.trim() || "imported rows",
    filter_json: JSON.stringify({}),
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
      row.id, row.name, row.sheet_id, row.source, row.filter_json,
      row.rows_json, row.preview_json, row.created_at, row.updated_at,
    )
    .run();
  return detailFrom(row, emptyRowEdits());
}

/**
 * A project with nothing in it yet: no sheet, no rows. Everything it will hold
 * is added by hand (addProjectRow), stored as manual rows beside it, and it
 * builds boards from those exactly as a sheet-backed project builds from its
 * reading. Like an imported project it has no sheet to refresh from.
 */
export async function createBlankProject(input: { name: string }): Promise<AutoboardProjectDetail> {
  const DB = await ensureProjectStorage();
  const now = Date.now();
  const row: ProjectRow = {
    id: projectId(),
    name: input.name.trim() || "Untitled project",
    sheet_id: "",
    source: "blank project",
    filter_json: JSON.stringify({}),
    rows_json: "[]",
    preview_json: JSON.stringify(previewBoards([])),
    created_at: now,
    updated_at: now,
  };
  await DB.prepare(
    `INSERT INTO autoboard_projects
       (id, name, sheet_id, source, filter_json, rows_json, preview_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      row.id, row.name, row.sheet_id, row.source, row.filter_json,
      row.rows_json, row.preview_json, row.created_at, row.updated_at,
    )
    .run();
  return detailFrom(row, emptyRowEdits());
}

export async function listProjects(): Promise<AutoboardProject[]> {
  const DB = await ensureProjectStorage();
  const [result, edits] = await Promise.all([
    DB.prepare("SELECT * FROM autoboard_projects ORDER BY updated_at DESC").all<ProjectRow>(),
    listAllRowEdits(),
  ]);
  return result.results.map((row) => publicProject(row, edits.get(row.id) ?? emptyRowEdits()));
}

export async function getProject(id: string): Promise<AutoboardProjectDetail | null> {
  const row = await projectRow(id);
  return row ? detailFor(row) : null;
}

export async function deleteProject(id: string): Promise<boolean> {
  const DB = await ensureProjectStorage();
  // Photos first: a project row deleted while its photos remain leaves R2
  // objects nothing will ever reference again.
  await deleteProjectPhotos(id);
  await deleteProjectBoardState(id);
  await deleteProjectRenders(id);
  await deleteProjectRowEdits(id);
  const result = await DB.prepare("DELETE FROM autoboard_projects WHERE id = ?").bind(id).run();
  return Boolean(result.meta?.changes);
}

// ---------------------------------------------------------------------------
// Row edits: add, remove, restore, pin
// ---------------------------------------------------------------------------

/**
 * The form for adding a row to a project.
 *
 * A project with a sheet gets one field per sheet column — the sheet's own
 * picklists as dropdowns, its existing values as suggestions — because the row
 * is going INTO the sheet. A project without one gets the fields a row needs
 * to build a board, with suggestions drawn from the rows it already has.
 */
export type RowForm = {
  mode: "sheet" | "manual";
  fields: RowField[];
  /** What to write the row into, so the UI can say so before the person does. */
  target: string;
};

const MANUAL_FIELDS: Omit<RowField, "suggestions">[] = [
  { key: "itemName", label: "Item", kind: "text", required: true, options: [], field: "itemName" },
  { key: "unitType", label: "Unit type", kind: "text", required: true, options: [], field: "unitType" },
  { key: "roomType", label: "Room", kind: "text", required: true, options: [], field: "roomType" },
  {
    key: "costCode",
    label: "Cost code",
    kind: "text",
    required: false,
    options: [],
    field: "costCode",
    // The slot rules key some slots on cost code as well as name (match.ts):
    // a faucet without "11 45" lands in Not placed. Saying so here beats a
    // person wondering why their faucet is not on the board.
    hint: "Some slots match by cost code: 11 45 plumbing fixtures, 09 00 hardware, 26 51 lighting. Leave it blank and pin the item to a slot if unsure.",
  },
  { key: "sku", label: "SKU", kind: "text", required: false, options: [], field: "sku" },
  { key: "qty", label: "Qty", kind: "text", required: false, options: [], field: "qty" },
  { key: "reference", label: "Reference URL", kind: "text", required: false, options: [], field: "reference" },
  { key: "status", label: "Status", kind: "select", required: false, options: ["", "preferred", "alternative", "pending"], field: "status" },
];

function distinct(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

export async function projectRowForm(id: string): Promise<RowForm | null> {
  const row = await projectRow(id);
  if (!row) return null;
  if (row.sheet_id) {
    const sheet = await fetchSheet({ token: await smartsheetToken(), sheetId: row.sheet_id });
    return { mode: "sheet", fields: sheetSchema(sheet), target: `Smartsheet ${row.sheet_id}` };
  }
  const { rows } = storedPreview(row, await listRowEdits(id));
  const suggestions: Record<string, string[]> = {
    unitType: distinct(rows.map((entry) => entry.unitType)),
    roomType: distinct(rows.map((entry) => entry.roomOriginal || entry.roomLabel)),
    costCode: distinct(rows.map((entry) => entry.costCode)),
  };
  return {
    mode: "manual",
    fields: MANUAL_FIELDS.map((field) => ({ ...field, suggestions: suggestions[field.key] ?? [] })),
    target: "this project",
  };
}

export type AddedProjectRow = {
  rowId: string;
  /** Whether the row is now in this project. A sheet row outside the project's filter is in the sheet but not here. */
  inProject: boolean;
  where: string;
};

/**
 * Adds a row. With a sheet behind the project the row is written into the
 * sheet, filed under its unit type and room (sheet-write.ts), and the project
 * is re-read so the new row arrives with its real row id, the way every other
 * row does. Without one the row is stored beside the project as a manual row.
 */
export async function addProjectRow(
  id: string,
  values: Record<string, unknown>,
): Promise<{ project: AutoboardProjectDetail; added: AddedProjectRow } | null> {
  const row = await projectRow(id);
  if (!row) return null;

  if (row.sheet_id) {
    const added = await addSheetRow({ token: await smartsheetToken(), sheetId: row.sheet_id, values });
    const project = await refreshProject(id);
    if (!project) return null;
    const inProject = project.rows.some((entry) => entry.rowId === added.rowId);
    const at = added.rowNumber === null ? "" : ` as row ${added.rowNumber}`;
    const where = added.placement.after
      ? `Written to the sheet${at}, ${added.placement.reason} (after "${added.placement.after.itemName}").`
      : `Written to the bottom of the sheet${at}: ${added.placement.reason}.`;
    return {
      project,
      added: {
        rowId: added.rowId,
        inProject,
        where: inProject
          ? where
          : `${where} It is not in this project: the project's filter leaves out its unit type or room.`,
      },
    };
  }

  const manual = await addManualRow(id, values);
  const DB = await ensureProjectStorage();
  await DB.prepare("UPDATE autoboard_projects SET updated_at = ? WHERE id = ?").bind(Date.now(), id).run();
  const project = await detailFor((await projectRow(id)) ?? row);
  return { project, added: { rowId: manual.rowId, inProject: true, where: "Added to this project." } };
}

// The row as the project currently knows it, edits included, so a removal
// snapshots what the person saw and a pin targets a row that exists.
async function knownRow(row: ProjectRow, rowId: string): Promise<LibraryRow | undefined> {
  const edits = await listRowEdits(row.id);
  const stored = JSON.parse(row.rows_json) as LibraryRow[];
  return [...stored, ...edits.manual].find((entry) => entry.rowId === rowId) ?? edits.excluded.get(rowId);
}

export async function setProjectRowExcluded(
  id: string,
  rowId: string,
  excluded: boolean,
): Promise<AutoboardProjectDetail | null> {
  const row = await projectRow(id);
  if (!row) return null;
  if (excluded) {
    const known = await knownRow(row, rowId);
    if (!known) throw new Error("That row is not in this project.");
    await setRowExcluded(id, rowId, known);
  } else {
    await setRowExcluded(id, rowId, null);
  }
  return detailFor(row);
}

// A board as the project currently knows it: found on the (not-yet-excluded)
// preview, or in the snapshot from a previous removal — a restore does not
// need the board to still exist, only to have existed once.
async function knownBoard(row: ProjectRow, boardId: string): Promise<RemovedBoardSnapshot | undefined> {
  const edits = await listRowEdits(row.id);
  const { preview } = storedPreview(row, edits);
  const board = preview.boards.find((entry) => entry.id === boardId);
  if (board) return { id: board.id, title: board.title, unitType: board.unitType, roomLabel: board.roomLabel, kindLabel: board.kindLabel };
  return edits.excludedBoards.get(boardId);
}

/**
 * Removes a board entirely, distinct from removing a row: the board's rows
 * stay in the project (and still count toward any other board they belong
 * to), only this one board's card disappears from both the preview and the
 * built boards, in both views alike (storedPreview and buildProjectBoards
 * apply the same excludedBoards set). Board STATE (instruction, notes,
 * render options) lives in a separate table and is untouched, so restoring a
 * board brings it back exactly as it was left.
 */
export async function setProjectBoardExcluded(
  id: string,
  boardId: string,
  excluded: boolean,
): Promise<AutoboardProjectDetail | null> {
  const row = await projectRow(id);
  if (!row) return null;
  if (excluded) {
    const known = await knownBoard(row, boardId);
    if (!known) throw new Error("That board is not in this project.");
    await setBoardExcluded(id, boardId, known);
  } else {
    await setBoardExcluded(id, boardId, null);
  }
  return detailFor(row);
}

export async function setProjectRowPin(
  id: string,
  rowId: string,
  pin: unknown | null,
): Promise<AutoboardProjectDetail | null> {
  const row = await projectRow(id);
  if (!row) return null;
  if (pin !== null && pin !== undefined && pin !== "" && !(await knownRow(row, rowId))) {
    throw new Error("That row is not in this project.");
  }
  await setRowPin(id, rowId, pin);
  return detailFor(row);
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
  const { boards: builtBoards } = buildBoards(project.rows, {
    resolveImages: (rowId) => byRow.get(rowId) ?? [],
    gaps,
    pins: new Map(Object.entries(project.edits.pins)),
  });
  const boards = excludeBoards(builtBoards, project.edits.removedBoards.map((entry) => entry.id));

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

  if (!existing.sheet_id) {
    throw new Error(
      `"${existing.name}" was built from supplied rows, not a sheet, so there is nothing to re-read. ` +
        "Seed it again to take a new reading.",
    );
  }
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
  return detailFor(updated);
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
