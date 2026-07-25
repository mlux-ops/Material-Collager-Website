import assert from "node:assert/strict";
import test from "node:test";

import {
  BlockedUpgradeError,
  dataUrlToBlob,
  decidePendingSave,
  DEFAULT_GRAPH_NAME,
  graphThumbnailSource,
  graphThumbnailStorageKey,
  migrateBlobKey,
  migrateV1Record,
  rejectTransactionFailures,
  withoutLegacyThumbnail,
} from "../app/components/workbench/persistence.ts";

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

// issue-2/AC17: a v1 database never had ANY thumbnail concept -- a migrated
// record must carry neither the blob-keyed field nor the legacy inline one,
// and that must still be a VALID GraphMeta shape (records without
// thumbnails stay valid), not a crash or a forced-blank placeholder field.
test("migrateV1Record's meta carries neither thumbnail field (a v1 record never had a thumbnail; both stay validly absent)", () => {
  const v1 = {
    version: 1,
    savedAt: 1,
    nodes: [{ id: "photo-1", kind: "photo", params: {}, position: { x: 0, y: 0 } }],
    edges: [],
  };
  const { meta } = migrateV1Record(v1, "g1");
  assert.equal("thumbnailKey" in meta, false);
  assert.equal("thumbnail" in meta, false);
  assert.equal(graphThumbnailSource(meta).kind, "none");
});

// issue-2/AC17: the graph-list thumbnail's namespaced blob-storage key mapping
// (`blob:<graphId>:graph-thumbnail`, via the SAME blobStorageKey convention
// every other SOURCE/OUTPUT blob uses -- see migrateBlobKey's own tests
// above for that shared convention). Reusing it means deleteGraph's existing
// generic `blob:<graphId>:*` prefix sweep deletes this blob for free too.
test("graphThumbnailStorageKey namespaces a graph's thumbnail blob the same way migrateBlobKey namespaces any other blob-cache key, and never collides across graphs", () => {
  const key = graphThumbnailStorageKey("graph-abc");
  assert.equal(key, "blob:graph-abc:graph-thumbnail");
  assert.equal(key, migrateBlobKey("graph-thumbnail", "graph-abc"), "must use the identical blob:<graphId>:<key> convention every other blob-cache key uses");

  const otherGraph = graphThumbnailStorageKey("graph-xyz");
  assert.notEqual(key, otherGraph, "two different graphs' thumbnail keys must never collide");
});

test("graphThumbnailStorageKey is a pure function: identical graphId always produces identical output", () => {
  assert.equal(graphThumbnailStorageKey("graph-1"), graphThumbnailStorageKey("graph-1"));
});

// issue-2/AC17: the "meta shape" decision GraphManager renders from --
// prefers the blob-keyed thumbnail, tolerates a legacy-only record read-only,
// and both-absent means nothing to show. Verified directly, independent of
// any real IndexedDB/Blob/React rendering.
test("graphThumbnailSource prefers the blob-keyed thumbnail (thumbnailKey) when present, even alongside a stale legacy field", () => {
  const source = graphThumbnailSource({ thumbnailKey: "graph-thumbnail", thumbnail: "data:image/jpeg;base64,AAAA" });
  assert.deepEqual(source, { kind: "key", key: "graph-thumbnail" });
});

test("graphThumbnailSource tolerates a legacy-only record (thumbnailKey absent, thumbnail present) read-only", () => {
  const source = graphThumbnailSource({ thumbnail: "data:image/jpeg;base64,AAAA" });
  assert.deepEqual(source, { kind: "legacy", dataUrl: "data:image/jpeg;base64,AAAA" });
});

test("graphThumbnailSource is 'none' when a GraphMeta record has neither thumbnail field (records without thumbnails stay valid)", () => {
  assert.deepEqual(graphThumbnailSource({}), { kind: "none" });
  assert.deepEqual(graphThumbnailSource({ thumbnailKey: undefined, thumbnail: undefined }), { kind: "none" });
});

// issue-1: WorkbenchApp.tsx's graph-switch flush must never perform a
// redundant DOUBLE save -- saveGraph (the "full" save) already rewrites the
// structure record in the same transaction, so a pending blob-save must
// take priority and a separately-pending structure-save becomes moot, not
// an ADDITIONAL call. This is the exact decision that used to be able to
// silently lose (or, if implemented naively, double-write) a pending
// change when a graph switch/create reloaded the page mid-debounce.
test("decidePendingSave never asks for both saves at once (no double-save): a pending blob-save alone is enough", () => {
  assert.equal(decidePendingSave(false, true), "full");
  assert.equal(decidePendingSave(true, true), "full", "a pending structure-save must NOT also fire when a full save already covers it");
});

test("decidePendingSave performs the lighter structure-only save when only the structure autosave is pending", () => {
  assert.equal(decidePendingSave(true, false), "structure");
});

test("decidePendingSave is a no-op flush when nothing is pending (the common case: switching graphs with no recent edits incurs no extra save)", () => {
  assert.equal(decidePendingSave(false, false), "none");
});

// N-18: previously only onerror was wired on every transaction in
// persistence.ts, so a transaction that ABORTS with no preceding request
// error (an explicit abort(), or the connection force-closed by another
// tab's versionchange upgrade) left its promise pending FOREVER -- and,
// since round 5 made switchGraph `await` a save before it can navigate, that
// would now wedge the whole graph-switch UI indefinitely. These tests
// exercise rejectTransactionFailures directly against duck-typed
// transaction/db stand-ins (no real IndexedDB needed -- the function only
// ever reads transaction.error and calls db.close()/the two setters).

function fakeTransaction(error = null) {
  return { error, onerror: null, onabort: null };
}

function fakeDb() {
  const closedCalls = [];
  return { closedCalls, close: () => closedCalls.push(true) };
}

test("rejectTransactionFailures wires both onerror and onabort as functions", () => {
  const transaction = fakeTransaction();
  rejectTransactionFailures(transaction, fakeDb(), () => {}, "message");
  assert.equal(typeof transaction.onerror, "function");
  assert.equal(typeof transaction.onabort, "function");
});

test("rejectTransactionFailures's onabort handler closes the connection and rejects with the fallback message when transaction.error is unset -- the exact case (an abort with no preceding request error) that previously hung forever", () => {
  const transaction = fakeTransaction(null);
  const db = fakeDb();
  let rejectedWith;
  rejectTransactionFailures(transaction, db, (reason) => { rejectedWith = reason; }, "Could not save the workbench graph.");

  transaction.onabort();

  assert.equal(db.closedCalls.length, 1, "the connection must be closed on abort, not left open");
  assert.ok(rejectedWith instanceof Error, "abort with no preceding error must still reject, not hang forever");
  assert.equal(rejectedWith.message, "Could not save the workbench graph.");
});

test("rejectTransactionFailures's onerror handler behaves identically to onabort (same close + reject contract)", () => {
  const transaction = fakeTransaction(null);
  const db = fakeDb();
  let rejectedWith;
  rejectTransactionFailures(transaction, db, (reason) => { rejectedWith = reason; }, "Could not load the workbench graph.");

  transaction.onerror();

  assert.equal(db.closedCalls.length, 1);
  assert.equal(rejectedWith.message, "Could not load the workbench graph.");
});

test("rejectTransactionFailures prefers the browser-supplied transaction.error over the fallback message when one is present", () => {
  const specificError = new Error("QuotaExceededError");
  const transaction = fakeTransaction(specificError);
  let rejectedWith;
  rejectTransactionFailures(transaction, fakeDb(), (reason) => { rejectedWith = reason; }, "generic fallback message");

  transaction.onabort();

  assert.equal(rejectedWith, specificError, "a specific browser-supplied error must not be masked by the generic fallback");
});

// round 7 issue-1: WorkbenchApp.tsx's restore path must treat a
// version-blocked v1->v2 open COMPLETELY differently from a legitimate
// loadGraph() null result (no graph saved yet) -- a distinct, checkable
// error class is what makes `error instanceof BlockedUpgradeError` a real
// branch rather than a fragile string match against the message.
test("BlockedUpgradeError is a distinctly-typed, checkable Error subclass carrying its own message", () => {
  const error = new BlockedUpgradeError("Close other Material Collager tabs and try again -- storage is upgrading.");
  assert.ok(error instanceof Error, "must still be a real Error (stack trace, try/catch compatibility, etc.)");
  assert.ok(error instanceof BlockedUpgradeError, "must be distinguishable from any other rejection reason");
  assert.equal(error.name, "BlockedUpgradeError");
  assert.equal(error.message, "Close other Material Collager tabs and try again -- storage is upgrading.");
});

test("BlockedUpgradeError is NOT confused with a plain Error (the restore path's instanceof check must not false-positive)", () => {
  const plainError = new Error("Could not load the workbench graph.");
  assert.equal(plainError instanceof BlockedUpgradeError, false);
});

// round 7 issue-3: dataUrlToBlob is the exact inverse of blob-cache.ts's
// blobToDataUrl -- the byte-level decode step the eager legacy-thumbnail
// migration depends on. Framework-free (Node has global Blob/atob).
test("dataUrlToBlob decodes a real base64 data URL back into a Blob of the right size and mime type (round-trips the exact bytes)", async () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 250, 251, 252]);
  const base64 = btoa(String.fromCharCode(...bytes));
  const dataUrl = `data:image/jpeg;base64,${base64}`;

  const blob = dataUrlToBlob(dataUrl);

  assert.ok(blob instanceof Blob);
  assert.equal(blob.type, "image/jpeg");
  assert.equal(blob.size, bytes.length);
  const roundTripped = new Uint8Array(await blob.arrayBuffer());
  assert.deepEqual([...roundTripped], [...bytes]);
});

test("dataUrlToBlob returns undefined for a non-data-URL string (a corrupted/foreign value some record happened to carry) instead of throwing", () => {
  assert.equal(dataUrlToBlob("not-a-data-url"), undefined);
  assert.equal(dataUrlToBlob(""), undefined);
});

test("dataUrlToBlob never throws even for a malformed base64 payload -- it degrades to undefined so the caller can drop the thumbnail rather than crash listing every other graph", () => {
  assert.doesNotThrow(() => dataUrlToBlob("data:image/jpeg;base64,not-valid-base64!!!"));
});

test("dataUrlToBlob falls back to image/jpeg when the data URL's own mime type segment is empty", () => {
  const base64 = btoa(String.fromCharCode(1, 2, 3));
  const blob = dataUrlToBlob(`data:;base64,${base64}`);
  assert.ok(blob instanceof Blob);
  assert.equal(blob.type, "image/jpeg");
});

// round 7 issue-3: the "meta shape" decision at the heart of the eager
// migration -- a legacy record's inline base64 field must NEVER survive
// into the object handed back, regardless of whether the migration's own
// blob write has been confirmed yet.
test("withoutLegacyThumbnail strips the inline field and adds NO thumbnailKey when the migration hasn't (yet) confirmed a blob write", () => {
  const meta = { id: "g1", name: "My graph", savedAt: 100, nodeCount: 3, thumbnail: "data:image/jpeg;base64,AAAA" };
  const result = withoutLegacyThumbnail(meta);
  assert.equal("thumbnail" in result, false, "the base64 string must never survive into the returned object");
  assert.equal("thumbnailKey" in result, false, "must not CLAIM a blob-keyed thumbnail exists before a write is confirmed");
  assert.deepEqual(result, { id: "g1", name: "My graph", savedAt: 100, nodeCount: 3 });
});

test("withoutLegacyThumbnail sets thumbnailKey (and still strips the inline field) once the caller confirms the migration's blob write landed", () => {
  const meta = { id: "g1", name: "My graph", savedAt: 100, nodeCount: 3, thumbnail: "data:image/jpeg;base64,AAAA" };
  const result = withoutLegacyThumbnail(meta, "graph-thumbnail");
  assert.deepEqual(result, { id: "g1", name: "My graph", savedAt: 100, nodeCount: 3, thumbnailKey: "graph-thumbnail" });
});

test("withoutLegacyThumbnail's output is itself reported as 'none' (no thumbnail) or 'key' (blob-keyed) by graphThumbnailSource, never 'legacy' -- confirming a migrated record can never re-render the inline base64 path", () => {
  const meta = { id: "g1", name: "My graph", savedAt: 100, nodeCount: 3, thumbnail: "data:image/jpeg;base64,AAAA" };
  assert.equal(graphThumbnailSource(withoutLegacyThumbnail(meta)).kind, "none");
  assert.equal(graphThumbnailSource(withoutLegacyThumbnail(meta, "graph-thumbnail")).kind, "key");
});
