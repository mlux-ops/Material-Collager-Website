import type { Edge } from "@xyflow/react";
import { imageCacheKeysFromValue } from "./nodes/generation";
import { executeMap, isExecutable } from "./nodes/index";
import { alwaysExecuteMap, draftOverrideMap, estimateCostMap, outputValuesFor } from "./nodes/manifests";
import { activeRunOf, isPinned, signatureFor, type SignatureContext } from "./signature";
import { downstreamOf, useWorkbenchStore } from "./store";
import { acceptedKindsFor, specFor, type ExecuteContext, type NodeOutputValue, type WorkbenchNode } from "./types";

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
    const fallbackPort = specFor(source.data.kind).outputs[0]?.id ?? "";
    const candidates = outputValuesFor(source, run, edge.sourceHandle ?? fallbackPort);
    if (candidates.length) values.push(candidates[0]);
  }
  return values;
}

// issue-6: the ACTUAL number of images arriving at a node, not "how many
// incoming edges" (a single References edge can expand to many images, and
// an edge on a text/report port carries none). Shares this exact expansion
// semantics with nodes/shared.tsx's useConnectedImageCount so the toolbar's
// stale-run aggregate and the per-node connected-image display always agree
// on what a run would actually bill.
function countConnectedImages(context: GraphContext, nodeId: string): number {
  const node = currentNode(nodeId);
  const spec = specFor(node.data.kind);
  const imagePortIds = new Set(
    spec.inputs
      .filter((port) => acceptedKindsFor(port).some((kind) => kind === "image" || kind === "references"))
      .map((port) => port.id),
  );
  if (!imagePortIds.size) return 0;
  let total = 0;
  for (const edge of context.incoming.get(nodeId) ?? []) {
    if (!imagePortIds.has(edge.targetHandle ?? "")) continue;
    const source = currentNode(edge.source);
    const run = activeRunOf(source);
    if (!run) continue;
    const fallbackPort = specFor(source.data.kind).outputs[0]?.id ?? "";
    const value = outputValuesFor(source, run, edge.sourceHandle ?? fallbackPort)[0];
    if (!value) continue;
    total += imageCacheKeysFromValue(value).length;
  }
  return total;
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
async function executeNode(context: GraphContext, nodeId: string, signature: string, draft: boolean, targetIds: string[]): Promise<void> {
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
    // Reference Finder only (AC5): parks the node awaiting a candidate pick
    // instead of applying a run, carrying the original run request's target
    // ids so picking a candidate can resume exactly this scheduled subtree.
    setAwaitingSelection: (payload) =>
      useWorkbenchStore.getState().setPendingSelection(nodeId, { ...payload, resumeTargets: targetIds, signature }),
  };
  await execute(ctx);
}

let currentController: AbortController | null = null;

export function cancelExecution() {
  currentController?.abort();
}

export type RunNodesOptions = {
  // N-2: targetIds' own shape can't distinguish "the user pressed this ONE
  // node's own button" from "runAll()'s terminal sweep happened to compute a
  // single-element target list" -- a graph whose SOLE terminal is an
  // Export/Download node produces the identical targetIds=[id] either way.
  // A caller that IS a dedicated per-node button (not a workflow-level
  // sweep) sets this so alwaysExecute-declaring kinds (Export/Download)
  // force-execute; runAll()/retryFrom omit it, so a Run Workflow press
  // always treats such a node as ordinarily memoized (a cache hit when
  // nothing changed), even for a single-terminal graph.
  explicitSingleNode?: boolean;
};

export async function runNodes(targetIds: string[], options: RunNodesOptions = {}): Promise<void> {
  const store = useWorkbenchStore.getState();
  // round 7 issue-1: every run path (runAll's workflow sweep AND every
  // per-node RunFooter button) funnels through this one function, so
  // gating it HERE is what makes "no writes of any kind while blocked"
  // (no paid API call, no applyRun) an actual guarantee rather than a UI
  // convention -- see WorkbenchApp.tsx's restore effect for what sets this.
  if (store.running || store.restoreBlocked) return;
  const controller = new AbortController();
  currentController = controller;
  store.setRunning(true);
  const explicitSingleNode = options.explicitSingleNode === true;
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

      // Output pinning (AC15): honored BEFORE the signature check. A pinned
      // node's output is authoritative -- it never re-runs or re-bills even
      // when stale (its own params or an ancestor changed), so the signature
      // for this node is never even computed while pinned.
      if (isPinned(node)) {
        if (node.data.status !== "done") useWorkbenchStore.getState().setStatus(id, "done");
        continue;
      }

      const signature = signatureFor(signatureContext, node);
      const cached = activeRunOf(node);
      // Terminal side-effect nodes (Export/Download, W-4) opt out of
      // memoization -- but ONLY for an explicit press of their OWN button
      // (N-2): otherwise runAll()'s terminal sweep would silently re-trigger
      // the side effect on every unrelated Run Workflow press whenever the
      // node happens to be a (or the sole) graph terminal. See
      // RunNodesOptions.explicitSingleNode above.
      const forceExecute =
        alwaysExecuteMap[node.data.kind] === true && explicitSingleNode && targetIds.length === 1 && targetIds[0] === id;
      if (!forceExecute && cached && cached.signature === signature && node.data.status !== "error") {
        if (node.data.status !== "done") useWorkbenchStore.getState().setStatus(id, "done");
        continue; // cache hit — no re-run, no re-bill
      }
      useWorkbenchStore.getState().setStatus(id, "running");
      try {
        await executeNode(context, id, signature, draft, targetIds);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          useWorkbenchStore.getState().setStatus(id, "idle");
          throw error;
        }
        useWorkbenchStore.getState().setStatus(id, "error", error instanceof Error ? error.message : "Node failed.");
        throw error;
      }
      // Human-in-the-loop hard stop (AC5): a node that just parked itself
      // awaiting a candidate pick halts the whole run here. Everything still
      // scheduled after it stays untouched (idle), not failed and not run.
      if (currentNode(id).data.status === "needs-selection") break;
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

// The order runNodes(targetIds) would actually schedule, without running
// anything -- shared by the stale-cost estimator and the Run Workflow
// button's disabled/blocking checks so both agree with the real executor.
function scheduledOrder(context: GraphContext, targetIds: string[]): string[] {
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
  return order;
}

// Aggregate estimate summed over ONLY the nodes about to actually run and
// bill (S27/AC21): skips non-executable/non-paid kinds, pinned nodes (the
// executor never re-bills them), and cache hits (unchanged signature) --
// mirroring runNodes' own scheduling/skip logic exactly so the Run Workflow
// button's number never overstates what a press would actually cost.
export function estimateStaleCost(targetIds: string[]): { totalUsd: number | null; staleCount: number } {
  const { nodes, edges, draft } = useWorkbenchStore.getState();
  const context = buildContext(nodes, edges, new AbortController().signal);
  const signatureContext = signatureContextFor(context, draft);
  let total = 0;
  let counted = false;
  let staleCount = 0;
  for (const id of scheduledOrder(context, targetIds)) {
    const node = currentNode(id);
    if (!isExecutable(node.data.kind) || isPinned(node)) continue;
    const signature = signatureFor(signatureContext, node);
    const cached = activeRunOf(node);
    // N-2: estimateStaleCost only ever represents the WORKFLOW-level
    // aggregate (WorkbenchApp.tsx's terminalIds sweep), never a single
    // explicit node press -- it must mirror runNodes' now-scoped
    // alwaysExecute behavior and so never treats an alwaysExecute node
    // (Export/Download) as force-stale here; it is a genuine cache hit like
    // any other memoized node when nothing changed, matching what a Run
    // Workflow press will actually do.
    if (cached && cached.signature === signature && node.data.status !== "error") continue; // cache hit — no charge
    staleCount += 1;
    const estimateCost = estimateCostMap[node.data.kind];
    if (!estimateCost) continue;
    const override = draft ? draftOverrideMap[node.data.kind] : undefined;
    const effectiveParams = override ? override(node.data.params) : node.data.params;
    const inputImages = countConnectedImages(context, id);
    const value = estimateCost({ params: effectiveParams, inputImages });
    if (value !== null) {
      total += value;
      counted = true;
    }
  }
  return { totalUsd: counted ? total : null, staleCount };
}

// Every required input port (across every scheduled node) that has no edge
// connected -- the Run Workflow button's disabled-with-reason surface
// (S29/AC24). Returns node-id/label pairs so the UI can name the culprit.
export function unmetRequiredInputs(targetIds: string[]): Array<{ nodeId: string; label: string; missing: string[] }> {
  const { nodes, edges } = useWorkbenchStore.getState();
  const context = buildContext(nodes, edges, new AbortController().signal);
  const problems: Array<{ nodeId: string; label: string; missing: string[] }> = [];
  for (const id of scheduledOrder(context, targetIds)) {
    const node = currentNode(id);
    const spec = specFor(node.data.kind);
    const connected = new Set((context.incoming.get(id) ?? []).map((edge) => edge.targetHandle));
    // C1: a required port can also be satisfied by a param value with no
    // connection at all (e.g. Reference Finder's query override) --
    // satisfiedByParams lets the port declare that without dropping
    // required entirely.
    const missing = spec.inputs
      .filter((port) => port.required && !connected.has(port.id) && !port.satisfiedByParams?.(node.data.params))
      .map((port) => port.label);
    if (missing.length) problems.push({ nodeId: id, label: spec.title, missing });
  }
  return problems;
}

// Retry-from-failed-node (S29/AC24): re-runs the failed node plus everything
// downstream of it. Every already-succeeded ANCESTOR of the failed node stays
// a cache hit (runNodes' own signature check skips them, no re-billing);
// downstream nodes that never got a chance to run execute normally once the
// retry clears the failure.
export async function retryFrom(nodeId: string): Promise<void> {
  const { edges } = useWorkbenchStore.getState();
  const downstream = [...downstreamOf(edges, nodeId)];
  await runNodes([nodeId, ...downstream]);
}
