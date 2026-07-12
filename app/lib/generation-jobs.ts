import { env } from "cloudflare:workers";

export type GenerationJob = {
  id: string;
  mode: "economy" | "immediate";
  status: string;
  openaiBatchId: string | null;
  outputKey: string | null;
  filename: string;
  format: string;
  estimatedUsd: number | null;
  usage: Record<string, unknown> | null;
  qa: Record<string, unknown> | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
};

type JobRow = {
  id: string;
  mode: "economy" | "immediate";
  status: string;
  openai_batch_id: string | null;
  output_key: string | null;
  filename: string;
  format: string;
  estimated_usd: number | null;
  usage_json: string | null;
  qa_json: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
};

type RuntimeEnv = {
  DB?: D1Database;
  OUTPUTS?: R2Bucket;
};

export function runtimeStorage() {
  return env as unknown as RuntimeEnv;
}

export async function ensureJobStorage() {
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
    estimated_usd REAL,
    usage_json TEXT,
    qa_json TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`).run();
  await DB.prepare("CREATE INDEX IF NOT EXISTS generation_jobs_created_idx ON generation_jobs(created_at DESC)").run();
  return DB;
}

export async function cleanupExpiredJobs() {
  const DB = await ensureJobStorage();
  const { OUTPUTS } = runtimeStorage();
  const now = Date.now();
  const expired = await DB.prepare("SELECT output_key FROM generation_jobs WHERE expires_at < ? AND output_key IS NOT NULL")
    .bind(now).all<{ output_key: string }>();
  if (OUTPUTS) await Promise.all(expired.results.map((row: { output_key: string }) => OUTPUTS.delete(row.output_key)));
  await DB.prepare("DELETE FROM generation_jobs WHERE expires_at < ?").bind(now).run();
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
    estimatedUsd: row.estimated_usd,
    usage: parseJson(row.usage_json),
    qa: parseJson(row.qa_json),
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}

function parseJson(value: string | null) {
  if (!value) return null;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}
