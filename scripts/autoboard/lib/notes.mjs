// Per-board hand-authored notes: after `generate` produces a draft, the user
// reviews it and edits notes.json to guide `finalize`'s re-render. This never
// touches item images or board-wide art direction — only each item's
// "specific instruction" line in the prompt (see app/lib/collage.ts's
// buildGenerationPrompt, the REFERENCE MAP detail list).

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export function notesFilePath(runDir, boardId) {
  return path.join(runDir, "boards", boardId, "notes.json");
}

// Written once per board, after its first successful candidate render. Never
// overwrites an existing file, so hand-authored edits are never clobbered by
// a later --force re-render.
export function scaffoldNotesFile(runDir, board) {
  const filePath = notesFilePath(runDir, board.id);
  if (existsSync(filePath)) return filePath;
  mkdirSync(path.dirname(filePath), { recursive: true });
  const stub = {
    boardId: board.id,
    title: board.title,
    instructions:
      "Fill in `note` for any item after reviewing its draft, then run finalize. " +
      "Blank notes are left as-is (quantity-only, if the item has qty > 1). " +
      "This only affects that one item's prompt line — it does not change composition, lighting, or other items.",
    items: board.items.map((item) => ({
      slotId: item.slotId,
      role: item.role,
      name: item.name,
      currentNotes: item.notes || "",
      note: "",
    })),
  };
  writeFileSync(filePath, JSON.stringify(stub, null, 2), "utf8");
  return filePath;
}

// Returns a Map<slotId, note> of only the non-empty, hand-authored notes.
export function readNoteOverrides(runDir, boardId) {
  const filePath = notesFilePath(runDir, boardId);
  if (!existsSync(filePath)) return new Map();
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${filePath} is not valid JSON: ${error.message}`);
  }
  const overrides = new Map();
  for (const item of parsed.items ?? []) {
    const note = String(item.note ?? "").trim();
    if (note) overrides.set(item.slotId, note);
  }
  return overrides;
}

// Applies overrides without mutating the input items; unmatched slots are
// unaffected (a typo'd slotId in notes.json is silently a no-op — callers
// that want to catch that should diff the returned appliedSlotIds).
export function applyNoteOverrides(items, overrides) {
  const appliedSlotIds = [];
  const nextItems = items.map((item) => {
    if (!overrides.has(item.slotId)) return item;
    appliedSlotIds.push(item.slotId);
    return { ...item, notes: overrides.get(item.slotId) };
  });
  return { items: nextItems, appliedSlotIds };
}

export function overridesToObject(overrides) {
  return Object.fromEntries(overrides);
}

// Compares a live Map (from readNoteOverrides) against a plain object snapshot
// (stored on a prior candidate/redraft result). Used to refuse finalizing
// notes.json edits that were never drafted and reviewed.
export function overridesEqual(overrides, snapshot) {
  const snapshotEntries = Object.entries(snapshot ?? {});
  if (overrides.size !== snapshotEntries.length) return false;
  return snapshotEntries.every(([slotId, note]) => overrides.get(slotId) === note);
}
