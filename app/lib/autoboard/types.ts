// Shared autoboard types. Both the CLI (scripts/autoboard/) and the web review
// board build the same boards from the same rules; these are the shapes that
// cross that boundary.
//
// Every export here is a `type`, and every importer must use `import type`.
// Node's --experimental-strip-types erases only what is syntactically marked as
// a type — it never resolves anything — so a value-position import of a name
// declared here is a link-time SyntaxError that tsc and eslint both accept.
// tsconfig sets `verbatimModuleSyntax` so that mistake is a compile error.

import type { CollageItemInput, CollageType } from "../collage.ts";

export type { CollageType };

// A row as both sources normalize it: Smartsheet live, or build_manifest_v2.csv
// offline. `status` is the project-definition marker (preferred / alternative /
// pending); only "alternative" changes behaviour.
export type LibraryRow = {
  rowId: string;
  status: string;
  unitType: string;
  roomLabel: string;
  roomOriginal: string;
  costCode: string;
  itemName: string;
  sku: string;
  qty: number;
  reference: string;
};

// Resolves a row to its reference image paths.
//
// The second parameter is the reused-row-id guard: the disk resolver uses it to
// detect a row-id entry whose SKU no longer matches what the caller expects and
// fall back to the SKU index. It is OPTIONAL and, in the shipped CLI, never
// supplied — both production call sites wrap the resolver in withUploads, whose
// closure takes one parameter and drops the sku. That drop is deliberate:
// forwarding it would switch the guard on and change which folder's photos land
// on a board, which is a rendering change and not part of this extraction.
// tests/autoboard-parity.test.mjs pins both halves.
export type ResolveImages = (rowId: string, sku?: string) => string[];

export type BoardItem = {
  slotId: string;
  role: string;
  required: boolean;
  // `null` marks a tile injected from the tile schedule rather than sourced
  // from a library row. The CLI's HOLD warning keys on `=== null` exactly, so
  // this is `string | null` and never optional: omitting the key would make the
  // warning silently disappear.
  rowId: string | null;
  sku: string;
  brand: string;
  name: string;
  notes: string;
  images: string[];
  tier?: string;
  provenance?: string;

  // `notes` and `note` are NOT the same field and must not be merged.
  // `notes` is model-facing and reaches buildGenerationPrompt as the item's
  // "specific instruction"; `note` is what a reviewer typed about this slot in
  // the review UI. boardForRender joins them, in that order, only at render
  // time. Both feed selectionHash, so editing either makes a draft stale.
  note?: string;

  // Review bookkeeping, deliberately excluded from selectionHash: changing
  // them must not invalidate an otherwise-identical render.
  overriddenAt?: number;
  imageMeta?: { path: string; width?: number; height?: number; error?: string }[];
};

export type Board = {
  id: string;
  unitType: string;
  roomLabel: string;
  collageType: CollageType;
  kindLabel: string;
  title: string;
  items: BoardItem[];
  aliases?: string[];

  // Set from the review UI. `heroItemId` names the slot that anchors the
  // composition, overriding the per-board-type ranking, but only while it still
  // names a slot the board has. `renderOptions` is sparse on purpose: a plan
  // written before the options UI has no such field and keeps the stage's
  // historical quality default.
  heroItemId?: string;
  renderOptions?: { quality?: string; background?: string };
};

export type TileEntry = {
  code: string;
  materialName: string;
  filePath: string;
};

export type TileAssignment = {
  mainTile?: string;
  accentTile?: string;
};

// Everything the pipeline could not resolve, recorded instead of guessed.
// `substituteCandidates` is optional because callers predating substitutes pass
// a gaps object without it, and buildBoards pushes through `?.` so those
// callers skip the record rather than throwing.
export type Gaps = {
  blankUnitRows: unknown[];
  blankRoomRows: unknown[];
  substituteCandidates?: unknown[];
  unmappedItems: unknown[];
  imagelessItems: unknown[];
  skippedRooms: unknown[];
  slotConflicts: unknown[];
  unfilledSlots: unknown[];
  skippedBoards: unknown[];
  lowResolutionReferences: unknown[];
  mergedBoards: unknown[];
};

export type SlotAssignment = {
  preset: CollageItemInput;
  row: LibraryRow;
  alternates: LibraryRow[];
};

export type SlotConflict = {
  slotId: string;
  collageType: CollageType;
  picked: { rowId: string; itemName: string };
  alternates: { rowId: string; itemName: string }[];
};

export type SubstituteRecord = {
  slotId: string;
  collageType: CollageType;
  rowId: string;
  itemName: string;
  sku: string;
};

export type BuildBoardsOptions = {
  resolveImages: ResolveImages;
  imagesPerItem?: number;
  minSlots?: number;
  gaps?: Gaps;
  tileAssignments?: Map<string, TileAssignment>;
  tileIndex?: Map<string, TileEntry>;
};
