import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  applyNoteOverrides,
  notesFilePath,
  overridesEqual,
  overridesToObject,
  readNoteOverrides,
  scaffoldNotesFile,
} from "../scripts/autoboard/lib/notes.mjs";

function withTempRunDir(fn) {
  const runDir = mkdtempSync(path.join(tmpdir(), "autoboard-notes-test-"));
  try {
    return fn(runDir);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
}

const board = {
  id: "penthouse-bath-2-fixture",
  title: "Penthouse Bath 2 Fixture Collage",
  items: [
    { slotId: "vanity_faucet", role: "vanity faucet", name: "Brizo Odin Faucet", notes: "" },
    { slotId: "shower_head", role: "shower head and wall arm", name: "Brizo Showerhead", notes: "quantity 2" },
  ],
};

test("scaffoldNotesFile writes a stub with every slot and never overwrites an existing file", () => {
  withTempRunDir((runDir) => {
    const filePath = scaffoldNotesFile(runDir, board);
    const first = JSON.parse(readFileSync(filePath, "utf8"));
    assert.equal(first.boardId, board.id);
    assert.deepEqual(first.items.map((item) => item.slotId), ["vanity_faucet", "shower_head"]);
    assert.equal(first.items[0].note, "");
    assert.equal(first.items[1].currentNotes, "quantity 2");

    // simulate hand-editing, then re-scaffold — must not be clobbered
    const edited = { ...first, items: first.items.map((item) => ({ ...item, note: "edited" })) };
    writeFileSync(filePath, JSON.stringify(edited), "utf8");
    scaffoldNotesFile(runDir, board);
    const after = JSON.parse(readFileSync(filePath, "utf8"));
    assert.equal(after.items[0].note, "edited");
  });
});

test("readNoteOverrides returns only non-empty, trimmed notes", () => {
  withTempRunDir((runDir) => {
    const filePath = notesFilePath(runDir, board.id);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      JSON.stringify({
        items: [
          { slotId: "vanity_faucet", note: "  keep it reading matte black  " },
          { slotId: "shower_head", note: "" },
          { slotId: "shower_head", note: "   " },
        ],
      }),
      "utf8",
    );
    const overrides = readNoteOverrides(runDir, board.id);
    assert.equal(overrides.size, 1);
    assert.equal(overrides.get("vanity_faucet"), "keep it reading matte black");
  });
});

test("readNoteOverrides returns an empty Map when no notes.json exists", () => {
  withTempRunDir((runDir) => {
    const overrides = readNoteOverrides(runDir, "no-such-board");
    assert.equal(overrides.size, 0);
  });
});

test("applyNoteOverrides overrides only matched slots and reports which ones changed", () => {
  const overrides = new Map([["vanity_faucet", "reads matte black, not chrome"]]);
  const { items, appliedSlotIds } = applyNoteOverrides(board.items, overrides);
  assert.equal(items[0].notes, "reads matte black, not chrome");
  assert.equal(items[1].notes, "quantity 2"); // unmatched slot untouched
  assert.deepEqual(appliedSlotIds, ["vanity_faucet"]);
  // original items are not mutated
  assert.equal(board.items[0].notes, "");
});

test("overridesToObject / overridesEqual round-trip and detect drift", () => {
  const overrides = new Map([["vanity_faucet", "reads matte black"], ["shower_head", "keep small"]]);
  const snapshot = overridesToObject(overrides);
  assert.deepEqual(snapshot, { vanity_faucet: "reads matte black", shower_head: "keep small" });
  assert.equal(overridesEqual(overrides, snapshot), true);
  assert.equal(overridesEqual(overrides, {}), false);
  assert.equal(overridesEqual(new Map(), {}), true);
  assert.equal(overridesEqual(overrides, { ...snapshot, shower_head: "different" }), false);
  assert.equal(overridesEqual(overrides, { vanity_faucet: "reads matte black" }), false); // fewer keys
});
