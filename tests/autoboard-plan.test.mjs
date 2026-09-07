import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { validateCollageRequest } from "../app/lib/collage.ts";
import { normalizeRoomLabel, parseCsv, csvObjects, emptyGaps } from "../scripts/autoboard/lib/source.mjs";
import {
  applyBoardMerges,
  assignSlots,
  boardTypesForRoom,
  buildBoards,
  extractBrand,
  extractTier,
  loadBuildLog,
  makeDiskImageResolver,
} from "../scripts/autoboard/lib/match.mjs";
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
  // The schedule sentence is provenance (bookkeeping for the human reviewer),
  // not a model-facing note — see Finding F4.
  assert.match(mainTile.provenance, /HOLD/);
  assert.equal(mainTile.notes, "");
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

// Finding F7: Smartsheet item names are typed in every casing under the sun,
// but the returned brand must always use the manufacturer's own display
// casing (e.g. "Hansgrohe"), not whatever casing happened to be typed.
test("extractBrand is case-insensitive and returns canonical display casing", () => {
  assert.equal(extractBrand("hansgrohe Vivenis Widespread Bathroom Faucet"), "Hansgrohe");
  assert.equal(extractBrand("HANSGROHE Vivenis Widespread Bathroom Faucet"), "Hansgrohe");
  assert.equal(extractBrand("Hansgrohe Vivenis Widespread Bathroom Faucet"), "Hansgrohe");
  assert.equal(extractBrand("grohe essence lavatory faucet"), "GROHE");
});

test("extractBrand recognizes Emtek door hardware", () => {
  assert.equal(extractBrand("Emtek Stuttgart Brass Modern Passage Leverset"), "Emtek");
});

// Finding F6: good/better/best alternates are typed as a prefix on the item
// name itself, e.g. "-Better- option - Duo Pendant" — that prefix belongs on
// item.tier, not on the product name shown/sent to the model.
test("extractTier strips a leading good/better/best marker and records the tier", () => {
  assert.deepEqual(extractTier("-Better- option - Duo Pendant"), { name: "Duo Pendant", tier: "better" });
  assert.deepEqual(extractTier("-Good- option - Duo Pendant"), { name: "Duo Pendant", tier: "good" });
  assert.deepEqual(extractTier("-Best- option - Duo Pendant"), { name: "Duo Pendant", tier: "best" });
  // No marker: name passes through unchanged, tier is absent (undefined).
  assert.deepEqual(extractTier("Brizo Odin Lavatory Faucet"), { name: "Brizo Odin Lavatory Faucet", tier: undefined });
});

test("buildBoards splits the good/better/best marker off item.name into item.tier", () => {
  const rows = [
    row({ rowId: "1", itemName: "-Better- option - Duo Pendant", costCode: "26 51 Lighting Fixtures - M" }),
    row({ rowId: "2", itemName: "Brizo Round Showerhead" }),
  ];
  const { boards } = buildBoards(rows, { resolveImages: (rowId) => [`/fake/${rowId}.png`], gaps: emptyGaps() });
  const board = boards.find((entry) => entry.collageType === "bathroom_fixture_collage");
  const lightFixture = board.items.find((item) => item.slotId === "light_fixture");
  assert.equal(lightFixture.name, "Duo Pendant");
  assert.equal(lightFixture.tier, "better");
  // an item with no tier marker never gets the key at all
  const showerHead = board.items.find((item) => item.slotId === "shower_head");
  assert.equal(showerHead.name, "Brizo Round Showerhead");
  assert.ok(!("tier" in showerHead));
});

// Finding F1 regression: a long item name must reach item.name verbatim (the
// old .slice(0, 80) truncation in match.mjs's board-building path is gone).
test("buildBoards never truncates a long item name", () => {
  const longName = "Brizo Odin Single-Handle Widespread Lavatory Faucet With Matching Pop-Up Drain Assembly In Matte Black Finish";
  assert.ok(longName.length > 80);
  const rows = [
    row({ rowId: "1", itemName: longName }),
    row({ rowId: "2", itemName: "Brizo Round Showerhead" }),
  ];
  const { boards } = buildBoards(rows, { resolveImages: (rowId) => [`/fake/${rowId}.png`], gaps: emptyGaps() });
  const board = boards.find((entry) => entry.collageType === "bathroom_fixture_collage");
  const faucet = board.items.find((item) => item.slotId === "vanity_faucet");
  assert.equal(faucet.name, longName);
});

// ---------------------------------------------------------------------------
// loadBuildLog / makeDiskImageResolver: SKU fallback for reused row ids.
// (Observed on real data 2026-09-06: Smartsheet reused a row id, so a row-id
// -only lookup can return a different product's photos than the caller asked
// for. The SKU index lets the resolver detect and correct for that.)
// ---------------------------------------------------------------------------

function makeFakeLibrary(csvRows) {
  const root = mkdtempSync(path.join(os.tmpdir(), "autoboard-buildlog-"));
  const buildDir = path.join(root, "Master_Library_Build");
  mkdirSync(buildDir, { recursive: true });
  const header = "row_id,item_name,sku,folder,matched_files";
  const lines = csvRows.map((r) => `${r.row_id},${r.item_name},${r.sku},${r.folder},${r.matched_files}`);
  writeFileSync(path.join(buildDir, "_BUILD_LOG.csv"), [header, ...lines].join("\n") + "\n", "utf8");
  return root;
}

function makeFolderWithImage(root, folderName, fileName) {
  const dir = path.join(root, ...folderName.split("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, fileName), "fake image bytes");
}

test("resolveImages: unchanged row id resolves exactly as before", (t) => {
  const root = makeFakeLibrary([
    { row_id: "1", item_name: "GROHE Chrome Valve", sku: "GRH-1", folder: "GROHE_Valve", matched_files: "photo.jpg" },
  ]);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  makeFolderWithImage(root, "GROHE_Valve", "photo.jpg");

  const buildLog = loadBuildLog(root);
  const resolveImages = makeDiskImageResolver(root, buildLog);
  const images = resolveImages("1", "GRH-1");
  assert.equal(images.length, 1);
  assert.ok(images[0].endsWith(path.join("GROHE_Valve", "photo.jpg")));

  // No sku passed at all behaves identically (today's callers).
  const imagesNoSku = resolveImages("1");
  assert.deepEqual(imagesNoSku, images);
});

test("resolveImages: row-id entry with a different sku than requested falls back to the SKU match", (t) => {
  const root = makeFakeLibrary([
    // Row 1 was a GROHE valve; the sheet reused row id 1 for a Hansgrohe hand shower.
    { row_id: "1", item_name: "GROHE Chrome Valve", sku: "GRH-1", folder: "GROHE_Valve", matched_files: "photo.jpg" },
    { row_id: "2", item_name: "Hansgrohe Matte White Hand Shower", sku: "HG-2", folder: "Hansgrohe_HandShower", matched_files: "hand.jpg" },
  ]);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  makeFolderWithImage(root, "GROHE_Valve", "photo.jpg");
  makeFolderWithImage(root, "Hansgrohe_HandShower", "hand.jpg");

  const resolveImages = makeDiskImageResolver(root, loadBuildLog(root));
  // Caller asks for row 1 but expects the Hansgrohe SKU (row id was reused).
  const images = resolveImages("1", "HG-2");
  assert.equal(images.length, 1);
  assert.ok(images[0].endsWith(path.join("Hansgrohe_HandShower", "hand.jpg")));
});

test("resolveImages: unknown row id with a known sku resolves by SKU", (t) => {
  const root = makeFakeLibrary([
    { row_id: "5", item_name: "Brizo Odin Faucet", sku: "BRZ-5", folder: "Brizo_Odin", matched_files: "faucet.jpg" },
  ]);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  makeFolderWithImage(root, "Brizo_Odin", "faucet.jpg");

  const resolveImages = makeDiskImageResolver(root, loadBuildLog(root));
  const images = resolveImages("999", "BRZ-5");
  assert.equal(images.length, 1);
  assert.ok(images[0].endsWith(path.join("Brizo_Odin", "faucet.jpg")));
});

test("resolveImages: unknown row id with unknown sku returns []", (t) => {
  const root = makeFakeLibrary([
    { row_id: "5", item_name: "Brizo Odin Faucet", sku: "BRZ-5", folder: "Brizo_Odin", matched_files: "faucet.jpg" },
  ]);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  makeFolderWithImage(root, "Brizo_Odin", "faucet.jpg");

  const resolveImages = makeDiskImageResolver(root, loadBuildLog(root));
  assert.deepEqual(resolveImages("999", "NOPE"), []);
  // Also unknown row id, no sku at all.
  assert.deepEqual(resolveImages("999"), []);
});

test("resolveImages: SKU '.0' suffix normalization matches spreadsheet-export skus", (t) => {
  const root = makeFakeLibrary([
    // Spreadsheet export coerced this sku through a numeric column.
    { row_id: "7", item_name: "Kohler Widespread Faucet", sku: "12345.0", folder: "Kohler_Faucet", matched_files: "f.jpg" },
  ]);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  makeFolderWithImage(root, "Kohler_Faucet", "f.jpg");

  const resolveImages = makeDiskImageResolver(root, loadBuildLog(root));
  // Caller's sku for this row lacks the ".0", and row id is unknown so this
  // must go through the bySku path to prove normalization is applied there.
  const images = resolveImages("unknown-row", "12345");
  assert.equal(images.length, 1);
  assert.ok(images[0].endsWith(path.join("Kohler_Faucet", "f.jpg")));

  // Also exercise the row-id path: entry sku "12345.0" must normalize-equal
  // a requested sku of "12345" so the row-id entry is trusted, not bypassed.
  const imagesViaRowId = resolveImages("7", "12345");
  assert.deepEqual(imagesViaRowId, images);
});

function makeBoard(overrides) {
  return {
    id: overrides.id,
    unitType: overrides.unitType,
    roomLabel: overrides.roomLabel,
    collageType: overrides.collageType ?? "bathroom_fixture_collage",
    kindLabel: overrides.kindLabel ?? "Fixture Collage",
    title: `${overrides.unitType} ${overrides.roomLabel} ${overrides.kindLabel ?? "Fixture Collage"}`,
    items: overrides.items ?? [],
  };
}

test("applyBoardMerges: happy path merges two identical-selection boards into one with an alias", () => {
  const keep = makeBoard({ id: "penthouse-bath-2-fixture", unitType: "Penthouse", roomLabel: "Bath 2" });
  const merge = makeBoard({ id: "triplex-bath-4-fixture", unitType: "Triplex", roomLabel: "Bath 4" });
  const gaps = emptyGaps();
  const result = applyBoardMerges(
    [keep, merge],
    gaps,
    [{ keep: "penthouse::bath 2", merge: ["triplex::bath 4"] }],
  );

  assert.equal(result.length, 1);
  assert.equal(result[0].id, "penthouse-bath-2-fixture");
  assert.deepEqual(result[0].aliases, ["Triplex Bath 4"]);
  assert.equal(result[0].title, "Penthouse Bath 2 / Triplex Bath 4 Fixture Collage");
  assert.deepEqual(gaps.mergedBoards, [
    {
      unitType: "Triplex",
      roomLabel: "Bath 4",
      collageType: "bathroom_fixture_collage",
      mergedInto: "penthouse-bath-2-fixture",
    },
  ]);
});

test("applyBoardMerges: multi-alias powder room case appends every merged room to the title", () => {
  const keep = makeBoard({ id: "penthouse-powder-room-fixture", unitType: "Penthouse", roomLabel: "Powder Room" });
  const mergeA = makeBoard({ id: "triplex-powder-room-fixture", unitType: "Triplex", roomLabel: "Powder Room" });
  const mergeB = makeBoard({ id: "triplex-powder-2-fixture", unitType: "Triplex", roomLabel: "Powder 2" });
  const gaps = emptyGaps();
  const result = applyBoardMerges(
    [keep, mergeA, mergeB],
    gaps,
    [{ keep: "penthouse::powder room", merge: ["triplex::powder room", "triplex::powder 2"] }],
  );

  assert.equal(result.length, 1);
  assert.deepEqual(result[0].aliases, ["Triplex Powder Room", "Triplex Powder 2"]);
  assert.equal(result[0].title, "Penthouse Powder Room / Triplex Powder Room / Triplex Powder 2 Fixture Collage");
  assert.equal(gaps.mergedBoards.length, 2);
});

test("applyBoardMerges: kept room missing a board for the collage type leaves the merge board in place and records a gap", () => {
  const merge = makeBoard({ id: "triplex-bath-2-fixture", unitType: "Triplex", roomLabel: "Bath 2" });
  const gaps = emptyGaps();
  // No "penthouse::bath 3" board exists at all — the kept room has zero boards.
  const result = applyBoardMerges(
    [merge],
    gaps,
    [{ keep: "penthouse::bath 3", merge: ["triplex::bath 2"] }],
  );

  assert.equal(result.length, 1);
  assert.equal(result[0].id, "triplex-bath-2-fixture");
  assert.equal(result[0].aliases, undefined);
  assert.deepEqual(gaps.mergedBoards, [
    {
      unitType: "Triplex",
      roomLabel: "Bath 2",
      collageType: "bathroom_fixture_collage",
      mergedInto: null,
      reason: "kept room has no bathroom_fixture_collage board",
    },
  ]);
});

test("applyBoardMerges: no merges configured returns boards unchanged", () => {
  const board = makeBoard({ id: "penthouse-bath-2-fixture", unitType: "Penthouse", roomLabel: "Bath 2" });
  const gaps = emptyGaps();
  const result = applyBoardMerges([board], gaps, []);
  assert.deepEqual(result, [board]);
  assert.deepEqual(gaps.mergedBoards, []);
});
