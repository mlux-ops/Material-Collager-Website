import type { Edge } from "@xyflow/react";
import { getBlob, putBlob } from "./blob-cache";
import { defaultParams, type NodeKind, type WorkbenchNode, type WorkbenchParams } from "./types";

// Autosaved graph persistence, using the same split-blob IndexedDB pattern as
// the generator's drafts: the graph record is small and rewritten freely; the
// Photo-node source images are stored once under their own keys.

const DB_NAME = "material-collager-workbench";
const STORE = "graphs";
const GRAPH_KEY = "current";
const BLOB_PREFIX = "blob:";

export const PHOTO_SOURCE_KEY = (nodeId: string) => `${nodeId}:src`;

type StoredNode = {
  id: string;
  kind: NodeKind;
  params: WorkbenchParams;
  position: { x: number; y: number };
  hasPhoto?: boolean;
};

type StoredGraph = {
  version: 1;
  savedAt: number;
  nodes: StoredNode[];
  edges: Array<Pick<Edge, "id" | "source" | "target" | "sourceHandle" | "targetHandle">>;
};

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open workbench storage."));
  });
}

export async function saveGraph(nodes: WorkbenchNode[], edges: Edge[]): Promise<void> {
  const record: StoredGraph = {
    version: 1,
    savedAt: Date.now(),
    nodes: nodes.map((node) => ({
      id: node.id,
      kind: node.data.kind,
      params: node.data.params,
      position: node.position,
      hasPhoto: node.data.kind === "photo" && Boolean(getBlob(PHOTO_SOURCE_KEY(node.id))),
    })),
    edges: edges.map(({ id, source, target, sourceHandle, targetHandle }) => ({ id, source, target, sourceHandle, targetHandle })),
  };
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    store.put(record, GRAPH_KEY);
    const keysRequest = store.getAllKeys();
    keysRequest.onsuccess = () => {
      const existing = new Set((keysRequest.result as IDBValidKey[]).map(String));
      const needed = new Set<string>();
      for (const node of record.nodes) {
        if (!node.hasPhoto) continue;
        const key = `${BLOB_PREFIX}${node.id}`;
        needed.add(key);
        const blob = getBlob(PHOTO_SOURCE_KEY(node.id));
        if (blob && !existing.has(key)) store.put(blob, key);
      }
      for (const key of existing) {
        if (key.startsWith(BLOB_PREFIX) && !needed.has(key)) store.delete(key);
      }
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

export async function loadGraph(): Promise<{ nodes: WorkbenchNode[]; edges: Edge[] } | null> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, "readonly");
    const store = transaction.objectStore(STORE);
    const graphRequest = store.get(GRAPH_KEY);
    const blobRequests = new Map<string, IDBRequest>();
    graphRequest.onsuccess = () => {
      const record = graphRequest.result as StoredGraph | undefined;
      if (!record) return;
      for (const node of record.nodes) {
        if (node.hasPhoto) blobRequests.set(node.id, store.get(`${BLOB_PREFIX}${node.id}`));
      }
    };
    transaction.oncomplete = () => {
      db.close();
      const record = graphRequest.result as StoredGraph | undefined;
      if (!record) return resolve(null);
      const nodes: WorkbenchNode[] = record.nodes.map((stored) => {
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
        const blob = blobRequests.get(stored.id)?.result as Blob | undefined;
        if (blob) {
          const url = putBlob(PHOTO_SOURCE_KEY(stored.id), blob);
          node.data.runs = [{
            runId: `restored-${stored.id}`,
            signature: `photo:${stored.params.fileFingerprint ?? stored.id}`,
            at: record.savedAt,
            values: [[{ kind: "image", url, cacheKey: PHOTO_SOURCE_KEY(stored.id) }]],
          }];
          node.data.status = "done";
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
