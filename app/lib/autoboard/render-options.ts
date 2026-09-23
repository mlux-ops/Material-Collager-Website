// Render options, the hashes staleness is keyed on, and the board a render
// actually sees.
//
// Shared because a board drafted on the CLI and reviewed in the browser have to
// agree on one question: is this render still current? That answer is a sha1 of
// what the model sees, and it is already written into every results.json on
// disk — so the hash must be computed identically on both sides, from the same
// fields, in the same order.

import { sha1Hex } from "./sha1.ts";
import { modelNotes, orderedBoardItems } from "./variants.ts";
import type { Board } from "./types.ts";

export type RenderKind = "draft" | "confirm" | "final";
export type RenderOptions = { quality: string; background: string };

export const SUNBURST_QUALITY_OPTIONS: string[] = ["low", "medium", "high", "xhigh", "max", "auto"];
export const SUNBURST_BACKGROUND_OPTIONS: string[] = ["opaque", "transparent"];
const DEFAULT_STAGE_QUALITY: Record<string, string> = { draft: "low", confirm: "medium", final: "high" };

function validQuality(value: unknown): string | undefined {
  return typeof value === "string" && SUNBURST_QUALITY_OPTIONS.includes(value) ? value : undefined;
}

function validBackground(value: unknown): string | undefined {
  return typeof value === "string" && SUNBURST_BACKGROUND_OPTIONS.includes(value) ? value : undefined;
}

// Saved options are intentionally sparse. A plan written before the options
// UI has no renderOptions field and therefore remains opaque, with the stage's
// historical quality default. Reading this helper never mutates that plan.
export function savedRenderOptions(board: Board | null | undefined): { quality: string | undefined; background: string } {
  const saved = board?.renderOptions && typeof board.renderOptions === "object" ? board.renderOptions : {};
  return {
    quality: validQuality(saved.quality),
    background: validBackground(saved.background) ?? "opaque",
  };
}

// Explicit command/panel overrides win over a saved board option, which wins
// over the established draft/confirm/final default. Finals retain the Task 1
// minimum of high: low, medium, and auto are upgraded while xhigh/max remain
// explicit choices.
export function resolveRenderOptions(
  board: Board | null | undefined,
  kind: RenderKind,
  overrides: Partial<RenderOptions> = {},
): RenderOptions {
  const saved = savedRenderOptions(board);
  const stageDefault = DEFAULT_STAGE_QUALITY[kind];
  if (!stageDefault) throw new Error(`Unknown render kind "${kind}".`);
  const requestedQuality = validQuality(overrides.quality) ?? saved.quality ?? stageDefault;
  const quality = kind === "final" && ["low", "medium", "auto"].includes(requestedQuality)
    ? "high"
    : requestedQuality;
  return {
    quality,
    background: validBackground(overrides.background) ?? saved.background,
  };
}

// Bump when the prompt text app/lib/collage.ts produces changes shape, not just
// when a render option changes. selectionHash covers the board (items, notes,
// instruction) but not the prompt builder, so without this a prompt change
// would silently alter output while every existing render still reported as
// fresh. Folding it in here makes pre-change renders show as stale, which is
// what the review board already knows how to display.
// 2: change-scoped framing for layout-reference (confirm/final) renders.
const PROMPT_SHAPE_VERSION = 2;

export function renderOptionsHash(options: RenderOptions): string {
  return sha1Hex(
    JSON.stringify({ quality: options.quality, background: options.background, promptShape: PROMPT_SHAPE_VERSION }),
  );
}

export function renderRecordIsStale(
  board: Board,
  record: { selectionHash?: string; renderOptionsHash?: string } | null | undefined,
  kind: RenderKind,
  instruction = "",
): boolean {
  if (!record) return true;
  if (record.selectionHash !== selectionHash(board, instruction)) return true;
  // Historical records predate renderOptionsHash. Keep them unchanged and
  // compatible while marking them stale as soon as a board explicitly gains
  // saved options.
  if (record.renderOptionsHash || board?.renderOptions) {
    const current = resolveRenderOptions(board, kind);
    if (record.renderOptionsHash !== renderOptionsHash(current)) return true;
  }
  return false;
}

// Hash of everything the model actually sees for this board: which images
// fill each slot, each slot's note, and the board instruction. Used for
// stale detection and revision bumps. Bookkeeping fields (overriddenAt,
// title, provenance, imageMeta) deliberately excluded.
export function selectionHash(board: Board, instruction: unknown = ""): string {
  const digests = board.imageDigests ?? {};
  const material = {
    instruction: String(instruction ?? "").trim(),
    // item.notes goes through modelNotes so an edit to a legacy provenance
    // sentence it strips anyway (see modelNotes/LEGACY_NOTE_PATTERNS in
    // variants.mjs) doesn't mark an otherwise-unchanged draft stale.
    items: orderedBoardItems(board).map((item) => {
      const images = item.images ?? [];
      const entry: unknown[] = [item.slotId, images, modelNotes(item.notes) ?? "", String(item.note ?? "").trim()];
      // A photo replaced in place keeps its path, so only its digest shows the
      // pixels changed. Appended only when one of this item's images has a
      // digest, so every hash computed before digests existed is unchanged.
      const imageDigests = images.map((image) => digests[image] ?? null);
      if (imageDigests.some(Boolean)) entry.push(imageDigests);
      return entry;
    }),
  };
  return sha1Hex(JSON.stringify(material));
}

// The collage request has no board-level notes field (app/lib/collage.ts),
// only per-item notes, so the board instruction rides on the hero item —
// the first item in payload order — prefixed so the model can tell it apart
// from that item's own note. Returns a copy; never mutates the plan board.
export function boardForRender(board: Board, instruction: unknown = ""): Board {
  const heroSlotId = orderedBoardItems(board)[0]?.slotId;
  const cleanInstruction = String(instruction ?? "").trim();
  return {
    ...board,
    items: board.items.map((item) => {
      const parts = [modelNotes(item.notes) ?? "", String(item.note ?? "").trim()];
      if (cleanInstruction && item.slotId === heroSlotId) parts.push(`Board instruction: ${cleanInstruction}`);
      return { ...item, notes: parts.filter(Boolean).join(" ") };
    }),
  };
}
