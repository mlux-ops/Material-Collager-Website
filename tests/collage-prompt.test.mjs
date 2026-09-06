import assert from "node:assert/strict";
import test from "node:test";

import { buildGenerationPrompt } from "../app/lib/collage.ts";

// A "supporting view" is a second, third, ... image uploaded into one item slot:
// another photograph of the SAME physical item. The generator kept rendering
// those extra views as extra objects in the collage, so the prompt has to say
// which image carries identity, which ones are only guides, and how many
// objects the finished canvas may contain.
function request(overrides = {}) {
  return {
    collageType: "bathroom_fixture_collage",
    orientation: "default",
    quality: "medium",
    items: [
      { id: "faucet", role: "vanity faucet", finish: "matte black", imageKeys: ["a.png", "b.png", "c.png"] },
      { id: "tile", role: "wall tile", imageKeys: ["d.png"] },
    ],
    ...overrides,
  };
}

test("a multi-image item names its primary identity view and its supporting views", () => {
  const prompt = buildGenerationPrompt(request());

  assert.match(prompt, /Images 1-3 -> item "faucet"/);
  assert.match(prompt, /primary identity view: Image 1/);
  assert.match(prompt, /supporting views of this same physical item: Images 2-3/);
});

test("a single-image item's label gets no primary/supporting split", () => {
  const prompt = buildGenerationPrompt(request({
    items: [{ id: "tile", role: "wall tile", imageKeys: ["d.png"] }],
  }));
  // This board's other item still has a supporting view, so the standing
  // fidelity rules still discuss them; only the single-image item's own map
  // line must stay free of a split it doesn't have.
  const label = prompt.split("\n").find((line) => line.includes('-> item "tile"'));

  assert.equal(label, 'Image 1 -> item "tile" (role: wall tile)');
});

test("the view numbering follows the approved draft's offset on a final render", () => {
  const prompt = buildGenerationPrompt(request({ layoutReference: true }));

  // Image 1 is the approved draft, so the faucet's own views start at 2.
  assert.match(prompt, /Images 2-4 -> item "faucet"/);
  assert.match(prompt, /primary identity view: Image 2/);
  assert.match(prompt, /supporting views of this same physical item: Images 3-4/);
});

test("the prompt states the exact object count and discounts the supporting views", () => {
  const prompt = buildGenerationPrompt(request());

  assert.match(prompt, /OBJECT COUNT/);
  assert.match(prompt, /exactly 2 referenced objects, one per item ID: "faucet", "tile"/);
  assert.match(prompt, /2 of the 4 uploaded product images are supporting views that add no object of their own/);
  assert.match(prompt, /if the count exceeds 2, a supporting view was rendered as its own object/);
});

test("the object count reads naturally for one object and omits the supporting sentence when there are none", () => {
  const prompt = buildGenerationPrompt(request({
    items: [{ id: "tile", role: "wall tile", imageKeys: ["d.png"] }],
  }));

  assert.match(prompt, /exactly 1 referenced object, one per item ID: "tile"/);
  assert.doesNotMatch(prompt, /add no object of their own/);
});

test("the fidelity rules forbid rendering a supporting view as its own element", () => {
  const prompt = buildGenerationPrompt(request());

  assert.match(prompt, /Never place a supporting view on the canvas as its own element/);
  assert.match(prompt, /two objects on the canvas would trace back to one item ID/);
  assert.match(prompt, /Where they disagree, the primary view decides/);
});

// F5: the four supporting-view fidelity bullets describe a concept
// ("supporting view") that does not exist when every item has exactly one
// reference image. Emitting them anyway is confusing noise for the model.
test("a board with exactly one image per item never mentions supporting views", () => {
  const prompt = buildGenerationPrompt(request({
    items: [
      { id: "faucet", role: "vanity faucet", imageKeys: ["a.png"] },
      { id: "tile", role: "wall tile", imageKeys: ["b.png"] },
    ],
  }));

  assert.doesNotMatch(prompt, /supporting view/i);
});

test("a board where one item has two images still states the supporting-view rules and count", () => {
  const prompt = buildGenerationPrompt(request({
    items: [
      { id: "faucet", role: "vanity faucet", imageKeys: ["a.png", "b.png"] },
      { id: "tile", role: "wall tile", imageKeys: ["c.png"] },
    ],
  }));

  assert.match(prompt, /A supporting view is another photograph of the SAME physical item/);
  assert.match(prompt, /1 of the 3 uploaded product images is a supporting view that add no object of their own/);
});
