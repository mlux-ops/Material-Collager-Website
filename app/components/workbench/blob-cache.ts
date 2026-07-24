// Image payloads live here, outside React state — nodes hold only object-URL
// strings, so canvas re-renders never diff multi-MB blobs.

// Self-contained-export encoding (AC18): turns a cached blob into a data URL
// using only Blob.arrayBuffer()/btoa (no FileReader), so this stays a plain
// function callable from export-import.ts without pulling in any DOM-element
// APIs. Decoding a data URL back into bytes on import is export-import.ts's
// job (it also has to MIME/byte-cap-check untrusted input first).
export async function blobToDataUrl(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  const mimeType = blob.type || "image/png";
  return `data:${mimeType};base64,${btoa(binary)}`;
}

const blobs = new Map<string, Blob>();
const urls = new Map<string, string>();

export function putBlob(key: string, blob: Blob): string {
  releaseBlob(key);
  blobs.set(key, blob);
  const url = URL.createObjectURL(blob);
  urls.set(key, url);
  return url;
}

export function getBlob(key: string): Blob | undefined {
  return blobs.get(key);
}

// The object URL already minted for a cached blob (e.g. one restored by
// persistence.ts on graph load), without minting a redundant new one.
export function getBlobUrl(key: string): string | undefined {
  return urls.get(key);
}

function releaseUrl(key: string) {
  const url = urls.get(key);
  if (url) URL.revokeObjectURL(url);
  urls.delete(key);
  blobs.delete(key);
}

export function releaseBlob(key: string) {
  releaseUrl(key);
  releaseUrl(thumbnailKeyFor(key));
  pendingThumbnails.delete(key);
}

export function releaseByPrefix(prefix: string) {
  for (const key of [...blobs.keys()]) {
    if (key.startsWith(prefix)) releaseBlob(key);
  }
}

// Sum of Blob.size for every key still resident in the in-memory cache (keys
// already evicted/never-cached contribute 0). Used by persistence.ts's
// per-graph byte-budget eviction (AC16) to size OUTPUT-class blobs before
// deciding what survives a save.
export function totalCachedBytes(keys: Iterable<string>): number {
  let total = 0;
  for (const key of keys) total += blobs.get(key)?.size ?? 0;
  return total;
}

// ---------------------------------------------------------------------------
// Card thumbnails (AC20): node cards must never hold a full-res bitmap. Each
// cacheable full-res image can carry a derived <=256px thumbnail blob, cached
// under its own key so it survives independently and is released alongside
// the source blob. Generation is lazy and best-effort — callers fall back to
// the full-res URL until (or if) a thumbnail becomes available.
// ---------------------------------------------------------------------------

const THUMBNAIL_SUFFIX = "::thumb";
const MAX_THUMBNAIL_DIMENSION = 256;

export function thumbnailKeyFor(key: string): string {
  return `${key}${THUMBNAIL_SUFFIX}`;
}

export function getThumbnailUrl(key: string): string | undefined {
  return urls.get(thumbnailKeyFor(key));
}

const pendingThumbnails = new Map<string, Promise<string | undefined>>();

export function ensureThumbnail(key: string, maxDimension = MAX_THUMBNAIL_DIMENSION): Promise<string | undefined> {
  const existing = getThumbnailUrl(key);
  if (existing) return Promise.resolve(existing);
  const pending = pendingThumbnails.get(key);
  if (pending) return pending;

  const task = (async (): Promise<string | undefined> => {
    try {
      const source = getBlob(key);
      if (!source || typeof createImageBitmap !== "function") return undefined;
      const bitmap = await createImageBitmap(source);
      try {
        const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
        const width = Math.max(1, Math.round(bitmap.width * scale));
        const height = Math.max(1, Math.round(bitmap.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) return undefined;
        context.drawImage(bitmap, 0, 0, width, height);
        const thumbBlob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
        if (!thumbBlob) return undefined;
        return putBlob(thumbnailKeyFor(key), thumbBlob);
      } finally {
        bitmap.close();
      }
    } catch {
      // Best-effort: node cards fall back to the full-res URL.
      return undefined;
    } finally {
      pendingThumbnails.delete(key);
    }
  })();
  pendingThumbnails.set(key, task);
  return task;
}
