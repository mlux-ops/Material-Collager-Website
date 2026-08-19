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
  return Promise.all(files.map((file) => optimizeReferenceForTransport(file, targetBytes)));
}

// Compressing a reference is expensive (decode + multiple canvas encodes on
// the main thread) and the same files are re-sent on every iterative
// generation, so cache results per source file and target size.
const transportCache = new Map<string, File>();
const TRANSPORT_CACHE_LIMIT = 64;

export async function optimizeReferenceForTransport(file: File, targetBytes: number) {
  if (file.size <= targetBytes) return file;
  const cacheKey = `${fileFingerprint(file)}|${targetBytes}`;
  const cached = transportCache.get(cacheKey);
  if (cached) return cached;
  const optimized = await compressReferenceForTransport(file, targetBytes);
  if (transportCache.size >= TRANSPORT_CACHE_LIMIT) {
    const oldest = transportCache.keys().next().value;
    if (oldest !== undefined) transportCache.delete(oldest);
  }
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
