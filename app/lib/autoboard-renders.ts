// Renders of a review-board board: the draft / confirm / final chain.
//
// The request goes through the app's OWN /api/generate handler rather than
// calling OpenAI here. That route already holds every rule that matters —
// payload validation, the final-quality floor, reference counting, usage and
// cost accounting, the diagnostics the CLI relies on — and a second path to the
// image API would be a second place for those to drift.
//
// It is called IN-PROCESS, as a function, never fetched over HTTP. A Worker
// cannot fetch its own hostname (Cloudflare's loop protection answers error
// 1042), and even if it could, that request would arrive at the Access gate
// with no JWT. Miniflare allows the self-fetch, which is exactly how a design
// that only works locally gets shipped. The handler is injected so the chain
// stays testable without spending on a render.
//
// Every render records the two hashes it was made under, so the board can say
// whether it is still current instead of guessing.

import { env } from "cloudflare:workers";
import { DEFAULT_VARIANTS, boardPayload, type Variant } from "./autoboard/variants.ts";
import { boardForRender, renderOptionsHash, resolveRenderOptions, selectionHash } from "./autoboard/render-options.ts";
import { decodeGeneratedImage } from "./generated-image.ts";
import type { Board } from "./autoboard/types.ts";
import { getPhotoObject } from "./autoboard-photos.ts";

export type RenderKind = "draft" | "confirm" | "final";
export type RenderStatus = "candidate" | "picked" | "approved";

export type BoardRender = {
  id: string;
  projectId: string;
  boardId: string;
  kind: RenderKind;
  variant: string;
  status: RenderStatus;
  selectionHash: string;
  renderOptionsHash: string;
  quality: string;
  background: string;
  costUsd: number | null;
  imageUrl: string;
  createdAt: number;
};

type RenderRow = {
  id: string;
  project_id: string;
  board_id: string;
  kind: RenderKind;
  variant: string;
  status: RenderStatus;
  r2_key: string;
  selection_hash: string;
  render_options_hash: string;
  quality: string;
  background: string;
  cost_usd: number | null;
  created_at: number;
};

type RuntimeEnv = { DB?: D1Database; OUTPUTS?: R2Bucket };

function runtime(): RuntimeEnv {
  return env as unknown as RuntimeEnv;
}

function bucket(): R2Bucket {
  const { OUTPUTS } = runtime();
  if (!OUTPUTS) throw new Error("Renders need the R2 binding `OUTPUTS`, which is not configured here.");
  return OUTPUTS;
}

let schemaReady: Promise<D1Database> | null = null;

export function ensureRenderStorage(): Promise<D1Database> {
  schemaReady ??= initRenderStorage().catch((error) => {
    schemaReady = null;
    throw error;
  });
  return schemaReady;
}

async function initRenderStorage(): Promise<D1Database> {
  const { DB } = runtime();
  if (!DB) throw new Error("The review board is not configured on this deployment (no D1 binding `DB`).");
  await DB.prepare(`CREATE TABLE IF NOT EXISTS autoboard_renders (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    board_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    variant TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'candidate',
    r2_key TEXT NOT NULL,
    selection_hash TEXT NOT NULL,
    render_options_hash TEXT NOT NULL,
    quality TEXT NOT NULL,
    background TEXT NOT NULL,
    cost_usd REAL,
    created_at INTEGER NOT NULL
  )`).run();
  await DB.prepare(
    "CREATE INDEX IF NOT EXISTS autoboard_renders_board ON autoboard_renders (project_id, board_id, created_at)",
  ).run();
  return DB;
}

export function publicRender(row: RenderRow): BoardRender {
  return {
    id: row.id,
    projectId: row.project_id,
    boardId: row.board_id,
    kind: row.kind,
    variant: row.variant,
    status: row.status,
    selectionHash: row.selection_hash,
    renderOptionsHash: row.render_options_hash,
    quality: row.quality,
    background: row.background,
    costUsd: row.cost_usd,
    imageUrl: `/api/autoboard/renders/${encodeURIComponent(row.id)}/image`,
    createdAt: row.created_at,
  };
}

// A board item's images are /api/autoboard/photos/<id> urls, so the stored
// object is one id lookup away. Anything else is a bug in how the board was
// built, not something to paper over with a placeholder.
function photoIdFromUrl(url: string): string {
  const id = url.split("/").pop() ?? "";
  if (!id) throw new Error(`Reference "${url}" is not a stored photo url.`);
  return decodeURIComponent(id);
}

export type RenderDeps = {
  /**
   * The /api/generate route's POST handler, called in-process. Injected (rather
   * than imported here) so a test can hand in a stub and so this module never
   * has to know the route's file path.
   */
  generate: (request: Request) => Promise<Response>;
  /**
   * Origin of the incoming request. Used ONLY to give the constructed Request a
   * well-formed absolute URL, which the handler parses for query params. No
   * network request is made to it.
   */
  origin: string;
  /**
   * The incoming request's signal; once dispatched, the generate route passes
   * it on to the image API, and aborting can never un-bill a request OpenAI
   * already accepted. In principle this stops a render the reviewer has
   * already abandoned before anything is read or paid for -- but an incoming
   * request's `signal` only fires on a client disconnect when workerd's
   * `enable_request_signal` compatibility flag is on, and wrangler.jsonc does
   * not set it (see CLAUDE.md Gotchas). So today this fires for an injected
   * signal (the tests abort their own AbortController), not a real abandoned
   * request in production.
   */
  signal?: AbortSignal;
};

/**
 * Renders one draft for a board and stores it.
 *
 * `board` must already carry the reviewer's state (notes, hero, options) —
 * buildProjectBoards applies it — because the hashes recorded here are what
 * staleness is later judged against.
 */
export async function renderBoardDraft(
  projectId: string,
  board: Board,
  instruction: string,
  options: { variant?: Variant; kind?: RenderKind } & RenderDeps,
): Promise<BoardRender> {
  options.signal?.throwIfAborted();
  const DB = await ensureRenderStorage();
  const kind = options.kind ?? "draft";
  const variant = options.variant ?? DEFAULT_VARIANTS[0];

  if (!board.items.length) throw new Error("This board has no references yet. Choose a photo for at least one slot.");

  const renderOptions = resolveRenderOptions(board, kind);
  const forRender = boardForRender(board, instruction);
  const payload = boardPayload(forRender, variant, {
    ...renderOptions,
    renderKind: kind === "draft" ? "draft" : "final",
    outputResolution: kind === "draft" ? "standard" : "studio",
    basename: (location) => location.split("/").pop() ?? location,
  });

  // The multipart file list has to match the payload's imageNames
  // position-for-position; both are built from orderedBoardItems, so the order
  // here is that order and not the board's own.
  const form = new FormData();
  form.set("payload", JSON.stringify(payload));
  for (const item of (payload.items as { id: string; imageNames?: string[] }[]) ?? []) {
    const boardItem = forRender.items.find((entry) => entry.slotId === item.id);
    for (const [index, url] of (boardItem?.images ?? []).entries()) {
      const found = await getPhotoObject(photoIdFromUrl(url));
      if (!found) throw new Error(`A reference photo for ${item.id} is no longer stored.`);
      const bytes = await found.object.arrayBuffer();
      form.append(
        "image[]",
        new File([bytes], item.imageNames?.[index] ?? `${item.id}-${index + 1}.png`, { type: found.contentType }),
      );
    }
  }

  const response = await options.generate(
    new Request(`${options.origin}/api/generate`, { method: "POST", body: form, signal: options.signal }),
  );
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    // The generate route answers JSON with a readable message; pass it straight
    // through rather than replacing it with a generic failure.
    let message = body.slice(0, 400);
    try {
      message = (JSON.parse(body) as { error?: string }).error ?? message;
    } catch {
      // not JSON — keep the raw text
    }
    throw new Error(`The render failed: ${message}`);
  }

  const { bytes, contentType, costUsd } = decodeGeneratedImage(await response.json());

  const id = `render-${crypto.randomUUID()}`;
  const r2Key = `autoboard/renders/${projectId}/${board.id}/${id}.png`;
  await bucket().put(r2Key, bytes, { httpMetadata: { contentType } });

  const row: RenderRow = {
    id,
    project_id: projectId,
    board_id: board.id,
    kind,
    variant: variant.key,
    status: "candidate",
    r2_key: r2Key,
    selection_hash: selectionHash(board, instruction),
    render_options_hash: renderOptionsHash(renderOptions),
    quality: renderOptions.quality,
    background: renderOptions.background,
    cost_usd: costUsd,
    created_at: Date.now(),
  };
  await DB.prepare(
    `INSERT INTO autoboard_renders
       (id, project_id, board_id, kind, variant, status, r2_key, selection_hash, render_options_hash, quality, background, cost_usd, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      row.id, row.project_id, row.board_id, row.kind, row.variant, row.status, row.r2_key,
      row.selection_hash, row.render_options_hash, row.quality, row.background, row.cost_usd, row.created_at,
    )
    .run();
  return publicRender(row);
}

export async function listRenders(projectId: string): Promise<BoardRender[]> {
  const DB = await ensureRenderStorage();
  const result = await DB.prepare(
    "SELECT * FROM autoboard_renders WHERE project_id = ? ORDER BY board_id, created_at DESC",
  )
    .bind(projectId)
    .all<RenderRow>();
  return result.results.map(publicRender);
}

const STATUSES = new Set<RenderStatus>(["candidate", "picked", "approved"]);

/**
 * Picking is exclusive per board and kind: a board has one picked draft, and
 * picking another releases the first. Without that, "the approved draft" is
 * ambiguous and the confirm stage has no single source.
 */
export async function setRenderStatus(renderId: string, status: unknown): Promise<BoardRender | null> {
  if (!STATUSES.has(status as RenderStatus)) {
    throw new Error('A render is "candidate", "picked" or "approved".');
  }
  const DB = await ensureRenderStorage();
  const row = await DB.prepare("SELECT * FROM autoboard_renders WHERE id = ?").bind(renderId).first<RenderRow>();
  if (!row) return null;
  // One selection per board and kind. Clearing the others and marking this one
  // go out as ONE batch, which D1 runs as a transaction: two picks made at the
  // same time can no longer interleave into two selections, and a failure
  // part-way can no longer leave the board with none.
  const statements: D1PreparedStatement[] = [];
  if (status !== "candidate") {
    statements.push(
      DB.prepare("UPDATE autoboard_renders SET status = 'candidate' WHERE project_id = ? AND board_id = ? AND kind = ? AND id != ?")
        .bind(row.project_id, row.board_id, row.kind, renderId),
    );
  }
  statements.push(DB.prepare("UPDATE autoboard_renders SET status = ? WHERE id = ?").bind(status, renderId));
  await DB.batch(statements);
  return publicRender({ ...row, status: status as RenderStatus });
}

export async function getRenderObject(renderId: string) {
  const DB = await ensureRenderStorage();
  const row = await DB.prepare("SELECT r2_key FROM autoboard_renders WHERE id = ?")
    .bind(renderId)
    .first<{ r2_key: string }>();
  if (!row) return null;
  const object = await bucket().get(row.r2_key);
  return object ?? null;
}

export async function deleteRender(renderId: string): Promise<boolean> {
  const DB = await ensureRenderStorage();
  const row = await DB.prepare("SELECT r2_key FROM autoboard_renders WHERE id = ?")
    .bind(renderId)
    .first<{ r2_key: string }>();
  if (!row) return false;
  await bucket().delete(row.r2_key);
  await DB.prepare("DELETE FROM autoboard_renders WHERE id = ?").bind(renderId).run();
  return true;
}

export async function deleteProjectRenders(projectId: string): Promise<void> {
  const DB = await ensureRenderStorage();
  const result = await DB.prepare("SELECT r2_key FROM autoboard_renders WHERE project_id = ?")
    .bind(projectId)
    .all<{ r2_key: string }>();
  for (const row of result.results) await bucket().delete(row.r2_key);
  await DB.prepare("DELETE FROM autoboard_renders WHERE project_id = ?").bind(projectId).run();
}
