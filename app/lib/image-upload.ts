// Shared by the routes that write a caller's image into the library (the
// Workbench's Save to Library and the Library's own upload page) and by the
// upload page in the browser, which checks the same rules before it sends
// anything. Browser-safe on purpose: no `cloudflare:workers`, no node builtins,
// so nothing here may import generation-jobs or openai-server.

export type LibraryImageType = "image/png" | "image/jpeg" | "image/webp";

/**
 * The real per-file ceiling for a library upload. Route handlers share the
 * 32 MB request-body cap (next.config.ts), so a single image has to leave room
 * for the multipart envelope and the title field under it.
 */
export const LIBRARY_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

/** What the file picker offers; the bytes still decide what is accepted. */
export const LIBRARY_UPLOAD_ACCEPT = "image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp";

export function base64FromBytes(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

const EXTENSION_FOR_TYPE: Record<LibraryImageType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/**
 * The EXIF Orientation (tag 0x0112 in IFD0) of a JPEG, or 1 when there is
 * none or the data is malformed. Every read is bounds-checked against the
 * APP1 segment, so a truncated or hostile header falls back to "unrotated"
 * instead of throwing.
 */
export function readJpegOrientation(bytes: Uint8Array): number {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return 1;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return 1;
    const marker = bytes[offset + 1];
    if (marker === 0xff) {
      offset += 1; // fill byte
      continue;
    }
    // Start of scan / end of image: no metadata segments past here.
    if (marker === 0xda || marker === 0xd9) return 1;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = view.getUint16(offset + 2);
    if (length < 2) return 1;
    const segmentStart = offset + 4;
    const segmentEnd = Math.min(offset + 2 + length, bytes.length);
    if (marker === 0xe1 && segmentEnd - segmentStart >= 6
      && bytes[segmentStart] === 0x45 && bytes[segmentStart + 1] === 0x78 && bytes[segmentStart + 2] === 0x69
      && bytes[segmentStart + 3] === 0x66 && bytes[segmentStart + 4] === 0 && bytes[segmentStart + 5] === 0) {
      return orientationFromTiff(view, segmentStart + 6, segmentEnd);
    }
    offset += 2 + length;
  }
  return 1;
}

function orientationFromTiff(view: DataView, tiff: number, end: number): number {
  if (tiff + 8 > end) return 1;
  const order = view.getUint16(tiff);
  const little = order === 0x4949; // "II"
  if (!little && order !== 0x4d4d) return 1; // neither "II" nor "MM"
  if (view.getUint16(tiff + 2, little) !== 42) return 1;
  const ifd = tiff + view.getUint32(tiff + 4, little);
  if (ifd < tiff + 8 || ifd + 2 > end) return 1;
  const count = view.getUint16(ifd, little);
  for (let index = 0; index < count; index++) {
    const entry = ifd + 2 + index * 12;
    if (entry + 12 > end) return 1;
    if (view.getUint16(entry, little) !== 0x0112) continue;
    // SHORT (type 3), count 1: the value sits in the first two bytes of the
    // entry's value field.
    if (view.getUint16(entry + 2, little) !== 3) return 1;
    const value = view.getUint16(entry + 8, little);
    return value >= 1 && value <= 8 ? value : 1;
  }
  return 1;
}

/**
 * The size a browser draws: EXIF orientations 5-8 rotate the image a quarter
 * turn, so the stored (sensor-order) width and height swap.
 */
export function displaySize(size: { width: number; height: number }, bytes: Uint8Array) {
  const orientation = readJpegOrientation(bytes);
  return orientation >= 5 ? { width: size.height, height: size.width } : size;
}

// Renaming is not transcoding: "board.png" holding JPEG bytes is stored as
// "board.jpg", so its name, MIME type and recorded format all agree.
export function safeFilename(value: string | undefined, type: LibraryImageType, fallbackStem: string) {
  const stem = (value?.trim() || fallbackStem).replace(/\.(png|jpe?g|webp)$/i, "");
  return `${stem}.${EXTENSION_FOR_TYPE[type]}`.replace(/[<>:"/\\|?*]+/g, "_");
}
