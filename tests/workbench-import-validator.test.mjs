import assert from "node:assert/strict";
import test from "node:test";

import { EXPORT_FORMAT, EXPORT_VERSION, ImportValidationError, validateImport } from "../app/components/workbench/export-import.ts";
import { importSchemaMap, NODE_KINDS } from "../app/components/workbench/nodes/manifests.ts";

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

test("the allowlist of importable node kinds is derived from the manifest registry, not a separate hand-maintained list", () => {
  // importSchemaMap is keyed by every NodeKind the registry knows about — the
  // validator's "unknown kind" rejection reads exactly this map, so there is
  // no second allowlist to fall out of sync with new node types.
  for (const kind of NODE_KINDS) {
    assert.ok(importSchemaMap[kind], `${kind} must have a registry-declared importSchema`);
  }
  const result = validateImport(
    baseGraph({ nodes: [{ id: "n1", kind: "totallyMadeUpKind", params: {}, position: { x: 0, y: 0 } }] }),
  );
  assert.equal(result.nodes.length, 0);
  assert.ok(result.warnings.some((w) => w.includes("unrecognized kind")));
});

test("every declared NodeKind round-trips an empty-params import cleanly (schema-driven defaults fill required/optional gaps)", () => {
  for (const kind of NODE_KINDS) {
    const result = validateImport(baseGraph({ nodes: [{ id: `n-${kind}`, kind, params: {}, position: { x: 1, y: 2 } }] }));
    assert.equal(result.nodes.length, 1, `${kind}: an empty-params node of a known kind must always import`);
    assert.equal(result.nodes[0].kind, kind);
  }
});

test("a key not declared in the node's importSchema is rejected even when it matches another kind's declared key", () => {
  // "targetWidth" is declared for resize but not for note.
  const result = validateImport(
    baseGraph({ nodes: [{ id: "n1", kind: "note", params: { text: "hi", targetWidth: 999 }, position: { x: 0, y: 0 } }] }),
  );
  assert.equal(result.nodes[0].params.text, "hi");
  assert.equal("targetWidth" in result.nodes[0].params, false);
});

test("an OPTIONAL declared param that is simply absent imports fine (validateImport fills it from defaultParams, not an error)", () => {
  const result = validateImport(
    baseGraph({ nodes: [{ id: "n1", kind: "resize", params: {}, position: { x: 0, y: 0 } }] }),
  );
  assert.equal(result.nodes.length, 1);
  assert.equal(result.nodes[0].params.targetWidth, 1536); // resize's defaultParams value, not an imported override
});

test("__proto__/constructor/prototype keys anywhere in an imported node's params never pollute Object.prototype, at any nesting depth", () => {
  const raw = JSON.parse(
    '{"format":"material-collager-workbench","version":1,"graphOnly":true,"images":{},"edges":[],"nodes":[{"id":"n1","kind":"references","position":{"x":0,"y":0},"params":{"referenceItems":[{"id":"a","role":"wood","imageKeys":[],"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}]}}]}',
  );
  const before = {}.polluted;
  const result = validateImport(raw);
  assert.equal(before, undefined);
  assert.equal({}.polluted, undefined);
  assert.equal(result.nodes[0].params.referenceItems[0].role, "wood");
});

test("SVG data URLs, javascript: URLs, and remote (non-data:) URLs are all rejected as images regardless of node kind", () => {
  const svg = `data:image/svg+xml;base64,${Buffer.from("<svg onload=alert(1)></svg>").toString("base64")}`;
  for (const badUrl of [svg, "javascript:alert(1)", "https://evil.example.com/x.png", "not-a-url-at-all"]) {
    const result = validateImport(
      baseGraph({ nodes: [{ id: "photo-1", kind: "photo", position: { x: 0, y: 0 }, params: {} }], images: { "photo-1:src": badUrl } }),
    );
    assert.equal(result.images.length, 0, badUrl);
  }
});

test("a valid PNG under the per-image byte cap and total cap survives; an oversized one is dropped without throwing", () => {
  const okResult = validateImport(
    baseGraph({ nodes: [{ id: "photo-1", kind: "photo", position: { x: 0, y: 0 }, params: {} }], images: { "photo-1:src": PNG_DATA_URL } }),
  );
  assert.equal(okResult.images.length, 1);
  assert.equal(okResult.images[0].mimeType, "image/png");

  const oversized = Buffer.concat([Buffer.from(atob(PNG_1PX), "binary"), Buffer.alloc(60 * 1024 * 1024, 7)]);
  const oversizedResult = validateImport(
    baseGraph({
      nodes: [{ id: "photo-1", kind: "photo", position: { x: 0, y: 0 }, params: {} }],
      images: { "photo-1:src": `data:image/png;base64,${oversized.toString("base64")}` },
    }),
  );
  assert.equal(oversizedResult.images.length, 0);
});

test("node/edge count caps throw ImportValidationError rather than silently truncating", () => {
  const nodes = Array.from({ length: 301 }, (_, i) => ({ id: `n${i}`, kind: "note", params: {}, position: { x: 0, y: 0 } }));
  assert.throws(() => validateImport(baseGraph({ nodes })), ImportValidationError);
});

test("a round trip (validate, then re-validate the already-validated output as fresh input) is stable / idempotent", () => {
  const graph = baseGraph({
    nodes: [
      { id: "photo-1", kind: "photo", position: { x: 3, y: 4 }, params: { fileName: "a.png" } },
      { id: "resize-1", kind: "resize", position: { x: 10, y: 10 }, params: { targetWidth: 800, targetHeight: 600 } },
    ],
    edges: [{ id: "e1", source: "photo-1", target: "resize-1", sourceHandle: "image", targetHandle: "image" }],
    images: { "photo-1:src": PNG_DATA_URL },
  });
  const first = validateImport(graph);
  const asExport = baseGraph({
    nodes: first.nodes,
    edges: first.edges,
    images: Object.fromEntries(first.images.map((img) => [img.key, `data:${img.mimeType};base64,${Buffer.from(img.bytes).toString("base64")}`])),
  });
  const second = validateImport(asExport);
  assert.equal(second.nodes.length, first.nodes.length);
  assert.equal(second.edges.length, first.edges.length);
  assert.equal(second.images.length, first.images.length);
  assert.deepEqual(second.nodes.find((n) => n.kind === "resize").params.targetWidth, 800);
});
