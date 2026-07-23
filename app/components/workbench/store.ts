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
import {
  defaultParams,
  specFor,
  type NodeKind,
  type NodeRun,
  type NodeStatus,
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

// Type-checked, acyclic connections: an output can only reach an input of the
// same data kind, and a connection that would create a cycle is refused.
export function connectionIsValid(nodes: WorkbenchNode[], edges: Edge[], connection: Connection | Edge): boolean {
  if (!connection.source || !connection.target || connection.source === connection.target) return false;
  const source = nodes.find((node) => node.id === connection.source);
  const target = nodes.find((node) => node.id === connection.target);
  const sourcePort = portSpecFor(source, connection.sourceHandle, "out");
  const targetPort = portSpecFor(target, connection.targetHandle, "in");
  if (!sourcePort || !targetPort || sourcePort.kind !== targetPort.kind) return false;

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
  dirtyStamp: number; // bumped on any persistable change; drives autosave
  onNodesChange: (changes: NodeChange<WorkbenchNode>[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;
  addNode: (kind: NodeKind, position: { x: number; y: number }) => void;
  updateParams: (id: string, patch: Partial<WorkbenchParams>) => void;
  setStatus: (id: string, status: NodeStatus, error?: string, progress?: string) => void;
  applyRun: (id: string, run: NodeRun) => void;
  setActiveRun: (id: string, index: number) => void;
  setRunning: (running: boolean) => void;
  loadGraph: (nodes: WorkbenchNode[], edges: Edge[]) => void;
};

export const useWorkbenchStore = create<WorkbenchStore>((set, get) => ({
  nodes: [],
  edges: [],
  running: false,
  dirtyStamp: 0,

  onNodesChange: (changes) => {
    for (const change of changes) {
      if (change.type === "remove") releaseByPrefix(`${change.id}:`);
    }
    const structural = changes.some((change) => change.type === "remove" || change.type === "position");
    set((state) => ({
      nodes: applyNodeChanges(changes, state.nodes),
      dirtyStamp: structural ? Date.now() : state.dirtyStamp,
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
        return { ...node, data: { ...node.data, runs, activeRun: 0, status: "done" as const, error: undefined, progress: undefined } };
      }),
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

  setRunning: (running) => set({ running }),

  loadGraph: (nodes, edges) => set({ nodes, edges, dirtyStamp: 0 }),
}));
