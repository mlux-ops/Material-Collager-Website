// Reference photos for a review-board project.
//
// Metadata in D1, bytes in R2. A photo is a CANDIDATE until a person selects it;
// only selected photos become a board's references, which is the whole point of
// the review grid — nothing reaches a render because a scraper thought it looked
// right.
//
// Dimensions are read from the file header (app/lib/autoboard/image-size.ts)
// rather than sharp, which does not exist on the Worker, and the content type is
// sniffed from the same magic bytes rather than trusted from the server's header
// or a client's filename.

import { env } from "cloudflare:workers";
import { readImageSizeFromBytes, sniffImageType } from "./autoboard/image-size.ts";
import {
  assertFetchableUrl,
  extractImageUrls,
  isImageContentType,
  isLowResolution,
} from "./autoboard/photo-sources.ts";
import { fetchPublic, readCapped } from "./guarded-fetch.ts";

export type PhotoStatus = "candidate" | "selected" | "rejected";

export type ProjectPhoto = {
  id: string;
  projectId: string;
  rowId: string;
  source: "url" | "upload";
  sourceUrl: string | null;
  contentType: string;
  bytes: number;
  width: number;
  height: number;
  sha256: string;
  status: PhotoStatus;
  lowResolution: boolean;
  imageUrl: string;
  createdAt: number;
};

type PhotoRow = {
  id: string;
  project_id: string;
  row_id: string;
  r2_key: string;
  source: "url" | "upload";
  source_url: string | null;
  content_type: string;
  bytes: number;
  width: number;
  height: number;
  sha256: string;
  status: PhotoStatus;
  created_at: number;
};

type RuntimeEnv = { DB?: D1Database; OUTPUTS?: R2Bucket };

function runtime(): RuntimeEnv {
  return env as unknown as RuntimeEnv;
}

export const MAX_PHOTO_BYTES = 20 * 1024 * 1024;

// A product page can be large; a photo cannot hide past this much HTML, and an
// unbounded read of an untrusted URL is how one request becomes a memory
// problem.
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

let schemaReady: Promise<D1Database> | null = null;

export function ensurePhotoStorage(): Promise<D1Database> {
  schemaReady ??= initPhotoStorage().catch((error) => {
    schemaReady = null;
    throw error;
  });
  return schemaReady;
}

async function initPhotoStorage(): Promise<D1Database> {
  const { DB } = runtime();
  if (!DB) throw new Error("The review board is not configured on this deployment (no D1 binding `DB`).");
  await DB.prepare(`CREATE TABLE IF NOT EXISTS autoboard_photos (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    row_id TEXT NOT NULL,
    r2_key TEXT NOT NULL,
    source TEXT NOT NULL,
    source_url TEXT,
    content_type TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'candidate',
    created_at INTEGER NOT NULL
  )`).run();
  await DB.prepare(
    "CREATE INDEX IF NOT EXISTS autoboard_photos_row ON autoboard_photos (project_id, row_id, created_at)",
  ).run();
  // One copy of a given image per row, however many times it is offered: a
  // product page listing the same hero shot under og:image and twitter:image
  // must not fill the grid with duplicates.
  await DB.prepare(
    "CREATE UNIQUE INDEX IF NOT EXISTS autoboard_photos_dedupe ON autoboard_photos (project_id, row_id, sha256)",
  ).run();
  return DB;
}

function bucket(): R2Bucket {
  const { OUTPUTS } = runtime();
  if (!OUTPUTS) throw new Error("Reference photos need the R2 binding `OUTPUTS`, which is not configured here.");
  return OUTPUTS;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function publicPhoto(row: PhotoRow): ProjectPhoto {
  return {
    id: row.id,
    projectId: row.project_id,
    rowId: row.row_id,
    source: row.source,
    sourceUrl: row.source_url,
    contentType: row.content_type,
    bytes: row.bytes,
    width: row.width,
    height: row.height,
    sha256: row.sha256,
    status: row.status,
    lowResolution: isLowResolution(row.width, row.height),
    imageUrl: `/api/autoboard/photos/${encodeURIComponent(row.id)}`,
    createdAt: row.created_at,
  };
}

// Stores bytes that have already been read. Everything that can reject an image
// happens here, in one place, so a URL fetch and a manual upload are held to
// exactly the same standard.
async function storePhoto(input: {
  projectId: string;
  rowId: string;
  bytes: Uint8Array;
  source: "url" | "upload";
  sourceUrl: string | null;
}): Promise<ProjectPhoto> {
  const DB = await ensurePhotoStorage();
  const { bytes } = input;

  if (bytes.length === 0) throw new Error("That image is empty.");
  if (bytes.length > MAX_PHOTO_BYTES) {
    throw new Error(`Images must be under ${Math.round(MAX_PHOTO_BYTES / 1024 / 1024)} MB.`);
  }

  const contentType = sniffImageType(bytes);
  if (!contentType) throw new Error("That file is not a JPEG, PNG or WebP image.");

  const size = readImageSizeFromBytes(bytes);
  if (!size) throw new Error("That image's dimensions could not be read, so it may be corrupt.");

  const sha256 = await sha256Hex(bytes);
  const existing = await DB.prepare(
    "SELECT * FROM autoboard_photos WHERE project_id = ? AND row_id = ? AND sha256 = ?",
  )
    .bind(input.projectId, input.rowId, sha256)
    .first<PhotoRow>();
  if (existing) return publicPhoto(existing);

  const id = `photo-${crypto.randomUUID()}`;
  const r2Key = `autoboard/${input.projectId}/${input.rowId}/${id}`;
  await bucket().put(r2Key, bytes as unknown as ArrayBufferView, { httpMetadata: { contentType } });

  const row: PhotoRow = {
    id,
    project_id: input.projectId,
    row_id: input.rowId,
    r2_key: r2Key,
    source: input.source,
    source_url: input.sourceUrl,
    content_type: contentType,
    bytes: bytes.length,
    width: size.width,
    height: size.height,
    sha256,
    status: "candidate",
    created_at: Date.now(),
  };
  await DB.prepare(
    `INSERT INTO autoboard_photos
       (id, project_id, row_id, r2_key, source, source_url, content_type, bytes, width, height, sha256, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      row.id, row.project_id, row.row_id, row.r2_key, row.source, row.source_url,
      row.content_type, row.bytes, row.width, row.height, row.sha256, row.status, row.created_at,
    )
    .run();
  return publicPhoto(row);
}

// Each hop is validated before it is requested (guarded-fetch.ts); a
// redirect can no longer land somewhere the guard would have refused.
async function fetchGuarded(url: URL, accept: string): Promise<{ response: Response; url: URL }> {
  const fetched = await fetchPublic(url, {
    headers: {
      accept,
      // Some vendor sites serve a bot-blocking page to a default agent. Named
      // honestly rather than impersonating a browser.
      "user-agent": "MaterialCollager/1.0 (+design reference collection)",
    },
    timeoutMs: FETCH_TIMEOUT_MS,
  });
  if (!fetched.response.ok) {
    await fetched.response.body?.cancel();
    throw new Error(`${fetched.url.hostname} answered HTTP ${fetched.response.status}.`);
  }
  return fetched;
}

const PHOTO_TOO_LARGE = `Images must be under ${Math.round(MAX_PHOTO_BYTES / 1024 / 1024)} MB.`;

/**
 * What a reference URL actually offers.
 *
 * An image URL resolves to itself. A product page resolves to the images it
 * declares about itself, which is the common case: the sheet's reference column
 * holds pages, not photos.
 */
export async function discoverPhotoUrls(rawUrl: unknown): Promise<{ kind: "image" | "page"; urls: string[] }> {
  const url = assertFetchableUrl(rawUrl);
  const { response, url: landed } = await fetchGuarded(url, "image/*,text/html;q=0.9,*/*;q=0.5");
  const contentType = response.headers.get("content-type");

  if (isImageContentType(contentType)) {
    await response.body?.cancel();
    return { kind: "image", urls: [landed.toString()] };
  }
  const html = new TextDecoder().decode(await readCapped(response, MAX_HTML_BYTES, { tooLarge: "That page is too large to read." }));
  const urls = extractImageUrls(html, landed.toString());
  if (!urls.length) {
    throw new Error(
      `${url.hostname} returned a page with no image to collect. Open it and paste the photo's own URL, or upload the photo.`,
    );
  }
  return { kind: "page", urls };
}

export async function ingestPhotoFromUrl(projectId: string, rowId: string, rawUrl: unknown): Promise<ProjectPhoto> {
  const url = assertFetchableUrl(rawUrl);
  const { response, url: landed } = await fetchGuarded(url, "image/*");
  const bytes = await readCapped(response, MAX_PHOTO_BYTES, { tooLarge: PHOTO_TOO_LARGE });
  return storePhoto({ projectId, rowId, bytes, source: "url", sourceUrl: landed.toString() });
}

const ALLOWED_UPLOAD_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

export async function ingestUploadedPhoto(
  projectId: string,
  rowId: string,
  input: { mimeType?: unknown; dataBase64?: unknown },
): Promise<ProjectPhoto> {
  const mimeType = String(input.mimeType ?? "").toLowerCase();
  if (!ALLOWED_UPLOAD_MIME.has(mimeType)) throw new Error("Images must be JPEG, PNG or WebP.");
  const data = String(input.dataBase64 ?? "");
  if (!data) throw new Error("No image data received.");
  // Checked on the encoded length, before atob allocates the decoded copy:
  // base64 carries 3 bytes in every 4 characters.
  if (Math.floor((data.length * 3) / 4) > MAX_PHOTO_BYTES) throw new Error(PHOTO_TOO_LARGE);
  let binary: string;
  try {
    binary = atob(data);
  } catch {
    throw new Error("The uploaded image was not valid base64.");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  // The declared mime type is checked above only to reject obvious junk early;
  // what is stored is what the bytes say they are.
  return storePhoto({ projectId, rowId, bytes, source: "upload", sourceUrl: null });
}

export async function listProjectPhotos(projectId: string): Promise<ProjectPhoto[]> {
  const DB = await ensurePhotoStorage();
  const result = await DB.prepare(
    "SELECT * FROM autoboard_photos WHERE project_id = ? ORDER BY row_id, created_at",
  )
    .bind(projectId)
    .all<PhotoRow>();
  return result.results.map(publicPhoto);
}

/**
 * The selected photo for every row that has one, as the synchronous lookup
 * buildBoards requires.
 *
 * This is the edge half of the injected-resolver contract: buildBoards consumes
 * the returned array immediately and has no await anywhere, so the async work
 * happens here, once, and the resolver it produces is a plain Map read. The
 * values are photo API urls, not filesystem paths.
 */
export async function selectedImagesByRow(projectId: string): Promise<Map<string, string[]>> {
  const DB = await ensurePhotoStorage();
  const result = await DB.prepare(
    "SELECT * FROM autoboard_photos WHERE project_id = ? AND status = 'selected' ORDER BY row_id, created_at",
  )
    .bind(projectId)
    .all<PhotoRow>();
  const byRow = new Map<string, string[]>();
  for (const row of result.results) {
    const list = byRow.get(row.row_id) ?? [];
    list.push(publicPhoto(row).imageUrl);
    byRow.set(row.row_id, list);
  }
  return byRow;
}

const STATUSES = new Set<PhotoStatus>(["candidate", "selected", "rejected"]);

export async function setPhotoStatus(photoId: string, status: unknown): Promise<ProjectPhoto | null> {
  if (!STATUSES.has(status as PhotoStatus)) {
    throw new Error('A photo is "candidate", "selected" or "rejected".');
  }
  const DB = await ensurePhotoStorage();
  await DB.prepare("UPDATE autoboard_photos SET status = ? WHERE id = ?").bind(status, photoId).run();
  const row = await DB.prepare("SELECT * FROM autoboard_photos WHERE id = ?").bind(photoId).first<PhotoRow>();
  return row ? publicPhoto(row) : null;
}

export async function getPhotoObject(photoId: string) {
  const DB = await ensurePhotoStorage();
  const row = await DB.prepare("SELECT r2_key, content_type FROM autoboard_photos WHERE id = ?")
    .bind(photoId)
    .first<{ r2_key: string; content_type: string }>();
  if (!row) return null;
  const object = await bucket().get(row.r2_key);
  return object ? { object, contentType: row.content_type } : null;
}

export async function deletePhoto(photoId: string): Promise<boolean> {
  const DB = await ensurePhotoStorage();
  const row = await DB.prepare("SELECT r2_key FROM autoboard_photos WHERE id = ?")
    .bind(photoId)
    .first<{ r2_key: string }>();
  if (!row) return false;
  // R2 first: a delete that fails here must not leave a D1 row pointing at an
  // object nobody can reach, and an orphaned object is the cheaper mistake.
  await bucket().delete(row.r2_key);
  await DB.prepare("DELETE FROM autoboard_photos WHERE id = ?").bind(photoId).run();
  return true;
}

export async function deleteProjectPhotos(projectId: string): Promise<number> {
  const DB = await ensurePhotoStorage();
  const result = await DB.prepare("SELECT id, r2_key FROM autoboard_photos WHERE project_id = ?")
    .bind(projectId)
    .all<{ id: string; r2_key: string }>();
  for (const row of result.results) await bucket().delete(row.r2_key);
  await DB.prepare("DELETE FROM autoboard_photos WHERE project_id = ?").bind(projectId).run();
  return result.results.length;
}
