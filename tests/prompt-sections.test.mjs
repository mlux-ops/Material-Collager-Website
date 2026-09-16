import assert from "node:assert/strict";
import test from "node:test";

import { assembleSections, buildReferenceMap, changeScopeLines } from "../app/lib/prompt-sections.ts";

test("assembleSections joins heading and body with a blank line between sections", () => {
  const result = assembleSections([
    { heading: "GOAL", body: "Create one thing." },
    { heading: "OUTPUT", body: "Deliver it." },
  ]);

  assert.equal(result, "GOAL\nCreate one thing.\n\nOUTPUT\nDeliver it.");
});

test("assembleSections skips null and undefined entries", () => {
  const result = assembleSections([
    { heading: "GOAL", body: "Create one thing." },
    null,
    undefined,
    { heading: "OUTPUT", body: "Deliver it." },
  ]);

  assert.equal(result, "GOAL\nCreate one thing.\n\nOUTPUT\nDeliver it.");
});

test("assembleSections skips entries with an empty body", () => {
  const result = assembleSections([
    { heading: "GOAL", body: "Create one thing." },
    { heading: "ART DIRECTION", body: "" },
    { heading: "OUTPUT", body: "Deliver it." },
  ]);

  assert.equal(result, "GOAL\nCreate one thing.\n\nOUTPUT\nDeliver it.");
});

test("assembleSections interleaves nulls and empty bodies among sections that survive", () => {
  const result = assembleSections([
    null,
    { heading: "GOAL", body: "Create one thing." },
    { heading: "SKIP", body: "" },
    undefined,
    { heading: "OUTPUT", body: "Deliver it." },
    { heading: "ALSO SKIP", body: "" },
  ]);

  assert.equal(result, "GOAL\nCreate one thing.\n\nOUTPUT\nDeliver it.");
});

test("assembleSections returns an empty string when nothing survives", () => {
  assert.equal(assembleSections([null, undefined, { heading: "X", body: "" }]), "");
});

test("buildReferenceMap returns an empty string for an empty list", () => {
  assert.equal(buildReferenceMap([]), "");
});

test("buildReferenceMap numbers a single reference as Image 1", () => {
  const map = buildReferenceMap([{ role: "subject", label: "faucet" }]);

  assert.equal(map, 'Image 1 -> role: subject; label: faucet');
});

test("buildReferenceMap keeps numbering continuous across a 1-slot, 3-slot, then 1-slot sequence", () => {
  const map = buildReferenceMap([
    { role: "layout master", label: "approved draft" },
    { role: "subject", label: "faucet", supportingViews: 2 },
    { role: "style", label: "tile" },
  ]);
  const lines = map.split("\n");

  assert.equal(lines.length, 3);
  assert.equal(lines[0], 'Image 1 -> role: layout master; label: approved draft');
  assert.equal(
    lines[1],
    'Images 2-4 -> role: subject; label: faucet; primary identity view: Image 2; supporting views of this same physical item: Images 3-4',
  );
  assert.equal(lines[2], 'Image 5 -> role: style; label: tile');
});

test("buildReferenceMap omits the primary/supporting split when an entry has no supporting views", () => {
  const map = buildReferenceMap([{ role: "subject", supportingViews: 0 }]);

  assert.equal(map, "Image 1 -> role: subject");
  assert.doesNotMatch(map, /primary identity view/);
});

test("buildReferenceMap spells out the primary identity view and its supporting range for a multi-view entry", () => {
  const map = buildReferenceMap([{ role: "subject", supportingViews: 3 }]);

  assert.match(map, /^Images 1-4 -> /);
  assert.match(map, /primary identity view: Image 1/);
  assert.match(map, /supporting views of this same physical item: Images 2-4/);
});

test("changeScopeLines always emits a CHANGE section stating only what may change", () => {
  const sections = changeScopeLines({ change: "the white chairs with chairs made of wood" });

  assert.equal(sections.length, 1);
  assert.equal(sections[0].heading, "CHANGE");
  assert.equal(sections[0].body, "Change ONLY the white chairs with chairs made of wood.");
});

test("changeScopeLines adds PRESERVE and EXCLUSIONS sections when given", () => {
  const sections = changeScopeLines({
    change: "the faucet finish",
    preserve: ["camera angle", "room lighting", "floor shadows"],
    exclusions: ["text", "logos", "watermarks"],
  });

  assert.deepEqual(sections.map((section) => section.heading), ["CHANGE", "PRESERVE", "EXCLUSIONS"]);
  assert.equal(
    sections[1].body,
    "Preserve camera angle, room lighting, floor shadows. Keep all other aspects of the image unchanged.",
  );
  assert.equal(sections[2].body, "Do not add text, logos, watermarks.");
});

test("changeScopeLines omits PRESERVE and EXCLUSIONS when those arrays are empty or absent", () => {
  const withEmptyArrays = changeScopeLines({ change: "the tile color", preserve: [], exclusions: [] });
  const withNeitherGiven = changeScopeLines({ change: "the tile color" });

  assert.deepEqual(withEmptyArrays.map((section) => section.heading), ["CHANGE"]);
  assert.deepEqual(withNeitherGiven.map((section) => section.heading), ["CHANGE"]);
});

test("changeScopeLines output composes directly with assembleSections", () => {
  const prompt = assembleSections(
    changeScopeLines({
      change: "the sofa fabric",
      preserve: ["camera angle", "shadows"],
    }),
  );

  assert.equal(
    prompt,
    "CHANGE\nChange ONLY the sofa fabric.\n\nPRESERVE\nPreserve camera angle, shadows. Keep all other aspects of the image unchanged.",
  );
});
