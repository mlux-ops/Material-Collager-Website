import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPrompt,
  countReferences,
  promptBuilderManifest,
} from "../app/components/workbench/nodes/promptBuilder.manifest.ts";

const refItem = (id, ...imageKeys) => ({ id, role: id, imageKeys });

test("countReferences matches the multipart body, not the wire count", () => {
  assert.equal(countReferences([]), 0);
  assert.equal(countReferences([{ kind: "image", url: "u", cacheKey: "a" }]), 1);
  assert.equal(
    countReferences([{ kind: "references", items: [refItem("1", "k1"), refItem("2", "k2")], order: ["1", "2"] }]),
    2,
  );
  assert.equal(
    countReferences([
      { kind: "image", url: "u", cacheKey: "a" },
      { kind: "references", items: [refItem("1", "k1")], order: ["1"] },
      { kind: "text", text: "ignored" },
    ]),
    2,
  );
});

// These two are the reason countReferences delegates to imageCacheKeysFromValue
// instead of counting items: a naive count would number images the model never
// receives, or miss ones it does.
test("countReferences expands an item carrying several images", () => {
  assert.equal(
    countReferences([{ kind: "references", items: [refItem("faucet", "k1", "k2", "k3")], order: ["faucet"] }]),
    3,
  );
});

test("countReferences collapses a repeated item id the way the transport does", () => {
  assert.equal(
    countReferences([{ kind: "references", items: [refItem("tile", "k1")], order: ["tile", "tile"] }]),
    1,
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
    editPreserve: "camera angle\nfloor shadows",
    editExclusions: "text\nwatermarks",
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
    refineCarry: "the exact billboard text",
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

// executeGeneration pushes the base image into the multipart before any
// reference, so on an edit turn the thing being edited is Image 1 and the
// references connected to this node start at Image 2.
test("edit and refine reserve Image 1 for the base image; generate does not", () => {
  const edit = buildPrompt({ promptMode: "edit", editChange: "the tile", referenceRoles: ["style", "subject"] }, 2);
  assert.match(edit, /Image 1 -> role: the image being edited/);
  assert.match(edit, /Image 2 -> role: style/);
  assert.match(edit, /Image 3 -> role: subject/);

  const refine = buildPrompt({ promptMode: "refine", refineChange: "warmer light" }, 1);
  assert.match(refine, /Image 1 -> role: the image being edited/);
  assert.match(refine, /Image 2 -> role: subject/);

  const generate = buildPrompt({ promptMode: "generate", referenceRoles: ["style"] }, 1);
  assert.match(generate, /Image 1 -> role: style/);
  assert.doesNotMatch(generate, /the image being edited/);
});

test("an edit turn names its base image even with no references connected", () => {
  const edit = buildPrompt({ promptMode: "edit", editChange: "the tile" }, 0);
  assert.match(edit, /REFERENCE MAP\nImage 1 -> role: the image being edited/);
});

// Regression: these fields hold the raw textarea text. Normalizing them on
// every keystroke made space and Enter impossible to type, because the
// controlled value erased them as fast as they arrived.
test("list fields keep what was typed verbatim and normalize only at assembly", () => {
  const midTyping = buildPrompt({
    promptMode: "edit",
    editChange: "the tile",
    editPreserve: "camera angle\n\n  floor shadows  \n",
  }, 0);

  assert.match(midTyping, /PRESERVE\nPreserve camera angle, floor shadows\./);

  // A graph saved before the change stored an array; it must still render.
  const legacy = buildPrompt({ promptMode: "edit", editChange: "the tile", editPreserve: ["camera angle"] }, 0);
  assert.match(legacy, /Preserve camera angle\./);
});
