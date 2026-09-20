// Where a reference photo can come from, and what is safe to fetch.
//
// The sheet's reference column holds a PRODUCT PAGE far more often than an
// image: "https://www.fergusonhome.com/thermador-mc30wp/s1655894" is a page, and
// storing its HTML as a photo would be a silent corruption. So a reference is
// resolved in two steps — fetch it, and if what comes back is a page rather than
// an image, read the images the page declares about itself.
//
// Pure and network-free on purpose: the guard and the extractor are where the
// mistakes are, and both are testable without touching the internet.

export const MAX_DISCOVERED_IMAGES = 6;

// Hosts that must never be fetched server-side. A Worker's fetch reaches the
// public internet, so a URL pasted into a sheet is untrusted input: without this
// guard, "http://169.254.169.254/latest/meta-data/" is a request this service
// makes on the attacker's behalf, from inside the perimeter.
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "[::1]",
  "metadata.google.internal",
  "metadata.goog",
]);

const BLOCKED_HOST_SUFFIXES = [".local", ".internal", ".localhost"];

// Literal IPv4 in a range that is not routable on the public internet. Names
// that RESOLVE into these ranges are not caught here — that needs resolution the
// fetch itself performs — which is why the scheme is also pinned to https and
// redirects are re-checked by the caller.
function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => Number(part));
  if (octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  const [a, b] = octets;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true; // link-local, incl. the cloud metadata endpoint
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  return false;
}

/**
 * Validates a URL the service is about to fetch on a person's behalf.
 * Throws with a message meant to be shown, rather than returning null, because
 * every caller has to stop here anyway.
 */
export function assertFetchableUrl(raw: unknown): URL {
  const text = String(raw ?? "").trim();
  if (!text) throw new Error("Give a URL to fetch the photo from.");

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`"${text.slice(0, 120)}" is not a URL.`);
  }

  // https only. http is not merely insecure here: it is the scheme most
  // internal services answer on, and file:/data: would read the host.
  if (url.protocol !== "https:") {
    throw new Error(`Only https URLs can be fetched; got "${url.protocol}".`);
  }

  const hostname = url.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(hostname) || BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    throw new Error(`"${hostname}" is not a public host.`);
  }
  if (hostname.startsWith("[")) throw new Error(`"${hostname}" is not a public host.`); // IPv6 literal
  if (isPrivateIpv4(hostname)) throw new Error(`"${hostname}" is a private address.`);

  return url;
}

const IMAGE_CONTENT_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"]);

export function isImageContentType(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  return IMAGE_CONTENT_TYPES.has(contentType.split(";")[0].trim().toLowerCase());
}

// Attribute order varies by site, so each meta tag is matched whole and its
// content pulled out separately rather than assuming property-then-content.
const META_TAG = /<meta\b[^>]*>/gi;
const LINK_TAG = /<link\b[^>]*>/gi;
const ATTR = (name: string) => new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i");

function attribute(tag: string, name: string): string | null {
  const match = ATTR(name).exec(tag);
  if (!match) return null;
  return (match[2] ?? match[3] ?? match[4] ?? "").trim();
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

/**
 * The images a page declares about itself: Open Graph first, then Twitter's
 * card, then `link rel="image_src"`.
 *
 * Deliberately NOT every `<img>` on the page — that is navigation chrome, badges
 * and tracking pixels, and the whole point of this step is to hand back a small
 * set worth a person's attention. A product page's og:image is its hero shot.
 */
export function extractImageUrls(html: string, baseUrl: string): string[] {
  const found: string[] = [];
  const push = (value: string | null) => {
    if (!value) return;
    // A URL reference never contains raw whitespace. Without this, a junk
    // value like "product image coming soon" resolves against the page as a
    // relative path and arrives in the grid as a real-looking candidate.
    if (/\s/.test(value.trim()) || !value.trim()) return;
    let absolute: string;
    try {
      absolute = new URL(decodeEntities(value), baseUrl).toString();
    } catch {
      return;
    }
    try {
      assertFetchableUrl(absolute);
    } catch {
      return; // a page pointing at a private host is not a candidate
    }
    if (!found.includes(absolute)) found.push(absolute);
  };

  const metas = (html.match(META_TAG) ?? []).map((tag) => ({
    key: (attribute(tag, "property") ?? attribute(tag, "name") ?? "").toLowerCase(),
    content: attribute(tag, "content"),
  }));

  // By declaration, not by document order. og:image is the image a page names
  // as ITSELF — a product page's hero shot — while twitter:image is often a
  // cropped card and image_src is a legacy fallback. Taking them in source
  // order would put whichever the page happened to emit first at the top of a
  // person's review grid.
  for (const key of ["og:image", "og:image:url", "og:image:secure_url"]) {
    for (const meta of metas) if (meta.key === key) push(meta.content);
  }
  for (const key of ["twitter:image", "twitter:image:src"]) {
    for (const meta of metas) if (meta.key === key) push(meta.content);
  }
  for (const tag of html.match(LINK_TAG) ?? []) {
    if ((attribute(tag, "rel") ?? "").toLowerCase() === "image_src") push(attribute(tag, "href"));
  }

  return found.slice(0, MAX_DISCOVERED_IMAGES);
}

// A reference photo below this on either edge is too small to hold up as a
// generation reference. Matches the CLI's annotateReferenceMeta thresholds, so
// both sides flag the same photos — and like the CLI, it is a flag, never an
// exclusion: the person decides.
export const MIN_REFERENCE_EDGE = 600;

export function isLowResolution(width: number, height: number): boolean {
  return Math.min(width, height) < MIN_REFERENCE_EDGE || Math.max(width, height) < MIN_REFERENCE_EDGE;
}
