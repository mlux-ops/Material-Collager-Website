import { env } from "cloudflare:workers";

export type RenderKind = "draft" | "studio" | "final" | "repair";

export type GenerationJob = {
  id: string;
  mode: "economy" | "immediate";
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
  usage: Record<string, unknown> | null;
  qa: Record<string, unknown> | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
};

export type JobRow = {
  id: string;
  mode: "economy" | "immediate";
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
// truth: the economy route stamps the same lifetime, and cleanupExpiredJobs
// deletes both the D1 row and its R2 object once it passes, with no backup.
export const RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

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

export async function persistGenerationOutput(input: {
  imageBase64: string;
  filename: string;
  format: string;
  prompt: string;
  payload: Record<string, unknown>;
  usage?: Record<string, unknown>;
  qa?: Record<string, unknown> | null;
  renderKind: RenderKind;
  collageType: string;
  replaceJobId?: string;
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
  const title = outputTitle(input.filename, input.collageType);
  // Never persist the caller's OpenAI API key with the job record.
  const payloadJson = JSON.stringify({ ...input.payload, apiKey: undefined });
  await bucket.put(outputKey, base64Bytes(input.imageBase64), { httpMetadata: { contentType: mimeTypeForFilename(input.filename) } });

  if (existing) {
    await DB.prepare(`UPDATE generation_jobs SET
      mode = 'immediate', status = 'completed', output_key = ?, filename = ?, format = ?, prompt = ?, payload_json = ?,
      usage_json = ?, qa_json = ?, error = NULL, updated_at = ?, expires_at = ?, render_kind = ?, collage_type = ?,
      library_visible = ?, title = ?
      WHERE id = ?`)
      .bind(
        outputKey,
        input.filename,
        input.format,
        input.prompt,
        payloadJson,
        JSON.stringify(input.usage ?? {}),
        input.qa ? JSON.stringify(input.qa) : null,
        now,
        now + RETENTION_MS,
        input.renderKind,
        input.collageType,
        input.renderKind === "final" ? 1 : 0,
        title,
        id,
      ).run();
  } else {
    await DB.prepare(`INSERT INTO generation_jobs
      (id, mode, status, openai_batch_id, output_key, filename, format, prompt, payload_json, reference_ids_json,
       render_kind, collage_type, library_visible, title, estimated_usd, usage_json, qa_json, error, created_at, updated_at, expires_at)
      VALUES (?, 'immediate', 'completed', NULL, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?, ?)`)
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
        now,
        now,
        now + RETENTION_MS,
      ).run();
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

export async function listLibraryJobs() {
  const DB = await ensureJobStorage();
  return DB.prepare(`SELECT * FROM generation_jobs
    WHERE library_visible = 1 AND status = 'completed' AND output_key IS NOT NULL
      AND render_kind = 'final' AND expires_at >= ?
    ORDER BY created_at DESC LIMIT 60`)
    .bind(Date.now()).all<JobRow>();
}

export function publicJob(row: JobRow): GenerationJob {
  return {
    id: row.id,
    mode: row.mode,
    status: row.status,
    openaiBatchId: row.openai_batch_id,
    outputKey: row.output_key,
    filename: row.filename,
    format: row.format,
    renderKind: row.render_kind || "final",
    collageType: row.collage_type || "bathroom_fixture_collage",
    libraryVisible: Boolean(row.library_visible),
    title: row.title || outputTitle(row.filename, row.collage_type),
    estimatedUsd: row.estimated_usd,
    usage: parseJson(row.usage_json),
    qa: parseJson(row.qa_json),
    error: row.error,
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
