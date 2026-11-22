/**
 * Slot drop — the pure rules behind the Generator's reference-card drop
 * targets (app/components/SlotDrop.tsx).
 *
 * - isFileDrag: a drag only arms the cards when it carries files; a dragged
 *   link, text selection or in-page element never does.
 * - dropLabel: the over-state caption, "DROP TO SET 03", numbered the way the
 *   card's own `.item-number` badge is (two digits, 1-based).
 * - nextDragDepth: dragenter/dragleave fire for every child element the
 *   pointer crosses, and the child's enter arrives BEFORE the parent's leave,
 *   so a plain boolean flickers off and on at each child boundary. Counting
 *   enters minus leaves and treating "over" as depth > 0 does not.
 *
 * Import-free so node --test can load it directly (tests/slot-drop.test.mjs).
 */

/** True when a drag carries files: `DataTransfer.types` includes "Files". */
export function isFileDrag(types: readonly string[] | null | undefined): boolean {
  if (!types || types.length === 0) return false;
  for (const type of types) if (type === "Files") return true;
  return false;
}

/**
 * Two-digit, 1-based slot number, matching `String(index + 1).padStart(2, "0")`
 * on the card badge: 3 -> "03", 16 -> "16", 100 -> "100". Fractions are
 * truncated. Anything that is not a position (0, negatives, NaN, Infinity)
 * gives "".
 */
export function slotNumber(position: number): string {
  if (!Number.isFinite(position)) return "";
  const whole = Math.trunc(position);
  if (whole < 1) return "";
  return String(whole).padStart(2, "0");
}

/** "DROP TO SET 03". Without a valid position the number is left off. */
export function dropLabel(position: number): string {
  const number = slotNumber(position);
  return number ? `DROP TO SET ${number}` : "DROP TO SET";
}

export type DragDepthEvent = "enter" | "leave" | "drop" | "reset";

/**
 * The next enter/leave depth. Leaves never take it below 0 (an unbalanced
 * leave, e.g. from a drag that began over the element, is absorbed), and a
 * drop or reset always returns it to 0. A non-finite or negative depth is
 * read as 0.
 */
export function nextDragDepth(depth: number, event: DragDepthEvent): number {
  const current = Number.isFinite(depth) && depth > 0 ? Math.trunc(depth) : 0;
  switch (event) {
    case "enter":
      return current + 1;
    case "leave":
      return Math.max(0, current - 1);
    case "drop":
    case "reset":
      return 0;
  }
}

/** Whether a depth means the pointer is still over the element. */
export function isDragOver(depth: number): boolean {
  return Number.isFinite(depth) && depth > 0;
}
