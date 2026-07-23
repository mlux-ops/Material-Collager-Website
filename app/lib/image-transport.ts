// Shared client-side image transport helpers: compressing reference images to
// a byte budget before direct multipart upload, and converting between
// base64/data-URL/object-URL image representations without holding multi-MB
// base64 strings in React state.

export const DIRECT_REQUEST_REFERENCE_BUDGET = 700 * 1024;

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
