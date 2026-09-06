// Tile palette resolution. The Master Library has NO tile line items in the
// Smartsheet/manifest (only 4 cost codes: Hardware, Appliances, Plumbing,
// Lighting) — tiles exist only as a flat photo pool under Tile/tiles/, coded
// AT# (accent), FT# (floor), WT# (wall) followed by a material/color name.
// Per-room tile picks live in tile-assignments.json — see its own README for
// provenance (the "Wieland Selections Book" v4 schedule, Elm Surfaces).

import { closeSync, fstatSync, openSync, readSync, readdirSync } from "node:fs";
import path from "node:path";

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

export function resolveTileCode(index, code) {
  return index.get(code.trim().toUpperCase()) ?? null;
}

// --- Header-only image size reading -----------------------------------
//
// indexTileCodes is synchronous (readdirSync-based, called without await at
// both call sites), so dimensions here can't go through sharp's async API.
// These are small, deliberately narrow header parsers — just enough to read
// width/height from the three formats the tile library uses.

const HEADER_PEEK_BYTES = 64 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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

function parsePngSize(buffer) {
  if (buffer.length < 24) return null;
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  // IHDR is always the file's first chunk: 4-byte length + "IHDR" + width(4) + height(4),
  // so width/height sit at fixed offsets 16-23.
  if (buffer.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

// Walks JPEG markers looking for the first SOFn (0xFFC0-0xFFCF, excluding
// 0xFFC4 DHT, 0xFFC8 JPG, 0xFFCC DAC, which share the numeric range but
// aren't start-of-frame segments). Returns null if none is found in
// `buffer` — the caller re-reads the whole file and retries when that
// happens, since a SOF can sit after large APP0/APP1/EXIF segments.
function parseJpegSize(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1; // not a marker byte — resync
      continue;
    }
    let markerOffset = offset;
    let marker = buffer[markerOffset + 1];
    while (marker === 0xff && markerOffset + 2 < buffer.length) {
      markerOffset += 1; // markers may be padded with extra 0xFF fill bytes
      marker = buffer[markerOffset + 1];
    }
    const isStandalone = marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9);
    if (isStandalone) {
      offset = markerOffset + 2;
      continue;
    }
    if (markerOffset + 4 > buffer.length) return null;
    const segmentLength = buffer.readUInt16BE(markerOffset + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (markerOffset + 9 > buffer.length) return null; // segment header truncated
      return { height: buffer.readUInt16BE(markerOffset + 5), width: buffer.readUInt16BE(markerOffset + 7) };
    }
    offset = markerOffset + 2 + segmentLength;
  }
  return null;
}

// RIFF/WEBP container: 12-byte header, then a "VP8 " (lossy), "VP8L"
// (lossless), or "VP8X" (extended) chunk carrying the dimensions in three
// different bit layouts.
function parseWebpSize(buffer) {
  if (buffer.length < 30) return null;
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WEBP") return null;
  const fourCC = buffer.toString("ascii", 12, 16);
  const chunkDataStart = 20; // 12-byte RIFF/WEBP header + 4-byte fourCC + 4-byte chunk size
  if (fourCC === "VP8 ") {
    // 3-byte frame tag, then the 3-byte start code 0x9d 0x01 0x2a, then
    // width/height as little-endian u16 (14-bit dimension + 2-bit scale).
    const startCode = chunkDataStart + 3;
    if (buffer[startCode] !== 0x9d || buffer[startCode + 1] !== 0x01 || buffer[startCode + 2] !== 0x2a) return null;
    return {
      width: buffer.readUInt16LE(startCode + 3) & 0x3fff,
      height: buffer.readUInt16LE(startCode + 5) & 0x3fff,
    };
  }
  if (fourCC === "VP8L") {
    if (buffer[chunkDataStart] !== 0x2f) return null; // VP8L signature byte
    const bits = buffer.readUInt32LE(chunkDataStart + 1); // 14-bit width-1, 14-bit height-1, packed LE
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (fourCC === "VP8X") {
    // 1-byte flags + 3-byte reserved, then 24-bit LE canvas width-1 and height-1.
    return {
      width: buffer.readUIntLE(chunkDataStart + 4, 3) + 1,
      height: buffer.readUIntLE(chunkDataStart + 7, 3) + 1,
    };
  }
  return null;
}

// Reads image dimensions straight from the file header, without sharp.
// Reads only the first ~64 KB; if that's inconclusive for a JPEG and the
// file is bigger than the peek, re-reads the whole file once. Returns null
// for anything it can't parse.
export function readImageSize(filePath) {
  const { buffer, truncated } = readLeadingBytes(filePath, HEADER_PEEK_BYTES);
  const png = parsePngSize(buffer);
  if (png) return png;
  const webp = parseWebpSize(buffer);
  if (webp) return webp;
  const jpeg = parseJpegSize(buffer);
  if (jpeg) return jpeg;
  if (truncated) {
    const { buffer: fullBuffer } = readLeadingBytes(filePath, Infinity);
    return parseJpegSize(fullBuffer);
  }
  return null;
}
