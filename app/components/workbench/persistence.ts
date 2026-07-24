import type { Edge } from "@xyflow/react";
// Explicit .ts extensions on these two: they're real runtime (value) imports,
// and the pure migrateBlobKey/migrateV1Record helpers below must resolve
// under Node's --experimental-strip-types with no bundler (S23/W4's Node unit
// test target) -- its ESM loader does no extension searching. Everything
// pulled from "./types" below is type-only (`import type`), which Node's type
// stripping erases entirely, so that one relative import never needs to
// resolve at runtime and is left extensionless like the rest of the codebase.
import { getBlob, putBlob, thumbnailKeyFor, totalCachedBytes } from "./blob-cache.ts";
import { defaultParams, MANIFESTS } from "./nodes/manifests.ts";
import type { NodeKind, NodeOutputValue, NodeRun, WorkbenchNode, WorkbenchParams } from "./types";

// Named-graph, split-blob IndexedDB persistence (AC16, AC17).
//
// Records are keyed by graphId (not a single "current" singleton): a small
// `graph:<graphId>` structure record (nodes/edges/params/positions + each
// node's persisted run metadata), a `meta:<graphId>` index record (name,
// savedAt, node count) for a future graph-picker UI, and per-graph-namespaced
// blob rows `blob:<graphId>:<encodedCacheKey>` for the actual image bytes.
//
// PERSISTENCE POLICY (AC16, "pinned + active only"): every blob is one of two
// ownership classes.
//   - SOURCE: durable user uploads (Photo source images, References item
//     images, MaskedEdit's drawn mask, ...) -- read generically from each
//     node's manifest.persistBlobKeys (see sourceBlobKeysForNode below). SOURCE
//     blobs are exempt from byte-budget eviction; they're only ever removed
//     by the existing needed/GC diff when their owning node/param is deleted.
//   - OUTPUT: paid run results (+ thumbnails). Only each node's ACTIVE run
//     and (if different) its PINNED run are persisted -- the 8-run/node
//     history buffer (store.ts's MAX_RUNS_PER_NODE) stays memory-only. A
//     per-graph byte budget evicts the oldest UNPINNED output first when the
//     total exceeds it (applyByteBudget below); pinned outputs and every
//     SOURCE blob are never eviction candidates.
//
// SPLIT AUTOSAVE: saveGraphStructure writes only the structure record (safe
// to call on every dirtyStamp change, including position drags -- it never
// touches the blob store). saveGraph does that AND the full blob write/GC +
// byte-budget pass; WorkbenchApp.tsx calls it only on the new-run/pin-toggle/
// upload-or-source-change events (store.ts's blobStamp), never on a drag.

const DB_NAME = "material-collager-workbench";
const DB_VERSION = 2;
const STORE = "graphs";
const BLOB_PREFIX = "blob:";
const GRAPH_PREFIX = "graph:";
const META_PREFIX = "meta:";
// v1's bare singleton key -- the ONLY record a v1 database could contain.
const LEGACY_GRAPH_KEY = "current";

export const DEFAULT_GRAPH_ID = "default";
export const DEFAULT_GRAPH_NAME = "My Workbench";
// ~200MB of persisted OUTPUT-class bytes per graph before oldest-unpinned
// eviction kicks in. SOURCE blobs (Photo/References/mask uploads) and pinned
// outputs never count against this.
export const DEFAULT_GRAPH_BYTE_BUDGET = 200 * 1024 * 1024;

export const PHOTO_SOURCE_KEY = (nodeId: string) => `${nodeId}:src`;

export type GraphMeta = {
  id: string;
  name: string;
  savedAt: number;
  nodeCount: number;
};

export type StoredNode = {
  id: string;
  kind: NodeKind;
  params: WorkbenchParams;
  position: { x: number; y: number };
  // SOURCE blob-cache keys this node owned at save time (present under
  // `blob:<graphId>:<encoded key>`).
  blobKeys?: string[];
  // Persisted OUTPUT run(s): 0-2 entries -- [activeRun] or, when a different
  // run is pinned, [activeRun, pinnedRun]. `pinnedIndex` names which entry
  // (if any) is the pinned one.
  outputs?: NodeRun[];
  pinnedIndex?: number;
  /** @deprecated pre-generalization v1 flag; still read as a fallback for graphs saved before persistBlobKeys existed. */
  hasPhoto?: boolean;
};

export type StoredGraph = {
  version: 2;
  id: string;
  savedAt: number;
  nodes: StoredNode[];
  edges: Array<Pick<Edge, "id" | "source" | "target" | "sourceHandle" | "targetHandle">>;
};

// The only shape a v1 database could ever contain (the pre-graphId
// singleton). Kept local to this module -- only the migration reads it.
type StoredNodeV1 = {
  id: string;
  kind: NodeKind;
  params: WorkbenchParams;
  position: { x: number; y: number };
  blobKeys?: string[];
  hasPhoto?: boolean;
};

type StoredGraphV1 = {
  version: 1;
  savedAt: number;
  nodes: StoredNodeV1[];
  edges: Array<Pick<Edge, "id" | "source" | "target" | "sourceHandle" | "targetHandle">>;
};

// ---------------------------------------------------------------------------
// Pure, IDB-free v1->v2 helpers (S23 / W4). The onupgradeneeded handler below
// (migrateV1ToV2) does nothing but call these inside the single upgrade
// transaction, so the key-mapping/record-transform logic itself is
// unit-testable in Node with no IndexedDB implementation at all. The Node
// unit test (S31) covers ONLY these two; the real upgrade-transaction
// behavior -- atomicity, no orphaned legacy keys against a populated,
// real-world v1 database -- is a manual/Browser QA gate (S32), not something
// a Node test can exercise (Node has no native IndexedDB).
// ---------------------------------------------------------------------------

// The fully-qualified, per-graph-namespaced storage key for a logical
// blob-cache key. Every blob a node owns (SOURCE or OUTPUT) is stored under
// this, so two graphs can never collide even if a node id/cache key text
// happens to repeat across them (e.g. a cloned/duplicated graph).
export function blobStorageKey(graphId: string, cacheKey: string): string {
  return `${BLOB_PREFIX}${graphId}:${encodeURIComponent(cacheKey)}`;
}

// legacyKey is the RAW logical cache key a v1 record stored a blob under
// (`blob:${legacyKey}`, unnamespaced); returns the v2 storage key it moves to.
// Same formula as blobStorageKey -- named separately so the migration's exact
// contract (`migrateBlobKey(legacyKey, graphId) => 'blob:<graphId>:<encoded>'`)
// has its own stable, directly-importable symbol.
export function migrateBlobKey(legacyKey: string, graphId: string): string {
  return blobStorageKey(graphId, legacyKey);
}

// Moves a v1 singleton graph record into the first named v2 graph record +
// its meta index entry. Node/edge/param data carries over unchanged -- only
// the BLOB storage keys get namespaced (via migrateBlobKey, per key, by the
// caller); the logical cache keys recorded on the nodes themselves (blobKeys)
// never change shape, so this is a pure relabeling, never a data loss.
export function migrateV1Record(record: StoredGraphV1, graphId: string): { graph: StoredGraph; meta: GraphMeta } {
  const nodes: StoredNode[] = record.nodes.map((node) => ({
    id: node.id,
    kind: node.kind,
    params: node.params,
    position: node.position,
    blobKeys: node.blobKeys,
    hasPhoto: node.hasPhoto,
  }));
  return {
    graph: { version: 2, id: graphId, savedAt: record.savedAt, nodes, edges: record.edges },
    meta: { id: graphId, name: DEFAULT_GRAPH_NAME, savedAt: record.savedAt, nodeCount: nodes.length },
  };
}

// ---------------------------------------------------------------------------
// Database open + the v1->v2 upgrade.
// ---------------------------------------------------------------------------

// Runs entirely inside the versionchange transaction handed to us by
// onupgradeneeded: every store.get/put/delete below is issued synchronously
// off that SAME transaction (nested in each other's onsuccess, never awaited)
// so IndexedDB's own atomicity guarantee covers the whole migration -- either
// all of it lands, or (tab closed mid-upgrade, etc.) none of it does; there is
// no half-migrated state to leave the legacy 'current' graph in.
function migrateV1ToV2(transaction: IDBTransaction): void {
  const store = transaction.objectStore(STORE);
  const graphId = DEFAULT_GRAPH_ID;

  const keysRequest = store.getAllKeys();
  keysRequest.onsuccess = () => {
    const keys = (keysRequest.result as IDBValidKey[]).map(String);
    // Every "blob:" key a v1 database could hold is unnamespaced by
    // definition (namespacing is a v2 concept) -- so all of them are legacy.
    const legacyBlobStorageKeys = keys.filter((key) => key.startsWith(BLOB_PREFIX));

    if (keys.includes(LEGACY_GRAPH_KEY)) {
      const graphRequest = store.get(LEGACY_GRAPH_KEY);
      graphRequest.onsuccess = () => {
        const legacy = graphRequest.result as StoredGraphV1 | undefined;
        if (!legacy) return;
        const { graph, meta } = migrateV1Record(legacy, graphId);
        store.put(graph, `${GRAPH_PREFIX}${graphId}`);
        store.put(meta, `${META_PREFIX}${graphId}`);
        store.delete(LEGACY_GRAPH_KEY);
      };
    }

    for (const legacyStorageKey of legacyBlobStorageKeys) {
      const legacyCacheKey = legacyStorageKey.slice(BLOB_PREFIX.length);
      const newStorageKey = migrateBlobKey(legacyCacheKey, graphId);
      const blobRequest = store.get(legacyStorageKey);
      blobRequest.onsuccess = () => {
        const blob = blobRequest.result;
        if (blob !== undefined) store.put(blob, newStorageKey);
        store.delete(legacyStorageKey);
      };
    }
  };
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      const transaction = request.transaction;
      // Covers a brand-new database (oldVersion 0 -- migrateV1ToV2 is then a
      // safe no-op, nothing to migrate) and the real upgrade an existing
      // user hits (oldVersion 1 -- moves 'current' + every legacy blob key
      // into the v2 namespace, atomically, in this same transaction).
      if (transaction && event.oldVersion < 2) migrateV1ToV2(transaction);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open workbench storage."));
  });
}

export function createGraphId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `graph-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// SOURCE / OUTPUT blob classification + snapshotting (AC16, W7).
// ---------------------------------------------------------------------------

// Which blob-cache keys a node instance owns as durable SOURCE uploads, read
// generically from its manifest's persistBlobKeys (framework-free, imported
// from nodes/manifests.ts -- never nodes/index.ts, which pulls in .tsx). Any
// node that declares persistBlobKeys gets split-blob persistence with no
// per-kind gating in this file. Exported so export-import.ts (AC18) can reuse
// the exact same ownership list to decide what to embed on export, rather
// than re-deriving it (and risking drift from this module's own save path).
export function sourceBlobKeysForNode(kind: NodeKind, nodeId: string, params: WorkbenchParams): string[] {
  const declared = MANIFESTS[kind]?.persistBlobKeys?.(nodeId, params);
  if (declared) return declared;
  // Legacy convention predating the declarative persistBlobKeys field.
  if (kind === "photo") return [PHOTO_SOURCE_KEY(nodeId)];
  return [];
}

// Reconstructs a Photo node's display run from its restored SOURCE blob --
// the one kind whose run isn't rebuilt from generic output persistence (its
// image lives under the node-id convention, not a param field). Shared by
// loadGraph's legacy-fallback path below and export-import.ts's materializer
// (AC18) so both reconstruct the identical run shape.
export function buildPhotoRun(nodeId: string, url: string, cacheKey: string, fileFingerprint: string | undefined, at: number): NodeRun {
  return {
    runId: `restored-${nodeId}`,
    signature: `photo:${fileFingerprint ?? nodeId}`,
    at,
    values: [[{ kind: "image", url, cacheKey }]],
  };
}

// The OUTPUT-class blob-cache keys (image/mask cacheKey + its thumbnail, if
// any) referenced by a set of persisted runs. Other kinds (text/references/
// report) carry no separate blob -- their payload is plain JSON already
// inline in the run.
function valueBlobKeys(value: NodeOutputValue): string[] {
  if (value.kind !== "image" && value.kind !== "mask") return [];
  const keys = [value.cacheKey];
  const thumbKey = thumbnailKeyFor(value.cacheKey);
  if (getBlob(thumbKey)) keys.push(thumbKey);
  return keys;
}

function outputBlobKeysOfRuns(runs: NodeRun[]): string[] {
  const keys: string[] = [];
  for (const run of runs) {
    for (const candidates of run.values) {
      for (const value of candidates) keys.push(...valueBlobKeys(value));
    }
  }
  return keys;
}

// The persisted OUTPUT run(s) for one node: the active run always, plus the
// pinned run too when it differs from the active one (AC15's pin is by run
// index, not necessarily index 0). `runs[node.data.activeRun]` intentionally
// mirrors signature.ts's activeRunOf ordering (pin wins) so what gets
// persisted always matches what's currently displayed/propagating.
function activeAndPinnedRuns(node: WorkbenchNode): { outputs: NodeRun[]; pinnedIndex?: number } {
  const runs = node.data.runs;
  const activeRun = runs[node.data.activeRun] ?? runs[0];
  if (!activeRun) return { outputs: [] };
  const pinnedRaw = node.data.pinnedOutput;
  const pinnedRun = pinnedRaw !== undefined && pinnedRaw !== null ? runs[pinnedRaw] : undefined;
  if (!pinnedRun) return { outputs: [activeRun] };
  if (pinnedRun.runId === activeRun.runId) return { outputs: [activeRun], pinnedIndex: 0 };
  return { outputs: [activeRun, pinnedRun], pinnedIndex: 1 };
}

type NodeSnapshot = {
  id: string;
  kind: NodeKind;
  params: WorkbenchParams;
  position: { x: number; y: number };
  sourceKeys: string[]; // SOURCE, durable, present-in-cache filtered
  outputs: NodeRun[]; // OUTPUT: [active] or [active, pinned]
  pinnedIndex?: number;
};

function snapshotNodes(nodes: WorkbenchNode[]): NodeSnapshot[] {
  return nodes.map((node) => {
    const sourceKeys = sourceBlobKeysForNode(node.data.kind, node.id, node.data.params).filter((key) => Boolean(getBlob(key)));
    const { outputs, pinnedIndex } = activeAndPinnedRuns(node);
    return { id: node.id, kind: node.data.kind, params: node.data.params, position: node.position, sourceKeys, outputs, pinnedIndex };
  });
}

// Per-graph byte-budget eviction (AC16): walks ONLY the OUTPUT class, oldest
// (by run.at) unpinned entry first, and NEVER a key that's also a SOURCE
// blob anywhere in the graph -- so exceeding the budget can never delete a
// Photo/References upload, even if that same image happens to also be
// referenced from inside a persisted run's values. Mutates `snapshots` in
// place, dropping evicted runs (and re-pointing pinnedIndex at the pinned
// run's new position, since dropping an earlier entry shifts indices).
function applyByteBudget(snapshots: NodeSnapshot[], sourceKeys: Set<string>, budgetBytes: number): void {
  type Unit = { snapshot: NodeSnapshot; runIndex: number; keys: string[]; size: number; at: number };
  const units: Unit[] = [];
  for (const snapshot of snapshots) {
    snapshot.outputs.forEach((run, runIndex) => {
      if (snapshot.pinnedIndex === runIndex) return; // pinned -- durable, never a candidate
      const keys = outputBlobKeysOfRuns([run]).filter((key) => !sourceKeys.has(key));
      if (!keys.length) return;
      units.push({ snapshot, runIndex, keys, size: totalCachedBytes(keys), at: run.at });
    });
  }
  if (!units.length) return;

  units.sort((a, b) => a.at - b.at); // oldest first
  let total = units.reduce((sum, unit) => sum + unit.size, 0);
  const evicted = new Set<Unit>();
  for (const unit of units) {
    if (total <= budgetBytes) break;
    evicted.add(unit);
    total -= unit.size;
  }
  if (!evicted.size) return;

  for (const snapshot of snapshots) {
    const pinnedRunId = snapshot.pinnedIndex !== undefined ? snapshot.outputs[snapshot.pinnedIndex]?.runId : undefined;
    const evictedIndexes = new Set(
      [...evicted].filter((unit) => unit.snapshot === snapshot).map((unit) => unit.runIndex),
    );
    if (!evictedIndexes.size) continue;
    snapshot.outputs = snapshot.outputs.filter((_run, index) => !evictedIndexes.has(index));
    if (pinnedRunId === undefined) continue;
    const newIndex = snapshot.outputs.findIndex((run) => run.runId === pinnedRunId);
    snapshot.pinnedIndex = newIndex >= 0 ? newIndex : undefined;
  }
}

function toStoredNodes(snapshots: NodeSnapshot[]): StoredNode[] {
  return snapshots.map((snapshot) => ({
    id: snapshot.id,
    kind: snapshot.kind,
    params: snapshot.params,
    position: snapshot.position,
    blobKeys: snapshot.sourceKeys,
    outputs: snapshot.outputs,
    pinnedIndex: snapshot.pinnedIndex,
  }));
}

function serializeEdges(edges: Edge[]): StoredGraph["edges"] {
  return edges.map(({ id, source, target, sourceHandle, targetHandle }) => ({ id, source, target, sourceHandle, targetHandle }));
}

// ---------------------------------------------------------------------------
// Save: structure-only (cheap, every dirtyStamp -- incl. drags) vs. full
// (structure + blob write/GC + byte-budget eviction -- only on new-run,
// pin-toggle, and upload/source-change events; see store.ts's blobStamp).
// ---------------------------------------------------------------------------

// Writes ONLY the graph + meta records -- no blob-store read or write at all.
// Safe to call on every position drag: it can never touch a single blob.
export async function saveGraphStructure(graphId: string, nodes: WorkbenchNode[], edges: Edge[]): Promise<void> {
  const storedNodes = toStoredNodes(snapshotNodes(nodes));
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    const metaKey = `${META_PREFIX}${graphId}`;
    const existingMetaRequest = store.get(metaKey);
    existingMetaRequest.onsuccess = () => {
      const existing = existingMetaRequest.result as GraphMeta | undefined;
      const savedAt = Date.now();
      const graph: StoredGraph = { version: 2, id: graphId, savedAt, nodes: storedNodes, edges: serializeEdges(edges) };
      const meta: GraphMeta = { id: graphId, name: existing?.name ?? DEFAULT_GRAPH_NAME, savedAt, nodeCount: storedNodes.length };
      store.put(graph, `${GRAPH_PREFIX}${graphId}`);
      store.put(meta, metaKey);
    };
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error || new Error("Could not save the workbench graph."));
    };
  });
}

export type SaveGraphOptions = { byteBudget?: number };

// Full save: structure + the split-blob write/GC diff, scoped to this graph's
// blob namespace, plus byte-budget eviction over the OUTPUT class.
export async function saveGraph(graphId: string, nodes: WorkbenchNode[], edges: Edge[], options: SaveGraphOptions = {}): Promise<void> {
  const budgetBytes = options.byteBudget ?? DEFAULT_GRAPH_BYTE_BUDGET;
  const snapshots = snapshotNodes(nodes);
  const sourceKeys = new Set(snapshots.flatMap((snapshot) => snapshot.sourceKeys));
  applyByteBudget(snapshots, sourceKeys, budgetBytes);
  const storedNodes = toStoredNodes(snapshots);

  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    const metaKey = `${META_PREFIX}${graphId}`;
    const existingMetaRequest = store.get(metaKey);
    existingMetaRequest.onsuccess = () => {
      const existing = existingMetaRequest.result as GraphMeta | undefined;
      const savedAt = Date.now();
      const graph: StoredGraph = { version: 2, id: graphId, savedAt, nodes: storedNodes, edges: serializeEdges(edges) };
      const meta: GraphMeta = { id: graphId, name: existing?.name ?? DEFAULT_GRAPH_NAME, savedAt, nodeCount: storedNodes.length };
      store.put(graph, `${GRAPH_PREFIX}${graphId}`);
      store.put(meta, metaKey);

      const graphBlobPrefix = `${BLOB_PREFIX}${graphId}:`;
      const keysRequest = store.getAllKeys();
      keysRequest.onsuccess = () => {
        const existingBlobKeys = new Set(
          (keysRequest.result as IDBValidKey[]).map(String).filter((key) => key.startsWith(graphBlobPrefix)),
        );
        const rawNeeded = new Set<string>();
        for (const snapshot of snapshots) {
          for (const key of snapshot.sourceKeys) rawNeeded.add(key);
          for (const key of outputBlobKeysOfRuns(snapshot.outputs)) rawNeeded.add(key);
        }
        const neededStorageKeys = new Set<string>();
        for (const rawKey of rawNeeded) {
          const storageKey = blobStorageKey(graphId, rawKey);
          neededStorageKeys.add(storageKey);
          if (!existingBlobKeys.has(storageKey)) {
            const blob = getBlob(rawKey);
            if (blob) store.put(blob, storageKey);
          }
        }
        for (const storageKey of existingBlobKeys) {
          if (!neededStorageKeys.has(storageKey)) store.delete(storageKey);
        }
      };
    };
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error || new Error("Could not save the workbench graph."));
    };
  });
}

// ---------------------------------------------------------------------------
// Load.
// ---------------------------------------------------------------------------

// A persisted run, rehydrated for the current session: an "image" value's
// stale (previous-session) object URL is replaced with the fresh one minted
// when its blob was restored ("mask" values carry no url -- just a cacheKey
// -- so they're kept as-is once their blob's presence is confirmed). A value
// whose blob didn't survive is dropped; a run left with no candidates on its
// primary output port is dropped entirely rather than restored as a "done"
// node with nothing to show.
function rehydrateRun(run: NodeRun, restoredUrls: Map<string, string>): NodeRun | null {
  const values = run.values.map((candidates) =>
    candidates
      .map((value): NodeOutputValue | null => {
        if (value.kind === "image") {
          const url = restoredUrls.get(value.cacheKey);
          return url ? { ...value, url } : null;
        }
        if (value.kind === "mask") return restoredUrls.has(value.cacheKey) ? value : null;
        return value;
      })
      .filter((value): value is NodeOutputValue => value !== null),
  );
  if (!values[0]?.length) return null;
  return { ...run, values };
}

export async function loadGraph(graphId: string): Promise<{ nodes: WorkbenchNode[]; edges: Edge[] } | null> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, "readonly");
    const store = transaction.objectStore(STORE);
    const graphRequest = store.get(`${GRAPH_PREFIX}${graphId}`);
    // nodeId -> (logical cache key -> pending blob read), resolved once the
    // transaction completes.
    const blobRequests = new Map<string, Map<string, IDBRequest>>();
    // Ancient (pre-persistBlobKeys) fallback: a hasPhoto node's blob was
    // stored under the bare node id rather than PHOTO_SOURCE_KEY(id).
    const legacyPhotoRequests = new Map<string, IDBRequest>();
    graphRequest.onsuccess = () => {
      const record = graphRequest.result as StoredGraph | undefined;
      if (!record) return;
      for (const node of record.nodes) {
        const wanted = new Set<string>(node.blobKeys ?? []);
        for (const key of outputBlobKeysOfRuns(node.outputs ?? [])) wanted.add(key);
        if (wanted.size) {
          const reads = new Map<string, IDBRequest>();
          for (const key of wanted) reads.set(key, store.get(blobStorageKey(graphId, key)));
          blobRequests.set(node.id, reads);
        }
        if (node.hasPhoto && !node.blobKeys?.length) {
          legacyPhotoRequests.set(node.id, store.get(blobStorageKey(graphId, node.id)));
        }
      }
    };
    transaction.oncomplete = () => {
      db.close();
      const record = graphRequest.result as StoredGraph | undefined;
      if (!record) return resolve(null);
      const nodes: WorkbenchNode[] = record.nodes.map((stored) => {
        const restoredUrls = new Map<string, string>();
        const reads = blobRequests.get(stored.id);
        if (reads) {
          for (const [key, request] of reads) {
            const blob = request.result as Blob | undefined;
            if (blob) restoredUrls.set(key, putBlob(key, blob));
          }
        }

        const node: WorkbenchNode = {
          id: stored.id,
          type: stored.kind,
          position: stored.position,
          data: {
            kind: stored.kind,
            params: { ...defaultParams(stored.kind), ...stored.params },
            status: "idle",
            runs: [],
            activeRun: 0,
          },
        };

        // Generic active(+pinned) output restore (AC16): reconstructs `runs`
        // for ANY node kind directly from the persisted run metadata. Only
        // graphs saved by this code (post-S22) carry `outputs`; older/freshly
        // migrated records fall through to the legacy paths below unchanged.
        if (stored.outputs?.length) {
          const runs = stored.outputs.map((run) => rehydrateRun(run, restoredUrls)).filter((run): run is NodeRun => run !== null);
          if (runs.length) {
            node.data.runs = runs;
            node.data.activeRun = 0;
            if (stored.pinnedIndex !== undefined && stored.pinnedIndex < runs.length) node.data.pinnedOutput = stored.pinnedIndex;
            node.data.status = "done";
          }
        }

        // Legacy fallbacks (pre-S22 saves, or a v1 graph freshly migrated but
        // not yet re-autosaved in the new format): Photo is the only kind
        // whose run was reconstructed ad hoc before generic output
        // persistence existed. Other kinds rebuild their own display state
        // from params + the now-populated blob cache (see their .tsx module).
        if (!node.data.runs.length && stored.kind === "photo") {
          const photoUrl = restoredUrls.get(PHOTO_SOURCE_KEY(stored.id)) ?? legacyPhotoRestoredUrl(legacyPhotoRequests, stored.id);
          if (photoUrl) {
            node.data.runs = [
              buildPhotoRun(stored.id, photoUrl, PHOTO_SOURCE_KEY(stored.id), stored.params.fileFingerprint, record.savedAt),
            ];
            node.data.status = "done";
          }
        }
        return node;
      });
      resolve({ nodes, edges: record.edges as Edge[] });
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error || new Error("Could not load the workbench graph."));
    };
  });
}

function legacyPhotoRestoredUrl(legacyPhotoRequests: Map<string, IDBRequest>, nodeId: string): string | undefined {
  const request = legacyPhotoRequests.get(nodeId);
  const blob = request?.result as Blob | undefined;
  return blob ? putBlob(PHOTO_SOURCE_KEY(nodeId), blob) : undefined;
}

// ---------------------------------------------------------------------------
// Named-graph meta index (AC17). A full graph-management UI (new/rename/
// delete/switch) is a later step; this is the read-side primitive it'll need.
// ---------------------------------------------------------------------------

// Renames a graph's meta entry only (id/blob-namespace/structure untouched).
// A no-op if the graph has never been saved yet (nothing to rename).
export async function renameGraph(graphId: string, name: string): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    const metaKey = `${META_PREFIX}${graphId}`;
    const request = store.get(metaKey);
    request.onsuccess = () => {
      const existing = request.result as GraphMeta | undefined;
      if (existing) store.put({ ...existing, name }, metaKey);
    };
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error || new Error("Could not rename the workbench graph."));
    };
  });
}

// Deletes a graph's structure + meta + every blob in its namespace. Leaves
// every other graph's records (including any blob-key text that happens to
// repeat, since blobs are namespaced per-graph) completely untouched.
export async function deleteGraph(graphId: string): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    store.delete(`${GRAPH_PREFIX}${graphId}`);
    store.delete(`${META_PREFIX}${graphId}`);
    const graphBlobPrefix = `${BLOB_PREFIX}${graphId}:`;
    const keysRequest = store.getAllKeys();
    keysRequest.onsuccess = () => {
      for (const key of (keysRequest.result as IDBValidKey[]).map(String)) {
        if (key.startsWith(graphBlobPrefix)) store.delete(key);
      }
    };
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error || new Error("Could not delete the workbench graph."));
    };
  });
}

// Creates a brand-new EMPTY named graph (meta only — no structure record
// until the caller actually saves something into it) and returns its id, so
// the graph-management UI can switch to it immediately.
export async function createGraph(name: string): Promise<string> {
  const graphId = createGraphId();
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    const meta: GraphMeta = { id: graphId, name, savedAt: Date.now(), nodeCount: 0 };
    store.put(meta, `${META_PREFIX}${graphId}`);
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error || new Error("Could not create a new workbench graph."));
    };
  });
  return graphId;
}

export async function listGraphs(): Promise<GraphMeta[]> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, "readonly");
    const store = transaction.objectStore(STORE);
    const results: GraphMeta[] = [];
    const keysRequest = store.getAllKeys();
    keysRequest.onsuccess = () => {
      const metaKeys = (keysRequest.result as IDBValidKey[]).map(String).filter((key) => key.startsWith(META_PREFIX));
      for (const key of metaKeys) {
        const request = store.get(key);
        request.onsuccess = () => {
          if (request.result) results.push(request.result as GraphMeta);
        };
      }
    };
    transaction.oncomplete = () => {
      db.close();
      resolve(results.sort((a, b) => b.savedAt - a.savedAt));
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error || new Error("Could not list workbench graphs."));
    };
  });
}
