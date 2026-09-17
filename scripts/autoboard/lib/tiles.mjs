// Tile palette resolution. The Master Library has NO tile line items in the
// Smartsheet/manifest (only 4 cost codes: Hardware, Appliances, Plumbing,
// Lighting) — tiles exist only as a flat photo pool under Tile/tiles/, coded
// AT# (accent), FT# (floor), WT# (wall) followed by a material/color name.
// Per-room tile picks live in tile-assignments.json — see its own README for
// provenance (the "Wieland Selections Book" v4 schedule, Elm Surfaces).

import { closeSync, fstatSync, openSync, readSync, readdirSync } from "node:fs";
import path from "node:path";

import { HEADER_PEEK_BYTES, readImageSizeFromBytes } from "../../../app/lib/autoboard/image-size.ts";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const CODE_PATTERN = /^(?:([A-Z]{2}\d+)_)+/;

export function tileLibraryDir(libraryRoot) {
  return path.join(libraryRoot, "Tile", "tiles");
}

// Map<code, { code, materialName, filePath }>. A file can carry more than one
// code (e.g. "FT1_WT1_Cortar_Bone.jpg" is one photo used for both a floor and
// a wall tile schedule entry) — each code gets its own index entry pointing
// at the same file. When two files claim the same code (e.g. a thin
// reference strip and a proper field photo), the larger photo by pixel count
// (width*height) wins — a bigger reference beats an alphabetically-earlier
// one. When a size can't be read, or the two tie, the first file in
// alphabetical order wins (this function's own iteration order), matching
// this codebase's existing first-match-is-deterministic convention (see
// match.mjs's assignSlots).
export function indexTileCodes(libraryRoot) {
  const dir = tileLibraryDir(libraryRoot);
  const files = readdirSync(dir)
    .filter((name) => IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase()))
    .sort();
  const index = new Map();
  const pixelCounts = new Map(); // code -> current winner's width*height, or null if unreadable
  for (const file of files) {
    const base = file.slice(0, -path.extname(file).length);
    const codeMatch = base.match(CODE_PATTERN);
    if (!codeMatch) continue;
    const codePrefix = codeMatch[0];
    const codes = [...codePrefix.matchAll(/[A-Z]{2}\d+/g)].map((m) => m[0]);
    const materialName = base.slice(codePrefix.length).replaceAll("_", " ").trim();
    const filePath = path.join(dir, file);
    for (const code of codes) {
      if (!index.has(code)) {
        index.set(code, { code, materialName, filePath });
        pixelCounts.set(code, pixelCountOf(filePath));
        continue;
      }
      const candidatePixels = pixelCountOf(filePath);
      const currentPixels = pixelCounts.get(code);
      if (candidatePixels != null && (currentPixels == null || candidatePixels > currentPixels)) {
        index.set(code, { code, materialName, filePath });
        pixelCounts.set(code, candidatePixels);
      }
    }
  }
  return index;
}

function pixelCountOf(filePath) {
  const size = readImageSize(filePath);
  return size ? size.width * size.height : null;
}

// Re-exported from the shared core: buildBoards needs this lookup and must not
// import back into scripts/, so the implementation lives beside it.
export { resolveTileCode } from "../../../app/lib/autoboard/tiles.ts";

// --- Header-only image size reading -----------------------------------
//
// The parsers moved to app/lib/autoboard/image-size.ts so the Worker can use
// them too (it has no sharp, and indexTileCodes is synchronous so it cannot use
// sharp's async API either). What stays here is the file reading.

function readLeadingBytes(filePath, maxLength) {
  const fd = openSync(filePath, "r");
  try {
    const size = fstatSync(fd).size;
    const toRead = Math.min(maxLength, size);
    const buffer = Buffer.alloc(toRead);
    if (toRead > 0) readSync(fd, buffer, 0, toRead, 0);
    return { buffer, truncated: toRead < size };
  } finally {
    closeSync(fd);
  }
}

// Reads image dimensions straight from the file header, without sharp.
// Reads only the first ~64 KB; if that is inconclusive and the file is bigger
// than the peek, re-reads the whole file once (a JPEG's SOF can sit past a
// large EXIF segment). Returns null for anything it cannot parse.
export function readImageSize(filePath) {
  const { buffer, truncated } = readLeadingBytes(filePath, HEADER_PEEK_BYTES);
  const size = readImageSizeFromBytes(buffer);
  if (size) return size;
  if (truncated) {
    const { buffer: fullBuffer } = readLeadingBytes(filePath, Infinity);
    return readImageSizeFromBytes(fullBuffer);
  }
  return null;
}
