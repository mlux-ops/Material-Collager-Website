import assert from "node:assert/strict";
import test from "node:test";

import { buildGenerationPrompt, buildSummary, validateCollageRequest } from "../app/lib/collage.ts";

// A "layout master" is a previous collage the user uploads to dictate
// composition and organization. It rides as Image 1 (like a Final render's
// approved draft) but carries much stronger authority: its own products must
// never appear, and it outranks the art-direction composition/spacing presets.
function request(overrides = {}) {
  return {
    collageType: "bathroom_fixture_collage",
    orientation: "default",
    quality: "medium",
    composition: "catalog",
    density: "airy",
    items: [
      { id: "faucet", role: "vanity faucet", imageKeys: ["a.png", "b.png"] },
      { id: "tile", role: "wall tile", imageKeys: ["c.png"] },
    ],
    ...overrides,
  };
}

function layoutRequest(overrides = {}) {
  return request({ layoutReference: true, layoutReferenceMode: "uploaded-collage", ...overrides });
}

test("an uploaded layout master is declared as Image 1 and the sole authority for composition", () => {
  const prompt = buildGenerationPrompt(layoutRequest());

  assert.match(prompt, /Image 1 -> a previously produced collage supplied as the LAYOUT MASTER/);
  assert.match(prompt, /single source of truth for composition and organization/);
  assert.match(prompt, /Where Image 1 and any other composition or spacing instruction disagree, Image 1 wins/);
});

test("the layout master's own products are explicitly excluded from the output", () => {
  const prompt = buildGenerationPrompt(layoutRequest());

  assert.match(prompt, /Ignore every product, material, color, finish, and prop shown in Image 1/);
  assert.match(prompt, /none of them may appear in the output/);
});

// The whole point of the mode: the presets would otherwise contradict the
// image the user just declared authoritative.
test("composition and spacing presets are omitted while a layout master is active, and restored without one", () => {
  const withMaster = buildGenerationPrompt(layoutRequest());
  // "catalog" composition and "airy" density copy, verbatim from the presets.
  assert.doesNotMatch(withMaster, /Polished luxury product arrangement/);
  assert.doesNotMatch(withMaster, /approximately one third of the canvas should remain open/);

  const withoutMaster = buildGenerationPrompt(request());
  assert.match(withoutMaster, /Polished luxury product arrangement/);
  assert.match(withoutMaster, /approximately one third of the canvas should remain open/);
});

test("lighting and styling presets still apply under a layout master (they are independent of layout)", () => {
  const prompt = buildGenerationPrompt(layoutRequest({ lighting: "crisp_studio", styling: "materials_only" }));

  assert.match(prompt, /Large diffused studio source from the upper left/);
  assert.match(prompt, /Use no decorative props/);
});

test("item numbering starts at Image 2 so it does not collide with the layout master", () => {
  const prompt = buildGenerationPrompt(layoutRequest());

  assert.match(prompt, /Images 2-3 -> item "faucet"/);
  assert.match(prompt, /Image 4 -> item "tile"/);
});

test("the hero item becomes a slot assignment rather than a free-form anchor choice", () => {
  const prompt = buildGenerationPrompt(layoutRequest({ heroItemId: "faucet" }));
  assert.match(prompt, /Assign item "faucet" to the layout master's most prominent slot/);

  const withoutHero = buildGenerationPrompt(layoutRequest());
  assert.match(withoutHero, /Keep the layout master's existing emphasis/);
});

test("mismatched object counts and aspect ratios are handled explicitly, not left to chance", () => {
  const prompt = buildGenerationPrompt(layoutRequest());

  assert.match(prompt, /different number of objects than the item list/);
  assert.match(prompt, /aspect ratio differs from the target canvas/);
  assert.match(prompt, /Never crop an item to force the old proportions/);
});

// An approved-draft layout reference is the pre-existing Final-render path and
// must keep its softer "preserve as closely as possible" wording.
test("an approved-draft layout reference keeps its own wording and does not borrow the master's", () => {
  const prompt = buildGenerationPrompt(request({ layoutReference: true, layoutReferenceMode: "approved-draft" }));

  assert.match(prompt, /Image 1 -> approved draft used only for composition/);
  assert.doesNotMatch(prompt, /LAYOUT MASTER/);
  // The draft path leaves the art-direction presets in place.
  assert.match(prompt, /Polished luxury product arrangement/);
});

test("layoutReference with no mode set defaults to the approved-draft wording (back-compat)", () => {
  const prompt = buildGenerationPrompt(request({ layoutReference: true }));

  assert.match(prompt, /Image 1 -> approved draft used only for composition/);
  assert.doesNotMatch(prompt, /LAYOUT MASTER/);
});

test("the summary reports composition and spacing as coming from the layout master", () => {
  const summary = buildSummary(layoutRequest());

  assert.match(summary, /Composition: from the uploaded layout master/);
  assert.match(summary, /Spacing: from the uploaded layout master/);
});

// The layout master consumes one of the 16 image slots, so a full board of 16
// product references plus a master cannot be sent.
test("a layout reference plus a full 16-reference board is rejected with an actionable message", () => {
  const items = Array.from({ length: 16 }, (_, index) => ({
    id: `item-${index}`,
    role: "sample",
    imageKeys: [`${index}.png`],
  }));

  assert.throws(
    () => validateCollageRequest(layoutRequest({ items })),
    /at most 15 product references/,
  );
  // The same board is fine without the layout reference.
  assert.doesNotThrow(() => validateCollageRequest(request({ items })));
});
