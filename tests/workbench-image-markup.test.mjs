import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMarkupPrompt,
  colorsMissingInstructions,
  imageMarkupManifest,
  MARKUP_PALETTE,
  MARKUP_PROMPT_CLOSING,
  MARKUP_STROKES_MAX_LENGTH,
  markupColorHex,
  parseInstructions,
  parseStrokes,
  usedColors,
} from "../app/components/workbench/nodes/imageMarkup.manifest.ts";
import { defaultParams, importSchemaMap, MANIFESTS, NODE_KINDS, paidMap } from "../app/components/workbench/nodes/manifests.ts";
import { validateImport, EXPORT_FORMAT, EXPORT_VERSION } from "../app/components/workbench/export-import.ts";

const stroke = (color, points = [10, 10, 20, 20], radius = 12) => ({ color, radius, points });

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

test("the palette is six distinct named, opaque, high-contrast colours", () => {
  assert.equal(MARKUP_PALETTE.length, 6);
  assert.deepEqual(MARKUP_PALETTE.map((entry) => entry.name), ["red", "blue", "green", "yellow", "magenta", "cyan"]);
  assert.equal(new Set(MARKUP_PALETTE.map((entry) => entry.hex)).size, 6);
  for (const entry of MARKUP_PALETTE) assert.match(entry.hex, /^#[0-9a-f]{6}$/);
  assert.equal(markupColorHex("red"), "#ff0000");
});

// ---------------------------------------------------------------------------
// Stroke parsing
// ---------------------------------------------------------------------------

test("parseStrokes round-trips well-formed strokes", () => {
  const strokes = [stroke("red"), stroke("cyan", [0, 1000], 4)];
  assert.deepEqual(parseStrokes(JSON.stringify(strokes)), strokes);
});

test("parseStrokes returns nothing for empty, invalid or non-array JSON", () => {
  assert.deepEqual(parseStrokes(undefined), []);
  assert.deepEqual(parseStrokes(""), []);
  assert.deepEqual(parseStrokes("{not json"), []);
  assert.deepEqual(parseStrokes('{"color":"red"}'), []);
});

test("parseStrokes drops malformed strokes and keeps the rest", () => {
  const json = JSON.stringify([
    stroke("red"),
    stroke("purple"), // not in the palette
    { color: "blue", radius: 0, points: [1, 2] }, // non-positive radius
    { color: "blue", radius: "5", points: [1, 2] }, // non-number radius
    { color: "green", radius: 5, points: [1, 2, 3] }, // odd point count
    { color: "green", radius: 5, points: [] }, // no points
    { color: "green", radius: 5, points: [1, "2"] }, // non-number point
    null,
    "red",
    stroke("yellow"),
  ]);
  assert.deepEqual(parseStrokes(json).map((entry) => entry.color), ["red", "yellow"]);
});

test("parseStrokes clamps points to 0-1000 and the radius to 1000", () => {
  const [parsed] = parseStrokes(JSON.stringify([{ color: "red", radius: 5000, points: [-50, 1200, 500, 500] }]));
  assert.deepEqual(parsed.points, [0, 1000, 500, 500]);
  assert.equal(parsed.radius, 1000);
});

test("parseStrokes rejects non-finite numbers that JSON can carry as null", () => {
  assert.deepEqual(parseStrokes('[{"color":"red","radius":5,"points":[1,null]}]'), []);
});

// ---------------------------------------------------------------------------
// Instruction parsing
// ---------------------------------------------------------------------------

test("parseInstructions keeps only palette colours with string values", () => {
  const parsed = parseInstructions(JSON.stringify({ red: "swap the tile", purple: "nope", blue: 7, green: "" }));
  assert.deepEqual(parsed, { red: "swap the tile", green: "" });
});

test("parseInstructions tolerates empty, invalid and array JSON", () => {
  assert.deepEqual(parseInstructions(undefined), {});
  assert.deepEqual(parseInstructions("{oops"), {});
  assert.deepEqual(parseInstructions('["red"]'), {});
});

test("parseInstructions caps each instruction", () => {
  const parsed = parseInstructions(JSON.stringify({ red: "x".repeat(5000) }));
  assert.equal(parsed.red.length, 2000);
});

// ---------------------------------------------------------------------------
// Used colours
// ---------------------------------------------------------------------------

test("usedColors lists each drawn colour once, in palette order not draw order", () => {
  assert.deepEqual(usedColors([stroke("cyan"), stroke("red"), stroke("cyan"), stroke("blue")]), ["red", "blue", "cyan"]);
  assert.deepEqual(usedColors([]), []);
});

test("instructions for colours no longer drawn are kept but not listed as missing or emitted", () => {
  const instructions = { red: "warm oak floor", green: "left over from an undo" };
  assert.deepEqual(colorsMissingInstructions([stroke("red")], instructions), []);
  assert.doesNotMatch(buildMarkupPrompt([stroke("red")], instructions), /green/);
});

test("colorsMissingInstructions flags used colours whose instruction is blank or whitespace", () => {
  const strokes = [stroke("red"), stroke("blue"), stroke("yellow")];
  assert.deepEqual(colorsMissingInstructions(strokes, { red: "x", blue: "   " }), ["blue", "yellow"]);
});

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

test("buildMarkupPrompt writes one line per used colour in palette order, then the closing line", () => {
  const prompt = buildMarkupPrompt(
    [stroke("cyan"), stroke("red")],
    { red: "Replace the backsplash with green zellige", cyan: "  add a brass pendant light  " },
  );
  assert.equal(
    prompt,
    [
      "Inside the red marks: Replace the backsplash with green zellige.",
      "Inside the cyan marks: add a brass pendant light.",
      MARKUP_PROMPT_CLOSING,
    ].join("\n"),
  );
});

test("buildMarkupPrompt never doubles terminal punctuation", () => {
  const prompt = buildMarkupPrompt(
    [stroke("red"), stroke("blue"), stroke("green")],
    { red: "Remove the chair.", blue: "Make it brighter!", green: "Is this a window?" },
  );
  assert.match(prompt, /Inside the red marks: Remove the chair\.\n/);
  assert.match(prompt, /Inside the blue marks: Make it brighter!\n/);
  assert.match(prompt, /Inside the green marks: Is this a window\?\n/);
  assert.doesNotMatch(prompt, /\.\./);
});

test("buildMarkupPrompt collapses line breaks inside an instruction so each colour stays one line", () => {
  const prompt = buildMarkupPrompt([stroke("red")], { red: "swap the tile\nfor slate" });
  assert.equal(prompt.split("\n")[0], "Inside the red marks: swap the tile for slate.");
});

test("the closing line asks for the marks to be removed and the rest kept", () => {
  assert.match(MARKUP_PROMPT_CLOSING, /remove every drawn mark/);
  assert.match(MARKUP_PROMPT_CLOSING, /unchanged/);
});

test("buildMarkupPrompt refuses no strokes, no instructions, and any blank colour", () => {
  assert.throws(() => buildMarkupPrompt([], { red: "x" }), /Draw some markup/);
  assert.throws(() => buildMarkupPrompt([stroke("red")], {}), /Add an instruction for each colour/);
  assert.throws(
    () => buildMarkupPrompt([stroke("red"), stroke("blue"), stroke("cyan")], { red: "x" }),
    /Add an instruction for the blue, cyan marks/,
  );
});

// ---------------------------------------------------------------------------
// Manifest registration and import schema
// ---------------------------------------------------------------------------

test("Image Markup is registered, free, and takes one required image", () => {
  assert.ok(NODE_KINDS.includes("imageMarkup"));
  assert.equal(MANIFESTS.imageMarkup, imageMarkupManifest);
  assert.equal(paidMap.imageMarkup, false);
  assert.equal(imageMarkupManifest.execute, undefined, "execute is the DOM wrapper in imageMarkup.tsx");
  assert.deepEqual(
    imageMarkupManifest.spec.inputs.map((port) => [port.id, port.kind, Boolean(port.required)]),
    [["image", "image", true]],
  );
});

test("Image Markup outputs the Markup image first and the Prompt text second", () => {
  assert.deepEqual(
    imageMarkupManifest.spec.outputs.map((port) => [port.id, port.kind, port.label]),
    [["image", "image", "Markup"], ["text", "text", "Prompt"]],
  );
  assert.match(imageMarkupManifest.spec.description, /Markup port/);
  assert.match(imageMarkupManifest.spec.description, /Append/);
});

test("Image Markup can feed Image Edit's explicit-only Markup port and the Text node's Append port", () => {
  const markupPort = MANIFESTS.imageEdit.spec.inputs.find((port) => port.id === "markup");
  assert.equal(markupPort.kind, imageMarkupManifest.spec.outputs[0].kind);
  const appendPort = MANIFESTS.text.spec.inputs.find((port) => port.id === "append");
  assert.equal(appendPort.kind, imageMarkupManifest.spec.outputs[1].kind);
});

test("default params parse to an empty drawing", () => {
  const params = defaultParams("imageMarkup");
  assert.deepEqual(parseStrokes(params.strokes), []);
  assert.deepEqual(parseInstructions(params.instructions), {});
});

test("the import schema declares both params as capped strings and no blob keys", () => {
  const schema = importSchemaMap.imageMarkup;
  assert.deepEqual(Object.keys(schema.paramKeys).sort(), ["instructions", "strokes"]);
  assert.equal(schema.paramKeys.strokes.type, "string");
  assert.equal(schema.paramKeys.strokes.maxLength, MARKUP_STROKES_MAX_LENGTH);
  assert.equal(schema.paramKeys.instructions.type, "string");
  assert.ok(schema.paramKeys.instructions.maxLength >= 6 * 2000);
  assert.deepEqual(schema.sourceBlobKeys, []);
});

test("an exported Image Markup node imports with its strokes and instructions intact", () => {
  const params = {
    strokes: JSON.stringify([stroke("red")]),
    instructions: JSON.stringify({ red: "swap the tile" }),
  };
  const result = validateImport({
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: Date.now(),
    graphOnly: true,
    nodes: [{ id: "m1", kind: "imageMarkup", params, position: { x: 0, y: 0 } }],
    edges: [],
    images: {},
  });
  assert.equal(result.nodes.length, 1);
  assert.equal(result.nodes[0].params.strokes, params.strokes);
  assert.equal(result.nodes[0].params.instructions, params.instructions);
});
