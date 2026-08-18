// Base64 <-> bytes for code running inside the Worker, where a request that
// spends too long on the CPU or holds too much at once is killed by Cloudflare
// with error 1102 ("Worker exceeded resource limits") -- the client then sees
// Cloudflare's HTML error page instead of a JSON response.
//
// A generated collage is multi-MB, so the two idioms this replaces were the
// expensive ones on the render path:
//
//   Uint8Array.from(atob(value), (c) => c.charCodeAt(0))
//     -- one closure invocation per byte, millions of calls for one PNG.
//
//   binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
//     -- spreads 32,768 arguments per call, which is both slow and a stack
//        hazard on a large buffer.
//
// Prefer the engine's native conversions (Uint8Array.fromBase64/toBase64) and
// keep a tight monomorphic loop as the fallback for runtimes without them.

type Base64Static = { fromBase64?: (value: string) => Uint8Array<ArrayBuffer> };
type Base64Instance = { toBase64?: () => string };

// Returns a Uint8Array over its own ArrayBuffer, so the result is usable
// directly as a BlobPart or an R2 body without a defensive copy.
export function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const fromBase64 = (Uint8Array as unknown as Base64Static).fromBase64;
  if (fromBase64) {
    try {
      return fromBase64.call(Uint8Array, value);
    } catch {
      // Native decoding is stricter than atob about padding and stray
      // whitespace; fall through rather than failing a render over it.
    }
  }
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array) {
  const toBase64 = (bytes as unknown as Base64Instance).toBase64;
  if (toBase64) return toBase64.call(bytes);
  // 4k arguments per call stays well inside the argument limit; the chunks are
  // joined once instead of growing one rope per iteration.
  const chunkSize = 0x1000;
  const chunks: string[] = [];
  for (let index = 0; index < bytes.length; index += chunkSize) {
    chunks.push(String.fromCharCode.apply(null, bytes.subarray(index, index + chunkSize) as unknown as number[]));
  }
  return btoa(chunks.join(""));
}

export async function blobToDataUrl(blob: Blob, fallbackMimeType = "image/png") {
  const base64 = bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
  return `data:${blob.type || fallbackMimeType};base64,${base64}`;
}
