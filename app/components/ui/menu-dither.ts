/* Per-row Velaris palettes over the black background — each row also gets
   its own seed, so pattern AND palette are unique per option. Rows 1-3 are
   the owner's Rechroma exports (oklch converted to sRGB hex); rows 4-6 are
   curated to sit alongside them. Module-scope constants: a fresh array
   literal per render would re-init the WebGL context on every hover state
   change. */
export const VELARIS_BG = "#000000";
export const ROW_PALETTES: string[][] = [
  ["#fab9b3", "#8ddbe3", "#cec3fa"], // 1 - sunlit starfish / milk waterfall / heather
  ["#a1de9f", "#f9185b", "#a36fff"], // 2 - fresh avocado / habanero / orchid
  ["#5f8df8", "#c46aca", "#42ac4c"], // 3 - lupine / linen bubblegum / matcha
  ["#d9a441", "#cd6543", "#4a5560"], // 4 - ochre / terracotta / slate ink
  ["#3a7ca5", "#7ac9bc", "#e8c98f"], // 5 - cerulean / sea glass / sand
  ["#1a1a1a", "#7a7a7a", "#c9c9c9"], // 6 - house monochrome inks
];

/* Owner pick from the dither mockup round: fine riso — 1px color dither,
   two levels per channel, on every row. */
export const ROW_DITHER = { cell: 1, levels: 2 };
