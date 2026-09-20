// The unit-wide lighting board: one per unit type, every light fixture across
// the unit's rooms, built by the same core the room boards come from.
//
// Runs against app/lib/autoboard directly (the shared core), the way the web
// review board imports it.

import assert from "node:assert/strict";
import { test } from "node:test";

import { validateCollageRequest } from "../app/lib/collage.ts";
import {
  LIGHTING_SCOPE_LABEL,
  buildBoards,
  isLightFixture,
  lightingFixtures,
  lightingSlotId,
} from "../app/lib/autoboard/match.ts";
import { previewBoards } from "../app/lib/autoboard/preview.ts";
import { emptyGaps } from "../app/lib/autoboard/source.ts";
import { DEFAULT_VARIANTS, boardPayload, resolveHeroId } from "../app/lib/autoboard/variants.ts";

function row(overrides) {
  return {
    rowId: "1",
    status: "",
    unitType: "Penthouse",
    roomLabel: "Kitchen",
    roomOriginal: "Kitchen",
    costCode: "09 00 Finishes M",
    itemName: "Item",
    sku: "SKU-1",
    qty: 1,
    reference: "",
    ...overrides,
  };
}

const basename = (location) => location.split("/").pop();

// Two unit types, fixtures spread over rooms that have boards (Kitchen, Bath 2)
// and one that has none (Living Room), plus the false friends a name-based
// rule has to get right.
const ROWS = [
  row({ rowId: "1", itemName: "Tech Lighting Mini Pendant" }),
  row({ rowId: "2", itemName: "WAC Recessed Downlight", costCode: "26 51 Interior Lighting E" }),
  row({ rowId: "3", roomLabel: "Living Room", roomOriginal: "Living Room", itemName: "Visual Comfort Arn Chandelier" }),
  row({ rowId: "4", roomLabel: "Bath 2", roomOriginal: "Bath 2", itemName: "Modern Forms Cinch Vanity Light" }),
  row({ rowId: "5", roomLabel: "Bath 2", roomOriginal: "Bath 2", itemName: "Kohler Purist Widespread Basin Faucet", costCode: "11 45 Plumbing Fixtures M" }),
  row({ rowId: "6", itemName: "Light Gray Grout", costCode: "09 30 Tile M" }),
  row({ rowId: "7", itemName: "LED Bulb 3000K", costCode: "26 51 Interior Lighting E" }),
  row({ rowId: "8", roomLabel: "Living Room", roomOriginal: "Living Room", itemName: "AXOR Alternative Chandelier", status: "alternative" }),
  row({ rowId: "9", roomLabel: "Living Room", roomOriginal: "Living Room", itemName: "Sofa" }),
  row({ rowId: "20", unitType: "Simplex", itemName: "Sonneman Stiletto Pendant" }),
  row({ rowId: "21", unitType: "Simplex", roomLabel: "Bath 3", roomOriginal: "Bath 3", itemName: "Sonneman Stiletto Vanity Light" }),
];

const images = (rowId) => [`/fake/${rowId}.png`];

test("isLightFixture reads the name as a fixture, or trusts the luminaire cost code", () => {
  assert.equal(isLightFixture(row({ itemName: "Tech Lighting Mini Pendant" })), true);
  assert.equal(isLightFixture(row({ itemName: "Some Product", costCode: "26 51 Interior Lighting E" })), true);
  assert.equal(isLightFixture(row({ itemName: "Juno Under Cabinet Light" })), true);
  assert.equal(isLightFixture(row({ itemName: "Kuzco Flush Mount" })), true);
  // "light" as an adjective is not a fixture
  assert.equal(isLightFixture(row({ itemName: "Light Gray Grout" })), false);
  // parts and budget lines are not fixtures, even under the luminaire code
  assert.equal(isLightFixture(row({ itemName: "LED Bulb 3000K", costCode: "26 51 Interior Lighting E" })), false);
  assert.equal(isLightFixture(row({ itemName: "Lutron Dimmer", costCode: "26 51 Interior Lighting E" })), false);
  assert.equal(isLightFixture(row({ itemName: "Lighting Allowance" })), false);
  // the global exclusions still apply
  assert.equal(isLightFixture(row({ itemName: "Exhaust Fan with Light" })), false);
  assert.equal(isLightFixture(row({ itemName: "Kohler Purist Faucet", costCode: "11 45 Plumbing Fixtures M" })), false);
});

test("lightingFixtures orders chandeliers and pendants first, names each fixture's room, and holds substitutes back", () => {
  const { fixtures, substitutes } = lightingFixtures(ROWS.filter((entry) => entry.unitType === "Penthouse"));
  assert.deepEqual(fixtures.map((fixture) => fixture.row.rowId), ["3", "1", "2", "4"]);
  assert.deepEqual(
    fixtures.map((fixture) => fixture.role),
    ["Living Room chandelier", "Kitchen pendant light", "Kitchen ceiling light", "Bath 2 vanity light"],
  );
  assert.deepEqual(substitutes.map((entry) => entry.rowId), ["8"]);
});

test("slot ids come from the row, so they survive a sheet that gains or loses a fixture", () => {
  assert.equal(lightingSlotId(row({ rowId: "B2-07" })), "light_b2_07");
  assert.equal(lightingSlotId(row({ rowId: "1844209142501252" })), "light_1844209142501252");
  const before = lightingFixtures(ROWS).fixtures.map((fixture) => fixture.slotId);
  const after = lightingFixtures([row({ rowId: "0", itemName: "Extra Chandelier" }), ...ROWS]).fixtures.map((fixture) => fixture.slotId);
  for (const slotId of before) assert.ok(after.includes(slotId), `${slotId} kept its id`);
});

test("buildBoards emits one lighting board per unit type, spanning every room", () => {
  const gaps = emptyGaps();
  const { boards } = buildBoards(ROWS, { resolveImages: images, gaps });
  const lighting = boards.filter((board) => board.collageType === "lighting_collage");
  assert.deepEqual(lighting.map((board) => board.id), ["penthouse-all-rooms-lighting", "simplex-all-rooms-lighting"]);

  const penthouse = lighting[0];
  assert.equal(penthouse.roomLabel, LIGHTING_SCOPE_LABEL);
  assert.equal(penthouse.kindLabel, "Lighting Collage");
  assert.equal(penthouse.title, "Penthouse Lighting Collage");
  assert.deepEqual(penthouse.items.map((item) => item.rowId), ["3", "1", "2", "4"]);
  assert.deepEqual(penthouse.items.map((item) => item.slotId), ["light_3", "light_1", "light_2", "light_4"]);
  assert.equal(penthouse.items[0].role, "Living Room chandelier");
  assert.equal(penthouse.items[0].brand, "");
  assert.equal(penthouse.items[3].brand, "");

  const simplex = lighting[1];
  assert.deepEqual(simplex.items.map((item) => item.rowId), ["20", "21"]);

  // the room boards are untouched by the lighting pass
  assert.ok(boards.some((board) => board.id === "penthouse-bath-2-fixture"));
});

test("the chandelier leads the board and is the hero, and every variant's payload validates", () => {
  const { boards } = buildBoards(ROWS, { resolveImages: images, gaps: emptyGaps() });
  const board = boards.find((entry) => entry.id === "penthouse-all-rooms-lighting");
  assert.equal(resolveHeroId(board), "light_3");
  for (const variant of DEFAULT_VARIANTS) {
    const payload = boardPayload(board, variant, { basename });
    assert.doesNotThrow(() => validateCollageRequest(payload));
    assert.equal(payload.collageType, "lighting_collage");
    assert.equal(payload.heroItemId, "light_3");
    assert.equal(payload.items.length, 4);
  }
});

test("rows the lighting board accounts for are not stranded, unmapped, or double-reported", () => {
  const gaps = emptyGaps();
  buildBoards(ROWS, { resolveImages: images, gaps });
  // the living room has no board type; only the sofa is stranded there now
  const livingRoom = gaps.skippedRooms.filter((gap) => gap.roomLabel === "Living Room");
  assert.deepEqual(livingRoom.map((gap) => gap.itemCount), [1]);
  // the fixtures are on a board, so they are not unmapped
  for (const rowId of ["1", "2", "3", "4", "20", "21"]) {
    assert.ok(!gaps.unmappedItems.some((gap) => gap.rowId === rowId), `row ${rowId} is not unmapped`);
  }
  // the substitute chandelier is reported once, against the lighting board, and nowhere else
  const substitutes = gaps.substituteCandidates.filter((gap) => gap.rowId === "8");
  assert.deepEqual(substitutes.map((gap) => gap.collageType), ["lighting_collage"]);
  assert.ok(!gaps.unmappedItems.some((gap) => gap.rowId === "8"));
  // the grout and the bulb are not fixtures; the kitchen boards report them their own way
  assert.ok(!gaps.imagelessItems.some((gap) => gap.collageType === "lighting_collage"));
});

test("a living room whose only rows are fixtures is no longer a skipped room", () => {
  const gaps = emptyGaps();
  buildBoards(
    [
      row({ rowId: "1", roomLabel: "Living Room", roomOriginal: "Living Room", itemName: "Arn Chandelier" }),
      row({ rowId: "2", roomLabel: "Living Room", roomOriginal: "Living Room", itemName: "Wall Sconce" }),
    ],
    { resolveImages: images, gaps },
  );
  assert.deepEqual(gaps.skippedRooms, []);
});

test("an imageless fixture is reported against the lighting board with its own room", () => {
  const gaps = emptyGaps();
  const { boards } = buildBoards(ROWS, { resolveImages: (rowId) => (rowId === "3" ? [] : images(rowId)), gaps });
  const board = boards.find((entry) => entry.id === "penthouse-all-rooms-lighting");
  assert.deepEqual(board.items.map((item) => item.rowId), ["1", "2", "4"]);
  const gap = gaps.imagelessItems.find((entry) => entry.collageType === "lighting_collage");
  assert.equal(gap.rowId, "3");
  assert.equal(gap.slotId, "light_3");
  assert.equal(gap.roomLabel, "Living Room");
});

test("the lighting board honours the minimum slot count and the reference cap", () => {
  const single = emptyGaps();
  const one = buildBoards([row({ rowId: "1", itemName: "Lone Pendant" })], { resolveImages: images, gaps: single });
  assert.ok(!one.boards.some((board) => board.collageType === "lighting_collage"));
  assert.ok(single.skippedBoards.some((gap) => gap.collageType === "lighting_collage" && gap.reason.includes("minimum is 2")));

  const many = Array.from({ length: 17 }, (_, index) => row({ rowId: String(100 + index), itemName: `Pendant ${index}` }));
  const capped = emptyGaps();
  const { boards } = buildBoards(many, { resolveImages: images, gaps: capped });
  const board = boards.find((entry) => entry.collageType === "lighting_collage");
  assert.equal(board.items.length, 15);
  const dropped = capped.unfilledSlots.filter((gap) => gap.collageType === "lighting_collage");
  assert.equal(dropped.length, 2);
  assert.ok(dropped.every((gap) => gap.reason.includes("16-reference cap")));
  assert.deepEqual(dropped.map((gap) => gap.rowId), ["116", "115"]);
});

test("preview and build agree on the lighting boards, and the preview leaves nothing unfilled", () => {
  const preview = previewBoards(ROWS);
  const { boards } = buildBoards(ROWS, { resolveImages: images, gaps: emptyGaps() });
  const previewLighting = preview.boards.filter((board) => board.collageType === "lighting_collage");
  const builtLighting = boards.filter((board) => board.collageType === "lighting_collage");
  assert.deepEqual(previewLighting.map((board) => board.id), builtLighting.map((board) => board.id));
  for (const [index, board] of previewLighting.entries()) {
    assert.deepEqual(
      board.slots.map((slot) => [slot.slotId, slot.rowId, slot.role]),
      builtLighting[index].items.map((item) => [item.slotId, item.rowId, item.role]),
    );
    assert.deepEqual(board.unfilledSlots, []);
    assert.equal(board.title, builtLighting[index].title);
  }
  assert.ok(preview.rooms.some((scope) => scope.unitType === "Penthouse" && scope.roomLabel === LIGHTING_SCOPE_LABEL));
  // the same gap accounting as the build
  assert.deepEqual(preview.skippedRooms.filter((gap) => gap.roomLabel === "Living Room").map((gap) => gap.itemCount), [1]);
  assert.ok(!preview.unmapped.some((entry) => ["1", "2", "3", "4"].includes(entry.rowId)));
  assert.deepEqual(preview.substitutes.filter((entry) => entry.rowId === "8").map((entry) => entry.collageType), ["lighting_collage"]);
});

// ---------------------------------------------------------------------------
// A pin overrides isLightFixture and the substitute hold-back: the one way
// to place a fixture the name/cost-code rules missed, or one that lives in a
// room (a living room, a foyer) with no board of its own to be "unmapped" on.
// ---------------------------------------------------------------------------

test("a pin forces a row onto the lighting board even when isLightFixture would exclude it", () => {
  const pins = new Map([["9", { collageType: "lighting_collage", slotId: "light_fixture" }]]);
  const { fixtures } = lightingFixtures(ROWS.filter((entry) => entry.unitType === "Penthouse"), pins);
  // row 9 is "Sofa" — not a fixture by any rule; only the pin puts it here.
  assert.ok(fixtures.some((fixture) => fixture.row.rowId === "9"));
});

test("a pin places a lighting substitute on the board too, the same override a pin is everywhere else", () => {
  const pins = new Map([["8", { collageType: "lighting_collage", slotId: "light_fixture" }]]);
  const { fixtures, substitutes } = lightingFixtures(ROWS.filter((entry) => entry.unitType === "Penthouse"), pins);
  assert.ok(fixtures.some((fixture) => fixture.row.rowId === "8"));
  assert.ok(!substitutes.some((entry) => entry.rowId === "8"));
});

test("an unpinned row is unaffected: a pin on another row does not loosen isLightFixture generally", () => {
  const pins = new Map([["9", { collageType: "lighting_collage", slotId: "light_fixture" }]]);
  const { fixtures } = lightingFixtures(ROWS.filter((entry) => entry.unitType === "Penthouse"), pins);
  assert.ok(!fixtures.some((fixture) => fixture.row.rowId === "6"), "the grout, still not a fixture");
});

test("buildBoards honours a lighting pin end to end, and the row leaves the room's stranded count", () => {
  const pins = new Map([["9", { collageType: "lighting_collage", slotId: "light_fixture" }]]);
  const gaps = emptyGaps();
  const { boards } = buildBoards(ROWS, { resolveImages: images, gaps, pins });
  const board = boards.find((entry) => entry.id === "penthouse-all-rooms-lighting");
  const item = board.items.find((entry) => entry.rowId === "9");
  assert.ok(item);
  assert.equal(item.name, "Sofa");
  // the sofa was Living Room's only stranded row; pinned, nothing is left to skip
  assert.deepEqual(gaps.skippedRooms.filter((gap) => gap.roomLabel === "Living Room"), []);
});

test("previewBoards lists a stranded row individually, and a lighting pin removes it from that list and places it on the board", () => {
  const unpinned = previewBoards(ROWS);
  const stranded = unpinned.skippedRoomItems.filter((entry) => entry.roomLabel === "Living Room");
  assert.deepEqual(stranded.map((entry) => entry.rowId), ["9"]);
  assert.deepEqual(
    unpinned.skippedRooms.filter((entry) => entry.roomLabel === "Living Room").map((entry) => entry.itemCount),
    [1],
  );

  const pins = new Map([["9", { collageType: "lighting_collage", slotId: "light_fixture" }]]);
  const pinned = previewBoards(ROWS, { pins });
  assert.deepEqual(pinned.skippedRoomItems.filter((entry) => entry.roomLabel === "Living Room"), []);
  assert.deepEqual(pinned.skippedRooms.filter((entry) => entry.roomLabel === "Living Room"), []);
  const board = pinned.boards.find((entry) => entry.id === "penthouse-all-rooms-lighting");
  const slot = board.slots.find((entry) => entry.rowId === "9");
  assert.ok(slot);
  assert.equal(slot.pinned, true);
  // an auto-matched fixture's slot is not marked pinned just because it is on the board
  assert.equal(board.slots.find((entry) => entry.rowId === "1").pinned, undefined);
});

// ---------------------------------------------------------------------------
// Good/Better/Best: a unit whose light fixtures are tiered splits into three
// boards — one per package — each holding its own tier's items plus every
// untiered fixture (which has no alternate to swap in, so it belongs on all
// three). A unit that never tiers its fixtures still gets one consolidated
// board, exactly as before tiering existed.
// ---------------------------------------------------------------------------

const TIERED_ROWS = [
  row({ rowId: "t1", unitType: "Duplex Down", roomLabel: "Bath 2", roomOriginal: "Bath 2", itemName: "-Good- option - Cinch Vanity Light" }),
  row({ rowId: "t2", unitType: "Duplex Down", roomLabel: "Bath 2", roomOriginal: "Bath 2", itemName: "-Better- option - Cinch Vanity Light Plus" }),
  row({ rowId: "t3", unitType: "Duplex Down", roomLabel: "Bath 2", roomOriginal: "Bath 2", itemName: "-Best- option - Cinch Vanity Light Deluxe" }),
  // Untiered — has no Good/Better/Best alternate, so it belongs on every package.
  row({ rowId: "t4", unitType: "Duplex Down", itemName: "Tech Lighting Mini Pendant" }),
];

function findLighting(boards, unitType, id) {
  const board = boards.find((entry) => entry.collageType === "lighting_collage" && entry.unitType === unitType && entry.id === id);
  assert.ok(board, `expected a lighting board with id ${id}`);
  return board;
}

test("a unit whose fixtures include a tier splits into three boards, each holding its own tier plus every untiered fixture", () => {
  const preview = previewBoards(TIERED_ROWS);
  const good = findLighting(preview.boards, "Duplex Down", "duplex-down-all-rooms-good-lighting");
  const better = findLighting(preview.boards, "Duplex Down", "duplex-down-all-rooms-better-lighting");
  const best = findLighting(preview.boards, "Duplex Down", "duplex-down-all-rooms-best-lighting");

  assert.equal(good.roomLabel, "All Rooms — Good");
  assert.equal(good.title, "Duplex Down Lighting Collage — Good");
  assert.equal(good.kindLabel, "Lighting Collage");

  assert.deepEqual(good.slots.map((slot) => slot.rowId).sort(), ["t1", "t4"]);
  assert.deepEqual(better.slots.map((slot) => slot.rowId).sort(), ["t2", "t4"]);
  assert.deepEqual(best.slots.map((slot) => slot.rowId).sort(), ["t3", "t4"]);

  // Each item's own tier is recorded (or absent, for the untiered pendant).
  assert.equal(good.slots.find((slot) => slot.rowId === "t1").tier, "good");
  assert.equal(better.slots.find((slot) => slot.rowId === "t2").tier, "better");
  assert.equal(best.slots.find((slot) => slot.rowId === "t3").tier, "best");
  assert.equal(good.slots.find((slot) => slot.rowId === "t4").tier, undefined);

  // Only three lighting boards for this unit — no fourth, untiered one.
  const allLighting = preview.boards.filter((entry) => entry.collageType === "lighting_collage" && entry.unitType === "Duplex Down");
  assert.equal(allLighting.length, 3);
});

test("buildBoards produces the same three tier boards, and each validates against the generator", () => {
  const gaps = emptyGaps();
  const { boards } = buildBoards(TIERED_ROWS, { resolveImages: images, gaps });
  const good = findLighting(boards, "Duplex Down", "duplex-down-all-rooms-good-lighting");
  const better = findLighting(boards, "Duplex Down", "duplex-down-all-rooms-better-lighting");
  const best = findLighting(boards, "Duplex Down", "duplex-down-all-rooms-best-lighting");
  assert.deepEqual(good.items.map((item) => item.rowId).sort(), ["t1", "t4"]);
  assert.deepEqual(better.items.map((item) => item.rowId).sort(), ["t2", "t4"]);
  assert.deepEqual(best.items.map((item) => item.rowId).sort(), ["t3", "t4"]);
  for (const board of [good, better, best]) {
    for (const variant of DEFAULT_VARIANTS) {
      const payload = boardPayload(board, variant, { basename });
      assert.doesNotThrow(() => validateCollageRequest(payload));
    }
  }
});

test("preview and build agree on which units get split and which stay consolidated", () => {
  const rows = [
    ...TIERED_ROWS,
    row({ rowId: "u1", unitType: "Common", itemName: "Tech Lighting Mini Pendant" }),
    row({ rowId: "u2", unitType: "Common", roomLabel: "Bath 2", roomOriginal: "Bath 2", itemName: "Modern Forms Cinch Vanity Light" }),
  ];
  const preview = previewBoards(rows);
  const gaps = emptyGaps();
  const { boards } = buildBoards(rows, { resolveImages: images, gaps });

  const tieredPreview = preview.boards.filter((entry) => entry.collageType === "lighting_collage" && entry.unitType === "Duplex Down");
  const tieredBuilt = boards.filter((entry) => entry.collageType === "lighting_collage" && entry.unitType === "Duplex Down");
  assert.equal(tieredPreview.length, 3);
  assert.equal(tieredBuilt.length, 3);

  // Common's fixtures are never tiered — one consolidated board, not three
  // identical ones (three times the render cost for zero difference).
  const consolidatedPreview = preview.boards.filter((entry) => entry.collageType === "lighting_collage" && entry.unitType === "Common");
  const consolidatedBuilt = boards.filter((entry) => entry.collageType === "lighting_collage" && entry.unitType === "Common");
  assert.equal(consolidatedPreview.length, 1);
  assert.equal(consolidatedPreview[0].id, "common-all-rooms-lighting");
  assert.equal(consolidatedPreview[0].roomLabel, "All Rooms");
  assert.equal(consolidatedPreview[0].title, "Common Lighting Collage");
  assert.equal(consolidatedBuilt.length, 1);
  assert.equal(consolidatedBuilt[0].id, "common-all-rooms-lighting");
});

test("a substitute held back from a tiered board is reported once, not once per tier", () => {
  // Living Room, deliberately: a room with no board type of its own, so the
  // only substitute report this row could produce is the lighting board's —
  // isolating "not once per tier" from the pre-existing, separate rule that a
  // substitute is reported once per BOARD TYPE that held it back.
  const rows = [
    ...TIERED_ROWS,
    row({
      rowId: "t5",
      unitType: "Duplex Down",
      roomLabel: "Living Room",
      roomOriginal: "Living Room",
      itemName: "-Better- option - Alternative Sconce",
      status: "alternative",
    }),
  ];
  const gaps = emptyGaps();
  buildBoards(rows, { resolveImages: images, gaps });
  const reported = gaps.substituteCandidates.filter((entry) => entry.rowId === "t5");
  assert.equal(reported.length, 1);
  assert.equal(reported[0].collageType, "lighting_collage");

  const preview = previewBoards(rows);
  assert.equal(preview.substitutes.filter((entry) => entry.rowId === "t5").length, 1);
});

test("a pin overrides isLightFixture and the substitute rule independent of tiering: an untiered pinned row still lands on every tier board", () => {
  const rows = [...TIERED_ROWS, row({ rowId: "t5", unitType: "Duplex Down", itemName: "Random Object", status: "alternative" })];
  const pins = new Map([["t5", { collageType: "lighting_collage", slotId: "light_fixture" }]]);
  const { boards } = buildBoards(rows, { resolveImages: images, gaps: emptyGaps(), pins });
  const lighting = boards.filter((board) => board.collageType === "lighting_collage" && board.unitType === "Duplex Down");
  assert.equal(lighting.length, 3);
  for (const board of lighting) {
    assert.ok(board.items.some((item) => item.rowId === "t5"), `${board.title} includes the pinned row`);
  }
});

test("a sheet with no fixtures at all gets no lighting preview and no lighting board", () => {
  const rows = [
    row({ rowId: "1", roomLabel: "Bath 2", roomOriginal: "Bath 2", itemName: "Brizo Odin Lavatory Faucet", costCode: "11 45 Plumbing Fixtures M" }),
    row({ rowId: "2", roomLabel: "Bath 2", roomOriginal: "Bath 2", itemName: "Brizo Round Showerhead", costCode: "11 45 Plumbing Fixtures M" }),
  ];
  assert.ok(!previewBoards(rows).boards.some((board) => board.collageType === "lighting_collage"));
  const gaps = emptyGaps();
  const { boards } = buildBoards(rows, { resolveImages: images, gaps });
  assert.ok(!boards.some((board) => board.collageType === "lighting_collage"));
  assert.ok(!gaps.skippedBoards.some((gap) => gap.collageType === "lighting_collage"));
});
