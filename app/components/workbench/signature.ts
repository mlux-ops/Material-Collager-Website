// FRAMEWORK-FREE signature module: the single authoritative memoization key
// for node runs. Unit tests import this under Node's
// --experimental-strip-types runner, so it must never pull in .tsx, React,
// zustand, or "@/" path aliases — the executor injects live store access
// through SignatureContext instead.

import type { Edge } from "@xyflow/react";
import { draftOverrideMap, specFor, stableParamsMap } from "./nodes/manifests.ts";
import type { NodeRun, WorkbenchNode } from "./types";

function hash(value: string): string {
  let h = 5381;
  for (let index = 0; index < value.length; index += 1) {
    h = ((h << 5) + h + value.charCodeAt(index)) >>> 0;
  }
  return h.toString(36);
}

export function activeRunOf(node: WorkbenchNode): NodeRun | undefined {
  return node.data.runs[node.data.activeRun] ?? node.data.runs[0];
}

export type SignatureContext = {
  incoming: Map<string, Edge[]>; // keyed by target node id
  // Fresh node lookup (the store's current state): signatures computed late
  // in a run must see the runIds ancestors produced earlier in the same run.
  liveNode: (id: string) => WorkbenchNode | undefined;
  // Global run-mode flag. When true, nodes declaring a draftOverride hash
  // their EFFECTIVE draft request; nodes without one are byte-for-byte
  // unaffected by the toggle.
  draft: boolean;
};

// A node's signature covers its own settings plus the identity (runId) of
// every upstream output it consumes — matching runIds mean identical inputs,
// so the cached run can be reused without re-billing. Per-manifest
// stableParams strips presentation/run-artifact params (e.g. compare's split,
// saveToLibrary's savedJobId) before hashing.
export function signatureFor(context: SignatureContext, node: WorkbenchNode): string {
  const { kind } = node.data;
  const spec = specFor(kind);
  const override = context.draft ? draftOverrideMap[kind] : undefined;
  const effective = override ? override(node.data.params) : node.data.params;
  const stable = stableParamsMap[kind]?.(effective) ?? effective;
  const upstream = spec.inputs.map((port) => {
    const edges = (context.incoming.get(node.id) ?? []).filter((edge) => edge.targetHandle === port.id);
    return edges
      .map((edge) => {
        const live = context.liveNode(edge.source);
        const run = live ? activeRunOf(live) : undefined;
        return `${port.id}<${edge.source}#${run?.runId ?? "unrun"}`;
      })
      .join(",");
  });
  return hash(JSON.stringify([kind, stable, upstream]));
}
