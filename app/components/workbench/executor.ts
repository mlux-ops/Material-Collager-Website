import type { Edge } from "@xyflow/react";
import { executeMap, isExecutable } from "./nodes/index";
import { draftOverrideMap } from "./nodes/manifests";
import { activeRunOf, signatureFor, type SignatureContext } from "./signature";
import { useWorkbenchStore } from "./store";
import { specFor, type ExecuteContext, type NodeOutputValue, type WorkbenchNode } from "./types";

// Client-orchestrated execution: the browser is the scheduler (the host has
// no server-side queues), one API call per paid node, with ComfyUI-style
// signature memoization so unchanged nodes never re-run or re-bill. Node
// behavior lives in the registry (./nodes): dispatch goes through executeMap,
// memoization keys through signature.ts.

function createRunId() {
  return globalThis.crypto?.randomUUID?.().slice(0, 8) ?? `${Date.now()}`;
}

type GraphContext = {
  nodes: Map<string, WorkbenchNode>;
  incoming: Map<string, Edge[]>; // keyed by target node id
  signal: AbortSignal;
};

function buildContext(nodes: WorkbenchNode[], edges: Edge[], signal: AbortSignal): GraphContext {
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const incoming = new Map<string, Edge[]>();
  for (const edge of edges) {
    const list = incoming.get(edge.target) ?? [];
    list.push(edge);
    incoming.set(edge.target, list);
  }
  return { nodes: nodeMap, incoming, signal };
}

function currentNode(id: string): WorkbenchNode {
  const node = useWorkbenchStore.getState().nodes.find((candidate) => candidate.id === id);
  if (!node) throw new Error("A connected node was removed mid-run.");
  return node;
}

// Ordered upstream values arriving at one input port.
function inputValues(context: GraphContext, nodeId: string, portId: string): NodeOutputValue[] {
  const edges = (context.incoming.get(nodeId) ?? []).filter((edge) => edge.targetHandle === portId);
  const values: NodeOutputValue[] = [];
  for (const edge of edges) {
    const source = currentNode(edge.source);
    const run = activeRunOf(source);
    if (!run) continue;
    const spec = specFor(source.data.kind);
    const portIndex = spec.outputs.findIndex((port) => port.id === edge.sourceHandle);
    const candidates = run.values[portIndex >= 0 ? portIndex : 0] ?? [];
    if (candidates.length) values.push(candidates[0]);
  }
  return values;
}

function signatureContextFor(context: GraphContext, draft: boolean): SignatureContext {
  return {
    incoming: context.incoming,
    liveNode: (id) => useWorkbenchStore.getState().nodes.find((candidate) => candidate.id === id),
    draft,
  };
}

function ancestorsOf(context: GraphContext, nodeId: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    for (const edge of context.incoming.get(id) ?? []) {
      if (!seen.has(edge.source)) {
        seen.add(edge.source);
        visit(edge.source);
        result.push(edge.source);
      }
    }
  };
  visit(nodeId);
  return result; // already in dependency order (post-order)
}

// Registry dispatch: look the node's execute up in executeMap and hand it an
// ExecuteContext. Draft mode swaps in the manifest's cheaper effective params
// for nodes that declare a draftOverride — the same params signatureFor
// hashes, so the request and its memoization key can never diverge.
async function executeNode(context: GraphContext, nodeId: string, signature: string, draft: boolean): Promise<void> {
  const node = currentNode(nodeId);
  const execute = executeMap[node.data.kind];
  if (!execute) return;
  const override = draft ? draftOverrideMap[node.data.kind] : undefined;
  const ctx: ExecuteContext = {
    nodeId,
    node,
    params: override ? override(node.data.params) : node.data.params,
    signature,
    signal: context.signal,
    inputs: (portId) => inputValues(context, nodeId, portId),
    createRunId,
    applyRun: (run) => useWorkbenchStore.getState().applyRun(nodeId, run),
    setProgress: (message) => useWorkbenchStore.getState().setStatus(nodeId, "running", undefined, message),
  };
  await execute(ctx);
}

let currentController: AbortController | null = null;

export function cancelExecution() {
  currentController?.abort();
}

export async function runNodes(targetIds: string[]): Promise<void> {
  const store = useWorkbenchStore.getState();
  if (store.running) return;
  const controller = new AbortController();
  currentController = controller;
  store.setRunning(true);
  try {
    const { nodes, edges, draft } = useWorkbenchStore.getState();
    const context = buildContext(nodes, edges, controller.signal);
    const signatureContext = signatureContextFor(context, draft);

    // Pull model: each requested node runs after its ancestors, oldest first,
    // deduplicated across targets.
    const order: string[] = [];
    const scheduled = new Set<string>();
    for (const targetId of targetIds) {
      for (const id of [...ancestorsOf(context, targetId), targetId]) {
        if (!scheduled.has(id)) {
          scheduled.add(id);
          order.push(id);
        }
      }
    }

    for (const id of order) {
      if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
      const node = currentNode(id);
      if (!isExecutable(node.data.kind)) continue;
      const signature = signatureFor(signatureContext, node);
      const cached = activeRunOf(node);
      if (cached && cached.signature === signature && node.data.status !== "error") {
        if (node.data.status !== "done") useWorkbenchStore.getState().setStatus(id, "done");
        continue; // cache hit — no re-run, no re-bill
      }
      useWorkbenchStore.getState().setStatus(id, "running");
      try {
        await executeNode(context, id, signature, draft);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          useWorkbenchStore.getState().setStatus(id, "idle");
          throw error;
        }
        useWorkbenchStore.getState().setStatus(id, "error", error instanceof Error ? error.message : "Node failed.");
        throw error;
      }
    }
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "AbortError")) {
      // The failing node already carries the message; execution stops there.
    }
  } finally {
    useWorkbenchStore.getState().setRunning(false);
    currentController = null;
  }
}

export async function runAll(): Promise<void> {
  const { nodes, edges } = useWorkbenchStore.getState();
  // Terminal runnable nodes: everything that nothing else depends on. Non-
  // executable terminals (e.g. compare) stay in as targets so their
  // ancestors still run; notes have no inputs, so excluding them just keeps
  // the schedule clean.
  const withOutgoing = new Set(edges.map((edge) => edge.source));
  const terminals = nodes
    .filter((node) => !withOutgoing.has(node.id) && node.data.kind !== "note")
    .map((node) => node.id);
  await runNodes(terminals);
}
