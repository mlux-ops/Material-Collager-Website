// Image dimensions straight from a file header, with no decoder.
//
// Both sides need this and neither can use the same tool. The CLI's tile index
// is synchronous (readdirSync-based, called without await), so it cannot go
// through sharp's async API; the Worker has no sharp at all. So the parsers are
// here, on Uint8Array and DataView rather than node:Buffer — Buffer exists on
// the Worker under nodejs_compat but not in the browser bundle, and app/lib is
// compiled into both.
//
// Deliberately narrow: just enough to read width and height from the three
// formats this pipeline handles. Anything else returns null, which callers
// treat as "unknown", never as an error.

export type ImageSize = { width: number; height: number };

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let out = "";
  for (let i = start; i < end && i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function parsePngSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 24) return null;
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return null;
  }
  // IHDR is always the first chunk: 4-byte length + "IHDR" + width(4) + height(4),
  // so width/height sit at fixed offsets 16-23.
  if (ascii(bytes, 12, 16) !== "IHDR") return null;
  const view = viewOf(bytes);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

// Walks JPEG markers looking for the first SOFn (0xFFC0-0xFFCF, excluding
// 0xFFC4 DHT, 0xFFC8 JPG, 0xFFCC DAC, which share the numeric range but are not
// start-of-frame segments). Returns null if none is found in `bytes` — the
// caller re-reads the whole file and retries when that happens, since a SOF can
// sit after large APP0/APP1/EXIF segments.
function parseJpegSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const view = viewOf(bytes);
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1; // not a marker byte — resync
      continue;
    }
    let markerOffset = offset;
    let marker = bytes[markerOffset + 1];
    while (marker === 0xff && markerOffset + 2 < bytes.length) {
      markerOffset += 1; // markers may be padded with extra 0xFF fill bytes
      marker = bytes[markerOffset + 1];
    }
    const isStandalone = marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9);
    if (isStandalone) {
      offset = markerOffset + 2;
      continue;
    }
    if (markerOffset + 4 > bytes.length) return null;
    const segmentLength = view.getUint16(markerOffset + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (markerOffset + 9 > bytes.length) return null; // segment header truncated
      return { height: view.getUint16(markerOffset + 5), width: view.getUint16(markerOffset + 7) };
    }
    offset = markerOffset + 2 + segmentLength;
  }
  return null;
}

// RIFF/WEBP container: 12-byte header, then a "VP8 " (lossy), "VP8L"
// (lossless), or "VP8X" (extended) chunk carrying the dimensions in three
// different bit layouts.
function parseWebpSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 30) return null;
  if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 12) !== "WEBP") return null;
  const fourCC = ascii(bytes, 12, 16);
  const view = viewOf(bytes);
  const chunkDataStart = 20; // 12-byte RIFF/WEBP header + 4-byte fourCC + 4-byte chunk size
  if (fourCC === "VP8 ") {
    // 3-byte frame tag, then the 3-byte start code 0x9d 0x01 0x2a, then
    // width/height as little-endian u16 (14-bit dimension + 2-bit scale).
    const startCode = chunkDataStart + 3;
    if (bytes[startCode] !== 0x9d || bytes[startCode + 1] !== 0x01 || bytes[startCode + 2] !== 0x2a) return null;
    return {
      width: view.getUint16(startCode + 3, true) & 0x3fff,
      height: view.getUint16(startCode + 5, true) & 0x3fff,
    };
  }
  if (fourCC === "VP8L") {
    if (bytes[chunkDataStart] !== 0x2f) return null; // VP8L signature byte
    const bits = view.getUint32(chunkDataStart + 1, true); // 14-bit width-1, 14-bit height-1, packed LE
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (fourCC === "VP8X") {
    // 1-byte flags + 3-byte reserved, then 24-bit LE canvas width-1 and height-1.
    const uint24 = (at: number) => bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16);
    return {
      width: uint24(chunkDataStart + 4) + 1,
      height: uint24(chunkDataStart + 7) + 1,
    };
  }
  return null;
}

/**
 * Reads dimensions from an image's leading bytes.
 *
 * `truncated` tells the function whether `bytes` is the whole file. A JPEG's
 * SOF can sit past a large EXIF segment, so an inconclusive parse over a
 * truncated head is "read more and try again", not "unparseable" — the caller
 * decides how to get the rest, which is the only part that differs between a
 * file descriptor and an HTTP response.
 */
export function readImageSizeFromBytes(bytes: Uint8Array): ImageSize | null {
  return parsePngSize(bytes) ?? parseWebpSize(bytes) ?? parseJpegSize(bytes);
}

export const HEADER_PEEK_BYTES = 64 * 1024;

// The sniffed content type, from the same magic bytes the parsers key on, so a
// file's own header decides what it is rather than a server's Content-Type
// header or a client-supplied filename.
export function sniffImageType(bytes: Uint8Array): "image/png" | "image/jpeg" | "image/webp" | null {
  if (parsePngSize(bytes)) return "image/png";
  if (parseWebpSize(bytes)) return "image/webp";
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  return null;
}
