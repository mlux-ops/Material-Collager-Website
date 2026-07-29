import type { Edge } from "@xyflow/react";
import { activeOutputPortsFor, outputValuesFor, specFor } from "./nodes/manifests.ts";
import { activeRunOf } from "./signature.ts";
import type { NodeOutputValue, WorkbenchNode } from "./types";

export type FinalImageOutput = {
  nodeId: string;
  runId: string;
  identity: string;
  value: Extract<NodeOutputValue, { kind: "image" }>;
};

// Collect the image values that represent completed terminal branches.
// Image-producing terminals contribute every candidate. Text/report/download
// terminals contribute the first image actually arriving at each image input,
// matching executor input semantics. Explicit Save to Library terminals are
// skipped because their own successful run has already persisted that image.
export function collectFinalImageOutputs(nodes: WorkbenchNode[], edges: Edge[]): FinalImageOutput[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const withOutgoing = new Set(edges.map((edge) => edge.source));
  const terminals = nodes.filter(
    (node) => !withOutgoing.has(node.id) && node.data.kind !== "note" && node.data.kind !== "saveToLibrary",
  );
  const results: FinalImageOutput[] = [];
  const seenCacheKeys = new Set<string>();

  const add = (nodeId: string, runId: string, signature: string, value: NodeOutputValue | undefined) => {
    if (!value || value.kind !== "image" || seenCacheKeys.has(value.cacheKey)) return;
    seenCacheKeys.add(value.cacheKey);
    results.push({
      nodeId,
      runId,
      // `runId` can change for a presentation-only candidate selection. The
      // request signature plus stable output cache key identifies the actual
      // image content without suppressing a newly uploaded Photo (whose
      // signature changes even though its node-owned cache key is reused).
      identity: `${nodeId}:${signature}:${value.cacheKey}`,
      value,
    });
  };

  for (const terminal of terminals) {
    const terminalRun = activeRunOf(terminal);
    let emittedImage = false;
    if (terminalRun) {
      for (const port of activeOutputPortsFor(terminal)) {
        if (port.kind !== "image") continue;
        const value = outputValuesFor(terminal, terminalRun, port.id)[0];
        if (value?.kind === "image") emittedImage = true;
        add(terminal.id, terminalRun.runId, terminalRun.signature, value);
      }
    }
    if (emittedImage) continue;

    const terminalSpec = specFor(terminal.data.kind);
    const imageInputIds = new Set(terminalSpec.inputs.filter((port) => port.kind === "image").map((port) => port.id));
    for (const edge of edges) {
      if (edge.target !== terminal.id || !imageInputIds.has(edge.targetHandle ?? "")) continue;
      const source = byId.get(edge.source);
      const sourceRun = source ? activeRunOf(source) : undefined;
      if (!source || !sourceRun) continue;
      const fallbackPort = specFor(source.data.kind).outputs[0]?.id ?? "";
      const value = outputValuesFor(source, sourceRun, edge.sourceHandle ?? fallbackPort)[0];
      add(source.id, sourceRun.runId, sourceRun.signature, value);
    }
  }
  return results;
}
