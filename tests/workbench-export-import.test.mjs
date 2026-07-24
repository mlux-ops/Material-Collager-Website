import assert from "node:assert/strict";
import test from "node:test";

import {
  EXPORT_FORMAT,
  EXPORT_VERSION,
  ImportValidationError,
  MAX_IMPORT_EDGES,
  MAX_IMPORT_NODES,
  sniffImageFormat,
  stripDangerousKeys,
  validateImport,
} from "../app/components/workbench/export-import.ts";

// A real (tiny) PNG, base64-encoded: 1x1 transparent pixel.
const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const PNG_DATA_URL = `data:image/png;base64,${PNG_1PX}`;

function baseGraph(overrides = {}) {
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: Date.now(),
    graphOnly: false,
    nodes: [],
    edges: [],
    images: {},
    ...overrides,
  };
}

test("rejects a fundamentally malformed top-level shape", () => {
  assert.throws(() => validateImport(null), ImportValidationError);
  assert.throws(() => validateImport({ format: "not-a-workbench-export" }), ImportValidationError);
  assert.throws(() => validateImport("just a string"), ImportValidationError);
});

test("enforces node/edge count caps", () => {
  const nodes = Array.from({ length: MAX_IMPORT_NODES + 1 }, (_, i) => ({ id: `n${i}`, kind: "note", params: {}, position: { x: 0, y: 0 } }));
  assert.throws(() => validateImport(baseGraph({ nodes })), ImportValidationError);

  const edges = Array.from({ length: MAX_IMPORT_EDGES + 1 }, (_, i) => ({ id: `e${i}`, source: "a", target: "b" }));
  assert.throws(() => validateImport(baseGraph({ edges })), ImportValidationError);
});

test("drops unknown node kinds instead of rendering them", () => {
  const result = validateImport(
    baseGraph({
      nodes: [
        { id: "n1", kind: "evilInjectedNode", params: {}, position: { x: 0, y: 0 } },
        { id: "n2", kind: "note", params: { text: "hi" }, position: { x: 10, y: 10 } },
      ],
    }),
  );
  assert.equal(result.nodes.length, 1);
  assert.equal(result.nodes[0].kind, "note");
  assert.ok(result.warnings.some((w) => w.includes("unrecognized kind")));
});

test("strips __proto__/constructor/prototype at every nesting level and never pollutes Object.prototype", () => {
  const polluted = JSON.parse(
    '{"__proto__": {"polluted": true}, "a": {"__proto__": {"polluted": true}, "b": [{"constructor": {"polluted": true}, "prototype": {"polluted": true}, "c": 1}]}}',
  );
  const clean = stripDangerousKeys(polluted);
  assert.equal(({}).polluted, undefined);
  assert.equal(clean.__proto__, Object.prototype); // no OWN __proto__ property was ever assigned
  assert.equal(Object.prototype.hasOwnProperty.call(clean, "__proto__"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(clean.a, "__proto__"), false);
  assert.equal(clean.a.b[0].c, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(clean.a.b[0], "constructor"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(clean.a.b[0], "prototype"), false);
});

test("a __proto__ key anywhere in a node's params is stripped before validation, never merged in", () => {
  const raw = JSON.parse('{"format": "material-collager-workbench", "version": 1, "graphOnly": true, "images": {}, "edges": [], "nodes": [{"id": "n1", "kind": "note", "position": {"x":0,"y":0}, "params": {"text": "safe", "__proto__": {"polluted": true}}}]}');
  const result = validateImport(raw);
  assert.equal(({}).polluted, undefined);
  assert.equal(result.nodes[0].params.text, "safe");
});

test("rejects keys not declared in the node's own importSchema, keeps optional-and-absent params fine", () => {
  const result = validateImport(
    baseGraph({
      nodes: [
        {
          id: "n1",
          kind: "note",
          position: { x: 0, y: 0 },
          params: { text: "kept", savedJobId: "should-not-exist-on-note", evilField: "drop-me" },
        },
      ],
    }),
  );
  const params = result.nodes[0].params;
  assert.equal(params.text, "kept");
  assert.equal("savedJobId" in params, false);
  assert.equal("evilField" in params, false);
});

test("optional declared params absent still import fine (defaults fill in)", () => {
  const result = validateImport(
    baseGraph({
      nodes: [{ id: "n1", kind: "imageEdit", position: { x: 0, y: 0 }, params: {} }],
    }),
  );
  assert.equal(result.nodes.length, 1);
  assert.equal(typeof result.nodes[0].params.size, "string"); // defaultParams filled it in
});

test("rejects invalid enum/number values for a declared key rather than trusting them", () => {
  const result = validateImport(
    baseGraph({
      nodes: [
        { id: "n1", kind: "imageEdit", position: { x: 0, y: 0 }, params: { quality: "ultra-mega", candidates: 999 } },
      ],
    }),
  );
  const params = result.nodes[0].params;
  assert.notEqual(params.quality, "ultra-mega");
  assert.notEqual(params.candidates, 999);
});

test("sniffs real magic bytes and rejects SVG/mislabeled/non-data-URL images", () => {
  assert.equal(sniffImageFormat(Uint8Array.from(atob(PNG_1PX), (c) => c.charCodeAt(0))), "png");

  const svgAsDataUrl = `data:image/svg+xml;base64,${Buffer.from("<svg onload=alert(1)></svg>").toString("base64")}`;
  const svgLabeledPng = `data:image/png;base64,${Buffer.from("<svg onload=alert(1)></svg>").toString("base64")}`;
  const graph = baseGraph({
    nodes: [{ id: "photo-1", kind: "photo", position: { x: 0, y: 0 }, params: {} }],
    images: {
      "photo-1:src": svgAsDataUrl,
      legit: PNG_DATA_URL,
    },
  });
  const result = validateImport(graph);
  // The declared-svg image is rejected outright (bad prefix), the mislabeled
  // one (if it were keyed in) would fail the magic-byte sniff too.
  assert.equal(result.images.length, 0);
  assert.ok(result.warnings.some((w) => w.includes("Skipped an embedded image")));

  const decodedSniff = sniffImageFormat(Buffer.from(svgLabeledPng.split(",")[1], "base64"));
  assert.equal(decodedSniff, null);

  assert.equal(
    validateImport(baseGraph({ images: { x: "javascript:alert(1)" } })).warnings.some((w) => w.includes("Skipped an embedded image")),
    true,
  );
  assert.equal(
    validateImport(baseGraph({ images: { x: "https://evil.example.com/x.png" } })).warnings.some((w) => w.includes("Skipped an embedded image")),
    true,
  );
});

test("photo node re-adopts its own embedded image under a freshly remapped key, mints a new id", () => {
  const graph = baseGraph({
    nodes: [{ id: "photo-old-1", kind: "photo", position: { x: 5, y: 5 }, params: { fileName: "wall.png" } }],
    images: { "photo-old-1:src": PNG_DATA_URL },
  });
  const result = validateImport(graph);
  assert.equal(result.nodes.length, 1);
  assert.notEqual(result.nodes[0].id, "photo-old-1"); // ids are always re-minted
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].key, `${result.nodes[0].id}:src`);
  assert.equal(result.images[0].mimeType, "image/png");
});

test("a node cannot claim another node's blob key (ownership prefix enforced)", () => {
  const graph = baseGraph({
    nodes: [
      { id: "masked-a", kind: "maskedEdit", position: { x: 0, y: 0 }, params: { maskCacheKey: "photo-old-1:src" } },
      { id: "photo-old-1", kind: "photo", position: { x: 0, y: 0 }, params: {} },
    ],
    images: { "photo-old-1:src": PNG_DATA_URL },
  });
  const result = validateImport(graph);
  const masked = result.nodes.find((n) => n.kind === "maskedEdit");
  // defaultParams always fills maskCacheKey in (as ""); the leaked foreign
  // key must never have survived into it.
  assert.notEqual(masked.params.maskCacheKey, "photo-old-1:src");
  assert.equal(masked.params.maskCacheKey, "");
});

test("referenceItemList: sanitizes item metadata, caps counts, remaps nested imageKeys, drops unresolvable ones", () => {
  const graph = baseGraph({
    nodes: [
      {
        id: "refs-1",
        kind: "references",
        position: { x: 0, y: 0 },
        params: {
          referenceItems: [
            { id: "item-1", role: "wood", imageKeys: ["refs-1:ref:item-1:0", "someone-elses-node:src"], __proto__: { polluted: true } },
            { role: "stone", imageKeys: [] },
          ],
        },
      },
    ],
    images: { "refs-1:ref:item-1:0": PNG_DATA_URL },
  });
  const result = validateImport(graph);
  assert.equal(({}).polluted, undefined);
  const items = result.nodes[0].params.referenceItems;
  assert.equal(items.length, 2);
  assert.equal(items[0].role, "wood");
  assert.equal(items[0].imageKeys.length, 1);
  assert.ok(items[0].imageKeys[0].endsWith(":ref:item-1:0"));
  assert.notEqual(items[0].imageKeys[0], "refs-1:ref:item-1:0"); // remapped to the new node id
  assert.ok(items[1].id); // missing id was synthesized
});

test("edges: unknown node references, invalid/missing ports, kind mismatches, and cycles are all dropped", () => {
  const graph = baseGraph({
    nodes: [
      { id: "photo-1", kind: "photo", position: { x: 0, y: 0 }, params: {} },
      { id: "text-1", kind: "text", position: { x: 0, y: 0 }, params: { text: "prompt" } },
      { id: "edit-1", kind: "imageEdit", position: { x: 0, y: 0 }, params: {} },
    ],
    edges: [
      { id: "e1", source: "photo-1", target: "ghost-node", sourceHandle: "image", targetHandle: "image" },
      { id: "e2", source: "photo-1", target: "edit-1", sourceHandle: "image", targetHandle: "image" },
      { id: "e3", source: "text-1", target: "edit-1", sourceHandle: "not-a-real-port", targetHandle: "prompt" },
      { id: "e4", source: "text-1", target: "edit-1", sourceHandle: "text", targetHandle: "image" }, // kind mismatch (text -> image)
      { id: "e5", source: "edit-1", target: "photo-1", sourceHandle: "image", targetHandle: "image" }, // would cycle back to photo-1 (no input port anyway)
    ],
  });
  const result = validateImport(graph);
  // Only the valid photo -> imageEdit(image) edge should survive.
  assert.equal(result.edges.length, 1);
  const photoId = result.nodes.find((n) => n.kind === "photo").id;
  const editId = result.nodes.find((n) => n.kind === "imageEdit").id;
  assert.equal(result.edges[0].source, photoId);
  assert.equal(result.edges[0].target, editId);
});

test("total decoded-byte cap and per-image byte cap both drop offending images without throwing", () => {
  const hugeButValidPngBytes = Buffer.concat([Buffer.from(atob(PNG_1PX), "binary"), Buffer.alloc(60 * 1024 * 1024, 1)]);
  const oversizedDataUrl = `data:image/png;base64,${hugeButValidPngBytes.toString("base64")}`;
  const result = validateImport(
    baseGraph({
      nodes: [{ id: "photo-1", kind: "photo", position: { x: 0, y: 0 }, params: {} }],
      images: { "photo-1:src": oversizedDataUrl },
    }),
  );
  assert.equal(result.images.length, 0);
  assert.ok(result.warnings.some((w) => w.includes("Skipped an embedded image")));
});

test("graph-only import (no images map) still imports node structure/params cleanly", () => {
  const result = validateImport(
    baseGraph({
      graphOnly: true,
      images: {},
      nodes: [
        { id: "refs-1", kind: "references", position: { x: 0, y: 0 }, params: { referenceItems: [{ id: "a", role: "wood", imageKeys: ["refs-1:ref:a:0"] }] } },
      ],
    }),
  );
  assert.equal(result.images.length, 0);
  assert.equal(result.nodes[0].params.referenceItems[0].imageKeys.length, 0); // no image data available to resolve
  assert.equal(result.nodes[0].params.referenceItems[0].role, "wood"); // metadata still preserved
});
