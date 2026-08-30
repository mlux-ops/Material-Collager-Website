// Tile palette resolution. The Master Library has NO tile line items in the
// Smartsheet/manifest (only 4 cost codes: Hardware, Appliances, Plumbing,
// Lighting) — tiles exist only as a flat photo pool under Tile/tiles/, coded
// AT# (accent), FT# (floor), WT# (wall) followed by a material/color name.
// Per-room tile picks live in tile-assignments.json — see its own README for
// provenance (the "Wieland Selections Book" v4 schedule, Elm Surfaces).

import { readdirSync } from "node:fs";
import path from "node:path";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const CODE_PATTERN = /^(?:([A-Z]{2}\d+)_)+/;

export function tileLibraryDir(libraryRoot) {
  return path.join(libraryRoot, "Tile", "tiles");
}

// Map<code, { code, materialName, filePath }>. A file can carry more than one
// code (e.g. "FT1_WT1_Cortar_Bone.jpg" is one photo used for both a floor and
// a wall tile schedule entry) — each code gets its own index entry pointing
// at the same file. When two files claim the same code, the first in
// alphabetical order wins, matching this codebase's existing
// first-match-is-deterministic convention (see match.mjs's assignSlots).
export function indexTileCodes(libraryRoot) {
  const dir = tileLibraryDir(libraryRoot);
  const files = readdirSync(dir)
    .filter((name) => IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase()))
    .sort();
  const index = new Map();
  for (const file of files) {
    const base = file.slice(0, -path.extname(file).length);
    const codeMatch = base.match(CODE_PATTERN);
    if (!codeMatch) continue;
    const codePrefix = codeMatch[0];
    const codes = [...codePrefix.matchAll(/[A-Z]{2}\d+/g)].map((m) => m[0]);
    const materialName = base.slice(codePrefix.length).replaceAll("_", " ").trim();
    for (const code of codes) {
      if (index.has(code)) continue;
      index.set(code, { code, materialName, filePath: path.join(dir, file) });
    }
  }
  return index;
}

export function resolveTileCode(index, code) {
  return index.get(code.trim().toUpperCase()) ?? null;
}
