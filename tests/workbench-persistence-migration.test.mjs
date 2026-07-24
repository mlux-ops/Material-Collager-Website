import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_GRAPH_NAME, migrateBlobKey, migrateV1Record } from "../app/components/workbench/persistence.ts";

// PURE key-mapping only (W4 — Node has no IndexedDB). The real
// onupgradeneeded upgrade-transaction behavior (atomicity, no orphaned legacy
// keys against a populated real-world v1 database) is a manual/Browser QA
// gate (S32), not something a Node test can exercise.

test("migrateBlobKey maps a legacy (unnamespaced) blob-cache key to the namespaced v2 storage key", () => {
  assert.equal(migrateBlobKey("photo-1:src", "graph-abc"), "blob:graph-abc:photo-1%3Asrc");
});

test("migrateBlobKey encodes special characters in the cache key so it can never collide across graphs", () => {
  const key = migrateBlobKey("node-1:ref:item-1:0", "graph-xyz");
  assert.equal(key, `blob:graph-xyz:${encodeURIComponent("node-1:ref:item-1:0")}`);
  // Two different graphIds for the SAME logical cache key never collide.
  const otherGraph = migrateBlobKey("node-1:ref:item-1:0", "graph-other");
  assert.notEqual(key, otherGraph);
});

test("migrateBlobKey is a pure function: identical inputs always produce identical output", () => {
  const a = migrateBlobKey("photo-1:src", "graph-1");
  const b = migrateBlobKey("photo-1:src", "graph-1");
  assert.equal(a, b);
});

test("migrateV1Record moves the singleton v1 graph into a named v2 graph record + meta index entry", () => {
  const v1 = {
    version: 1,
    savedAt: 1_700_000_000_000,
    nodes: [
      { id: "photo-1", kind: "photo", params: { fileName: "wall.png" }, position: { x: 10, y: 20 }, blobKeys: ["photo-1:src"] },
      { id: "text-1", kind: "text", params: { text: "prompt" }, position: { x: 100, y: 20 } },
    ],
    edges: [{ id: "e1", source: "photo-1", target: "text-1", sourceHandle: "image", targetHandle: "image" }],
  };
  const { graph, meta } = migrateV1Record(v1, "graph-default");

  assert.equal(graph.version, 2);
  assert.equal(graph.id, "graph-default");
  assert.equal(graph.savedAt, v1.savedAt);
  assert.equal(graph.nodes.length, 2);
  assert.deepEqual(graph.edges, v1.edges);
  // Node/edge/param data carries over unchanged — only blob storage keys get
  // namespaced elsewhere (by the caller, via migrateBlobKey per key).
  assert.equal(graph.nodes[0].id, "photo-1");
  assert.deepEqual(graph.nodes[0].params, { fileName: "wall.png" });
  assert.deepEqual(graph.nodes[0].blobKeys, ["photo-1:src"]);
  assert.equal(graph.nodes[1].id, "text-1");

  assert.equal(meta.id, "graph-default");
  assert.equal(meta.name, DEFAULT_GRAPH_NAME);
  assert.equal(meta.savedAt, v1.savedAt);
  assert.equal(meta.nodeCount, 2);
});

test("migrateV1Record preserves the legacy hasPhoto fallback flag verbatim (no data loss for pre-persistBlobKeys graphs)", () => {
  const v1 = {
    version: 1,
    savedAt: 1,
    nodes: [{ id: "photo-1", kind: "photo", params: {}, position: { x: 0, y: 0 }, hasPhoto: true }],
    edges: [],
  };
  const { graph } = migrateV1Record(v1, "g1");
  assert.equal(graph.nodes[0].hasPhoto, true);
});

test("migrateV1Record on an empty v1 graph produces an empty (not crashing) v2 graph + meta record", () => {
  const { graph, meta } = migrateV1Record({ version: 1, savedAt: 5, nodes: [], edges: [] }, "g-empty");
  assert.deepEqual(graph.nodes, []);
  assert.deepEqual(graph.edges, []);
  assert.equal(meta.nodeCount, 0);
});
