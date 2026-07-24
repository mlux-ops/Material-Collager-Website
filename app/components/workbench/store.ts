import { create } from "zustand";
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
} from "@xyflow/react";
import { releaseByPrefix } from "./blob-cache";
import { NODE_KINDS } from "./nodes/manifests";
import {
  acceptedKindsFor,
  defaultParams,
  specFor,
  type NodeKind,
  type NodeRun,
  type NodeStatus,
  type PendingReferenceSelection,
  type PortKind,
  type WorkbenchNode,
  type WorkbenchParams,
} from "./types";

function createNodeId() {
  return globalThis.crypto?.randomUUID?.().slice(0, 8) ?? `${Date.now()}-${Math.random()}`;
}

export function portSpecFor(node: WorkbenchNode | undefined, handleId: string | null | undefined, direction: "in" | "out") {
  if (!node) return undefined;
  const spec = specFor(node.data.kind);
  const ports = direction === "in" ? spec.inputs : spec.outputs;
  return ports.find((port) => port.id === handleId);
}

// Type-checked, acyclic connections: an output can only reach an input that
// accepts its data kind, and a connection that would create a cycle is
// refused. A port accepts its own kind unless it lists acceptedKinds (e.g.
// reference inputs take both "image" and "references").
export function connectionIsValid(nodes: WorkbenchNode[], edges: Edge[], connection: Connection | Edge): boolean {
  if (!connection.source || !connection.target || connection.source === connection.target) return false;
  const source = nodes.find((node) => node.id === connection.source);
  const target = nodes.find((node) => node.id === connection.target);
  const sourcePort = portSpecFor(source, connection.sourceHandle, "out");
  const targetPort = portSpecFor(target, connection.targetHandle, "in");
  if (!sourcePort || !targetPort) return false;
  if (!acceptedKindsFor(targetPort).includes(sourcePort.kind)) return false;

  // Reject cycles: walk downstream from the target; if we reach the source,
  // this edge would close a loop.
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    const list = outgoing.get(edge.source) ?? [];
    list.push(edge.target);
    outgoing.set(edge.source, list);
  }
  const queue = [connection.target];
  const seen = new Set<string>();
  while (queue.length) {
    const current = queue.pop()!;
    if (current === connection.source) return false;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const next of outgoing.get(current) ?? []) queue.push(next);
  }
  return true;
}

// Node kinds with a compatible port for a wire dropped on empty canvas
// (S29/AC24, drag-wire-to-empty-canvas): derived from the registry, never a
// hand-maintained list. Dragging from a SOURCE (output) handle of kind
// `portKind` looks for candidates with an INPUT port that accepts it (reusing
// acceptedKindsFor -- the same rule connectionIsValid enforces, so a wire
// completed this way is always one connectionIsValid would already accept);
// dragging from a TARGET (input) handle looks for candidates with an OUTPUT
// port of exactly that kind.
export function nodeKindsForWire(handleType: "source" | "target", portKind: PortKind): NodeKind[] {
  return NODE_KINDS.filter((candidate) => {
    const spec = specFor(candidate);
    return handleType === "source"
      ? spec.inputs.some((port) => acceptedKindsFor(port).includes(portKind))
      : spec.outputs.some((port) => port.kind === portKind);
  });
}

export function downstreamOf(edges: Edge[], nodeId: string): Set<string> {
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    const list = outgoing.get(edge.source) ?? [];
    list.push(edge.target);
    outgoing.set(edge.source, list);
  }
  const result = new Set<string>();
  const queue = [nodeId];
  while (queue.length) {
    const current = queue.pop()!;
    for (const next of outgoing.get(current) ?? []) {
      if (!result.has(next)) {
        result.add(next);
        queue.push(next);
      }
    }
  }
  return result;
}

const MAX_RUNS_PER_NODE = 8;

type WorkbenchStore = {
  nodes: WorkbenchNode[];
  edges: Edge[];
  running: boolean;
  // Global run-mode flag: when true, nodes declaring a draftOverride run (and
  // sign) their cheaper draft variant. No UI toggles it yet; the executor and
  // signature already honor it.
  draft: boolean;
  dirtyStamp: number; // bumped on any persistable change (incl. drags); drives the lightweight structure-only autosave
  // Bumped ONLY on new-run, pin-toggle, and upload/source-change events --
  // never on position drags or plain param edits. Drives the separate,
  // heavier autosave pass that reads/writes the split-blob store and runs
  // byte-budget eviction (persistence.ts's saveGraph), so dragging a node
  // around the canvas never touches a single blob (AC16).
  blobStamp: number;
  onNodesChange: (changes: NodeChange<WorkbenchNode>[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;
  // Returns the new node's id so callers (e.g. Spotlight's drag-wire-to-empty-
  // canvas flow) can immediately wire an edge to/from it.
  addNode: (kind: NodeKind, position: { x: number; y: number }) => string;
  updateParams: (id: string, patch: Partial<WorkbenchParams>) => void;
  setStatus: (id: string, status: NodeStatus, error?: string, progress?: string) => void;
  applyRun: (id: string, run: NodeRun) => void;
  // Reference Finder's human-in-the-loop pause (AC5): parks the node in
  // "needs-selection" with its candidates instead of a completed run.
  setPendingSelection: (id: string, pending: PendingReferenceSelection) => void;
  setActiveRun: (id: string, index: number) => void;
  // Output pinning (AC15): pins `runs[index]` as this node's permanent
  // output (also browses to it), or clears the pin with index null. A
  // history entry is "promoted to pinned" by calling this with its index.
  setPinned: (id: string, index: number | null) => void;
  setRunning: (running: boolean) => void;
  setDraft: (draft: boolean) => void;
  // Explicit blob-ownership-changed event for the rare mutation path that
  // doesn't already go through applyRun/setPinned (maskedEdit's mask upload
  // rewrites maskCacheKey via updateParams alone -- see maskedEdit.tsx).
  touchBlobs: () => void;
  loadGraph: (nodes: WorkbenchNode[], edges: Edge[]) => void;
  // Appends a pre-built subgraph onto whatever's already on the canvas
  // (rather than replacing it, unlike loadGraph) -- shared by the templates
  // gallery (AC19, always onto an empty canvas) and JSON import (AC18, which
  // may add to an existing graph). New nodes may carry freshly cached blobs,
  // so this bumps blobStamp too (the heavier autosave pass persists them).
  importGraph: (nodes: WorkbenchNode[], edges: Edge[]) => void;
};

export const useWorkbenchStore = create<WorkbenchStore>((set, get) => ({
  nodes: [],
  edges: [],
  running: false,
  draft: false,
  dirtyStamp: 0,
  blobStamp: 0,

  onNodesChange: (changes) => {
    for (const change of changes) {
      if (change.type === "remove") releaseByPrefix(`${change.id}:`);
    }
    const removed = changes.some((change) => change.type === "remove");
    const structural = removed || changes.some((change) => change.type === "position");
    set((state) => ({
      nodes: applyNodeChanges(changes, state.nodes),
      dirtyStamp: structural ? Date.now() : state.dirtyStamp,
      // A removed node's blobs need GC'ing out of the persisted store too
      // (not just the in-memory cache above) -- that's a blob-ownership
      // change, unlike a plain position drag.
      blobStamp: removed ? Date.now() : state.blobStamp,
    }));
  },

  onEdgesChange: (changes) => {
    const structural = changes.some((change) => change.type === "remove");
    const removedTargets = new Set(
      changes
        .filter((change) => change.type === "remove")
        .map((change) => get().edges.find((edge) => edge.id === change.id)?.target)
        .filter((target): target is string => Boolean(target)),
    );
    set((state) => {
      let nodes = state.nodes;
      if (removedTargets.size) {
        const stale = new Set<string>();
        for (const target of removedTargets) {
          stale.add(target);
          for (const id of downstreamOf(state.edges, target)) stale.add(id);
        }
        nodes = state.nodes.map((node) =>
          stale.has(node.id) && node.data.status === "done"
            ? { ...node, data: { ...node.data, status: "stale" as const } }
            : node,
        );
      }
      return {
        nodes,
        edges: applyEdgeChanges(changes, state.edges),
        dirtyStamp: structural ? Date.now() : state.dirtyStamp,
      };
    });
  },

  onConnect: (connection) => {
    const { nodes, edges } = get();
    if (!connectionIsValid(nodes, edges, connection)) return;
    const target = nodes.find((node) => node.id === connection.target);
    const targetPort = portSpecFor(target, connection.targetHandle, "in");
    set((state) => {
      // Single-input ports replace the existing connection.
      const kept = targetPort?.multi
        ? state.edges
        : state.edges.filter((edge) => !(edge.target === connection.target && edge.targetHandle === connection.targetHandle));
      const stale = new Set([connection.target!, ...downstreamOf(kept, connection.target!)]);
      return {
        edges: addEdge(connection, kept),
        nodes: state.nodes.map((node) =>
          stale.has(node.id) && node.data.status === "done"
            ? { ...node, data: { ...node.data, status: "stale" as const } }
            : node,
        ),
        dirtyStamp: Date.now(),
      };
    });
  },

  addNode: (kind, position) => {
    const node: WorkbenchNode = {
      id: `${kind}-${createNodeId()}`,
      type: kind,
      position,
      data: { kind, params: defaultParams(kind), status: "idle", runs: [], activeRun: 0 },
    };
    set((state) => ({ nodes: [...state.nodes, node], dirtyStamp: Date.now() }));
    return node.id;
  },

  updateParams: (id, patch) => {
    set((state) => {
      const stale = new Set([id, ...downstreamOf(state.edges, id)]);
      return {
        nodes: state.nodes.map((node) => {
          if (node.id === id) {
            const status = node.data.status === "done" ? ("stale" as const) : node.data.status;
            return { ...node, data: { ...node.data, params: { ...node.data.params, ...patch }, status } };
          }
          if (stale.has(node.id) && node.data.status === "done") {
            return { ...node, data: { ...node.data, status: "stale" as const } };
          }
          return node;
        }),
        dirtyStamp: Date.now(),
      };
    });
  },

  setStatus: (id, status, error, progress) => {
    set((state) => ({
      nodes: state.nodes.map((node) =>
        node.id === id ? { ...node, data: { ...node.data, status, error, progress } } : node,
      ),
    }));
  },

  applyRun: (id, run) => {
    set((state) => ({
      nodes: state.nodes.map((node) => {
        if (node.id !== id) return node;
        const runs = [run, ...node.data.runs].slice(0, MAX_RUNS_PER_NODE);
        return {
          ...node,
          data: {
            ...node.data,
            runs,
            activeRun: 0,
            // A brand-new run invalidates any previously pinned index -- it
            // no longer points at the same content. Clearing it here (rather
            // than leaving a stale index silently pointing at the wrong run)
            // keeps the pin badge truthful for the call sites that add a run
            // directly, bypassing the executor's pin guard (Photo re-upload,
            // References edits, Variations' candidate reselection). The
            // executor itself never calls applyRun for a pinned node, so this
            // is a no-op on the normal paid-node re-run path.
            pinnedOutput: undefined,
            status: "done" as const,
            error: undefined,
            progress: undefined,
            pendingSelection: undefined,
          },
        };
      }),
      // New-run event (AC16): drives both the structure autosave (the run's
      // metadata is part of the graph JSON) and the heavier blob write/GC
      // pass (persistence.ts's saveGraph persists this node's fresh active
      // output).
      dirtyStamp: Date.now(),
      blobStamp: Date.now(),
    }));
  },

  setPendingSelection: (id, pending) => {
    set((state) => ({
      nodes: state.nodes.map((node) =>
        node.id === id
          ? { ...node, data: { ...node.data, pendingSelection: pending, status: "needs-selection" as const, error: undefined, progress: undefined } }
          : node,
      ),
    }));
  },

  setActiveRun: (id, index) => {
    set((state) => ({
      nodes: state.nodes.map((node) =>
        node.id === id && index >= 0 && index < node.data.runs.length
          ? { ...node, data: { ...node.data, activeRun: index } }
          : node,
      ),
    }));
  },

  // Output pinning (AC15). Pinning also browses to the pinned entry (so the
  // card displays exactly what's now protected); unpinning (index null)
  // leaves activeRun where it is. Pin-toggle is one of the three events that
  // trigger the heavier blob write/GC autosave pass (AC16), so both stamps
  // bump: the pin flag is part of the graph-structure JSON, and the pinned
  // run's blobs must be durably written (and exempted from byte-budget
  // eviction) right away rather than waiting for the next unrelated run.
  setPinned: (id, index) => {
    set((state) => ({
      nodes: state.nodes.map((node) => {
        if (node.id !== id) return node;
        if (index === null) return { ...node, data: { ...node.data, pinnedOutput: undefined } };
        if (index < 0 || index >= node.data.runs.length) return node;
        return { ...node, data: { ...node.data, pinnedOutput: index, activeRun: index } };
      }),
      dirtyStamp: Date.now(),
      blobStamp: Date.now(),
    }));
  },

  setRunning: (running) => set({ running }),

  setDraft: (draft) => set({ draft }),

  touchBlobs: () => set({ blobStamp: Date.now() }),

  loadGraph: (nodes, edges) => set({ nodes, edges, dirtyStamp: 0, blobStamp: 0 }),

  importGraph: (nodes, edges) => {
    if (!nodes.length && !edges.length) return;
    set((state) => ({
      nodes: [...state.nodes, ...nodes],
      edges: [...state.edges, ...edges],
      dirtyStamp: Date.now(),
      blobStamp: Date.now(),
    }));
  },
}));
