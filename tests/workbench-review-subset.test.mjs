import assert from "node:assert/strict";
import test from "node:test";

import { reviewGeneratedImage } from "../app/lib/accuracy-review.ts";

// issue-1: the canonical contract between accuracy-review.ts and its callers
// (both /api/workbench/review/route.ts and the workbench's
// accuracyReviewer.tsx client) is that `references[]` carries images for
// ONLY the reviewed subset -- reviewGeneratedImage numbers its reference-
// range map from `referenceItems = selectedIds.size ? items.filter(item =>
// selectedIds.has(item.id)) : items` (board order, filtered to selected),
// and the caller must supply exactly that many reference images, in that
// same order. `items` (the full board list) is still used verbatim for the
// schema's minItems/maxItems -- only the reference IMAGE BYTES are scoped to
// the subset. accuracyReviewer.tsx used to serialize references for EVERY
// item regardless of selectedItemIds, which this test locks the correct
// contract against.

function withMockedFetch(handler, run) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return Promise.resolve(run()).finally(() => {
    globalThis.fetch = original;
  });
}

function pngBlob() {
  return new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/png" });
}

function mockSuccessResponse(items) {
  return new Response(
    JSON.stringify({
      output_text: JSON.stringify({
        passed: true,
        score: 95,
        findings: [],
        recommendation: "",
        items: items.map((item) => ({ id: item.id, passed: true, finding: "" })),
      }),
    }),
    { status: 200 },
  );
}

const NOT_A_REAL_API_KEY = ["unit", "test", "mock", "no-network-call"].join("-");

test("a masked-repair (selectedItemIds) review numbers its reference-range map from ONLY the selected subset, using the subset's own local numbering starting at 1 -- not the full board's cumulative count", async () => {
  let capturedBody;
  const boardItems = [
    { id: "wood", role: "wood cabinet", referenceCount: 2 },
    { id: "countertop", role: "countertop stone", referenceCount: 1 },
    { id: "faucet", role: "kitchen faucet", referenceCount: 3 },
  ];

  await withMockedFetch(
    async (_url, init) => {
      capturedBody = JSON.parse(init.body);
      return mockSuccessResponse(boardItems);
    },
    () =>
      reviewGeneratedImage({
        apiKey: NOT_A_REAL_API_KEY,
        imageBase64: "AA==",
        items: boardItems,
        selectedItemIds: ["countertop"], // a PROPER SUBSET of the 3-item board
        // Exactly countertop's own referenceCount (1) worth of images -- NOT
        // the full board's total of 6. This is the contract accuracyReviewer
        // .tsx must now honor.
        references: [{ blob: pngBlob() }],
        domain: "interior render",
      }),
  );

  assert.ok(capturedBody, "reviewGeneratedImage must have called fetch");
  const promptText = capturedBody.input[0].content[0].text;
  // Local numbering: the selected item is the ONLY entry, so it is
  // "reference 1", not "reference 3" (which is where it would fall under the
  // full board's cumulative numbering, since wood consumes references 1-2).
  assert.ok(promptText.includes("reference 1 -> countertop: countertop stone"), promptText);
  assert.ok(!promptText.includes("wood cabinet"), "the unselected item must not appear in the reference-range map");
  assert.ok(!promptText.includes("kitchen faucet"), "the unselected item must not appear in the reference-range map");

  // content = [input_text, main image, ...references] -- exactly 1 reference
  // image was supplied (matching the subset's own referenceCount, not the
  // full board's), and reviewGeneratedImage must consume exactly that many,
  // never expecting more.
  assert.equal(capturedBody.input[0].content.length, 3);

  // The schema's item count still reflects the FULL board (3), not the
  // subset (1) -- expectedItems (schema minItems/maxItems) and referenceItems
  // (the reference-range numbering) are deliberately different arrays for
  // deliberately different purposes.
  assert.equal(capturedBody.text.format.schema.properties.items.minItems, 3);
  assert.equal(capturedBody.text.format.schema.properties.items.maxItems, 3);
});

test("a full-board review (no selectedItemIds) numbers its reference-range map cumulatively across every item, in board order", async () => {
  let capturedBody;
  const boardItems = [
    { id: "wood", role: "wood cabinet", referenceCount: 2 },
    { id: "countertop", role: "countertop stone", referenceCount: 1 },
  ];

  await withMockedFetch(
    async (_url, init) => {
      capturedBody = JSON.parse(init.body);
      return mockSuccessResponse(boardItems);
    },
    () =>
      reviewGeneratedImage({
        apiKey: NOT_A_REAL_API_KEY,
        imageBase64: "AA==",
        items: boardItems,
        selectedItemIds: [], // empty -> full-board scoring
        references: [{ blob: pngBlob() }, { blob: pngBlob() }, { blob: pngBlob() }], // 2 + 1 = 3, the full board's total
        domain: "interior render",
      }),
  );

  const promptText = capturedBody.input[0].content[0].text;
  assert.ok(promptText.includes("references 1-2 -> wood: wood cabinet"), promptText);
  assert.ok(promptText.includes("reference 3 -> countertop: countertop stone"), promptText);
  assert.equal(capturedBody.input[0].content.length, 5); // input_text + main image + 3 references
});

test("multi-image items (referenceCount>1) inside a selected subset still produce a correct 'references N-M' range using the subset's own local numbering", async () => {
  let capturedBody;
  const boardItems = [
    { id: "wood", role: "wood cabinet", referenceCount: 2 },
    { id: "countertop", role: "countertop stone", referenceCount: 1 },
    { id: "faucet", role: "kitchen faucet", referenceCount: 3 },
  ];

  await withMockedFetch(
    async (_url, init) => {
      capturedBody = JSON.parse(init.body);
      return mockSuccessResponse(boardItems);
    },
    () =>
      reviewGeneratedImage({
        apiKey: NOT_A_REAL_API_KEY,
        imageBase64: "AA==",
        items: boardItems,
        selectedItemIds: ["faucet"], // a subset containing a referenceCount>1 item
        references: [{ blob: pngBlob() }, { blob: pngBlob() }, { blob: pngBlob() }], // faucet's own 3 images
        domain: "interior render",
      }),
  );

  const promptText = capturedBody.input[0].content[0].text;
  assert.ok(promptText.includes("references 1-3 -> faucet: kitchen faucet"), promptText);
  assert.ok(!promptText.includes("wood cabinet"));
  assert.ok(!promptText.includes("countertop stone"));
  assert.equal(capturedBody.input[0].content.length, 5); // input_text + main image + 3 references
});

// N-11: after issue-1 (round 3), the route's OWN pre-lib validation
// (app/api/workbench/review/route.ts's validateItems) still capped on the
// FULL board's summed referenceCount, not the reviewed SUBSET actually
// transmitted -- so a 2-image subset review of a board whose OTHER items
// summed past 16 references was rejected citing images it never sent, even
// though reviewGeneratedImage itself (tested below) was always perfectly
// happy with exactly this shape of request. The fix moves that cap onto
// `reviewedItems` (computed the same way this lib already does, at
// route.ts's own call site) and adds a separate, correctly-scoped
// board-SHAPE sanity cap on items.length (metadata only, no image bytes).
//
// route.ts itself cannot be imported directly under this test runner: it
// uses Next's "@/" path-alias imports (`@/app/lib/...`), which are a
// tsconfig/bundler-only resolution feature -- Node's bare ESM loader (no
// loader/resolve hook is registered for `npm run test:workbench`) throws
// ERR_MODULE_NOT_FOUND for a bare "@/app/..." specifier. This was confirmed
// empirically, not assumed. The fix was independently verified against the
// REAL route.ts (not a reimplementation) via a temporary, string-substituted
// copy with only its three `@/`-prefixed import specifiers rewritten to
// their equivalent relative paths -- everything else byte-identical -- run
// once through `node --experimental-strip-types` and deleted immediately
// after. All three scenarios below passed against that copy: (1) a 20-image
// board (5+5+8+2 across 4 items) reviewed via a 2-image subset returned 200
// (previously rejected); (2) a 20-item board (1 reference each) was rejected
// with "Describe no more than 16 items in one review" regardless of
// selection (the new board-shape cap); (3) a full-board (no selection)
// review whose OWN total exceeds 16 was still rejected with "Use no more
// than 16 reference images in one review" (proving the cap was correctly
// RE-SCOPED, not simply deleted). This test file instead locks the
// contract at the shared-lib boundary it CAN import directly.
test("N-11: reviewGeneratedImage itself has no issue with a large board (>16 references summed across all items) reviewed via a small selected subset -- the (now-fixed) rejection was route.ts's own pre-lib cap, never this shared lib", async () => {
  let capturedBody;
  const boardItems = [
    { id: "a", role: "item a", referenceCount: 5 },
    { id: "b", role: "item b", referenceCount: 5 },
    { id: "c", role: "item c", referenceCount: 8 }, // 5+5+8 = 18, already over MAX_REFERENCE_IMAGES (16)
    { id: "d", role: "item d", referenceCount: 2 }, // the reviewed subset
  ];

  await withMockedFetch(
    async (_url, init) => {
      capturedBody = JSON.parse(init.body);
      return mockSuccessResponse(boardItems);
    },
    () =>
      reviewGeneratedImage({
        apiKey: NOT_A_REAL_API_KEY,
        imageBase64: "AA==",
        items: boardItems,
        selectedItemIds: ["d"], // a 2-image subset of a board whose full total is 20
        references: [{ blob: pngBlob() }, { blob: pngBlob() }], // exactly item d's own 2 images
        domain: "interior render",
      }),
  );

  assert.ok(capturedBody, "reviewGeneratedImage must have called fetch");
  const promptText = capturedBody.input[0].content[0].text;
  // item d's own referenceCount is 2, so its LOCAL (subset) numbering is a
  // range ("references 1-2"), not a single reference -- matching the same
  // range-numbering semantics the earlier tests in this file already pin.
  assert.ok(promptText.includes("references 1-2 -> d: item d"), promptText);
  // Only the reviewed subset may be mapped. Check the map lines themselves
  // rather than the whole prompt: the standing criteria are prose about items
  // in general, so a substring scan for "item a" trips over ordinary wording.
  const mapLines = promptText.split("\n").filter((line) => / -> \w+: /.test(line));
  assert.equal(mapLines.length, 1, promptText);
  assert.ok(mapLines[0].startsWith("references 1-2 -> d: item d"), mapLines[0]);
  // The schema's item count still reflects the FULL board (4), independent
  // of the reviewed subset (1) -- unaffected by N-11 (that's issue-1's
  // contract, re-confirmed here on a bigger board than the earlier tests use).
  assert.equal(capturedBody.text.format.schema.properties.items.minItems, 4);
});

// Supporting views (image 2..n in one item slot) were being rendered as extra
// objects in the collage. The generator prompt now names the primary/supporting
// split and states an exact object count; QA has to police the same contract,
// otherwise a stray object built from a supporting view scores as a legitimate
// element and the repair loop never removes it.
test("a full review maps each item's primary and supporting views and states the board's exact object count", async () => {
  let capturedBody;
  const boardItems = [
    { id: "wall_tile", role: "wall tile", referenceCount: 3 },
    { id: "faucet", role: "hardware", referenceCount: 2 },
    { id: "countertop", role: "countertop stone", referenceCount: 1 },
  ];

  await withMockedFetch(
    async (_url, init) => {
      capturedBody = JSON.parse(init.body);
      return mockSuccessResponse(boardItems);
    },
    () =>
      reviewGeneratedImage({
        apiKey: NOT_A_REAL_API_KEY,
        imageBase64: "AA==",
        items: boardItems,
        selectedItemIds: [],
        references: [{ blob: pngBlob() }, { blob: pngBlob() }, { blob: pngBlob() }, { blob: pngBlob() }, { blob: pngBlob() }, { blob: pngBlob() }],
        domain: "material collage",
      }),
  );

  const promptText = capturedBody.input[0].content[0].text;
  assert.ok(
    promptText.includes("references 1-3 -> wall_tile: wall tile (primary identity view: reference 1; supporting views of this same physical item: references 2-3)"),
    promptText,
  );
  // One supporting view stays singular, and a single-reference item gets no split.
  assert.ok(promptText.includes("supporting view of this same physical item: reference 5"), promptText);
  assert.ok(promptText.includes("reference 6 -> countertop: countertop stone\n"), promptText);
  assert.ok(promptText.includes("exactly 3 referenced objects on the canvas, one per item ID"), promptText);
  assert.ok(promptText.includes("No object was built from a supporting view."), promptText);
});

test("a masked repair omits the object count, since the canvas it reviews still carries the whole board", async () => {
  let capturedBody;
  const boardItems = [
    { id: "wall_tile", role: "wall tile", referenceCount: 3 },
    { id: "faucet", role: "hardware", referenceCount: 2 },
  ];

  await withMockedFetch(
    async (_url, init) => {
      capturedBody = JSON.parse(init.body);
      return mockSuccessResponse(boardItems);
    },
    () =>
      reviewGeneratedImage({
        apiKey: NOT_A_REAL_API_KEY,
        imageBase64: "AA==",
        items: boardItems,
        selectedItemIds: ["faucet"],
        references: [{ blob: pngBlob() }, { blob: pngBlob() }],
        domain: "material collage",
      }),
  );

  const promptText = capturedBody.input[0].content[0].text;
  assert.doesNotMatch(promptText, /referenced object/);
  // The supporting-view rule still applies to the item being repaired.
  assert.ok(promptText.includes("references 1-2 -> faucet: hardware (primary identity view: reference 1"), promptText);
  assert.ok(promptText.includes("No object was built from a supporting view."), promptText);
});
