// Tile-code lookup. The index itself is built by walking a photo directory
// (scripts/autoboard/lib/tiles.mjs, which stays on the CLI side because it
// reads the filesystem); the lookup is a pure Map read and travels with
// buildBoards so the core has no import back into scripts/.

import type { TileEntry } from "./types.ts";

export function resolveTileCode(index: Map<string, TileEntry>, code: string): TileEntry | null {
  return index.get(code.trim().toUpperCase()) ?? null;
}

