// A person's edits on top of the sheet: pins, removals, hand-added rows, and
// the row written back into a Smartsheet. Runs against app/lib/autoboard
// directly, the way the web review board imports it.

import assert from "node:assert/strict";
import { test } from "node:test";

import { assignSlots, buildBoards } from "../app/lib/autoboard/match.ts";
import { previewBoards } from "../app/lib/autoboard/preview.ts";
import { emptyGaps } from "../app/lib/autoboard/source.ts";
import {
  MANUAL_ROW_PREFIX,
  applyRowEdits,
  emptyRowEdits,
  excludeBoards,
  isManualRowId,
  manualRow,
  pinChoices,
  validatePin,
} from "../app/lib/autoboard/row-edits.ts";
import { addSheetRow, cellValue, fileNewRow, sheetSchema } from "../app/lib/autoboard/sheet-write.ts";

function row(overrides) {
  return {
    rowId: "1",
    status: "",
    unitType: "Penthouse",
    roomLabel: "Bath 2",
    roomOriginal: "Bath 2",
    costCode: "11 45 Plumbing Fixtures M",
    itemName: "Item",
    sku: "SKU-1",
    qty: 1,
    reference: "",
    ...overrides,
  };
}

const pin = (rowId, slotId, collageType = "bathroom_fixture_collage") => new Map([[rowId, { collageType, slotId }]]);
const images = (rowId) => [`/fake/${rowId}.png`];

// ---------------------------------------------------------------------------
// Pins
// ---------------------------------------------------------------------------

test("a pinned row wins its slot ahead of every rule match, whatever it is called", () => {
  const rows = [
    row({ rowId: "1", itemName: "Brizo Odin Lavatory Faucet" }),
    row({ rowId: "2", itemName: "Mystery Item 200" }),
  ];
  const { filled, conflicts, unmapped } = assignSlots(rows, "bathroom_fixture_collage", pin("2", "vanity_faucet"));
  const faucet = filled.find((slot) => slot.preset.id === "vanity_faucet");
  assert.equal(faucet.row.rowId, "2");
  assert.deepEqual(faucet.alternates.map((entry) => entry.rowId), ["1"]);
  assert.deepEqual(conflicts.map((entry) => [entry.slotId, entry.picked.rowId]), [["vanity_faucet", "2"]]);
  assert.deepEqual(unmapped.map((entry) => entry.rowId), ["1"]);
});

test("a row pinned to one slot is never a candidate for another slot on that board type", () => {
  const rows = [row({ rowId: "1", itemName: "Kohler Purist Faucet" })];
  const { filled } = assignSlots(rows, "bathroom_fixture_collage", pin("1", "countertop"));
  assert.deepEqual(filled.map((slot) => [slot.preset.id, slot.row.rowId]), [["countertop", "1"]]);
});

test("a pin on another board type leaves this board type's rules alone", () => {
  const rows = [row({ rowId: "1", itemName: "Kohler Purist Faucet" })];
  const { filled } = assignSlots(rows, "bathroom_fixture_collage", pin("1", "wall_tile", "bathroom_tile_collage"));
  assert.deepEqual(filled.map((slot) => [slot.preset.id, slot.row.rowId]), [["vanity_faucet", "1"]]);
});

test("a pinned substitute is placed: the pin is the person's decision", () => {
  const rows = [row({ rowId: "1", itemName: "AXOR Uno Lavatory Faucet", status: "alternative" })];
  const { filled, substitutes } = assignSlots(rows, "bathroom_fixture_collage", pin("1", "vanity_faucet"));
  assert.deepEqual(filled.map((slot) => slot.row.rowId), ["1"]);
  assert.deepEqual(substitutes, []);
});

test("two rows pinned to one slot: the first in source order wins and the other is an alternate", () => {
  const rows = [row({ rowId: "1", itemName: "First" }), row({ rowId: "2", itemName: "Second" })];
  const pins = new Map([
    ["1", { collageType: "bathroom_fixture_collage", slotId: "countertop" }],
    ["2", { collageType: "bathroom_fixture_collage", slotId: "countertop" }],
  ]);
  const { filled, conflicts } = assignSlots(rows, "bathroom_fixture_collage", pins);
  assert.deepEqual(filled.map((slot) => [slot.preset.id, slot.row.rowId]), [["countertop", "1"]]);
  assert.deepEqual(conflicts[0].alternates.map((entry) => entry.rowId), ["2"]);
});

test("a pin naming a slot the board type does not have is ignored, not obeyed", () => {
  const rows = [row({ rowId: "1", itemName: "Kohler Purist Faucet" })];
  const { filled } = assignSlots(rows, "bathroom_fixture_collage", pin("1", "no_such_slot"));
  assert.deepEqual(filled.map((slot) => [slot.preset.id, slot.row.rowId]), [["vanity_faucet", "1"]]);
});

test("buildBoards and previewBoards both honour pins, and the preview marks the pinned slot", () => {
  const rows = [
    row({ rowId: "1", itemName: "Brizo Odin Lavatory Faucet" }),
    row({ rowId: "2", itemName: "Brizo Round Showerhead" }),
    row({ rowId: "3", itemName: "Marble Remnant" }),
  ];
  const pins = pin("3", "countertop");
  const { boards } = buildBoards(rows, { resolveImages: images, gaps: emptyGaps(), pins });
  const board = boards.find((entry) => entry.collageType === "bathroom_fixture_collage");
  assert.ok(board.items.some((item) => item.slotId === "countertop" && item.rowId === "3"));

  const preview = previewBoards(rows, { pins });
  const previewBoard = preview.boards.find((entry) => entry.collageType === "bathroom_fixture_collage");
  const countertop = previewBoard.slots.find((slot) => slot.slotId === "countertop");
  assert.equal(countertop.rowId, "3");
  assert.equal(countertop.pinned, true);
  assert.equal(previewBoard.slots.find((slot) => slot.slotId === "vanity_faucet").pinned, undefined);
  assert.ok(!preview.unmapped.some((entry) => entry.rowId === "3"));
});

test("excludeBoards applied to buildBoards and previewBoards output drops the same board from both, by the id they share", () => {
  const rows = [
    row({ rowId: "1", itemName: "Brizo Odin Lavatory Faucet" }),
    row({ rowId: "2", itemName: "Brizo Round Showerhead" }),
  ];
  const { boards: built } = buildBoards(rows, { resolveImages: images, gaps: emptyGaps() });
  const preview = previewBoards(rows);
  const targetId = built.find((entry) => entry.collageType === "bathroom_fixture_collage").id;
  assert.ok(preview.boards.some((entry) => entry.id === targetId), "preview and build must agree on the id to begin with");

  assert.ok(!excludeBoards(built, [targetId]).some((entry) => entry.id === targetId));
  assert.ok(!excludeBoards(preview.boards, [targetId]).some((entry) => entry.id === targetId));
  // A board id that never existed removes nothing — the count is unchanged.
  assert.equal(excludeBoards(built, ["no-such-board"]).length, built.length);
});

// ---------------------------------------------------------------------------
// Row edits
// ---------------------------------------------------------------------------

test("applyRowEdits keeps sheet rows first, appends manual rows, and drops what was removed", () => {
  const edits = emptyRowEdits();
  edits.manual.push(row({ rowId: "manual-a", itemName: "Hand-added Sconce" }));
  edits.excluded.set("2", row({ rowId: "2", itemName: "Removed" }));
  const rows = applyRowEdits([row({ rowId: "1" }), row({ rowId: "2" }), row({ rowId: "1" })], edits);
  assert.deepEqual(rows.map((entry) => entry.rowId), ["1", "manual-a"]);
});

// A board removed entirely: unlike applyRowEdits (which the row list is built
// from before a board exists), excludeBoards runs on the boards array AFTER
// buildBoards/previewBoards produce it — the id it filters on does not exist
// any earlier.
test("excludeBoards drops only the named board ids, leaving every other board untouched", () => {
  const boards = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.deepEqual(excludeBoards(boards, ["b"]), [{ id: "a" }, { id: "c" }]);
  // Accepts a Map's keys directly (how RowEdits.excludedBoards is stored) as
  // well as a plain array (how the public ProjectEdits.removedBoards shape
  // carries the same ids over HTTP) -- both are what the two real call sites
  // actually pass.
  const asMapKeys = new Map([["a", { id: "a", title: "A" }]]).keys();
  assert.deepEqual(excludeBoards(boards, asMapKeys), [{ id: "b" }, { id: "c" }]);
  assert.deepEqual(excludeBoards(boards, []), boards);
});

test("manualRow normalizes like the sheet reader and refuses a row no board could use", () => {
  const made = manualRow({ itemName: "  Kohler   Purist Sconce ", unitType: "Penthouse", roomType: "Bathroom 2", qty: "2" });
  assert.ok(isManualRowId(made.rowId));
  assert.ok(made.rowId.startsWith(MANUAL_ROW_PREFIX));
  assert.equal(made.itemName, "Kohler Purist Sconce");
  assert.equal(made.roomLabel, "Bath 2");
  assert.equal(made.roomOriginal, "Bathroom 2");
  assert.equal(made.qty, 2);
  assert.throws(() => manualRow({ unitType: "Penthouse", roomType: "Bath 2" }), /Give the item a name/);
  assert.throws(() => manualRow({ itemName: "X", roomType: "Bath 2" }), /unit type/);
  assert.throws(() => manualRow({ itemName: "X", unitType: "Penthouse" }), /room/);
});

test("validatePin accepts a real slot, normalizes a lighting pin, and refuses unknown types and slots", () => {
  assert.deepEqual(validatePin({ collageType: "bathroom_fixture_collage", slotId: "countertop" }), {
    collageType: "bathroom_fixture_collage",
    slotId: "countertop",
  });
  // The lighting board has no preset slots to validate against — any slotId
  // normalizes to the one placeholder, since a lighting pin means "force this
  // row onto the board," not "assign it to slot X."
  assert.deepEqual(validatePin({ collageType: "lighting_collage", slotId: "whatever" }), {
    collageType: "lighting_collage",
    slotId: "light_fixture",
  });
  assert.deepEqual(validatePin({ collageType: "lighting_collage" }), {
    collageType: "lighting_collage",
    slotId: "light_fixture",
  });
  assert.throws(() => validatePin({ collageType: "garage_collage", slotId: "x" }), /not a board type/);
  assert.throws(() => validatePin({ collageType: "bathroom_fixture_collage", slotId: "wall_tile" }), /not a slot on the bathroom_fixture_collage board/);
  assert.throws(() => validatePin("countertop"), /A pin is/);
});

test("pinChoices lists every preset slot of the room's board types, plus a standing way to force the lighting board", () => {
  const choices = pinChoices(["bathroom_fixture_collage", "bathroom_tile_collage", "lighting_collage"]);
  assert.ok(choices.some((choice) => choice.collageType === "bathroom_fixture_collage" && choice.slotId === "vanity_faucet"));
  assert.ok(choices.some((choice) => choice.collageType === "bathroom_tile_collage" && choice.slotId === "wall_tile"));
  const lighting = choices.filter((choice) => choice.collageType === "lighting_collage");
  assert.equal(lighting.length, 1);
  assert.equal(lighting[0].slotId, "light_fixture");
  assert.ok(choices.every((choice) => choice.role));
});

test("pinChoices offers the lighting board even for a room with no board type of its own", () => {
  const choices = pinChoices([]);
  assert.deepEqual(choices.map((choice) => choice.collageType), ["lighting_collage"]);
});

// ---------------------------------------------------------------------------
// Writing a row into the sheet
// ---------------------------------------------------------------------------

const COLUMNS = [
  { id: 1, title: "Row ID", type: "TEXT_NUMBER", systemColumnType: "AUTO_NUMBER" },
  { id: 2, title: "Cost Code", type: "TEXT_NUMBER" },
  { id: 3, title: "Unit Type", type: "PICKLIST", options: ["Penthouse", "Simplex"] },
  { id: 4, title: "Room Type", type: "TEXT_NUMBER" },
  { id: 5, title: "Primary Column", type: "TEXT_NUMBER", primary: true },
  { id: 6, title: "SKU", type: "TEXT_NUMBER" },
  { id: 7, title: "Qty", type: "TEXT_NUMBER" },
  { id: 8, title: "AGENT IGNORE", type: "CHECKBOX" },
  { id: 9, title: "Total", type: "TEXT_NUMBER", formula: "=SUM([Qty]@row)" },
];

function sheetRow(id, rowNumber, values) {
  return {
    id,
    rowNumber,
    cells: Object.entries(values).map(([columnId, value]) => ({ columnId: Number(columnId), value, displayValue: String(value) })),
  };
}

const SHEET = {
  version: 7,
  columns: COLUMNS,
  rows: [
    sheetRow(101, 1, { 5: "PENTHOUSE" }),
    sheetRow(102, 2, { 3: "Penthouse", 4: "Kitchen", 5: "Range", 2: "11 30 Appliances" }),
    sheetRow(103, 3, { 3: "Penthouse", 4: "Bath 2", 5: "Faucet", 2: "11 45 Plumbing" }),
    sheetRow(104, 4, { 3: "Penthouse", 4: "Bathroom 2", 5: "Vanity", 2: "12 30 Cabinetry" }),
    sheetRow(105, 5, { 3: "Simplex", 4: "Kitchen", 5: "Hood", 2: "11 30 Appliances" }),
  ],
};

test("sheetSchema turns the sheet's columns into form fields and leaves out what the sheet fills in itself", () => {
  const fields = sheetSchema(SHEET);
  assert.deepEqual(fields.map((field) => field.label), ["Cost Code", "Unit Type", "Room Type", "Primary Column", "SKU", "Qty", "AGENT IGNORE"]);
  const byLabel = Object.fromEntries(fields.map((field) => [field.label, field]));
  assert.equal(byLabel["Unit Type"].kind, "select");
  assert.deepEqual(byLabel["Unit Type"].options, ["Penthouse", "Simplex"]);
  assert.equal(byLabel["AGENT IGNORE"].kind, "checkbox");
  assert.equal(byLabel["Primary Column"].required, true);
  assert.equal(byLabel["Primary Column"].field, "itemName");
  assert.equal(byLabel["Room Type"].required, true);
  assert.equal(byLabel["SKU"].required, false);
  // distinct existing values, sorted, so a text column offers what the sheet already uses
  assert.deepEqual(byLabel["Room Type"].suggestions, ["Bath 2", "Bathroom 2", "Kitchen"]);
  assert.deepEqual(byLabel["Cost Code"].suggestions, ["11 30 Appliances", "11 45 Plumbing", "12 30 Cabinetry"]);
  assert.deepEqual(byLabel["Unit Type"].suggestions, []);
});

test("fileNewRow places a row below the last row of its unit type and room, tolerating room aliases", () => {
  const placement = fileNewRow(SHEET, { 3: "Penthouse", 4: "Bath 2", 5: "New Sconce" });
  assert.equal(placement.siblingId, 104);
  assert.deepEqual(placement.after, { rowNumber: 4, itemName: "Vanity" });
  assert.equal(placement.toBottom, undefined);
});

test("fileNewRow falls back to the unit type, then to the bottom of the sheet", () => {
  const unitOnly = fileNewRow(SHEET, { 3: "penthouse", 4: "Powder Room", 5: "Sconce" });
  assert.equal(unitOnly.siblingId, 104);
  assert.match(unitOnly.reason, /no row of that room/);
  const bottom = fileNewRow(SHEET, { 3: "Duplex Down", 4: "Kitchen", 5: "Range" });
  assert.equal(bottom.toBottom, true);
  assert.equal(bottom.after, null);
  const noUnit = fileNewRow(SHEET, { 4: "Kitchen", 5: "Range" });
  assert.equal(noUnit.toBottom, true);
  assert.match(noUnit.reason, /no unit type/);
});

test("cellValue sends numbers as numbers, ticks as true, and nothing for a blank", () => {
  assert.deepEqual(cellValue("text", " 2 "), { value: 2 });
  assert.deepEqual(cellValue("text", "K-T14414"), { value: "K-T14414" });
  assert.equal(cellValue("text", "   "), null);
  assert.deepEqual(cellValue("checkbox", true), { value: true });
  assert.deepEqual(cellValue("checkbox", "true"), { value: true });
  assert.equal(cellValue("checkbox", false), null);
  assert.deepEqual(cellValue("select", "Penthouse"), { value: "Penthouse" });
});

function stubSmartsheet({ onPost } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if ((init.method ?? "GET") === "GET") {
      return new Response(JSON.stringify(SHEET), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (onPost) return onPost(init);
    return new Response(JSON.stringify({ message: "SUCCESS", result: [{ id: 999, rowNumber: 5 }] }), { status: 200 });
  };
  return { fetchImpl, calls };
}

test("addSheetRow posts one filed row with only the filled cells and returns the new row id", async () => {
  const { fetchImpl, calls } = stubSmartsheet();
  const added = await addSheetRow({
    token: "tok",
    sheetId: "42",
    fetchImpl,
    values: { 2: "26 51 Lighting", 3: "Penthouse", 4: "Bath 2", 5: "Kohler Purist Sconce", 6: "", 7: "2", 8: false, 9: "ignored formula" },
  });
  assert.equal(added.rowId, "999");
  assert.equal(added.rowNumber, 5);
  assert.equal(added.placement.siblingId, 104);

  const post = calls.find((call) => call.init.method === "POST");
  assert.equal(post.url, "https://api.smartsheet.com/2.0/sheets/42/rows");
  assert.equal(post.init.headers.Authorization, "Bearer tok");
  const body = JSON.parse(post.init.body);
  assert.equal(body.length, 1);
  assert.equal(body[0].siblingId, 104);
  assert.equal(body[0].toBottom, undefined);
  assert.deepEqual(body[0].cells, [
    { columnId: 2, value: "26 51 Lighting", strict: false },
    { columnId: 3, value: "Penthouse", strict: false },
    { columnId: 4, value: "Bath 2", strict: false },
    { columnId: 5, value: "Kohler Purist Sconce", strict: false },
    { columnId: 7, value: 2, strict: false },
  ]);
});

test("addSheetRow refuses a row without its primary value and surfaces the sheet's refusal", async () => {
  const { fetchImpl } = stubSmartsheet();
  await assert.rejects(
    addSheetRow({ token: "tok", sheetId: "42", fetchImpl, values: { 3: "Penthouse", 4: "Bath 2" } }),
    /"Primary Column"/,
  );
  const refusing = stubSmartsheet({ onPost: () => new Response('{"message":"invalid picklist"}', { status: 400 }) });
  await assert.rejects(
    addSheetRow({ token: "tok", sheetId: "42", fetchImpl: refusing.fetchImpl, values: { 3: "Penthouse", 4: "Bath 2", 5: "Sconce" } }),
    /HTTP 400.*invalid picklist/,
  );
});
