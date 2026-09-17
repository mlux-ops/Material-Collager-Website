#!/usr/bin/env node
//
// Experiment: can a TypeSafe Choice fill an autoboard's preset slots more
// reliably than scripts/autoboard/lib/match.mjs's regex SLOT_RULES?
//
//   node --experimental-strip-types scripts/experiments/typesafe/slot-assignment.mjs [--baseline-only] [--condition parity|rich|both]
//
// Why this target: slot assignment is the one place in the pipeline where a
// regex has to understand what a product IS. Three failures showed up while
// setting up 651 Belmont alone:
//   * "Light natural-wood vanity" never reached vanity_wood, because that
//     slot's rule excludes /light/i to keep light fixtures out. The row had to
//     be renamed to suit the regex.
//   * bathroom_fixture_collage had no accent_tile rule at all, so a library
//     whose tiles are rows could not fill it.
//   * Which of several tile rows wins main_tile depends on manifest ORDER,
//     not on what the tiles are.
// Each is a semantic judgment wearing a regex costume.
//
// Protocol
//   labels     ground truth per (board, slot) from the recommendations
//              document, written by hand — never read back from either system
//   baseline   the shipped rules, via buildBoards
//   treatment  one Choice per slot over the room's rows, asked in a single
//              request per board (parallel questions over one state)
//   conditions parity = the model sees only what the regex sees (name, cost
//              code); rich = it also sees sku, status and spec. The pair
//              separates "reads names better" from "uses fields the regex
//              cannot".
// Scoring is slot-level exact match: for every slot on every board, did the
// right row land there (or correctly nothing)?

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { ITEM_PRESETS } from "../../../app/lib/collage.ts";
import { buildBoards } from "../../autoboard/lib/match.mjs";
import { emptyGaps, normalizeRoomLabel } from "../../autoboard/lib/source.mjs";
import { ask, loadApiKey, MODEL } from "./client.mjs";

const PROJECT = "scripts/autoboard/projects/651-belmont.json";
const OUT_DIR = "artifacts/typesafe-experiments";

// Ground truth. Written from the recommendations document, before running
// either system: the row that SHOULD occupy each slot, or null for a slot no
// selection fills. Alternatives (B2-14..B2-18, B3-16..B3-19) are substitutes
// and must never win a slot; accessories (towel bars, tissue holders) and the
// rough valve belong on no board at all.
const LABELS = {
  "Bath 2": {
    bathroom_fixture_collage: {
      vanity_faucet: "B2-04",
      shower_head: null,
      valve_trim: "B2-05",
      cabinet_hardware: "B2-06",
      light_fixture: "B2-07",
      vanity_wood: "B2-12",
      main_tile: "B2-01",
      accent_tile: "B2-02",
      countertop: null,
    },
    bathroom_tile_collage: {
      wall_tile: "B2-01",
      floor_tile: "B2-03",
      accent_tile: "B2-02",
      vanity_wood: "B2-12",
      countertop: null,
      metal_finish: "B2-08",
    },
  },
  "Bath 3": {
    bathroom_fixture_collage: {
      vanity_faucet: "B3-05",
      shower_head: "B3-06",
      valve_trim: null,
      cabinet_hardware: "B3-08",
      light_fixture: "B3-09",
      vanity_wood: "B3-14",
      main_tile: "B3-01",
      accent_tile: "B3-02",
      countertop: "B3-15",
    },
    bathroom_tile_collage: {
      wall_tile: "B3-01",
      floor_tile: "B3-03",
      accent_tile: "B3-02",
      vanity_wood: "B3-14",
      countertop: "B3-15",
      metal_finish: "B3-10",
    },
  },
};

// The row this project had to rename to get past the regex. The experiment
// restores the document's own wording, so both systems face the real input.
const ADVERSARIAL_NAMES = {
  "B2-12": "Light natural-wood vanity (product pending)",
};

// --- perturbation arm ------------------------------------------------------
// The canonical fixture names were written by someone who had already read
// SLOT_RULES. That flatters the regex: "ELM Palette Seafoam Wall Tile" says
// "wall tile" because the rule needs it to. This arm rewrites each row the way
// a different person might write the same line in a schedule — same product,
// same finish, same size, ordinary trade shorthand — and asks what survives.
//
// These are faithful renamings, not adversarial noise: every one names the
// product unambiguously to a human reader. Any slot lost here is a slot the
// pipeline holds only by naming discipline, which no one has written down.
const PERTURBED_NAMES = {
  "B2-01": "Palette Seafoam 6x6, glossy ceramic",
  "B2-02": "Gems Caraibi 5x10 fluted porcelain, niche back",
  "B2-03": "Bottega Caliza 23x23 porcelain, floors",
  "B2-04": "Purist wall-mount lav faucet trim, BN",
  "B2-05": "Purist bath/shower trim, BN",
  "B2-06": "Purist 5in pull, BN",
  "B2-07": "Cinch 24in LED bath bar, BN",
  "B2-08": "BN finish swatch",
  "B2-12": "Vanity cabinet, pale natural wood, TBD",
  "B3-01": "Grounded Alabaster 12x24 matte, shower walls",
  "B3-02": "Vivid Ligne Noir 3x10 matte relief, niche back",
  "B3-03": "Grounded Alabaster 12x24 matte, floors",
  "B3-05": "Purist widespread lav faucet, BL",
  "B3-06": "Purist showering kit with slidebar, BL",
  "B3-08": "Purist 5in pull, BL",
  "B3-09": "Banda 24in LED bath bar, BL",
  "B3-10": "BL finish swatch",
  "B3-14": "Vanity cabinet, white, TBD",
  "B3-15": "Vanity top, white quartz, TBD",
};

const SLOT_MEANING = {
  vanity_faucet: "The faucet at the vanity basin. Not a tub filler, not shower fittings.",
  shower_head: "The showerhead, rain head, or a showerhead-and-handshower package.",
  valve_trim: "The visible shower or tub/shower valve trim — the handle and escutcheon, not a concealed rough-in valve.",
  cabinet_hardware: "A cabinet pull or knob for the vanity casework.",
  light_fixture: "The vanity or wall light fixture.",
  vanity_wood: "The vanity cabinet itself, judged as a wood or casework sample.",
  // Run 1 of this experiment asked for "the surface that covers the most area"
  // and got the floor tile on two boards, which is a fair reading of that
  // sentence. The board wants the wall field, so the question now says so.
  main_tile: "The room's primary WALL field tile — the material covering the shower or tub walls. Not the floor tile, and not the niche accent.",
  accent_tile: "A secondary tile used as a deliberate accent, such as a niche back.",
  countertop: "The vanity countertop material.",
  wall_tile: "The tile on the walls.",
  floor_tile: "The tile on the floor.",
  metal_finish: "A sample standing for the room's metal finish.",
};

function nameFor(item, { adversarial, perturb }) {
  if (perturb && PERTURBED_NAMES[item.rowId]) return PERTURBED_NAMES[item.rowId];
  if (adversarial && ADVERSARIAL_NAMES[item.rowId]) return ADVERSARIAL_NAMES[item.rowId];
  return item.name;
}

function rowsForRoom(definition, room, { adversarial, perturb }) {
  return (definition.rooms.find((entry) => entry.room === room)?.items ?? []).map((item) => ({
    id: item.rowId,
    name: nameFor(item, { adversarial, perturb }),
    costCode: item.costCode ?? "",
    sku: item.sku ?? "",
    status: item.status ?? "preferred",
    spec: item.spec ?? "",
    substituteFor: item.substituteFor ?? "",
  }));
}

// --- baseline --------------------------------------------------------------
// buildBoards needs an image resolver; every row resolves to one placeholder
// so photo availability never decides the comparison. Slot assignment is the
// thing under test, not whether a vendor published a photo.
function baselineBoards(definition, rows, room) {
  const gaps = emptyGaps();
  const { boards } = buildBoards(
    rows.map((row) => ({
      rowId: row.id,
      unitType: definition.unitType,
      roomLabel: normalizeRoomLabel(room),
      roomOriginal: room,
      costCode: row.costCode,
      itemName: row.name,
      sku: row.sku,
      qty: 1,
      reference: "",
      // Carried through because the pipeline now reads it: a row marked
      // `alternative` is held back from automatic slot assignment.
      status: row.status,
    })),
    { resolveImages: () => ["placeholder.png"], minSlots: 1, gaps },
  );
  const byType = new Map(boards.map((board) => [board.collageType, board]));
  return { byType, gaps };
}

// --- treatment -------------------------------------------------------------
function questionsForBoard(collageType, rows, slots) {
  const options = Object.fromEntries(rows.map((row) => [row.id, `${row.name}${row.costCode ? ` — cost code ${row.costCode}` : ""}`]));
  const questions = {};
  for (const slot of slots) {
    questions[slot] = {
      type: "choice",
      instructions: [
        `The board is a ${collageType.replaceAll("_", " ")} for this bathroom: one flat-lay image showing the room's selected products and materials.`,
        `Which row in \`rows\` belongs in the board's "${slot}" slot?`,
        SLOT_MEANING[slot] ?? "",
        // Run 1 left this unsaid and the model read "(product pending)" as
        // "not a product", declining four slots a placeholder row was written
        // to hold. Which reading is right is a product decision, and the
        // pipeline's is: the placeholder holds the slot and shows up
        // downstream as an open slot with no photo.
        "A row whose name says the product is still pending is a placeholder the designer wrote for exactly this slot — choose it; it holds the slot open rather than leaving the slot unrepresented.",
        "Choose `none` when no row refers to that product at all, when the only candidates are rows marked as an alternative substitute, or when the row is a concealed rough-in part or an accessory that does not belong on a presentation board.",
      ].join(" "),
      criteria: { ...options, none: "No row in `rows` is this slot's product." },
    };
  }
  return questions;
}

function stateForBoard({ project, room, collageType, rows, condition }) {
  const visible = rows.map((row) =>
    condition === "parity"
      ? { id: row.id, name: row.name, costCode: row.costCode }
      : { id: row.id, name: row.name, costCode: row.costCode, sku: row.sku, status: row.status, spec: row.spec, substituteFor: row.substituteFor },
  );
  return {
    project,
    room,
    boardType: collageType,
    ...(condition === "rich"
      ? {
          statusMeaning: {
            preferred: "the current recommendation for its slot",
            alternative: "a substitute for the row named in substituteFor — never an addition, and never the board's pick",
            pending: "the design direction is set but no product has been chosen",
          },
        }
      : {}),
    rows: visible,
  };
}

// --- scoring ---------------------------------------------------------------
function score(predictions, labels) {
  const rows = [];
  for (const [slot, expected] of Object.entries(labels)) {
    const actual = predictions[slot] ?? null;
    rows.push({ slot, expected, actual, correct: (expected ?? null) === (actual ?? null) });
  }
  const correct = rows.filter((row) => row.correct).length;
  return { rows, correct, total: rows.length };
}

async function main() {
  const { values } = parseArgs({
    options: {
      "baseline-only": { type: "boolean" },
      condition: { type: "string", default: "both" },
      adversarial: { type: "boolean", default: true },
      perturb: { type: "boolean" },
    },
  });
  const definition = JSON.parse(await readFile(PROJECT, "utf8"));
  const conditions = values.condition === "both" ? ["parity", "rich"] : [values.condition];

  const results = { model: MODEL, ranAt: new Date().toISOString(), adversarial: values.adversarial, perturbed: Boolean(values.perturb), boards: [], usage: { input_tokens: 0, output_tokens: 0, requests: 0, latencyMs: 0 } };
  let apiKey = null;
  if (!values["baseline-only"]) {
    try {
      apiKey = loadApiKey();
    } catch (error) {
      console.error(`\n${error.message}\n`);
      console.error("Running the baseline only. Re-run without --baseline-only once a key is available.\n");
    }
  }

  for (const [room, boardLabels] of Object.entries(LABELS)) {
    const rows = rowsForRoom(definition, room, { adversarial: values.adversarial, perturb: values.perturb });
    const { byType } = baselineBoards(definition, rows, room);

    for (const [collageType, labels] of Object.entries(boardLabels)) {
      const slots = (ITEM_PRESETS[collageType] ?? []).map((preset) => preset.id);
      const board = byType.get(collageType);
      const baseline = Object.fromEntries(
        slots.map((slot) => [slot, board?.items.find((item) => item.slotId === slot)?.rowId ?? null]),
      );
      const entry = { room, collageType, baseline: score(baseline, labels), treatments: {} };

      if (apiKey) {
        for (const condition of conditions) {
          const state = stateForBoard({ project: definition.name, room, collageType, rows, condition });
          const questions = questionsForBoard(collageType, rows, slots);
          const response = await ask({ state, questions, apiKey });
          const predictions = {};
          const confidence = {};
          for (const slot of slots) {
            const answer = response.answers?.[slot];
            predictions[slot] = answer?.choice === "none" ? null : answer?.choice ?? null;
            confidence[slot] = answer?.confidence ?? null;
          }
          entry.treatments[condition] = { ...score(predictions, labels), confidence, latencyMs: response.latencyMs };
          results.usage.input_tokens += response.usage?.input_tokens ?? 0;
          results.usage.output_tokens += response.usage?.output_tokens ?? 0;
          results.usage.latencyMs += response.latencyMs;
          results.usage.requests += 1;
        }
      }
      results.boards.push(entry);
    }
  }

  await mkdir(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, values.perturb ? "slot-assignment-perturbed.json" : "slot-assignment.json");
  await writeFile(outFile, `${JSON.stringify(results, null, 2)}\n`, "utf8");

  const header = ["board", "baseline", ...conditions.filter(() => apiKey)];
  console.log(`\n${header.map((cell) => cell.padEnd(34)).join("")}`);
  for (const entry of results.boards) {
    const cells = [`${entry.room} ${entry.collageType.replace("bathroom_", "")}`.padEnd(34), `${entry.baseline.correct}/${entry.baseline.total}`.padEnd(34)];
    for (const condition of conditions) {
      if (!apiKey) continue;
      const treatment = entry.treatments[condition];
      cells.push(`${treatment.correct}/${treatment.total}`.padEnd(34));
    }
    console.log(cells.join(""));
  }

  const totals = (pick) => results.boards.reduce((sum, entry) => sum + (pick(entry)?.correct ?? 0), 0);
  const possible = results.boards.reduce((sum, entry) => sum + entry.baseline.total, 0);
  console.log(`\nslots: ${possible}`);
  console.log(`baseline correct: ${totals((entry) => entry.baseline)}`);
  for (const condition of conditions) {
    if (!apiKey) continue;
    console.log(`${condition} correct: ${totals((entry) => entry.treatments[condition])}`);
  }
  console.log("\nbaseline misses:");
  for (const entry of results.boards) {
    for (const row of entry.baseline.rows.filter((candidate) => !candidate.correct)) {
      console.log(`  ${entry.room} ${entry.collageType.replace("bathroom_", "")} ${row.slot}: expected ${row.expected ?? "none"}, got ${row.actual ?? "none"}`);
    }
  }
  if (apiKey) {
    for (const condition of conditions) {
      console.log(`\n${condition} misses:`);
      for (const entry of results.boards) {
        for (const row of entry.treatments[condition].rows.filter((candidate) => !candidate.correct)) {
          console.log(
            `  ${entry.room} ${entry.collageType.replace("bathroom_", "")} ${row.slot}: expected ${row.expected ?? "none"}, got ${row.actual ?? "none"}` +
              ` (confidence ${entry.treatments[condition].confidence[row.slot]?.toFixed(2) ?? "n/a"})`,
          );
        }
      }
    }
    console.log(`\nusage: ${results.usage.requests} requests, ${results.usage.input_tokens} input tokens, ${results.usage.output_tokens} output tokens, ${results.usage.latencyMs} ms total`);
  }
  console.log(`\nwrote ${outFile}`);
}

await main();
