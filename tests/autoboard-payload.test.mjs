import assert from "node:assert/strict";
import { test } from "node:test";

import { buildGenerationPrompt, validateCollageRequest } from "../app/lib/collage.ts";
import {
  DEFAULT_VARIANTS,
  boardPayload,
  boardReferenceFiles,
  modelNotes,
  orderedBoardItems,
} from "../scripts/autoboard/lib/variants.mjs";

// Matches the exact bookkeeping sentences match.mjs / review-core.mjs write
// (see Finding F4) — legacy plan.json files carry these inside item.notes.
const LEGACY_MANUAL_SENTENCE =
  "Manually selected in the review UI — overrides the v4 Elm Surfaces schedule's auto-pick.";
const LEGACY_SCHEDULE_SENTENCE =
  "Wieland Selections Book v4 tile schedule — approved direction, quote-pending (release status HOLD). See scripts/autoboard/tile-assignments.json.";

function item(overrides) {
  return {
    slotId: overrides.slotId,
    role: overrides.role ?? overrides.slotId.replaceAll("_", " "),
    required: overrides.required ?? true,
    rowId: overrides.rowId ?? null,
    sku: overrides.sku ?? "",
    brand: overrides.brand ?? "",
    name: overrides.name ?? "Item",
    notes: overrides.notes ?? "",
    images: overrides.images ?? [`/fake/${overrides.slotId}.png`],
  };
}

function board(overrides) {
  return {
    id: "penthouse-bath-2-fixture",
    title: "Penthouse Bath 2 Fixture Collage",
    collageType: "bathroom_fixture_collage",
    ...overrides,
  };
}

test("modelNotes strips legacy provenance sentences and returns undefined when nothing real is left", () => {
  assert.equal(modelNotes(""), undefined);
  assert.equal(modelNotes(undefined), undefined);
  assert.equal(modelNotes("quantity 3"), "quantity 3");
  assert.equal(modelNotes(LEGACY_MANUAL_SENTENCE), undefined);
  assert.equal(modelNotes(LEGACY_SCHEDULE_SENTENCE), undefined);
  assert.equal(
    modelNotes(`Keep grout lines crisp and matte. ${LEGACY_MANUAL_SENTENCE} ${LEGACY_SCHEDULE_SENTENCE}`),
    "Keep grout lines crisp and matte.",
  );
  // order-independent — the legacy sentence can precede the real instruction
  assert.equal(
    modelNotes(`${LEGACY_SCHEDULE_SENTENCE} Keep grout lines crisp and matte.`),
    "Keep grout lines crisp and matte.",
  );
});

test("boardPayload sends only the real instruction, stripped of legacy provenance sentences", () => {
  const b = board({
    items: [
      item({
        slotId: "main_tile",
        name: "Cortar Bone Reed",
        brand: "Elm Surfaces",
        notes: `Keep grout lines crisp and matte. ${LEGACY_MANUAL_SENTENCE} ${LEGACY_SCHEDULE_SENTENCE}`,
      }),
      item({ slotId: "vanity_faucet", name: "Brizo Odin Faucet", brand: "Brizo" }),
    ],
  });
  const payload = boardPayload(b, DEFAULT_VARIANTS[0]);
  const mainTile = payload.items.find((entry) => entry.id === "main_tile");
  assert.equal(mainTile.notes, "Keep grout lines crisp and matte.");
  assert.doesNotThrow(() => validateCollageRequest(payload));
});

test("boardPayload -> buildGenerationPrompt never leaks review-UI/schedule bookkeeping into the model prompt", () => {
  const b = board({
    items: [
      item({
        slotId: "main_tile",
        name: "Cortar Bone Reed",
        brand: "Elm Surfaces",
        notes: `Keep grout lines crisp and matte. ${LEGACY_MANUAL_SENTENCE} ${LEGACY_SCHEDULE_SENTENCE}`,
      }),
      item({ slotId: "vanity_faucet", name: "Brizo Odin Faucet", brand: "Brizo" }),
    ],
  });
  const payload = boardPayload(b, DEFAULT_VARIANTS[0]);
  const prompt = buildGenerationPrompt(payload);
  for (const forbidden of ["review UI", "schedule", "HOLD", "auto-pick", "tile-assignments.json"]) {
    assert.ok(!prompt.includes(forbidden), `prompt must not contain "${forbidden}"`);
  }
  assert.ok(prompt.includes("Keep grout lines crisp and matte."));
});

test("boardPayload honors board.heroItemId and orders it first (items + reference files stay aligned)", () => {
  const b = board({
    heroItemId: "main_tile",
    items: [
      item({ slotId: "shower_head", name: "Brizo Showerhead" }),
      item({ slotId: "main_tile", name: "Cortar Bone Reed", brand: "Elm Surfaces" }),
      item({ slotId: "vanity_faucet", name: "Brizo Odin Faucet", brand: "Brizo" }),
    ],
  });
  const payload = boardPayload(b, DEFAULT_VARIANTS[0]);
  assert.equal(payload.heroItemId, "main_tile");
  assert.equal(payload.items[0].id, "main_tile");
  assert.deepEqual(payload.items.map((entry) => entry.id), ["main_tile", "shower_head", "vanity_faucet"]);

  const files = boardReferenceFiles(b);
  assert.ok(files[0].name.startsWith("main_tile--"), `expected first file to start with "main_tile--", got "${files[0].name}"`);
  assert.deepEqual(files.map((file) => file.name), payload.items.flatMap((entry) => entry.imageNames));
  assert.doesNotThrow(() => validateCollageRequest(payload));
});

test("boardPayload falls back to the default hero when heroItemId is absent", () => {
  const b = board({
    items: [
      item({ slotId: "shower_head", name: "Brizo Showerhead" }),
      item({ slotId: "main_tile", name: "Cortar Bone Reed", brand: "Elm Surfaces" }),
      item({ slotId: "vanity_faucet", name: "Brizo Odin Faucet", brand: "Brizo" }),
    ],
  });
  const payload = boardPayload(b, DEFAULT_VARIANTS[0]);
  // vanity_faucet ranks highest in HERO_RANKING.bathroom_fixture_collage
  assert.equal(payload.heroItemId, "vanity_faucet");
  assert.equal(payload.items[0].id, "vanity_faucet");
});

test("boardPayload falls back to the default hero when heroItemId names a slot the board no longer has", () => {
  const b = board({
    heroItemId: "no_such_slot",
    items: [
      item({ slotId: "shower_head", name: "Brizo Showerhead" }),
      item({ slotId: "main_tile", name: "Cortar Bone Reed", brand: "Elm Surfaces" }),
    ],
  });
  const payload = boardPayload(b, DEFAULT_VARIANTS[0]);
  assert.equal(payload.heroItemId, "shower_head"); // next-ranked slot actually present
  assert.equal(payload.items[0].id, "shower_head");
});

test("orderedBoardItems moves the hero to front and keeps everyone else's relative order", () => {
  const b = board({
    heroItemId: "vanity_faucet",
    items: [
      item({ slotId: "shower_head" }),
      item({ slotId: "main_tile" }),
      item({ slotId: "vanity_faucet" }),
      item({ slotId: "countertop" }),
    ],
  });
  const ordered = orderedBoardItems(b);
  assert.deepEqual(ordered.map((entry) => entry.slotId), ["vanity_faucet", "shower_head", "main_tile", "countertop"]);
  // original array is untouched
  assert.deepEqual(b.items.map((entry) => entry.slotId), ["shower_head", "main_tile", "vanity_faucet", "countertop"]);
});
