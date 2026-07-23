import type { Edge } from "@xyflow/react";
import { readApiResponse } from "@/app/lib/api-client";
import { optimizeReferencesForTransport } from "@/app/lib/image-transport";
import { getBlob, putBlob } from "./blob-cache";
import { useWorkbenchStore } from "./store";
import { specFor, type NodeOutputValue, type NodeRun, type WorkbenchNode } from "./types";

// Client-orchestrated execution: the browser is the scheduler (the host has
// no server-side queues), one API call per paid node, with ComfyUI-style
// signature memoization so unchanged nodes never re-run or re-bill.

function hash(value: string): string {
  let h = 5381;
  for (let index = 0; index < value.length; index += 1) {
    h = ((h << 5) + h + value.charCodeAt(index)) >>> 0;
  }
  return h.toString(36);
}

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

function activeRun(node: WorkbenchNode): NodeRun | undefined {
  return node.data.runs[node.data.activeRun] ?? node.data.runs[0];
}

// Ordered upstream values arriving at one input port.
function inputValues(context: GraphContext, nodeId: string, portId: string): NodeOutputValue[] {
  const edges = (context.incoming.get(nodeId) ?? []).filter((edge) => edge.targetHandle === portId);
  const values: NodeOutputValue[] = [];
  for (const edge of edges) {
    const source = currentNode(edge.source);
    const run = activeRun(source);
    if (!run) continue;
    const spec = specFor(source.data.kind);
    const portIndex = spec.outputs.findIndex((port) => port.id === edge.sourceHandle);
    const candidates = run.values[portIndex >= 0 ? portIndex : 0] ?? [];
    if (candidates.length) values.push(candidates[0]);
  }
  return values;
}

// A node's signature covers its own settings plus the identity (runId) of
// every upstream output it consumes — matching runIds mean identical inputs,
// so the cached run can be reused without re-billing.
function signatureFor(context: GraphContext, node: WorkbenchNode): string {
  const spec = specFor(node.data.kind);
  const { savedJobId: _saved, split: _split, ...stableParams } = node.data.params;
  const upstream = spec.inputs.map((port) => {
    const edges = (context.incoming.get(node.id) ?? []).filter((edge) => edge.targetHandle === port.id);
    return edges
      .map((edge) => {
        const source = context.nodes.get(edge.source);
        const live = source ? useWorkbenchStore.getState().nodes.find((candidate) => candidate.id === source.id) : undefined;
        const run = live ? activeRun(live) : undefined;
        return `${port.id}<${edge.source}#${run?.runId ?? "unrun"}`;
      })
      .join(",");
  });
  return hash(JSON.stringify([node.data.kind, stableParams, upstream]));
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

async function blobFromImageValue(value: NodeOutputValue): Promise<File> {
  if (value.kind !== "image") throw new Error("Expected an image input.");
  const blob = getBlob(value.cacheKey);
  if (!blob) throw new Error("An input image is no longer cached. Re-run its node.");
  return new File([blob], "input.png", { type: blob.type || "image/png" });
}

async function executeNode(context: GraphContext, nodeId: string, signature: string): Promise<void> {
  const store = useWorkbenchStore.getState();
  const node = currentNode(nodeId);
  const { kind, params } = node.data;

  if (kind === "note" || kind === "compare") return;

  if (kind === "photo") {
    // Photo runs are created at upload time; nothing to execute.
    if (!node.data.runs.length) throw new Error("Choose an image for this Photo node first.");
    return;
  }

  if (kind === "text") {
    const text = (params.text ?? "").trim();
    if (!text) throw new Error("Enter some text first.");
    store.applyRun(nodeId, { runId: createRunId(), signature, at: Date.now(), values: [[{ kind: "text", text }]] });
    return;
  }

  if (kind === "promptBuilder") {
    const extra = inputValues(context, nodeId, "extra")
      .map((value) => (value.kind === "text" ? value.text : ""))
      .filter(Boolean)
      .join("\n");
    const domainLine = {
      interior: "Photorealistic interior architectural rendering. Preserve the room's geometry, camera position, and perspective exactly.",
      exterior: "Photorealistic exterior architectural rendering. Preserve the building massing, site context, camera position, and perspective exactly.",
      collage: "Clean editorial material collage on a pure white background, professionally lit, every item cleanly isolated.",
    }[params.domain ?? "interior"];
    const parts = [
      domainLine,
      params.lighting ? `Lighting: ${params.lighting}.` : "",
      params.styleDirection ? `Style: ${params.styleDirection}.` : "",
      params.extraDirection?.trim() ?? "",
      extra,
    ].filter(Boolean);
    store.applyRun(nodeId, { runId: createRunId(), signature, at: Date.now(), values: [[{ kind: "text", text: parts.join("\n") }]] });
    return;
  }

  if (kind === "imageGenerate" || kind === "imageEdit") {
    const promptParts = inputValues(context, nodeId, "prompt")
      .map((value) => (value.kind === "text" ? value.text : ""))
      .filter(Boolean);
    if (!promptParts.length) throw new Error("Connect a prompt (Text or Prompt Builder) first.");

    const form = new FormData();
    const files: File[] = [];
    if (kind === "imageEdit") {
      const base = inputValues(context, nodeId, "image");
      if (!base.length) throw new Error("Connect an input image first.");
      files.push(await blobFromImageValue(base[0]));
    }
    const references = inputValues(context, nodeId, "references");
    if (references.length) {
      const rawReferences = await Promise.all(references.map(blobFromImageValue));
      // The base image travels at full quality; supporting references share
      // the same transport budget the generator uses.
      const optimized = await optimizeReferencesForTransport(rawReferences);
      files.push(...optimized);
    }
    if (files.length > 16) throw new Error("A node can send at most 16 images.");

    form.append("payload", JSON.stringify({
      prompt: promptParts.join("\n"),
      size: params.size || "1536x1024",
      quality: params.quality || "medium",
      n: params.candidates || 1,
    }));
    for (const file of files) form.append("image[]", file, file.name);

    useWorkbenchStore.getState().setStatus(nodeId, "running", undefined, "Rendering…");
    const response = await fetch("/api/workbench/edit", { method: "POST", body: form, signal: context.signal })
      .then((value) => readApiResponse<{ ok: boolean; error?: string; images: string[]; mimeType: string; usage?: Record<string, unknown> }>(value));

    const runId = createRunId();
    const images: NodeOutputValue[] = response.images.map((base64, index) => {
      const cacheKey = `${nodeId}:${runId}:${index}`;
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      const cachedUrl = putBlob(cacheKey, new Blob([bytes], { type: response.mimeType || "image/png" }));
      return { kind: "image", url: cachedUrl, cacheKey };
    });
    useWorkbenchStore.getState().applyRun(nodeId, { runId, signature, at: Date.now(), values: [images], usage: response.usage });
    return;
  }

  if (kind === "saveToLibrary") {
    const image = inputValues(context, nodeId, "image");
    if (!image.length) throw new Error("Connect an image to save.");
    const file = await blobFromImageValue(image[0]);
    const form = new FormData();
    form.append("payload", JSON.stringify({ filename: params.filename || "workbench-output.png", prompt: "Workbench output", format: "workbench" }));
    form.append("image", file, file.name);
    const response = await fetch("/api/workbench/save", { method: "POST", body: form, signal: context.signal })
      .then((value) => readApiResponse<{ ok: boolean; error?: string; jobId: string }>(value));
    useWorkbenchStore.getState().applyRun(nodeId, {
      runId: createRunId(),
      signature,
      at: Date.now(),
      values: [],
      usage: { jobId: response.jobId },
    });
    return;
  }
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
    const { nodes, edges } = useWorkbenchStore.getState();
    const context = buildContext(nodes, edges, controller.signal);

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
      if (node.data.kind === "note" || node.data.kind === "compare") continue;
      const signature = signatureFor(context, node);
      const cached = node.data.runs[node.data.activeRun] ?? node.data.runs[0];
      if (cached && cached.signature === signature && node.data.status !== "error") {
        if (node.data.status !== "done") useWorkbenchStore.getState().setStatus(id, "done");
        continue; // cache hit — no re-run, no re-bill
      }
      useWorkbenchStore.getState().setStatus(id, "running");
      try {
        await executeNode(context, id, signature);
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
  // Terminal runnable nodes: everything that nothing else depends on.
  const withOutgoing = new Set(edges.map((edge) => edge.source));
  const terminals = nodes
    .filter((node) => !withOutgoing.has(node.id) && node.data.kind !== "note")
    .map((node) => node.id);
  await runNodes(terminals);
}
