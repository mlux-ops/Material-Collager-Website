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

function isValidThumb(candidate: unknown): candidate is LibraryThumb {
  if (typeof candidate !== "object" || candidate === null) return false;
  const t = candidate as Record<string, unknown>;
  return (
    typeof t.id === "string" &&
    t.id.trim().length > 0 &&
    typeof t.name === "string" &&
    typeof t.thumb === "string" &&
    DATA_URI.test(t.thumb)
  );
}

/** Parse a serialized store. Exposed for tests; tolerant of any garbage. */
export function parseThumbStore(raw: string | null): LibraryThumb[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return [];
    if ((parsed as StoreShape).v !== 1) return [];
    const items = (parsed as StoreShape).items;
    if (!Array.isArray(items)) return [];
    return items.filter(isValidThumb).slice(0, MAX_THUMBS);
  } catch {
    return [];
  }
}

/** Serialize with the version stamp and cap. Exposed for tests. */
export function serializeThumbStore(items: LibraryThumb[]): string {
  return JSON.stringify({ v: 1, items: items.filter(isValidThumb).slice(0, MAX_THUMBS) } satisfies StoreShape);
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
 * Downscale the given card images to data-URI thumbnails and persist them.
 * Runs after the scene has painted (images are in the HTTP cache), so this
 * is cheap; failures skip the item rather than aborting the batch.
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
  if (out.length > 0) storeThumbs(out);
}
