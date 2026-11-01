/**
 * Print-in split — which gallery photos dissolve on load and which print in
 * as they scroll into view (effects.css, `mc-print-later`).
 *
 * A photo that is on screen when the gallery mounts is already past any
 * scroll-driven entry range, so it would never print at all; those keep the
 * time-based load dissolve. Everything else is tagged to print later, bound
 * to its scroller's view timeline. Each photo is decided exactly once, on
 * its FIRST observation: re-observing it after a scroll must never flip it.
 *
 * Import-free so node --test can load it directly (tests/print-in.test.mjs).
 */

export const PRINT_LATER_CLASS = "mc-print-later";

export interface PrintInEntry {
  id: string;
  isIntersecting: boolean;
}

/**
 * Ids of photos that print later: not intersecting on their first entry.
 * Later entries for an id already seen in this batch are ignored, as are
 * entries without an id.
 */
export function partitionPrintIn(entries: Iterable<PrintInEntry>): Set<string> {
  const decided = new Map<string, boolean>();
  for (const entry of entries) {
    if (!entry.id || decided.has(entry.id)) continue;
    decided.set(entry.id, entry.isIntersecting);
  }
  const later = new Set<string>();
  for (const [id, intersecting] of decided) if (!intersecting) later.add(id);
  return later;
}

/**
 * Union of the ids already printing later with a new batch. Returns `prev`
 * itself when nothing is new, so a React state setter skips the re-render.
 */
export function mergePrintLater(prev: ReadonlySet<string>, add: ReadonlySet<string>): ReadonlySet<string> {
  let next: Set<string> | null = null;
  for (const id of add) {
    if (prev.has(id)) continue;
    next ??= new Set(prev);
    next.add(id);
  }
  return next ?? prev;
}

/** Class for one photo: the later class when its id is in the set, else "". */
export function printInClass(later: ReadonlySet<string>, id: string): string {
  return later.has(id) ? PRINT_LATER_CLASS : "";
}
