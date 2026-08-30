import assert from "node:assert/strict";
import { test } from "node:test";

import { validateCollageRequest } from "../app/lib/collage.ts";
import { normalizeRoomLabel, parseCsv, csvObjects, emptyGaps } from "../scripts/autoboard/lib/source.mjs";
import { assignSlots, boardTypesForRoom, buildBoards, extractBrand } from "../scripts/autoboard/lib/match.mjs";
import { boardPayload, boardReferenceFiles, heroFor, DEFAULT_VARIANTS } from "../scripts/autoboard/lib/variants.mjs";

function row(overrides) {
  return {
    rowId: overrides.rowId ?? String(Math.floor(Math.random() * 1e12)),
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

test("normalizeRoomLabel merges known label variants", () => {
  assert.equal(normalizeRoomLabel("Bathroom 2"), "Bath 2");
  assert.equal(normalizeRoomLabel("Primary Bathroom"), "Primary Bath");
  assert.equal(normalizeRoomLabel("Primary Bath"), "Primary Bath");
  assert.equal(normalizeRoomLabel("Kitchen Pendant"), "Kitchen");
  assert.equal(normalizeRoomLabel("  Powder   Room "), "Powder Room");
  assert.equal(normalizeRoomLabel(""), "");
});

test("parseCsv handles quoted fields with commas and escaped quotes", () => {
  const rows = parseCsv('a,b\n"one, two","he said ""hi"""\n');
  assert.deepEqual(rows, [["a", "b"], ["one, two", 'he said "hi"']]);
  const objects = csvObjects('row_id,item_name\n1,"Faucet, brass"\n');
  assert.deepEqual(objects, [{ row_id: "1", item_name: "Faucet, brass" }]);
});

test("boardTypesForRoom maps rooms to board types", () => {
  assert.deepEqual(boardTypesForRoom("Kitchen"), ["kitchen_material_palette", "appliance_collage"]);
  assert.deepEqual(boardTypesForRoom("Bathroom 3"), ["bathroom_fixture_collage", "bathroom_tile_collage"]);
  assert.deepEqual(boardTypesForRoom("Primary Bathroom"), ["bathroom_fixture_collage", "bathroom_tile_collage"]);
  assert.deepEqual(boardTypesForRoom("Powder 2"), ["bathroom_fixture_collage", "bathroom_tile_collage"]);
  assert.deepEqual(boardTypesForRoom("Primary Bedroom"), []);
  assert.deepEqual(boardTypesForRoom("Roof Deck"), []);
});

test("assignSlots maps bathroom items to fixture slots and excludes concealed parts", () => {
  const rows = [
    row({ rowId: "1", itemName: "Brizo Odin Single-Handle Lavatory Faucet" }),
    row({ rowId: "2", itemName: "Brizo Essential 8in Round Showerhead" }),
    row({ rowId: "3", itemName: "Brizo Tempassure Thermostatic Valve Trim" }),
    row({ rowId: "4", itemName: "Brizo Rough-In Valve R60000" }),
    row({ rowId: "5", itemName: "TOTO Drake Two-Piece Toilet" }),
    row({ rowId: "6", itemName: "Cabinet Pull 6in", costCode: "09 00 Finishes Hardware - M" }),
    row({ rowId: "7", itemName: "Visual Comfort Wall Sconce", costCode: "26 51 Lighting Fixtures - M" }),
  ];
  const { filled, unmapped, conflicts } = assignSlots(rows, "bathroom_fixture_collage");
  const bySlot = Object.fromEntries(filled.map((slot) => [slot.preset.id, slot.row.rowId]));
  assert.equal(bySlot.vanity_faucet, "1");
  assert.equal(bySlot.shower_head, "2");
  assert.equal(bySlot.valve_trim, "3");
  assert.equal(bySlot.cabinet_hardware, "6");
  assert.equal(bySlot.light_fixture, "7");
  assert.deepEqual(unmapped.map((entry) => entry.rowId).sort(), ["4", "5"]);
  assert.equal(conflicts.length, 0);
});

test("exclusions apply to what the item is, not its included (or omitted) accessories", () => {
  const rows = [
    row({ rowId: "30", itemName: "Hansgrohe Vivenis Widespread Bathroom Faucet 90 with Pop-Up Drain, 1.2 GPM" }),
    row({ rowId: "31", itemName: "Brizo Linear Shower Drain - Matte Black" }),
    row({ rowId: "32", itemName: "Hansgrohe Tecturis E 1.2 GPM Single Hole Bathroom Faucet - Less Drain Assembly" }),
  ];
  const { filled, unmapped } = assignSlots(rows, "bathroom_fixture_collage");
  assert.equal(filled.length, 1);
  assert.equal(filled[0].preset.id, "vanity_faucet");
  assert.equal(filled[0].row.rowId, "30"); // first match wins
  assert.equal(filled[0].alternates[0]?.rowId, "32"); // row 32 also matched — a real conflict, not excluded
  // Non-winning candidates still land in `unmapped` (see assignSlots's own
  // conflict test) — 31 (a true drain, correctly excluded) and 32 (a
  // legitimate second faucet match) both appear here.
  assert.deepEqual(unmapped.map((entry) => entry.rowId).sort(), ["31", "32"]);
});

test("assignSlots picks the first candidate deterministically and records alternates", () => {
  const rows = [
    row({ rowId: "10", itemName: "AXOR Uno Lavatory Faucet" }),
    row({ rowId: "11", itemName: "GROHE Essence Lavatory Faucet" }),
  ];
  const { filled, unmapped, conflicts } = assignSlots(rows, "bathroom_fixture_collage");
  assert.equal(filled.length, 1);
  assert.equal(filled[0].row.rowId, "10");
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].alternates[0].rowId, "11");
  assert.deepEqual(unmapped.map((entry) => entry.rowId), ["11"]);
});

test("assignSlots maps kitchen appliances", () => {
  const rows = [
    row({ rowId: "20", roomLabel: "Kitchen", costCode: "11 30 Appliances - T&M", itemName: "Miele 42- Built-In Panel Ready Fridge" }),
    row({ rowId: "21", roomLabel: "Kitchen", costCode: "11 30 Appliances - T&M", itemName: "Miele 36- Glass 5 Burner Cook Top" }),
    row({ rowId: "22", roomLabel: "Kitchen", costCode: "11 30 Appliances - T&M", itemName: "Miele 24- ADA Panel Ready Dishwasher" }),
    row({ rowId: "23", roomLabel: "Kitchen", costCode: "11 30 Appliances - T&M", itemName: "Miele 30- Convection Wall Oven Black" }),
    row({ rowId: "24", roomLabel: "Kitchen", costCode: "11 30 Appliances - T&M", itemName: "LG Front Load Washer and Gas Dryer Pair" }),
  ];
  const { filled, unmapped } = assignSlots(rows, "appliance_collage");
  const slots = filled.map((slot) => slot.preset.id).sort();
  assert.deepEqual(slots, ["cooktop", "dishwasher", "oven", "refrigerator"]);
  assert.deepEqual(unmapped.map((entry) => entry.rowId), ["24"]); // washer/dryer has no preset slot
});

test("buildBoards builds a fixture board, skips tile board without a tile scheme, and reports gaps", () => {
  const rows = [
    row({ rowId: "1", itemName: "Brizo Odin Lavatory Faucet" }),
    row({ rowId: "2", itemName: "Brizo Round Showerhead" }),
    row({ rowId: "3", itemName: "Brizo Thermostatic Valve Trim" }),
    row({ rowId: "4", itemName: "TOTO Drake Toilet" }),
  ];
  const gaps = emptyGaps();
  const { boards } = buildBoards(rows, {
    resolveImages: (rowId) => (rowId === "3" ? [] : [`/fake/${rowId}.png`]),
    gaps,
  });
  assert.equal(boards.length, 1);
  const board = boards[0];
  assert.equal(board.collageType, "bathroom_fixture_collage");
  assert.equal(board.id, "penthouse-bath-2-fixture");
  assert.deepEqual(board.items.map((item) => item.slotId), ["vanity_faucet", "shower_head"]);
  // valve_trim matched but had no image on disk
  assert.equal(gaps.imagelessItems.length, 1);
  assert.equal(gaps.imagelessItems[0].slotId, "valve_trim");
  // the toilet is globally excluded, so it lands in unmapped
  assert.ok(gaps.unmappedItems.some((gap) => gap.rowId === "4"));
  // no tile items -> no tile board and no skipped-board noise (nothing matched)
  assert.ok(!boards.some((entry) => entry.collageType === "bathroom_tile_collage"));
  // unfilled fixture slots are reported
  assert.ok(gaps.unfilledSlots.some((gap) => gap.slotId === "main_tile"));
});

test("buildBoards injects main_tile and accent_tile from tileAssignments + tileIndex", () => {
  const rows = [
    row({ rowId: "1", itemName: "Brizo Odin Lavatory Faucet" }),
    row({ rowId: "2", itemName: "Brizo Round Showerhead" }),
    row({ rowId: "3", itemName: "Brizo Thermostatic Valve Trim" }),
  ];
  const tileIndex = new Map([
    ["WT2", { code: "WT2", materialName: "Cortar Bone Reed", filePath: "/fake/WT2.jpg" }],
    ["AT1", { code: "AT1", materialName: "Clara Caviar", filePath: "/fake/AT1.jpg" }],
  ]);
  const tileAssignments = new Map([["penthouse::bath 2", { mainTile: "WT2", accentTile: "AT1" }]]);
  const gaps = emptyGaps();
  const { boards } = buildBoards(rows, {
    resolveImages: (rowId) => [`/fake/${rowId}.png`],
    gaps,
    tileAssignments,
    tileIndex,
  });
  const board = boards.find((entry) => entry.collageType === "bathroom_fixture_collage");
  const mainTile = board.items.find((item) => item.slotId === "main_tile");
  const accentTile = board.items.find((item) => item.slotId === "accent_tile");
  assert.equal(mainTile.name, "Cortar Bone Reed");
  assert.equal(mainTile.images[0], "/fake/WT2.jpg");
  assert.match(mainTile.notes, /HOLD/);
  assert.equal(mainTile.brand, "Elm Surfaces");
  assert.equal(mainTile.required, true);
  assert.equal(accentTile.name, "Clara Caviar");
  assert.equal(accentTile.required, false);
});

test("buildBoards leaves main_tile unfilled (as a gap) when no assignment exists for the room", () => {
  const rows = [
    row({ rowId: "1", itemName: "Brizo Odin Lavatory Faucet" }),
    row({ rowId: "2", itemName: "Brizo Round Showerhead" }),
  ];
  const gaps = emptyGaps();
  const { boards } = buildBoards(rows, { resolveImages: (rowId) => [`/fake/${rowId}.png`], gaps });
  const board = boards.find((entry) => entry.collageType === "bathroom_fixture_collage");
  assert.ok(!board.items.some((item) => item.slotId === "main_tile" || item.slotId === "accent_tile"));
  assert.ok(gaps.unfilledSlots.some((gap) => gap.slotId === "main_tile"));
});

test("buildBoards reports a bad tile code as an imageless item, not a silent drop", () => {
  const rows = [
    row({ rowId: "1", itemName: "Brizo Odin Lavatory Faucet" }),
    row({ rowId: "2", itemName: "Brizo Round Showerhead" }),
  ];
  const tileAssignments = new Map([["penthouse::bath 2", { mainTile: "WT404" }]]);
  const gaps = emptyGaps();
  const { boards } = buildBoards(rows, {
    resolveImages: (rowId) => [`/fake/${rowId}.png`],
    gaps,
    tileAssignments,
    tileIndex: new Map(),
  });
  const board = boards.find((entry) => entry.collageType === "bathroom_fixture_collage");
  assert.ok(!board.items.some((item) => item.slotId === "main_tile"));
  assert.ok(gaps.imagelessItems.some((gap) => gap.slotId === "main_tile" && gap.sku === "WT404"));
});

test("buildBoards skips boards under the minimum slot count", () => {
  const rows = [row({ rowId: "1", itemName: "Brizo Odin Lavatory Faucet" })];
  const gaps = emptyGaps();
  const { boards } = buildBoards(rows, { resolveImages: () => ["/fake/1.png"], gaps });
  assert.equal(boards.length, 0);
  assert.ok(gaps.skippedBoards.some((gap) => gap.reason.includes("minimum is 2")));
});

test("boardPayload passes the app's own validator for every default variant", () => {
  const rows = [
    row({ rowId: "1", itemName: "Brizo Odin Lavatory Faucet" }),
    row({ rowId: "2", itemName: "Brizo Round Showerhead" }),
    row({ rowId: "3", itemName: "Brizo Thermostatic Valve Trim" }),
  ];
  const { boards } = buildBoards(rows, { resolveImages: (rowId) => [`/fake/${rowId}.png`], gaps: emptyGaps() });
  assert.equal(boards.length, 1);
  for (const variant of DEFAULT_VARIANTS) {
    const payload = boardPayload(boards[0], variant);
    assert.doesNotThrow(() => validateCollageRequest(payload));
    assert.equal(payload.renderKind, "studio");
    assert.equal(payload.heroItemId, "vanity_faucet");
  }
  const finalPayload = boardPayload(boards[0], DEFAULT_VARIANTS[0], {
    quality: "high",
    outputResolution: "final",
    renderKind: "final",
    layoutReference: true,
  });
  assert.doesNotThrow(() => validateCollageRequest(finalPayload));
  assert.equal(finalPayload.layoutReferenceMode, "approved-draft");
});

test("boardPayload emits imageFileIds + layoutReferenceFileId for economy submissions, and still validates", () => {
  const rows = [
    row({ rowId: "1", itemName: "Brizo Odin Lavatory Faucet" }),
    row({ rowId: "2", itemName: "Brizo Round Showerhead" }),
  ];
  const { boards } = buildBoards(rows, { resolveImages: (rowId) => [`/fake/${rowId}.png`], gaps: emptyGaps() });
  const fileIdsBySlot = new Map([
    ["vanity_faucet", ["file-abc123"]],
    ["shower_head", ["file-def456"]],
  ]);
  const payload = boardPayload(boards[0], DEFAULT_VARIANTS[0], {
    quality: "high",
    outputResolution: "final",
    renderKind: "final",
    layoutReference: true,
    layoutReferenceFileId: "file-layout789",
    fileIdsBySlot,
  });
  assert.equal(payload.layoutReferenceFileId, "file-layout789");
  assert.deepEqual(payload.items.find((item) => item.id === "vanity_faucet").imageFileIds, ["file-abc123"]);
  assert.ok(!("imageNames" in payload.items[0]));
  assert.doesNotThrow(() => validateCollageRequest(payload));
});

test("boardReferenceFiles matches payload imageNames in count and order", () => {
  const rows = [
    row({ rowId: "1", itemName: "Brizo Odin Lavatory Faucet" }),
    row({ rowId: "2", itemName: "Brizo Round Showerhead" }),
  ];
  const { boards } = buildBoards(rows, { resolveImages: (rowId) => [`/fake/${rowId}.png`], gaps: emptyGaps() });
  const payload = boardPayload(boards[0], DEFAULT_VARIANTS[0]);
  const files = boardReferenceFiles(boards[0]);
  const payloadNames = payload.items.flatMap((item) => item.imageNames);
  assert.deepEqual(files.map((file) => file.name), payloadNames);
});

test("heroFor falls back through the ranking", () => {
  assert.equal(heroFor("bathroom_fixture_collage", ["cabinet_hardware", "shower_head"]), "shower_head");
  assert.equal(heroFor("kitchen_material_palette", ["hardware"]), "hardware");
});

test("extractBrand recognizes known manufacturers", () => {
  assert.equal(extractBrand("Brizo Odin Articulating Kitchen Faucet"), "Brizo");
  assert.equal(extractBrand("Miele 24- ADA Panel Ready Dishwasher"), "Miele");
  assert.equal(extractBrand("Generic No-Name Pull"), "");
});
