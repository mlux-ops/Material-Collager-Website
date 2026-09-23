// Downloads a vendor product photo for the CLI: scaffold-project.mjs
// --fetch-images and review-candidates.mjs. Those URLs are a vendor's, and a
// vendor host can redirect anywhere — Node's fetch follows a redirect to
// loopback or a private address without complaint — so the download goes
// through the guard the Worker's own photo fetches use (app/lib/guarded-fetch.ts):
// https and a public host at EVERY hop, each redirect checked before it is
// requested; a timeout, so a stalled server fails one file instead of hanging
// the run; and a byte cap, so an oversized body is cancelled rather than
// buffered whole.
//
// guarded-fetch.ts is TypeScript, so whatever imports this runs under
// `node --experimental-strip-types`, as the rest of the autoboard CLI does.
//
// Node's fetch ignores HTTP_PROXY/HTTPS_PROXY unless NODE_USE_ENV_PROXY is set,
// which matters only in sandboxes that require a proxy — a normal workstation
// needs nothing.

import { fetchPublic, readCapped } from "../../../app/lib/guarded-fetch.ts";

// The Worker's cap on a reference photo (MAX_PHOTO_BYTES in app/lib/autoboard-photos.ts).
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

export async function downloadImage(url, { timeoutMs = TIMEOUT_MS } = {}) {
  const { response } = await fetchPublic(url, { headers: { "User-Agent": "Mozilla/5.0" }, timeoutMs });
  const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim();
  if (!response.ok || !contentType.startsWith("image/")) {
    await response.body?.cancel();
    throw new Error(response.ok ? `content-type ${contentType || "unknown"} is not an image` : `HTTP ${response.status}`);
  }
  const bytes = await readCapped(response, MAX_IMAGE_BYTES, { tooLarge: `larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB` });
  return { buffer: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), contentType };
}
