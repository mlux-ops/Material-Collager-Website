import assert from "node:assert/strict";
import test from "node:test";

import {
  QA_MAX_PAYLOAD_BYTES,
  buildQaInstructions,
  computeFlagCount,
  parseQaModelJson,
  validateQaRequest,
} from "../app/lib/qa.ts";

// Small valid 1x1 PNG, base64-encoded, used as stand-in image data across
// these tests — its content never matters, only its size and validity as
// base64.
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function image(overrides = {}) {
  return { imageBase64: TINY_PNG_BASE64, mimeType: "image/png", ...overrides };
}

function request(overrides = {}) {
  return {
    output: image(),
    items: [
      { id: "faucet", role: "vanity faucet" },
      { id: "tile", role: "wall tile" },
    ],
    references: [
      { itemId: "faucet", ...image() },
      { itemId: "tile", ...image() },
    ],
    ...overrides,
  };
}

test("validateQaRequest rejects a missing output image", () => {
  const body = request();
  delete body.output;
  assert.throws(() => validateQaRequest(body), /rendered output image/);
});

test("validateQaRequest rejects a reference whose itemId does not match any item", () => {
  const body = request({
    references: [
      { itemId: "faucet", ...image() },
      { itemId: "not-a-real-item", ...image() },
    ],
  });
  assert.throws(() => validateQaRequest(body), /does not match any item/);
});

test("validateQaRequest rejects duplicate item ids", () => {
  const body = request({
    items: [
      { id: "faucet", role: "vanity faucet" },
      { id: "faucet", role: "duplicate faucet" },
    ],
  });
  assert.throws(() => validateQaRequest(body), /used more than once/);
});

test("validateQaRequest rejects an item with no matching reference", () => {
  const body = request({
    items: [
      { id: "faucet", role: "vanity faucet" },
      { id: "tile", role: "wall tile" },
      { id: "hardware", role: "cabinet hardware" },
    ],
  });
  assert.throws(() => validateQaRequest(body), /"hardware" is missing its reference image/);
});

test("validateQaRequest rejects a second reference for the same item", () => {
  const body = request({
    references: [
      { itemId: "faucet", ...image() },
      { itemId: "faucet", ...image() },
    ],
  });
  assert.throws(() => validateQaRequest(body), /more than one reference image/);
});

test("validateQaRequest rejects a payload over the byte budget", () => {
  // A run of 'A' characters is valid base64 (it decodes to null bytes), so
  // this exercises the size check rather than the base64-validity check.
  // Target just over the cap: base64 length must be a multiple of 4.
  const targetBytes = QA_MAX_PAYLOAD_BYTES + 1024 * 1024;
  const oversized = "A".repeat(Math.ceil(targetBytes / 3) * 4);
  const body = request({ output: image({ imageBase64: oversized }) });
  assert.throws(() => validateQaRequest(body), /over the .* MB QA limit/);
});

test("validateQaRequest rejects an unsupported mime type", () => {
  const body = request({ output: image({ mimeType: "image/gif" }) });
  assert.throws(() => validateQaRequest(body), /image\/png, image\/jpeg, image\/webp/);
});

test("validateQaRequest rejects invalid base64 image data", () => {
  const body = request({ output: image({ imageBase64: "not base64 at all!!" }) });
  assert.throws(() => validateQaRequest(body), /not valid base64/);
});

test("validateQaRequest accepts a well-formed request and returns normalized parts", () => {
  const result = validateQaRequest(request());
  assert.equal(result.items.length, 2);
  assert.equal(result.referencesByItem.size, 2);
  assert.ok(result.referencesByItem.has("faucet"));
  assert.ok(result.referencesByItem.has("tile"));
});

test("computeFlagCount counts items failing present/count/finishMatch/scaleOk, plus extraObjects", () => {
  const qa = {
    items: [
      { id: "a", present: true, count: 1, finishMatch: "match", scaleOk: true, issues: [] },
      { id: "b", present: false, count: 0, finishMatch: "unclear", scaleOk: null, issues: [] },
      { id: "c", present: true, count: 2, finishMatch: "match", scaleOk: true, issues: ["two objects"] },
      { id: "d", present: true, count: 1, finishMatch: "mismatch", scaleOk: true, issues: ["wrong finish"] },
      { id: "e", present: true, count: 1, finishMatch: "match", scaleOk: false, issues: ["too big"] },
    ],
    extraObjects: ["unexplained vase", "extra towel"],
  };
  // b, c, d, e are flagged (4) + 2 extraObjects = 6
  assert.equal(computeFlagCount(qa), 6);
});

test("computeFlagCount is zero for an all-clear result with no extras", () => {
  const qa = {
    items: [
      { id: "a", present: true, count: 1, finishMatch: "match", scaleOk: true, issues: [] },
      { id: "b", present: true, count: 1, finishMatch: "unclear", scaleOk: null, issues: [] },
    ],
    extraObjects: [],
  };
  assert.equal(computeFlagCount(qa), 0);
});

test("buildQaInstructions mentions every item id", () => {
  const items = [
    { id: "vanity_faucet", role: "vanity faucet" },
    { id: "main_tile", role: "main bathroom tile" },
    { id: "shower_head", role: "shower head and wall arm" },
  ];
  const instructions = buildQaInstructions(items);
  for (const item of items) {
    assert.match(instructions, new RegExp(`"${item.id}"`));
  }
});

test("buildQaInstructions mentions every note passed in", () => {
  const items = [
    { id: "vanity_faucet", role: "vanity faucet", notes: "must be matte black, not chrome" },
    { id: "main_tile", role: "main bathroom tile", notes: "large format, not mosaic" },
    { id: "shower_head", role: "shower head and wall arm" },
  ];
  const instructions = buildQaInstructions(items);
  assert.match(instructions, /must be matte black, not chrome/);
  assert.match(instructions, /large format, not mosaic/);
});

test("parsing a well-formed model JSON string into the response shape", () => {
  const raw = JSON.stringify({
    items: [
      { id: "faucet", present: true, count: 1, finishMatch: "match", scaleOk: true, issues: [] },
      { id: "tile", present: false, count: 0, finishMatch: "unclear", scaleOk: null, issues: ["not visible"] },
    ],
    extraObjects: ["stray towel"],
    summary: "Faucet matches; tile not detected.",
  });
  const parsed = parseQaModelJson(raw);
  assert.equal(parsed.items.length, 2);
  assert.equal(parsed.items[0].id, "faucet");
  assert.equal(parsed.items[0].present, true);
  assert.equal(parsed.items[1].scaleOk, null);
  assert.deepEqual(parsed.extraObjects, ["stray towel"]);
  assert.equal(parsed.summary, "Faucet matches; tile not detected.");
});

test("malformed JSON from the model raises a clear error mentioning \"QA model returned\"", () => {
  assert.throws(() => parseQaModelJson("{not json"), /QA model returned/);
  assert.throws(() => parseQaModelJson("null"), /QA model returned/);
  assert.throws(() => parseQaModelJson(JSON.stringify({ extraObjects: [], summary: "" })), /QA model returned/);
});
