// Server-side fetches of URLs a person supplied: sheet cells, pasted links,
// model-suggested product pages. Every such fetch follows two rules.
//
// - Every hop is checked BEFORE it is requested. `redirect: "follow"` would
//   already have contacted a private host by the time its final URL could be
//   checked, so redirects are followed here one at a time, each Location run
//   through assertFetchableUrl first, at most MAX_REDIRECTS hops.
// - A body is read against a byte cap and the download is cancelled the moment
//   it goes over, rather than buffered whole (Content-Length can be absent or
//   wrong) just to be rejected.
//
// The guard is hostname-based: a Worker has no DNS API, so a public name that
// resolves to a private address is not caught here. Production egress cannot
// reach private networks; local dev, where Miniflare runs on a developer's
// machine, is the case the literal-host checks exist for.
//
// init.headers is sent to every hop, including one that has redirected to a
// different host than the one the caller asked for — unlike a browser's own
// redirect handling, nothing here strips anything cross-origin. Never pass an
// Authorization header, cookie, or other credential through fetchPublic.

import { assertFetchableUrl } from "./autoboard/photo-sources.ts";

export const MAX_REDIRECTS = 5;

// Only these statuses carry a Location a client is expected to follow. Every
// other 3xx (300 Multiple Choices, 304 Not Modified, a bare 305/306/309-399)
// is handed back to the caller's own `!response.ok` handling instead — a
// spec-conformance fix, not a security one: a followed 300 or 304 would still
// be validated hop by hop like any other.
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export async function fetchPublic(
  url: URL | string,
  init: { headers?: HeadersInit; timeoutMs: number },
): Promise<{ response: Response; url: URL }> {
  const signal = AbortSignal.timeout(init.timeoutMs);
  let current = assertFetchableUrl(String(url));
  for (let hop = 0; ; hop++) {
    const response = await fetch(current.toString(), { headers: init.headers, redirect: "manual", signal });
    if (!REDIRECT_STATUSES.has(response.status)) return { response, url: current };
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location) throw new Error(`${current.hostname} answered a redirect with no destination.`);
    if (hop >= MAX_REDIRECTS) throw new Error(`${current.hostname} redirected more than ${MAX_REDIRECTS} times.`);
    current = assertFetchableUrl(new URL(location, current).toString());
  }
}

/**
 * Reads at most `limit` bytes of `response`, cancelling the download as soon as
 * it goes over. The default refuses an oversized body; `onOverflow: "truncate"`
 * keeps the first `limit` bytes instead (an HTML page whose metadata sits near
 * the top).
 */
export async function readCapped(
  response: Response,
  limit: number,
  options: { tooLarge?: string; onOverflow?: "throw" | "truncate" } = {},
): Promise<Uint8Array<ArrayBuffer>> {
  const tooLarge = options.tooLarge ?? "That file is over the size limit.";
  const truncate = options.onOverflow === "truncate";
  const declared = Number(response.headers.get("content-length") ?? "");
  if (!truncate && Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel();
    throw new Error(tooLarge);
  }
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > limit) {
      await reader.cancel();
      if (!truncate) throw new Error(tooLarge);
      chunks.push(value.subarray(0, limit - total));
      total = limit;
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
