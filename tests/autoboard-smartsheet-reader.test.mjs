// Reading the 651 Belmont sheet (FINISH DATABASE: 651 Belmont, 6391628162879364).
//
// The fixture below is shaped exactly like that sheet — the column titles, ids
// and primary flag are the live ones — because the first attempt to read it
// would have failed on the first click: the item name lives in a column still
// titled "Primary Column", which no title alternate matches. These tests hold
// the reader to that sheet as it actually is.

import assert from "node:assert/strict";
import { test } from "node:test";

import { boardTypesForRoom } from "../app/lib/autoboard/match.ts";
import { loadSmartsheetRows, normalizeRoomLabel, resolveColumnIds } from "../app/lib/autoboard/source.ts";

// Live column metadata from get_columns on the sheet, 2026-09-20.
const COLUMNS = [
  { id: 1281259189079940, title: "Job Numbers" },
  { id: 5784858816450436, title: "Cost Code" },
  { id: 3533059002765188, title: "Unit Type" },
  { id: 8036658630135684, title: "Room Type" },
  { id: 1844209142501252, title: "Primary Column", primary: true },
  { id: 1875708086620036, title: "SKU" },
  { id: 6347808769871748, title: "Image" },
  { id: 4096008956186500, title: "Reference" },
  { id: 8599608583556996, title: "Qty" },
  { id: 2125684119211908, title: "PM Notes" },
  { id: 6977311544741764, title: "AGENT IGNORE" },
];
const ID = Object.fromEntries(COLUMNS.map((column) => [column.title, column.id]));

function row(id, values) {
  const cells = Object.entries(values).map(([title, value]) => ({ columnId: ID[title], value, displayValue: typeof value === "boolean" ? undefined : String(value) }));
  return { id, cells };
}

const SHEET = {
  version: 412,
  columns: COLUMNS,
  rows: [
    // A section header: name only, no unit or room. collectRows records it as a
    // blank-unit gap, as it always has.
    row(1, { "Primary Column": "APPLIANCES" }),
    row(2, { "Primary Column": "Fisher & Paykel Series 7 Refrigerator", "Unit Type": "Duplex Down", "Room Type": "Kitchen", "Cost Code": "11 30 Appliances - T&M", SKU: "RS36A72J1N", Image: "RS36A72J1N.jpg", Reference: "https://www.fergusonhome.com/fisher-and-paykel-rs36a72j1-n/s1663885", Qty: 1 }),
    row(3, { "Primary Column": "Kohler Purist Basin Faucet", "Unit Type": "Penthouse", "Room Type": "Secondary Bathroom", "Cost Code": "11 45 Plumbing Fixtures M", SKU: "K-T14414-4-BN", Reference: "https://www.fergusonhome.com/x/s1" }),
    // Ticked AGENT IGNORE: a superseded pick that must not reach a board.
    row(4, { "Primary Column": "BRIZO ODIN BAR FAUCET HANDLE", "Unit Type": "Penthouse", "Room Type": "Kitchen", "Cost Code": "11 45 Plumbing Fixtures M", SKU: "HL5370-BN", "AGENT IGNORE": true }),
    // The ARCHIVE section header, also ticked.
    row(5, { "Primary Column": "ARCHIVE", "AGENT IGNORE": true }),
    row(6, { "Primary Column": "Duravit Vanity", "Unit Type": "Simplex", "Room Type": "Primary Bathroom", "Cost Code": "12 30 Cabinetry - M", SKU: "DV-1" }),
  ],
};

function stubFetch(sheet = SHEET) {
  return async () => new Response(JSON.stringify(sheet), { status: 200, headers: { "content-type": "application/json" } });
}

// ---------------------------------------------------------------------------
// Column resolution
// ---------------------------------------------------------------------------

test("itemName falls back to the sheet's primary column when no title matches", () => {
  const ids = resolveColumnIds(COLUMNS);
  assert.equal(ids.itemName, ID["Primary Column"]);
  assert.equal(ids.unitType, ID["Unit Type"]);
  assert.equal(ids.roomType, ID["Room Type"]);
  assert.equal(ids.costCode, ID["Cost Code"]);
  assert.equal(ids.sku, ID.SKU);
  assert.equal(ids.reference, ID.Reference);
  assert.equal(ids.qty, ID.Qty);
  assert.equal(ids.agentIgnore, ID["AGENT IGNORE"]);
});

test("a titled item-name column still wins over the primary fallback", () => {
  const columns = [...COLUMNS, { id: 99, title: "Product Name" }];
  assert.equal(resolveColumnIds(columns).itemName, 99);
});

test("no title match and no primary column is still a loud failure", () => {
  const columns = COLUMNS.filter((column) => column.title !== "Primary Column");
  assert.throws(() => resolveColumnIds(columns), /columns for \[itemName\] were not found/);
});

test("AGENT IGNORE is optional: a sheet without it resolves and reads every row", async () => {
  const sheet = { ...SHEET, columns: COLUMNS.filter((column) => column.title !== "AGENT IGNORE") };
  const { rows, gaps } = await loadSmartsheetRows({ token: "t", sheetId: "1", fetchImpl: stubFetch(sheet) });
  assert.deepEqual(gaps.ignoredRows, []);
  // Row 4 has no ignore column to be excluded by, so it comes through.
  assert.ok(rows.some((entry) => entry.rowId === "4"));
});

// ---------------------------------------------------------------------------
// Reading rows
// ---------------------------------------------------------------------------

test("loadSmartsheetRows reads 651 Belmont's shape: names from the primary column, ignored rows excluded", async () => {
  const { rows, gaps, source } = await loadSmartsheetRows({ token: "t", sheetId: "6391628162879364", fetchImpl: stubFetch() });
  assert.equal(source, "smartsheet:6391628162879364 (version 412)");

  assert.deepEqual(rows.map((entry) => entry.rowId).sort(), ["2", "3", "6"]);
  const fridge = rows.find((entry) => entry.rowId === "2");
  assert.equal(fridge.itemName, "Fisher & Paykel Series 7 Refrigerator");
  assert.equal(fridge.unitType, "Duplex Down");
  assert.equal(fridge.roomLabel, "Kitchen");
  assert.equal(fridge.sku, "RS36A72J1N");
  assert.equal(fridge.reference, "https://www.fergusonhome.com/fisher-and-paykel-rs36a72j1-n/s1663885");
  assert.equal(fridge.qty, 1);

  // Both ticked rows are excluded and both are recorded, so gaps.md can say so.
  assert.deepEqual(
    gaps.ignoredRows.map((entry) => [entry.rowId, entry.itemName]),
    [["4", "BRIZO ODIN BAR FAUCET HANDLE"], ["5", "ARCHIVE"]],
  );
  // An ignored row is not ALSO reported as blank-unit — it left before that check.
  assert.ok(!gaps.blankUnitRows.some((entry) => entry.rowId === "5"));
  // The unticked section header still lands where it always did.
  assert.deepEqual(gaps.blankUnitRows.map((entry) => entry.rowId), ["1"]);
});

test("the Image column is not read as a reference: it holds attachment filenames, not urls", async () => {
  const { rows } = await loadSmartsheetRows({ token: "t", sheetId: "1", fetchImpl: stubFetch() });
  const fridge = rows.find((entry) => entry.rowId === "2");
  assert.ok(!Object.values(fridge).includes("RS36A72J1N.jpg"));
});

// ---------------------------------------------------------------------------
// Room mapping for this sheet's picklist
// ---------------------------------------------------------------------------

test("Secondary Bathroom is a bathroom", () => {
  assert.equal(normalizeRoomLabel("Secondary Bathroom"), "Secondary Bath");
  assert.deepEqual(boardTypesForRoom("Secondary Bathroom"), ["bathroom_fixture_collage", "bathroom_tile_collage"]);
});

test("the rest of the sheet's room picklist maps as before", () => {
  const bath = ["bathroom_fixture_collage", "bathroom_tile_collage"];
  assert.deepEqual(boardTypesForRoom("Primary Bathroom"), bath);
  assert.deepEqual(boardTypesForRoom("Bath 2"), bath);
  assert.deepEqual(boardTypesForRoom("Bath 3"), bath);
  assert.deepEqual(boardTypesForRoom("Powder Room"), bath);
  assert.deepEqual(boardTypesForRoom("Kitchen"), ["kitchen_material_palette", "appliance_collage"]);
  // No board type exists for these yet; they are reported as skipped rooms,
  // not silently forced onto a bathroom or kitchen board.
  for (const room of ["Laundry", "Living Room", "Primary Bedroom", "Primary WIC", "Mudroom", "Dining", "Secondary Closet"]) {
    assert.deepEqual(boardTypesForRoom(room), [], room);
  }
});
