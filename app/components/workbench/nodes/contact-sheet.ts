// Pure helpers for the Multi-Run contact sheet (no DOM, no JSX, no alias
// imports) so a node:test file can import them directly.

export const SHEET_SIZES = [72, 112, 168, 256] as const;
export const SHEET_DEFAULT_SIZE_INDEX = 1;
export const SHEET_GAP = 4;
export const CARD_PREVIEW_COUNT = 12;

// Columns that fit a grid `width` px wide with cells of at least `cell` px.
export function columnsFor(width: number, cell: number, gap = SHEET_GAP): number {
  if (!(width > 0) || !(cell > 0)) return 1;
  return Math.max(1, Math.floor((width + gap) / (cell + gap)));
}

export type SheetKey = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown" | "Home" | "End";

// Index to move to from `index` for a navigation key, clamped to the list.
// Up/Down move by a row; a Down from the last partial row stays on the last
// cell instead of falling off the grid.
export function stepIndex(index: number, key: SheetKey, columns: number, total: number): number {
  if (total <= 0) return 0;
  const cols = Math.max(1, Math.floor(columns));
  const last = total - 1;
  const clamp = (value: number) => Math.min(last, Math.max(0, value));
  switch (key) {
    case "ArrowLeft":
      return clamp(index - 1);
    case "ArrowRight":
      return clamp(index + 1);
    case "ArrowUp":
      return index - cols < 0 ? clamp(index) : index - cols;
    case "ArrowDown":
      return index + cols > last ? (Math.floor(index / cols) < Math.floor(last / cols) ? last : clamp(index)) : index + cols;
    case "Home":
      return 0;
    case "End":
      return last;
  }
}

// Wrap-free stepping for the large view.
export function stepLarge(index: number, delta: -1 | 1, total: number): number {
  if (total <= 0) return 0;
  return Math.min(total - 1, Math.max(0, index + delta));
}

export function previewSplit<T>(items: readonly T[], count = CARD_PREVIEW_COUNT): { shown: T[]; hidden: number } {
  const shown = items.slice(0, Math.max(0, count));
  return { shown, hidden: Math.max(0, items.length - shown.length) };
}
