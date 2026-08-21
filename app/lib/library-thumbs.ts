/**
 * Tiny stored thumbnails of the Library's card images.
 *
 * The scene's canvas has nothing to show between mounting and its textures
 * arriving — that gap used to read as a white flash. These thumbnails are
 * captured client-side after the scene's first successful paint (~48px-wide
 * JPEG data URIs, a few hundred bytes each) and persisted in localStorage,
 * so every later visit can paint a dithered placeholder row instantly while
 * the real scene loads behind it (SceneWheelV2 + DitherReveal).
 *
 * No backend involvement: the store is derived, versioned, capped, and safe
 * to lose — a missing or corrupt store just means one visit without the
 * placeholder row, and the next paint re-captures it.
 */

export type LibraryThumb = {
  id: string;
  /** data: URI of the downscaled image. */
  thumb: string;
  name: string;
};

const STORE_KEY = "mc:library-thumbs:v1";
export const MAX_THUMBS = 16;
const THUMB_WIDTH = 48;
/** data: URIs only — anything else is rejected on load (a poisoned store
 * must never become an image source). */
const DATA_URI = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;

type StoreShape = { v: 1; items: LibraryThumb[] };

/** Hard ceiling per stored data URI (~9KB of image). Anything bigger is not
 * a 48px thumbnail and is rejected wholesale. */
export const MAX_THUMB_CHARS = 12_000;

function isValidThumb(candidate: unknown): candidate is LibraryThumb {
  if (typeof candidate !== "object" || candidate === null) return false;
  const t = candidate as Record<string, unknown>;
  return (
    typeof t.id === "string" &&
    t.id.trim().length > 0 &&
    t.id.length <= 128 &&
    typeof t.name === "string" &&
    t.name.length <= 256 &&
    typeof t.thumb === "string" &&
    t.thumb.length <= MAX_THUMB_CHARS &&
    DATA_URI.test(t.thumb)
  );
}

/** Validate an untrusted list into at most MAX_THUMBS clean entries. Shared
 * by the localStorage parse (client) and the API route (server) — the same
 * rules guard both directions. */
export function sanitizeThumbs(candidate: unknown): LibraryThumb[] {
  if (!Array.isArray(candidate)) return [];
  return candidate
    .filter(isValidThumb)
    .map((t) => ({ id: t.id, name: t.name, thumb: t.thumb }))
    .slice(0, MAX_THUMBS);
}

/** Parse a serialized store. Exposed for tests; tolerant of any garbage. */
export function parseThumbStore(raw: string | null): LibraryThumb[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return [];
    if ((parsed as StoreShape).v !== 1) return [];
    return sanitizeThumbs((parsed as StoreShape).items);
  } catch {
    return [];
  }
}

/** Serialize with the version stamp and cap. Exposed for tests. */
export function serializeThumbStore(items: LibraryThumb[]): string {
  return JSON.stringify({ v: 1, items: sanitizeThumbs(items) } satisfies StoreShape);
}

export function loadStoredThumbs(): LibraryThumb[] {
  if (typeof window === "undefined") return [];
  try {
    return parseThumbStore(window.localStorage.getItem(STORE_KEY));
  } catch {
    return []; // storage disabled (private mode etc.) — placeholder just skips
  }
}

function storeThumbs(items: LibraryThumb[]): void {
  try {
    window.localStorage.setItem(STORE_KEY, serializeThumbStore(items));
  } catch {
    // Quota/disabled storage: losing the cache is fine.
  }
}

/** True when the stored set already reflects these ids (skip re-capture). */
export function storedThumbsMatch(stored: LibraryThumb[], ids: string[]): boolean {
  const want = ids.slice(0, MAX_THUMBS);
  if (stored.length !== want.length) return false;
  return want.every((id, i) => stored[i]?.id === id);
}

/**
 * Fetch the shared thumbnail set from D1 (see /api/library/thumbs). Fills
 * localStorage so the next visit paints without a round trip. Returns []
 * on any failure — the placeholder row is always optional.
 */
export async function fetchServerThumbs(): Promise<LibraryThumb[]> {
  try {
    const response = await fetch("/api/library/thumbs", { cache: "no-store" });
    if (!response.ok) return [];
    const payload: unknown = await response.json();
    const thumbs = sanitizeThumbs((payload as { thumbs?: unknown })?.thumbs);
    if (thumbs.length > 0) storeThumbs(thumbs);
    return thumbs;
  } catch {
    return [];
  }
}

/**
 * Downscale the given card images to data-URI thumbnails and persist them —
 * locally for instant next paint, and to D1 so every device and visitor
 * shares the set. Runs after the scene has painted (images are in the HTTP
 * cache), so this is cheap; failures skip the item rather than aborting.
 */
export async function captureAndStoreThumbs(
  cards: { id: string; url: string; name: string }[],
): Promise<void> {
  const wanted = cards.slice(0, MAX_THUMBS);
  const out: LibraryThumb[] = [];
  for (const card of wanted) {
    try {
      const img = new Image();
      img.decoding = "async";
      img.src = card.url;
      await img.decode();
      const scale = THUMB_WIDTH / Math.max(1, img.naturalWidth);
      const canvas = document.createElement("canvas");
      canvas.width = THUMB_WIDTH;
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) continue;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      out.push({ id: card.id, name: card.name, thumb: canvas.toDataURL("image/jpeg", 0.6) });
    } catch {
      // Broken/blocked image: skip it.
    }
  }
  if (out.length === 0) return;
  storeThumbs(out);
  try {
    await fetch("/api/library/thumbs", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ thumbs: out }),
    });
  } catch {
    // Server persistence is best-effort; the local copy already landed.
  }
}
