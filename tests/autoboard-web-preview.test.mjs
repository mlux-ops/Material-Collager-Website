// The web review board's read-the-sheet step.
//
// previewBoards exists because buildBoards cannot run before photos exist: an
// item whose resolver returns nothing is recorded as a gap and dropped, so a
// board built straight from a freshly-read sheet comes back empty. The preview
// stops one step earlier and shows what each slot matched.
//
// The risk that creates is divergence — two functions answering "what goes in
// this slot" and drifting apart. These tests hold them to the same answer.

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildBoards } from "../app/lib/autoboard/match.ts";
import { emptyGaps } from "../app/lib/autoboard/source.ts";
import { filterRows, previewBoards, sheetFacets } from "../app/lib/autoboard/preview.ts";
import {
  readJsonBody,
  requireSheetId,
  requireStringList,
} from "../app/lib/autoboard-http.ts";

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

const ROOMS = [
  row({ rowId: "1", itemName: "Brizo Odin Lavatory Faucet" }),
  row({ rowId: "2", itemName: "Brizo Round Showerhead" }),
  row({ rowId: "3", itemName: "Brizo Thermostatic Valve Trim" }),
  row({ rowId: "4", itemName: "AXOR Uno Lavatory Faucet", status: "alternative" }),
  row({ rowId: "5", itemName: "Kohler Highline Toilet" }),
  row({ rowId: "10", roomLabel: "Kitchen", roomOriginal: "Kitchen", itemName: "Thermador Pro Range", costCode: "11 30 Appliances M" }),
  row({ rowId: "11", roomLabel: "Kitchen", roomOriginal: "Kitchen", itemName: "Zephyr Monsoon II Hood Insert", costCode: "11 30 Appliances M" }),
  row({ rowId: "20", roomLabel: "Garage", roomOriginal: "Garage", itemName: "Epoxy Floor Coating", costCode: "09 60 Flooring M" }),
];

// ---------------------------------------------------------------------------
// Preview / build agreement
// ---------------------------------------------------------------------------

test("preview and build agree on board ids and on which row fills each slot", () => {
  const preview = previewBoards(ROOMS);
  // Every row gets an image, so buildBoards keeps everything the rules matched
  // and the only difference left is the preview's own (it keeps empty boards).
  const { boards } = buildBoards(ROOMS, {
    resolveImages: (rowId) => [`/fake/${rowId}.png`],
    gaps: emptyGaps(),
    minSlots: 1,
  });

  for (const board of boards) {
    const previewed = preview.boards.find((entry) => entry.id === board.id);
    assert.ok(previewed, `preview has no board ${board.id}; it has ${preview.boards.map((b) => b.id)}`);
    assert.deepEqual(
      previewed.slots.map((slot) => [slot.slotId, slot.rowId]),
      board.items.map((item) => [item.slotId, item.rowId]),
      `slot assignment differs on ${board.id}`,
    );
    assert.equal(previewed.title, board.title);
    assert.equal(previewed.collageType, board.collageType);
  }
});

test("preview and build agree on held-back substitutes and unmapped rows", () => {
  const gaps = emptyGaps();
  buildBoards(ROOMS, { resolveImages: (rowId) => [`/fake/${rowId}.png`], gaps, minSlots: 1 });
  const preview = previewBoards(ROOMS);

  const key = (entry) => `${entry.rowId}::${entry.slotId}`;
  assert.deepEqual(
    preview.substitutes.map(key).sort(),
    gaps.substituteCandidates.map(key).sort(),
  );
  assert.deepEqual(
    preview.unmapped.map((entry) => entry.rowId).sort(),
    gaps.unmappedItems.map((entry) => entry.rowId).sort(),
  );
  // The toilet is globally excluded, so it is unmapped in both.
  assert.ok(preview.unmapped.some((entry) => entry.rowId === "5"));
  // The AXOR faucet is an alternative, so it is a substitute in both and never
  // unmapped.
  assert.ok(preview.substitutes.some((entry) => entry.rowId === "4"));
  assert.ok(!preview.unmapped.some((entry) => entry.rowId === "4"));
});

test("preview keeps a room that maps to no board type out of the boards and in skippedRooms", () => {
  const preview = previewBoards(ROOMS);
  assert.deepEqual(
    preview.skippedRooms.map((entry) => [entry.roomLabel, entry.itemCount]),
    [["Garage", 1]],
  );
  assert.ok(!preview.boards.some((board) => board.roomLabel === "Garage"));
  assert.deepEqual(preview.rooms.map((entry) => entry.roomLabel).sort(), ["Bath 2", "Kitchen"]);
});

// A board with nothing in it is the most important thing the preview can show —
// it is the difference between "this subsection is wrong" and "these rows need
// photos". buildBoards drops it (minSlots), so the preview must not.
test("preview keeps a board whose slots all came up empty", () => {
  const preview = previewBoards([row({ rowId: "1", itemName: "Brizo Odin Lavatory Faucet" })]);
  const tile = preview.boards.find((board) => board.collageType === "bathroom_tile_collage");
  assert.ok(tile, "the tile board must still be listed");
  assert.equal(tile.slots.length, 0);
  assert.ok(tile.unfilledSlots.some((slot) => slot.slotId === "wall_tile"));

  const { boards } = buildBoards([row({ rowId: "1", itemName: "Brizo Odin Lavatory Faucet" })], {
    resolveImages: () => ["/fake/1.png"],
    gaps: emptyGaps(),
  });
  assert.ok(!boards.some((board) => board.collageType === "bathroom_tile_collage"));
});

test("preview reports every unfilled preset slot with its role and required flag", () => {
  const preview = previewBoards(ROOMS);
  const fixture = preview.boards.find((board) => board.id === "penthouse-bath-2-fixture");
  assert.deepEqual(
    fixture.slots.map((slot) => slot.slotId),
    ["vanity_faucet", "shower_head", "valve_trim"],
  );
  const unfilled = fixture.unfilledSlots.find((slot) => slot.slotId === "main_tile");
  assert.ok(unfilled);
  assert.equal(typeof unfilled.role, "string");
  assert.equal(unfilled.required, true);
});

test("preview carries the row's reference url through, so the photo step has somewhere to start", () => {
  const preview = previewBoards([
    row({ rowId: "1", itemName: "Brizo Odin Lavatory Faucet", reference: "https://example.com/odin" }),
    row({ rowId: "2", itemName: "Brizo Round Showerhead" }),
  ]);
  const fixture = preview.boards.find((board) => board.collageType === "bathroom_fixture_collage");
  assert.equal(fixture.slots.find((slot) => slot.rowId === "1").reference, "https://example.com/odin");
});

test("preview splits a good/better/best tier prefix off the name, as the board does", () => {
  const rows = [
    row({ rowId: "1", itemName: "-Better- option - Brizo Odin Lavatory Faucet" }),
    row({ rowId: "2", itemName: "Brizo Round Showerhead" }),
  ];
  const slot = previewBoards(rows).boards
    .find((board) => board.collageType === "bathroom_fixture_collage")
    .slots.find((entry) => entry.rowId === "1");
  assert.equal(slot.name, "Brizo Odin Lavatory Faucet");
  assert.equal(slot.tier, "better");
  assert.equal(slot.brand, "Brizo");
  // itemName keeps the sheet's own text, so a person can find the row again.
  assert.equal(slot.itemName, "-Better- option - Brizo Odin Lavatory Faucet");
});

// ---------------------------------------------------------------------------
// Facets and filtering
// ---------------------------------------------------------------------------

test("sheetFacets counts every unit type and room, including rooms no board maps to", () => {
  const facets = sheetFacets(ROOMS);
  assert.deepEqual(facets.unitTypes, [{ value: "Penthouse", rowCount: 8 }]);
  assert.deepEqual(
    facets.rooms.map((entry) => [entry.value, entry.rowCount]),
    [["Bath 2", 5], ["Garage", 1], ["Kitchen", 2]],
  );
  // Garage maps to no board type, but the picker still has to offer it — a
  // facet list that hid it would look like the sheet was missing rows.
  assert.ok(facets.rooms.some((entry) => entry.value === "Garage"));
  assert.deepEqual(facets.rooms[0].unitTypes, ["Penthouse"]);
});

test("filterRows treats an empty or absent filter as everything, not nothing", () => {
  assert.equal(filterRows(ROOMS, {}).length, ROOMS.length);
  assert.equal(filterRows(ROOMS, { unitTypes: [], rooms: [] }).length, ROOMS.length);
  assert.equal(filterRows(ROOMS, { rooms: ["Kitchen"] }).length, 2);
  assert.equal(filterRows(ROOMS, { rooms: ["Kitchen", "Bath 2"] }).length, 7);
  // Case-insensitive on both sides: the picker sends back the sheet's own
  // casing, but a hand-written API call should not have to match it.
  assert.equal(filterRows(ROOMS, { unitTypes: ["penthouse"], rooms: ["kitchen"] }).length, 2);
  assert.equal(filterRows(ROOMS, { rooms: ["Nowhere"] }).length, 0);
});

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

test("requireSheetId accepts a Smartsheet id and rejects anything that is not one", () => {
  assert.equal(requireSheetId("6391628162879364"), "6391628162879364");
  assert.equal(requireSheetId("  6391628162879364  "), "6391628162879364");
  for (const bad of ["", "   ", "12345", "sheet-1", "https://app.smartsheet.com/sheets/abc", "1".repeat(26), null]) {
    assert.throws(() => requireSheetId(bad), /Smartsheet sheet id/, `should reject ${JSON.stringify(bad)}`);
  }
});

test("requireStringList accepts absent lists and rejects non-strings", () => {
  assert.deepEqual(requireStringList(undefined, "rooms"), []);
  assert.deepEqual(requireStringList(null, "rooms"), []);
  assert.deepEqual(requireStringList(["Kitchen"], "rooms"), ["Kitchen"]);
  assert.throws(() => requireStringList("Kitchen", "rooms"), /must be an array/);
  assert.throws(() => requireStringList([1], "rooms"), /must be an array/);
});

test("readJsonBody refuses a request that did not declare JSON", async () => {
  const asForm = new Request("https://example.com/api/autoboard/sheet", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "sheetId=6391628162879364",
  });
  await assert.rejects(() => readJsonBody(asForm), /Content-Type: application\/json/);

  const noType = new Request("https://example.com/api/autoboard/sheet", { method: "POST", body: "{}" });
  await assert.rejects(() => readJsonBody(noType), /Content-Type: application\/json/);

  const asJson = new Request("https://example.com/api/autoboard/sheet", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sheetId: "6391628162879364" }),
  });
  assert.deepEqual(await readJsonBody(asJson), { sheetId: "6391628162879364" });

  const brokenJson = new Request("https://example.com/api/autoboard/sheet", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  await assert.rejects(() => readJsonBody(brokenJson), /not valid JSON/);
});
