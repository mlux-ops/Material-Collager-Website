// The web seeder's row shape.
//
// rowsFromDefinition hands rows to the server, which runs them through the SAME
// collectRows the Smartsheet reader uses. That function normalizes what it is
// given, so it needs a RAW row — `roomType`, not `roomLabel`. Handing it an
// already-normalized row drops every single one on the blank-room check, with a
// message that sounds like the definition is at fault. This pins the shape.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

import { rowsFromDefinition } from "../scripts/autoboard/seed-web-project.mjs";
import { collectRows, emptyGaps } from "../scripts/autoboard/lib/source.mjs";

const definition = JSON.parse(
  readFileSync(new URL("../scripts/autoboard/projects/651-belmont.json", import.meta.url), "utf8"),
);

test("every row of the tracked definition survives collectRows", () => {
  const raw = rowsFromDefinition(definition);
  const expected = definition.rooms.reduce((sum, room) => sum + room.items.length, 0);
  assert.equal(raw.length, expected);

  const gaps = emptyGaps();
  const rows = collectRows(raw, gaps);
  assert.equal(rows.length, expected, "a dropped row means the shape is wrong, not the definition");
  assert.deepEqual(gaps.blankUnitRows, []);
  assert.deepEqual(gaps.blankRoomRows, []);
});

test("the seeded rows carry the fields the pipeline reads", () => {
  const rows = collectRows(rowsFromDefinition(definition), emptyGaps());
  const row = rows.find((entry) => entry.rowId === "B2-04");
  assert.ok(row, "651 Belmont should still have row B2-04");
  assert.equal(row.unitType, "651 Belmont");
  assert.equal(row.roomLabel, "Bath 2");
  assert.ok(row.itemName.length > 0);
  // status drives the substitute hold-back, so it has to survive the trip.
  assert.ok(rows.some((entry) => entry.status === "alternative"), "the definition has alternatives");
});

test("--rooms narrows to whole rooms, case-insensitively", () => {
  const bath2 = rowsFromDefinition(definition, { rooms: ["bath 2"] });
  assert.ok(bath2.length > 0);
  assert.ok(bath2.every((row) => row.roomType === "Bath 2"));

  const two = rowsFromDefinition(definition, { rooms: ["Bath 2", "Kitchen"] });
  assert.deepEqual(new Set(two.map((row) => row.roomType)), new Set(["Bath 2", "Kitchen"]));

  assert.deepEqual(rowsFromDefinition(definition, { rooms: ["Nowhere"] }), []);
});

test("importing the seeder does not start the CLI", () => {
  // The module is import-guarded; if it were not, importing it above would have
  // tried to reach a dev server and this file would never have got here.
  assert.ok(true);
});
