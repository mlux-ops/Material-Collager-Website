// Reference-image upload prep (finding F2b): the CLI's multipart upload path
// was shipping raw library photos as-is — 8 KB to 3.7 MB, up to 4000 px long
// edge — while the app's own browser upload path already caps the long edge
// at 2048. This brings the CLI path to parity: only resize/recompress what's
// actually over the app's own limits, and never touch (or upscale) anything
// already inside them.

import { readFile } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

const MIME_BY_EXTENSION = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
};

const LARGE_FILE_BYTES = 1.5 * 1024 * 1024;

export async function prepareReferenceForUpload(filePath, { maxLongEdge = 2048, jpegQuality = 86 } = {}) {
  const bytes = await readFile(filePath);
  const originalExt = path.extname(filePath).toLowerCase();
  const originalMime = MIME_BY_EXTENSION[originalExt] ?? "application/octet-stream";
  const image = sharp(bytes);
  const metadata = await image.metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  const longEdge = Math.max(width, height);

  const needsResize = longEdge > maxLongEdge || bytes.length > LARGE_FILE_BYTES;
  if (!needsResize) {
    return { bytes, filename: path.basename(filePath), mime: originalMime, resized: false, width, height };
  }

  const { data, info } = await image
    .resize(maxLongEdge, maxLongEdge, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: jpegQuality })
    .toBuffer({ resolveWithObject: true });
  const stem = path.basename(filePath, path.extname(filePath));
  return { bytes: data, filename: `${stem}.jpg`, mime: "image/jpeg", resized: true, width: info.width, height: info.height };
}
