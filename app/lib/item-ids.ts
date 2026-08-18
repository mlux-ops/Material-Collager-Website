// Item IDs are the join key for the whole pipeline: the generation prompt's
// reference map is keyed by them, hero selection points at one, and QA returns
// one verdict and one bounding box per ID. Duplicates are rejected outright by
// validateCollageRequest, so allocation has to guarantee uniqueness.
//
// The generator used to name a new row `item_${items.length + 1}`. Length is not
// a high-water mark: delete a row and the counter walks back onto a name that is
// still in use. Worse, the collision is a fixed point -- on a board of 8 rows
// holding two `item_8`s, deleting one leaves 7 rows and the next add recomputes
// `item_8`, so remove-and-re-add reproduces the same clash forever. The ID is
// also persisted in the saved draft, so a board stayed broken across reloads.
import { slugify } from "./collage.ts";

export type IdentifiableItem = {
  id?: string;
  role?: string;
};

// The ID a row resolves to today: its explicit ID, else its role slug, else its
// 1-based position. Mirrors what the request payload sends for this row.
export function resolveItemId(item: IdentifiableItem, index: number) {
  return item.id || slugify(item.role || `item_${index + 1}`);
}

// First `item_N` no row resolves to, starting the search past the current row
// count so ordinary boards still read item_6, item_7, item_8 in sequence.
export function nextItemId(items: IdentifiableItem[]) {
  return firstFreeId(new Set(items.map(resolveItemId)), items.length + 1);
}

// Give every row an explicit, unique ID, keeping the first claim on a name and
// renaming later collisions. Run on any board coming from outside current state
// (a restored draft) so an already-broken board heals instead of failing to
// generate until the user guesses which row to delete.
export function withUniqueItemIds<T extends IdentifiableItem>(items: T[]): T[] {
  const used = new Set<string>();
  return items.map((item, index) => {
    const resolved = resolveItemId(item, index);
    const id = used.has(resolved) ? firstFreeId(used, items.length + 1) : resolved;
    used.add(id);
    return item.id === id ? item : { ...item, id };
  });
}

function firstFreeId(used: Set<string>, from: number) {
  let suffix = from;
  while (used.has(`item_${suffix}`)) suffix += 1;
  return `item_${suffix}`;
}
