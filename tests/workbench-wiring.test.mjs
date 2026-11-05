import assert from "node:assert/strict";
import test from "node:test";

import { defaultParams, specFor } from "../app/components/workbench/nodes/manifests.ts";
import {
  autoAttachConnection,
  compatiblePorts,
  connectionIsValid,
  nodeKindsForWire,
} from "../app/components/workbench/wiring.ts";

// Fixture nodes carry the kind's real default params (activeOutputPortsFor
// reads them -- Variations' separateOutputs decides which outputs are live),
// with per-test overrides layered on top.
function node(id, kind, params = {}) {
  return {
    id,
    type: kind,
    position: { x: 0, y: 0 },
    data: { kind, params: { ...defaultParams(kind), ...params }, status: "idle", runs: [], activeRun: 0 },
  };
}

function edge(source, sourceHandle, target, targetHandle) {
  return { id: `${source}.${sourceHandle}->${target}.${targetHandle}`, source, sourceHandle, target, targetHandle };
}

function wire(source, sourceHandle, target, targetHandle) {
  return { source, sourceHandle, target, targetHandle };
}

const fromOutput = (nodeId, handleId) => ({ nodeId, handleId, handleType: "source" });
const fromInput = (nodeId, handleId) => ({ nodeId, handleId, handleType: "target" });

test("connectionIsValid refuses a kind mismatch", () => {
  const nodes = [node("text", "text"), node("photo", "photo"), node("edit", "imageEdit")];
  assert.equal(connectionIsValid(nodes, [], wire("text", "text", "edit", "image")), false, "text cannot feed an image input");
  assert.equal(connectionIsValid(nodes, [], wire("photo", "image", "edit", "prompt")), false, "an image cannot feed a text input");
  assert.equal(connectionIsValid(nodes, [], wire("photo", "image", "edit", "image")), true);
});

test("connectionIsValid honours acceptedKinds: a references bundle reaches Image Edit's References port, not its Image port", () => {
  const nodes = [node("refs", "references"), node("photo", "photo"), node("edit", "imageEdit")];
  assert.equal(connectionIsValid(nodes, [], wire("refs", "references", "edit", "references")), true);
  assert.equal(connectionIsValid(nodes, [], wire("photo", "image", "edit", "references")), true, "the port's own kind is still accepted");
  assert.equal(connectionIsValid(nodes, [], wire("refs", "references", "edit", "image")), false, "Image takes only its declared kind");
});

test("connectionIsValid refuses a self-wire and unknown handles", () => {
  const nodes = [node("crop", "crop"), node("photo", "photo")];
  assert.equal(connectionIsValid(nodes, [], wire("crop", "image", "crop", "image")), false);
  assert.equal(connectionIsValid(nodes, [], wire("photo", "missing", "crop", "image")), false);
  assert.equal(connectionIsValid(nodes, [], wire("photo", "image", "crop", "missing")), false);
});

test("connectionIsValid refuses a wire that would close a cycle", () => {
  const nodes = [node("photo", "photo"), node("editA", "imageEdit"), node("editB", "imageEdit")];
  const edges = [edge("photo", "image", "editA", "image"), edge("editA", "image", "editB", "image")];
  assert.equal(connectionIsValid(nodes, edges, wire("editB", "image", "editA", "references")), false);
  assert.equal(connectionIsValid(nodes, edges, wire("editA", "image", "editB", "references")), true, "the same pair in flow order is fine");
});

test("nodeKindsForWire still derives the empty-canvas prompt's kinds from the registry", () => {
  const portOf = (kind, side, id) => specFor(kind)[side].find((port) => port.id === id);
  const forReferences = nodeKindsForWire("source", portOf("references", "outputs", "references"));
  assert.ok(forReferences.includes("imageEdit"), "Image Edit's References port accepts a references bundle");
  assert.ok(!forReferences.includes("compare"), "Compare takes plain images only");
  assert.ok(nodeKindsForWire("target", portOf("patch", "inputs", "region")).includes("crop"), "Crop's Region output is the mask source");
  // Backwards from an input, every kind the input ACCEPTS counts, not only its
  // declared one: Image Edit's References input (declared image, accepts
  // references too) offers the References node.
  const intoEditReferences = nodeKindsForWire("target", portOf("imageEdit", "inputs", "references"));
  assert.ok(intoEditReferences.includes("references"), "a references bundle can feed Image Edit's References input");
  assert.ok(intoEditReferences.includes("photo"), "so can a plain image");
  assert.ok(!nodeKindsForWire("target", portOf("imageEdit", "inputs", "image")).includes("references"), "Image Edit's Image input takes plain images only");
});

test("autoAttachConnection prefers an empty single port, then a multi port, then an occupied single port", () => {
  const nodes = [node("photo", "photo"), node("other", "photo"), node("edit", "imageEdit")];

  // Tier 1: Image is single and empty -- it beats the multi References port
  // even though both accept an image.
  assert.deepEqual(
    autoAttachConnection(nodes, [], fromOutput("photo", "image"), "edit"),
    wire("photo", "image", "edit", "image"),
  );

  // Tier 2: with Image already wired, appending to References disturbs
  // nothing, so it beats replacing Image's wire.
  const imageTaken = [edge("other", "image", "edit", "image")];
  assert.deepEqual(
    autoAttachConnection(nodes, imageTaken, fromOutput("photo", "image"), "edit"),
    wire("photo", "image", "edit", "references"),
  );
});

test("autoAttachConnection keeps declared order within a tier and falls back to replacing an occupied single port", () => {
  const nodes = [node("photo", "photo"), node("x", "photo"), node("y", "photo"), node("compare", "compare")];
  assert.deepEqual(
    autoAttachConnection(nodes, [], fromOutput("photo", "image"), "compare"),
    wire("photo", "image", "compare", "a"),
    "both A and B are empty singles: declared order picks A",
  );
  assert.deepEqual(
    autoAttachConnection(nodes, [edge("x", "image", "compare", "a")], fromOutput("photo", "image"), "compare"),
    wire("photo", "image", "compare", "b"),
    "A is taken, B is the empty single",
  );
  assert.deepEqual(
    autoAttachConnection(
      nodes,
      [edge("x", "image", "compare", "a"), edge("y", "image", "compare", "b")],
      fromOutput("photo", "image"),
      "compare",
    ),
    wire("photo", "image", "compare", "a"),
    "both taken and no multi port: replace the first, as dropping on that handle would",
  );
});

test("autoAttachConnection routes by kind: a text wire lands on Prompt, not on an image port", () => {
  const nodes = [node("text", "text"), node("edit", "imageEdit")];
  assert.deepEqual(
    autoAttachConnection(nodes, [], fromOutput("text", "text"), "edit"),
    wire("text", "text", "edit", "prompt"),
  );
});

test("autoAttachConnection, dragged backwards from an input, picks the first valid visible output", () => {
  const nodes = [
    node("edit", "imageEdit"),
    node("variations", "variations"),
    node("revealed", "variations", { separateOutputs: true, n: 3 }),
    node("builder", "promptBuilder"),
  ];
  assert.deepEqual(
    autoAttachConnection(nodes, [], fromInput("edit", "image"), "variations"),
    wire("variations", "image", "edit", "image"),
  );
  assert.deepEqual(
    autoAttachConnection(nodes, [], fromInput("edit", "image"), "revealed"),
    wire("revealed", "image", "edit", "image"),
    "revealed variation-N handles never outrank the aggregate image output",
  );
  // Prompt Builder declares Prompt (text) then References (references); a
  // drag back from Image Edit's References port skips the text output.
  assert.deepEqual(
    autoAttachConnection(nodes, [], fromInput("edit", "references"), "builder"),
    wire("builder", "references", "edit", "references"),
  );
});

test("autoAttachConnection returns null for the origin card, an incompatible card, and a card whose only candidates would close a cycle", () => {
  const nodes = [
    node("photo", "photo"),
    node("text", "text"),
    node("compare", "compare"),
    node("editA", "imageEdit"),
    node("editB", "imageEdit"),
  ];
  const edges = [edge("photo", "image", "editA", "image"), edge("editA", "image", "editB", "image")];

  assert.equal(autoAttachConnection(nodes, edges, fromOutput("editA", "image"), "editA"), null, "same node");
  assert.equal(autoAttachConnection(nodes, edges, fromOutput("text", "text"), "compare"), null, "Compare has no text input");
  assert.equal(autoAttachConnection(nodes, edges, fromOutput("text", "text"), "photo"), null, "Photo has no inputs at all");
  assert.equal(autoAttachConnection(nodes, edges, fromInput("editA", "prompt"), "photo"), null, "Photo has no text output");
  // editB descends from editA, so each of editA's image-accepting inputs
  // (Image, References) would close a loop; Prompt is the wrong kind.
  assert.equal(autoAttachConnection(nodes, edges, fromOutput("editB", "image"), "editA"), null, "cycle");
  assert.equal(autoAttachConnection(nodes, edges, fromOutput("photo", "image"), "missing"), null, "unknown node");
});

test("autoAttachConnection never fills Image Edit's explicit-only Markup port", () => {
  const nodes = [node("photo", "photo"), node("a", "photo"), node("b", "photo"), node("edit", "imageEdit")];
  // Image and References taken: a dropped photo appends to References (or
  // would replace Image) -- it never becomes the annotation layer.
  const wired = [edge("a", "image", "edit", "image"), edge("b", "image", "edit", "references")];
  const attached = autoAttachConnection(nodes, wired, fromOutput("photo", "image"), "edit");
  assert.notEqual(attached?.targetHandle, "markup");
  assert.equal(attached?.targetHandle, "references");
});

test("compatiblePorts lists exactly the ports the drag highlighting lights up", () => {
  const nodes = [node("photo", "photo"), node("edit", "imageEdit"), node("variations", "variations"), node("text", "text")];
  assert.deepEqual(
    compatiblePorts(nodes, [], fromOutput("photo", "image"), nodes[1]).map((port) => port.id),
    // Markup lights up too: it takes a wire dropped on its own handle, it is
    // just never auto-attached (see the explicitOnly test below).
    ["image", "references", "markup"],
  );
  assert.deepEqual(compatiblePorts(nodes, [], fromOutput("photo", "image"), nodes[0]), [], "the origin card offers nothing");
  assert.deepEqual(compatiblePorts(nodes, [], fromOutput("photo", "image"), nodes[3]).map((port) => port.id), [], "Text has no image input");
  assert.deepEqual(
    compatiblePorts(nodes, [], fromInput("edit", "prompt"), nodes[3]).map((port) => port.id),
    ["text"],
    "a backward drag looks at the card's outputs",
  );
});
