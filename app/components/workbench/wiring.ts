// The canvas's wire rules: which output may feed which input, which ports a
// wire being dragged could land on, and -- for a wire released on a card's
// body instead of on one of its handles -- which port it should attach to.
//
// FRAMEWORK-FREE on purpose, under the same contract as nodes/manifests.ts:
// tests/workbench-wiring.test.mjs imports this module under Node's
// --experimental-strip-types runner, so relative runtime imports carry
// explicit .ts extensions (Node's ESM loader does no extension searching),
// @xyflow/react is imported for TYPES only (the library itself needs a DOM),
// and nothing here touches React, the DOM, or the store. store.ts re-exports
// connectionIsValid/nodeKindsForWire/portSpecFor so existing imports keep
// working.

import type { Connection, Edge } from "@xyflow/react";
import { activeOutputPortsFor, NODE_KINDS, specFor } from "./nodes/manifests.ts";
import { acceptedKindsFor, type NodeKind, type PortSpec, type WorkbenchNode } from "./types.ts";

// The fixed end of a wire while it is being dragged: the handle the drag
// started on. A drag can begin at either end -- from an output ("source")
// toward an input, or backwards from an input ("target") toward an output.
export type WireEnd = {
  nodeId: string;
  handleId: string | null;
  handleType: "source" | "target";
};

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
// hand-maintained list. Both directions apply acceptedKindsFor -- the same
// rule connectionIsValid enforces, so a wire completed this way is always one
// connectionIsValid would already accept. Dragging from a SOURCE (output)
// `port` looks for candidates with an INPUT that accepts its kind; dragging
// backwards from a TARGET (input) `port` looks for candidates with an OUTPUT
// of any kind that input accepts (Image Edit's References input offers the
// References node, not only image producers).
export function nodeKindsForWire(handleType: "source" | "target", port: PortSpec): NodeKind[] {
  const accepted = acceptedKindsFor(port);
  return NODE_KINDS.filter((candidate) => {
    const spec = specFor(candidate);
    return handleType === "source"
      ? spec.inputs.some((input) => acceptedKindsFor(input).includes(port.kind))
      : spec.outputs.some((output) => accepted.includes(output.kind));
  });
}

// The connection a wire dragged from `from` would make if it landed on
// `portId` of node `nodeId`, oriented source -> target whichever end the
// drag started from.
function connectionTo(from: WireEnd, nodeId: string, portId: string): Connection {
  return from.handleType === "source"
    ? { source: from.nodeId, sourceHandle: from.handleId, target: nodeId, targetHandle: portId }
    : { source: nodeId, sourceHandle: portId, target: from.nodeId, targetHandle: from.handleId };
}

// The ports on the opposite side of `node` -- its inputs for a drag that
// started on an output, its outputs for one that started on an input -- that
// the wire being dragged could validly land on, in declared order. Drives the
// drag-time port highlighting. Every declared output is considered, hidden
// ones included (Variations' unrevealed variation-N): the card only ever
// renders the visible subset, so a hidden id in the list is inert.
export function compatiblePorts(nodes: WorkbenchNode[], edges: Edge[], from: WireEnd, node: WorkbenchNode): PortSpec[] {
  if (node.id === from.nodeId) return [];
  const spec = specFor(node.data.kind);
  const ports = from.handleType === "source" ? spec.inputs : spec.outputs;
  return ports.filter((port) => connectionIsValid(nodes, edges, connectionTo(from, node.id, port.id)));
}

// Drop-a-wire-anywhere-on-a-card: picks the port a wire released over
// `targetNodeId`'s body (not on one of its handles) should attach to, or null
// when none can take it -- the caller then does nothing, it never falls back
// to the empty-canvas prompt over a card.
//
// From an output, the candidates are the card's inputs that pass
// connectionIsValid, ranked by tier and then declared order:
//   1. single ports with no incoming wire -- fills a gap without disturbing
//      anything already wired;
//   2. multi ports -- appending to one never removes an existing wire;
//   3. occupied single ports -- onConnect replaces that port's wire, which is
//      exactly what dropping on that handle directly would have done.
// Backwards from an input, it is the first ACTIVE output in declared order
// that passes connectionIsValid: activeOutputPortsFor leaves out outputs a
// card is not currently showing (Variations' hidden variation-N), so the wire
// always lands on a handle the user can see -- for Variations, its aggregate
// "image" output.
export function autoAttachConnection(
  nodes: WorkbenchNode[],
  edges: Edge[],
  from: WireEnd,
  targetNodeId: string,
): Connection | null {
  if (targetNodeId === from.nodeId) return null;
  const target = nodes.find((node) => node.id === targetNodeId);
  if (!target) return null;

  if (from.handleType === "target") {
    const output = activeOutputPortsFor(target).find((port) =>
      connectionIsValid(nodes, edges, connectionTo(from, targetNodeId, port.id)),
    );
    return output ? connectionTo(from, targetNodeId, output.id) : null;
  }

  const occupied = new Set(edges.filter((edge) => edge.target === targetNodeId).map((edge) => edge.targetHandle));
  const tier = (port: PortSpec) => (port.multi ? 1 : occupied.has(port.id) ? 2 : 0);
  // Array.prototype.sort is stable, so declared order survives within a tier.
  const [best] = compatiblePorts(nodes, edges, from, target).sort((a, b) => tier(a) - tier(b));
  return best ? connectionTo(from, targetNodeId, best.id) : null;
}
