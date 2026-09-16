import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPrompt,
  countReferences,
  promptBuilderManifest,
} from "../app/components/workbench/nodes/promptBuilder.manifest.ts";

test("countReferences expands a references bundle and counts bare images as one", () => {
  assert.equal(countReferences([]), 0);
  assert.equal(countReferences([{ kind: "image", url: "u", cacheKey: "a" }]), 1);
  assert.equal(
    countReferences([{ kind: "references", items: [{ id: "1" }, { id: "2" }, { id: "3" }], order: ["1", "2", "3"] }]),
    3,
  );
  assert.equal(
    countReferences([
      { kind: "image", url: "u", cacheKey: "a" },
      { kind: "references", items: [{ id: "1" }, { id: "2" }], order: ["1", "2"] },
      { kind: "text", text: "ignored" },
    ]),
    3,
  );
});

test("generate mode emits the labeled generation sections and skips empty ones", () => {
  const prompt = buildPrompt({ promptMode: "generate", domain: "collage", genScene: "overhead flat lay", lighting: "soft daylight" }, 0);

  assert.match(prompt, /^GOAL\nClean editorial material collage/);
  assert.match(prompt, /SCENE\noverhead flat lay/);
  assert.match(prompt, /MATERIALS AND DETAIL\nLighting: soft daylight\./);
  // No subject, constraints or references were supplied, so those headings
  // must not appear as empty stubs.
  assert.doesNotMatch(prompt, /SUBJECT/);
  assert.doesNotMatch(prompt, /CONSTRAINTS/);
  assert.doesNotMatch(prompt, /REFERENCE MAP/);
});

test("edit mode is change-scoped rather than a create instruction", () => {
  const prompt = buildPrompt({
    promptMode: "edit",
    editChange: "the white chairs, replaced with wood",
    editPreserve: ["camera angle", "floor shadows"],
    editExclusions: ["text", "watermarks"],
  }, 0);

  assert.match(prompt, /^CHANGE\nChange ONLY the white chairs, replaced with wood\./);
  assert.match(prompt, /PRESERVE\nPreserve camera angle, floor shadows\. Keep all other aspects of the image unchanged\./);
  assert.match(prompt, /EXCLUSIONS\nDo not add text, watermarks\./);
  assert.doesNotMatch(prompt, /GOAL/);
});

test("refine mode carries one change forward and offers no exclusions list", () => {
  const prompt = buildPrompt({
    promptMode: "refine",
    refineChange: "make it a winter evening with snowfall",
    refineCarry: ["the exact billboard text"],
  }, 0);

  assert.match(prompt, /^SINGLE CHANGE\nChange ONLY make it a winter evening with snowfall\./);
  assert.match(prompt, /CARRY FORWARD\nPreserve the exact billboard text\./);
  assert.doesNotMatch(prompt, /EXCLUSIONS/);
});

test("the reference map numbers every connected image and defaults an unset role", () => {
  const prompt = buildPrompt({ promptMode: "generate", referenceRoles: ["layout master"] }, 3);

  assert.match(prompt, /REFERENCE MAP\nImage 1 -> role: layout master/);
  assert.match(prompt, /Image 2 -> role: subject/);
  assert.match(prompt, /Image 3 -> role: subject/);
});

test("the node declares the references pass-through so the map and the images share one source", () => {
  const { inputs, outputs } = promptBuilderManifest.spec;

  const refIn = inputs.find((port) => port.id === "references");
  assert.ok(refIn?.multi);
  assert.deepEqual(refIn.acceptedKinds, ["image", "references"]);

  assert.deepEqual(outputs.map((port) => port.id), ["text", "references"]);
  assert.equal(outputs[1].kind, "references");
});

test("every param the node writes is declared in its importSchema", () => {
  const declared = new Set(Object.keys(promptBuilderManifest.importSchema.paramKeys));
  for (const key of Object.keys(promptBuilderManifest.defaultParams)) {
    assert.ok(declared.has(key), `defaultParams.${key} is missing from importSchema.paramKeys`);
  }
});
