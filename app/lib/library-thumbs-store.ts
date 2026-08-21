/**
 * D1-backed store for the Library's placeholder thumbnails (the dithered row
 * in SceneWheelV2). One shared set for the deployment: tiny data URIs
 * captured client-side after a successful scene paint (app/lib/library-thumbs.ts)
 * and replaced wholesale on refresh. Follows the generation-jobs pattern:
 * table created lazily, schema ensured once per isolate.
 */

import { env } from "cloudflare:workers";
import { sanitizeThumbs, type LibraryThumb } from "./library-thumbs.ts";

type RuntimeEnv = { DB?: D1Database };

let schemaReady: Promise<D1Database> | null = null;

function ensureThumbStorage() {
  schemaReady ??= init().catch((error) => {
    schemaReady = null; // transient D1 error must not poison the isolate
    throw error;
  });
  return schemaReady;
}

async function init(): Promise<D1Database> {
  const { DB } = env as unknown as RuntimeEnv;
  if (!DB) throw new Error("Library thumbnails are not configured on this deployment.");
  await DB.prepare(`CREATE TABLE IF NOT EXISTS library_thumbs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    thumb TEXT NOT NULL,
    position INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`).run();
  // Additive migration (generation-jobs pattern): aspect ratio landed after
  // the table shipped; legacy rows read back as the sanitizer's 4/3 default.
  const columns = await DB.prepare("PRAGMA table_info(library_thumbs)").all<{ name: string }>();
  const names = new Set((columns.results ?? []).map((c) => c.name));
  if (!names.has("ar")) {
    await DB.prepare("ALTER TABLE library_thumbs ADD COLUMN ar REAL").run();
  }
  return DB;
}

export async function getStoredLibraryThumbs(): Promise<LibraryThumb[]> {
  const DB = await ensureThumbStorage();
  const rows = await DB.prepare(
    "SELECT id, name, thumb, ar FROM library_thumbs ORDER BY position ASC",
  ).all<{ id: string; name: string; thumb: string; ar: number | null }>();
  // Rows were validated on write, but re-sanitize on the way out so a row
  // edited by hand can never reach a browser as an image source. Legacy rows
  // carry ar = NULL; surface that as "absent" so the sanitizer defaults it.
  return sanitizeThumbs(
    (rows.results ?? []).map(({ ar, ...rest }) => (ar === null ? rest : { ...rest, ar })),
  );
}

/** Replace the whole set (the client always captures a complete batch). */
export async function replaceLibraryThumbs(candidate: unknown, now = Date.now()): Promise<number> {
  const thumbs = sanitizeThumbs(candidate);
  const DB = await ensureThumbStorage();
  const statements = [
    DB.prepare("DELETE FROM library_thumbs"),
    ...thumbs.map((t, position) =>
      DB.prepare(
        "INSERT INTO library_thumbs (id, name, thumb, position, updated_at, ar) VALUES (?, ?, ?, ?, ?, ?)",
      ).bind(t.id, t.name, t.thumb, position, now, t.ar),
    ),
  ];
  await DB.batch(statements);
  return thumbs.length;
}
