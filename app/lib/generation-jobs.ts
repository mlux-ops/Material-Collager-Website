import { env } from "cloudflare:workers";
import { calculateSunburstUsageCost } from "./sunburst.ts";

export type RenderKind = "draft" | "studio" | "final" | "repair";

// `mode` and the batch columns are read as stored: rows written by the
// retired Economy (Batch API) mode can still be in the table until their
// retention passes, and the schema is left as it is rather than migrated.
export type GenerationJob = {
  id: string;
  mode: string;
  status: string;
  openaiBatchId: string | null;
  outputKey: string | null;
  filename: string;
  format: string;
  renderKind: RenderKind;
  collageType: string;
  libraryVisible: boolean;
  title: string;
  estimatedUsd: number | null;
  costUsd: number | null;
  model: string | null;
  quality: string | null;
  background: string | null;
  outputFormat: string | null;
  usage: Record<string, unknown> | null;
  qa: Record<string, unknown> | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
};

export type JobRow = {
  id: string;
  mode: string;
  status: string;
  openai_batch_id: string | null;
  output_key: string | null;
  filename: string;
  format: string;
  prompt: string;
  payload_json: string;
  reference_ids_json: string;
  render_kind: RenderKind;
  collage_type: string;
  library_visible: number;
  title: string;
  estimated_usd: number | null;
  cost_usd: number | null;
  model: string | null;
  quality: string | null;
  background: string | null;
  output_format: string | null;
  usage_json: string | null;
  qa_json: string | null;
  error: string | null;
  finalize_attempts: number;
  created_at: number;
  updated_at: number;
  expires_at: number;
};

type RuntimeEnv = {
  DB?: D1Database;
  OUTPUTS?: R2Bucket;
};

// Retention horizon for generated outputs. Exported as the single source of
// truth: every writer stamps the same lifetime, and cleanupExpiredJobs
// deletes both the D1 row and its R2 object once it passes, with no backup.
export const RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

// The expiry stamped on a row that must never be swept: images a person
// uploaded into the Library are kept until someone deletes them, unlike
// renders, which follow RETENTION_MS. 9999-12-31T23:59:59.000Z in ms — a
// valid Date, an exact JS number (< 2^53) and a SQLite/D1 64-bit integer, and
// still compared with the same `expires_at < now` every sweep uses, so no
// query needs a special case.
export const PERMANENT_EXPIRES_AT = Date.UTC(9999, 11, 31, 23, 59, 59);

export type Retention = "standard" | "permanent";

function expiresAtFor(retention: Retention | undefined, now: number) {
  return retention === "permanent" ? PERMANENT_EXPIRES_AT : now + RETENTION_MS;
}

export function runtimeStorage() {
  return env as unknown as RuntimeEnv;
}

// The schema is idempotent but costs several D1 round trips; run it once per
// isolate instead of on every request (reset on failure so a transient D1
// error does not poison the isolate).
let schemaReady: Promise<D1Database> | null = null;

export function ensureJobStorage() {
  schemaReady ??= initJobStorage().catch((error) => {
    schemaReady = null;
    throw error;
  });
  return schemaReady;
}

async function initJobStorage() {
  const { DB } = runtimeStorage();
  if (!DB) throw new Error("Generation history is not configured on this deployment.");
  await DB.prepare(`CREATE TABLE IF NOT EXISTS generation_jobs (
    id TEXT PRIMARY KEY,
    mode TEXT NOT NULL,
    status TEXT NOT NULL,
    openai_batch_id TEXT,
    output_key TEXT,
    filename TEXT NOT NULL,
    format TEXT NOT NULL,
    prompt TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    reference_ids_json TEXT NOT NULL,
    render_kind TEXT NOT NULL DEFAULT 'final',
    collage_type TEXT NOT NULL DEFAULT 'bathroom_fixture_collage',
    library_visible INTEGER NOT NULL DEFAULT 1,
    title TEXT NOT NULL DEFAULT '',
    estimated_usd REAL,
    cost_usd REAL,
    model TEXT,
    quality TEXT,
    background TEXT,
    output_format TEXT,
    usage_json TEXT,
    qa_json TEXT,
    error TEXT,
    finalize_attempts INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`).run();
  const columns = await DB.prepare("PRAGMA table_info(generation_jobs)").all<{ name: string }>();
  const names = new Set(columns.results.map((column: { name: string }) => column.name));
  const upgrades = [
    ["render_kind", "ALTER TABLE generation_jobs ADD COLUMN render_kind TEXT NOT NULL DEFAULT 'final'"],
    ["collage_type", "ALTER TABLE generation_jobs ADD COLUMN collage_type TEXT NOT NULL DEFAULT 'bathroom_fixture_collage'"],
    ["library_visible", "ALTER TABLE generation_jobs ADD COLUMN library_visible INTEGER NOT NULL DEFAULT 1"],
    ["title", "ALTER TABLE generation_jobs ADD COLUMN title TEXT NOT NULL DEFAULT ''"],
    ["finalize_attempts", "ALTER TABLE generation_jobs ADD COLUMN finalize_attempts INTEGER NOT NULL DEFAULT 0"],
    ["cost_usd", "ALTER TABLE generation_jobs ADD COLUMN cost_usd REAL"],
    ["model", "ALTER TABLE generation_jobs ADD COLUMN model TEXT"],
    ["quality", "ALTER TABLE generation_jobs ADD COLUMN quality TEXT"],
    ["background", "ALTER TABLE generation_jobs ADD COLUMN background TEXT"],
    ["output_format", "ALTER TABLE generation_jobs ADD COLUMN output_format TEXT"],
  ] as const;
  for (const [name, statement] of upgrades) {
    if (!names.has(name)) {
      try {
        await DB.prepare(statement).run();
      } catch (error) {
        if (!/duplicate column/i.test(error instanceof Error ? error.message : String(error))) throw error;
      }
    }
  }
  await DB.prepare("CREATE INDEX IF NOT EXISTS generation_jobs_created_idx ON generation_jobs(created_at DESC)").run();
  await DB.prepare("CREATE INDEX IF NOT EXISTS generation_jobs_library_idx ON generation_jobs(library_visible, status, created_at DESC)").run();
  return DB;
}

let lastCleanupAt = 0;

export async function cleanupExpiredJobs() {
  // Rows expire on a six-month horizon; sweeping once per isolate per 10 minutes
  // is plenty and keeps polled endpoints from paying the cleanup on every hit.
  if (Date.now() - lastCleanupAt < 10 * 60 * 1000) return;
  lastCleanupAt = Date.now();
  const DB = await ensureJobStorage();
  const { OUTPUTS } = runtimeStorage();
  const now = Date.now();
  const expired = await DB.prepare("SELECT output_key FROM generation_jobs WHERE expires_at < ? AND output_key IS NOT NULL")
    .bind(now).all<{ output_key: string }>();
  if (OUTPUTS) await Promise.all(expired.results.map((row: { output_key: string }) => OUTPUTS.delete(row.output_key)));
  await DB.prepare("DELETE FROM generation_jobs WHERE expires_at < ?").bind(now).run();
}

// The image arrives either as base64 (what the OpenAI routes hold) or as the
// raw bytes a caller already has. Raw bytes skip a base64 round trip, which
// for a 25 MB upload is several extra full-size copies inside one isolate.
type PersistImage = { imageBase64: string; imageBytes?: never } | { imageBytes: Uint8Array; imageBase64?: never };

export async function persistGenerationOutput(input: PersistImage & {
  filename: string;
  format: string;
  prompt: string;
  payload: Record<string, unknown>;
  model?: string;
  quality?: string;
  background?: string;
  outputFormat?: string;
  usage?: Record<string, unknown>;
  qa?: Record<string, unknown> | null;
  renderKind: RenderKind;
  collageType: string;
  replaceJobId?: string;
  /** "permanent" exempts the row from cleanupExpiredJobs; default: RETENTION_MS. */
  retention?: Retention;
  /** Stored verbatim when set; otherwise derived from the filename. */
  title?: string;
}) {
  const DB = await ensureJobStorage();
  const bucket = runtimeStorage().OUTPUTS;
  if (!bucket) throw new Error("Generated-output storage is not configured.");
  const existing = input.replaceJobId
    ? await DB.prepare("SELECT * FROM generation_jobs WHERE id = ? AND expires_at >= ?").bind(input.replaceJobId, Date.now()).first<JobRow>()
    : null;
  const id = existing?.id || crypto.randomUUID();
  const outputKey = existing?.output_key || `generation-outputs/${id}.${outputExtension(input.filename)}`;
  const now = Date.now();
  const title = input.title?.trim() || outputTitle(input.filename, input.collageType);
  const expiresAt = expiresAtFor(input.retention, now);
  // Unknown stays unknown: D1 refuses to bind undefined, and a Workbench save
  // carries no generation metadata at all. null is the honest value — never a
  // guessed model or quality.
  const model = input.model ?? stringField(input.payload, "model") ?? null;
  const quality = input.quality ?? stringField(input.payload, "quality") ?? null;
  const background = input.background ?? stringField(input.payload, "background") ?? null;
  const outputFormat = input.outputFormat ?? stringField(input.payload, "outputFormat") ?? outputExtension(input.filename);
  const costUsd = calculateSunburstUsageCost(input.usage);
  // Never persist the caller's OpenAI API key with the job record.
  const payloadJson = JSON.stringify({ ...input.payload, apiKey: undefined, model, quality, background, outputFormat });
  const body = input.imageBytes ?? base64Bytes(input.imageBase64);
  await bucket.put(outputKey, body, { httpMetadata: { contentType: mimeTypeForFilename(input.filename) } });

  if (existing) {
    await DB.prepare(`UPDATE generation_jobs SET
      mode = 'immediate', status = 'completed', output_key = ?, filename = ?, format = ?, prompt = ?, payload_json = ?,
      usage_json = ?, cost_usd = ?, qa_json = ?, error = NULL, updated_at = ?, expires_at = ?, render_kind = ?, collage_type = ?,
      model = ?, quality = ?, background = ?, output_format = ?,
      library_visible = ?, title = ?
      WHERE id = ?`)
      .bind(
        outputKey,
        input.filename,
        input.format,
        input.prompt,
        payloadJson,
        JSON.stringify(input.usage ?? {}),
        costUsd,
        input.qa ? JSON.stringify(input.qa) : null,
        now,
        expiresAt,
        input.renderKind,
        input.collageType,
        model,
        quality,
        background,
        outputFormat,
        input.renderKind === "final" ? 1 : 0,
        title,
        id,
      ).run();
  } else {
    try {
      await DB.prepare(`INSERT INTO generation_jobs
        (id, mode, status, openai_batch_id, output_key, filename, format, prompt, payload_json, reference_ids_json,
         render_kind, collage_type, library_visible, title, estimated_usd, usage_json, qa_json, error,
         model, quality, background, output_format, cost_usd, created_at, updated_at, expires_at)
         VALUES (?, 'immediate', 'completed', NULL, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(
          id,
          outputKey,
          input.filename,
          input.format,
          input.prompt,
          payloadJson,
          input.renderKind,
          input.collageType,
          input.renderKind === "final" ? 1 : 0,
          title,
          JSON.stringify(input.usage ?? {}),
          input.qa ? JSON.stringify(input.qa) : null,
          model,
          quality,
          background,
          outputFormat,
          costUsd,
          now,
          now,
          expiresAt,
        ).run();
    } catch (error) {
      // The object above is new and only this call knows its key. Without a
      // row nothing would ever show, expire or delete it (cleanupExpiredJobs
      // sweeps by row), so it goes too. The replace path keeps its object:
      // that key still belongs to the existing row.
      await bucket.delete(outputKey).catch(() => undefined);
      throw error;
    }
  }
  const row = await DB.prepare("SELECT * FROM generation_jobs WHERE id = ?").bind(id).first<JobRow>();
  if (!row) throw new Error("The generated output was stored without a history record.");
  return publicJob(row);
}

// Attaches an accuracy-review ("QA") result to a previously stored job. Used
// by /api/qa, which calls this only when the caller supplied a jobId; a
// missing/expired row is not an error here, the route just reports it unpersisted.
export async function updateGenerationQa(id: string, qa: unknown): Promise<boolean> {
  const DB = await ensureJobStorage();
  const result = await DB.prepare("UPDATE generation_jobs SET qa_json = ?, updated_at = ? WHERE id = ?")
    .bind(JSON.stringify(qa), Date.now(), id).run();
  return Boolean(result.meta.changes);
}

export async function setLibraryVisibility(id: string, visible: boolean) {
  const DB = await ensureJobStorage();
  await DB.prepare(`UPDATE generation_jobs SET library_visible = ?, updated_at = ?
    WHERE id = ? AND status = 'completed' AND output_key IS NOT NULL AND render_kind = 'final'`)
    .bind(visible ? 1 : 0, Date.now(), id).run();
  return DB.prepare(`SELECT * FROM generation_jobs
    WHERE id = ? AND status = 'completed' AND output_key IS NOT NULL AND render_kind = 'final'`)
    .bind(id).first<JobRow>();
}

export type DeleteUploadOutcome = "deleted" | "not_found" | "not_upload";

/**
 * Permanently removes an image a person uploaded into the Library: its D1 row
 * and its R2 object. Renders are refused ("not_upload") — only uploads can be
 * deleted. Hidden uploads (library_visible = 0) are deletable too.
 *
 * Row first, object second: if the object delete then fails, what is left is
 * an orphaned R2 object nothing points at — invisible, merely stored. The
 * other order could leave a row whose image is gone, which every Library
 * view would show as a broken plate.
 */
export async function deleteLibraryUpload(id: string): Promise<DeleteUploadOutcome> {
  const DB = await ensureJobStorage();
  const row = await DB.prepare("SELECT id, collage_type, output_key FROM generation_jobs WHERE id = ?")
    .bind(id).first<Pick<JobRow, "id" | "collage_type" | "output_key">>();
  if (!row) return "not_found";
  if (row.collage_type !== "upload") return "not_upload";
  await DB.prepare("DELETE FROM generation_jobs WHERE id = ? AND collage_type = 'upload'").bind(id).run();
  const { OUTPUTS } = runtimeStorage();
  if (row.output_key && OUTPUTS) await OUTPUTS.delete(row.output_key).catch(() => undefined);
  return "deleted";
}

export async function listLibraryJobs() {
  const DB = await ensureJobStorage();
  return DB.prepare(`SELECT * FROM generation_jobs
    WHERE library_visible = 1 AND status = 'completed' AND output_key IS NOT NULL
      AND render_kind = 'final' AND expires_at >= ?
    ORDER BY created_at DESC LIMIT 500`)
    .bind(Date.now()).all<JobRow>();
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "expired", "cancelled"]);

// Nothing refreshes a retired Economy batch any more, so an economy row left
// non-terminal (submitting, validating, in_progress, ...) would read as pending
// forever. Report it as cancelled, with the batch id so it can still be found
// on OpenAI's Batches page. The stored row is not changed.
function publicStatus(row: JobRow): { status: string; error: string | null } {
  if (row.mode !== "economy" || TERMINAL_STATUSES.has(row.status)) {
    return { status: row.status, error: row.error };
  }
  const batch = row.openai_batch_id ? ` Batch ${row.openai_batch_id}` : "";
  return {
    status: "cancelled",
    error: row.error ?? `Economy mode was removed before this render finished.${batch} is no longer collected.`,
  };
}

export function publicJob(row: JobRow): GenerationJob {
  const { status, error } = publicStatus(row);
  return {
    id: row.id,
    mode: row.mode,
    status,
    openaiBatchId: row.openai_batch_id,
    outputKey: row.output_key,
    filename: row.filename,
    format: row.format,
    renderKind: row.render_kind || "final",
    collageType: row.collage_type || "bathroom_fixture_collage",
    libraryVisible: Boolean(row.library_visible),
    title: row.title || outputTitle(row.filename, row.collage_type),
    estimatedUsd: row.estimated_usd,
    costUsd: row.cost_usd ?? null,
    model: row.model ?? null,
    quality: row.quality ?? null,
    background: row.background ?? null,
    outputFormat: row.output_format ?? null,
    usage: parseJson(row.usage_json),
    qa: parseJson(row.qa_json),
    error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}

// output-format-aware R2 storage: the caller (app/api/generate/route.ts)
// already resolves the right OpenAI output_format and hands us a filename
// carrying the matching extension, so the R2 key and content type are
// inferred from THAT filename rather than a second copy of the format enum.
// Note this is unrelated to the "format" field elsewhere in this file, which
// records the render's pixel-size string (e.g. "1536x1024").
const OUTPUT_MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

function outputExtension(filename: string) {
  const match = /\.([a-z0-9]+)$/i.exec(filename);
  return match ? match[1].toLowerCase() : "png";
}

function mimeTypeForFilename(filename: string) {
  return OUTPUT_MIME_TYPES[outputExtension(filename)] || "image/png";
}

function outputTitle(filename: string, collageType?: string) {
  const clean = filename.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim();
  if (clean && clean.toLowerCase() !== "material collage") return clean.replace(/\b\w/g, (letter) => letter.toUpperCase());
  return (collageType || "Material collage").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  return typeof record[key] === "string" && record[key] ? record[key] as string : undefined;
}

function base64Bytes(value: string) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function parseJson(value: string | null) {
  if (!value) return null;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}
