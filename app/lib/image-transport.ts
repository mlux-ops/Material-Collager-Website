// Shared client-side image transport helpers: compressing reference images to
// a byte budget before direct multipart upload, and converting between
// base64/data-URL/object-URL image representations without holding multi-MB
// base64 strings in React state.

export const DIRECT_REQUEST_REFERENCE_BUDGET = 700 * 1024;

// The immediate Final render sends the approved draft plus every product
// reference in ONE multipart body. The edge runtime rejects request bodies
// over 32 MB (next.config.ts raises serverActions.bodySizeLimit to "32mb",
// which vinext applies to route handlers too), so that whole payload has to
// be budgeted client-side — sending untouched originals 413s once a board of
// camera-native photos clears the ceiling. 28 MB leaves headroom for the JSON
// `payload` field and the multipart part headers.
//
// This budget exists to stop the 413, NOT to save bytes: Final's whole point
// is reference fidelity, so it is set as close to the ceiling as is safe.
export const FINAL_REQUEST_BODY_BUDGET = 28 * 1024 * 1024;

// The approved draft carries the composition the final render must follow, so
// it gets a guaranteed slice of the body budget before the product references
// divide up what is left. A 2560x1440 PNG draft is ~8 MB; 6 MB keeps it
// visually lossless while leaving the references the bulk of the body.
export const FINAL_LAYOUT_REFERENCE_BUDGET = 6 * 1024 * 1024;

// A user-uploaded layout master (a previous collage supplying composition
// only) gets its own slice on Studio/draft renders, so a large upload cannot
// squeeze the product references inside DIRECT_REQUEST_REFERENCE_BUDGET. It
// carries arrangement rather than product detail, so it needs far less
// fidelity than a reference — placement, scale, and overlap survive heavy
// compression.
export const LAYOUT_MASTER_TRANSPORT_BUDGET = 400 * 1024;

export function fileFingerprint(file: File) {
  return `${file.name}:${file.size}:${file.lastModified}:${file.type}`;
}

export async function dataUrlFile(dataUrl: string, filename: string) {
  const response = await fetch(dataUrl);
  return new File([await response.blob()], filename, { type: "image/png", lastModified: Date.now() });
}

export function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

export function base64ImageToObjectUrl(base64: string, mimeType: string) {
  const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  return URL.createObjectURL(new Blob([bytes], { type: mimeType || "image/png" }));
}

export async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

// Accuracy review is layout/box-oriented, not pixel-detail: downscale review
// images aggressively before base64-encoding them into the JSON review
// request, so a many-reference board still respects the 32MB request-body
// cap. Separate from optimizeReferencesForTransport (which targets a shared
// byte budget for direct multipart generation references).
export const REVIEW_IMAGE_MAX_DIMENSION = 1024;
export const REVIEW_IMAGE_BYTE_BUDGET = 350 * 1024;

export async function downscaleForReview(file: File, maxDimension = REVIEW_IMAGE_MAX_DIMENSION, budget = REVIEW_IMAGE_BYTE_BUDGET): Promise<File> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error(`Could not prepare ${file.name || "image"} for review.`);
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);

    let best: Blob | null = null;
    for (const quality of [0.82, 0.72, 0.62, 0.52, 0.42]) {
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (value) => value ? resolve(value) : reject(new Error(`Could not encode ${file.name || "image"} for review.`)),
          "image/jpeg",
          quality,
        ),
      );
      best = !best || blob.size < best.size ? blob : best;
      if (blob.size <= budget) break;
    }
    if (!best) throw new Error(`Could not encode ${file.name || "image"} for review.`);
    return new File([best], "review.jpg", { type: "image/jpeg", lastModified: Date.now() });
  } finally {
    bitmap.close();
  }
}

export async function optimizeReferencesForTransport(files: File[], budget = DIRECT_REQUEST_REFERENCE_BUDGET) {
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes <= budget) return files;

  // Redistribute the budget left over by small files to the oversized ones,
  // so one large photo isn't crushed while tiny swatches waste their share.
  const fairShare = Math.floor(budget / Math.max(files.length, 1));
  const surplus = files.reduce((sum, file) => sum + Math.max(0, fairShare - file.size), 0);
  const oversizedCount = files.filter((file) => file.size > fairShare).length;
  const targetBytes = fairShare + Math.floor(surplus / Math.max(oversizedCount, 1));
  return mapWithLimit(files, TRANSPORT_CONCURRENCY, (file) => optimizeReferenceForTransport(file, targetBytes));
}

// How many references went out as a re-encoded copy. optimizeReferenceForTransport
// returns the very same File when a reference fit its budget untouched and a new
// one when it had to be resized or re-encoded (and flattened onto white), so
// identity says which ones the model received at full quality.
export function compressedReferenceCount(originals: File[], sent: File[]): number {
  return sent.filter((file, index) => file !== originals[index]).length;
}

// Bounded by bytes, not entries: 64 small thumbnails and 64 near-budget
// references are very different amounts of memory.
const TRANSPORT_CACHE_BYTES = 64 * 1024 * 1024;

export function createByteBudgetCache(limitBytes: number) {
  const entries = new Map<string, File>();
  let bytes = 0;
  return {
    get(key: string) {
      return entries.get(key);
    },
    set(key: string, file: File) {
      const previous = entries.get(key);
      if (previous) {
        entries.delete(key);
        bytes -= previous.size;
      }
      entries.set(key, file);
      bytes += file.size;
      // Oldest first (Map keeps insertion order); the newest entry always stays.
      for (const [oldestKey, oldest] of entries) {
        if (bytes <= limitBytes || oldestKey === key) break;
        entries.delete(oldestKey);
        bytes -= oldest.size;
      }
    },
    get bytes() {
      return bytes;
    },
  };
}

const transportCache = createByteBudgetCache(TRANSPORT_CACHE_BYTES);

// Each over-budget reference is decoded to a full bitmap on the main thread
// (about 96 MB for a 24 MP photo), so they are prepared a couple at a time,
// not all at once.
export const TRANSPORT_CONCURRENCY = 2;

export async function mapWithLimit<T, R>(items: T[], limit: number, run: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Keyed on the bytes. fileFingerprint (name, size, date, type) is not identity
// here: Workbench hands every reference over as a fresh `input.<ext>` File
// stamped in the same millisecond (fileFromCacheKey), so two different images
// of one type and byte length would share a key, and a paid render would
// receive the other image's compressed copy. Hashing costs far less than the
// decode and re-encode this cache exists to skip.
export async function transportCacheKey(file: File, targetBytes: number): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return `${hex}|${targetBytes}`;
}

export async function optimizeReferenceForTransport(file: File, targetBytes: number) {
  if (file.size <= targetBytes) return file;
  const cacheKey = await transportCacheKey(file, targetBytes);
  const cached = transportCache.get(cacheKey);
  if (cached) return cached;
  const optimized = await compressReferenceForTransport(file, targetBytes);
  transportCache.set(cacheKey, optimized);
  return optimized;
}

async function compressReferenceForTransport(file: File, targetBytes: number) {
  const bitmap = await createImageBitmap(file);
  let scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
  let best: Blob | null = null;

  try {
    for (let pass = 0; pass < 4; pass += 1) {
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error(`Could not prepare ${file.name} for generation.`);
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
      context.drawImage(bitmap, 0, 0, width, height);

      for (const quality of [0.92, 0.86, 0.8, 0.74, 0.68]) {
        const blob = await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob(
            (value) => value ? resolve(value) : reject(new Error(`Could not optimize ${file.name}.`)),
            "image/jpeg",
            quality,
          ),
        );
        best = !best || blob.size < best.size ? blob : best;
        if (blob.size <= targetBytes) return transportFile(blob, file.name);
      }
      scale *= 0.78;
    }
  } finally {
    bitmap.close();
  }

  if (!best) throw new Error(`Could not optimize ${file.name}.`);
  return transportFile(best, file.name);
}

function transportFile(blob: Blob, originalName: string) {
  const base = originalName.replace(/\.[^.]+$/, "") || "reference";
  return new File([blob], `${base}-optimized.jpg`, { type: "image/jpeg", lastModified: Date.now() });
}
