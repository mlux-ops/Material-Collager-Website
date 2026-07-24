/* eslint-disable @next/next/no-img-element */
"use client";

import { Handle, Position, useEdges, type NodeProps } from "@xyflow/react";
import { useMemo, type ReactNode } from "react";
import { readApiResponse } from "@/app/lib/api-client";
import { optimizeReferencesForTransport } from "@/app/lib/image-transport";
import { getBlob, putBlob } from "../blob-cache";
import { formatUsd } from "../cost";
import { cancelExecution, runNodes } from "../executor";
import { useWorkbenchStore } from "../store";
import styles from "../workbench.module.css";
import {
  acceptedKindsFor,
  PORT_COLORS,
  type ExecuteContext,
  type NodeOutputValue,
  type NodeSpec,
  type WorkbenchNode,
  type WorkbenchNodeData,
} from "../types";
import {
  buildGenerationPayload,
  decodeBase64Image,
  GENERATION_QUALITIES,
  GENERATION_SIZES,
  imageCacheKeysFromValue,
} from "./generation";
import { estimateCostMap, specFor } from "./manifests";

export type WorkbenchNodeProps = NodeProps<WorkbenchNode>;

const STATUS_LABEL: Record<WorkbenchNodeData["status"], string> = {
  idle: "Idle",
  running: "Running",
  done: "Done",
  error: "Error",
  stale: "Stale",
};

function PortHandles({ spec }: { spec: NodeSpec }) {
  return (
    <>
      {spec.inputs.map((port, index) => (
        <Handle
          key={port.id}
          id={port.id}
          type="target"
          position={Position.Left}
          style={{ top: 44 + index * 22, background: PORT_COLORS[port.kind] }}
          title={`${port.label} (${acceptedKindsFor(port).join(" | ")}${port.multi ? ", multiple" : ""})`}
        />
      ))}
      {spec.outputs.map((port, index) => (
        <Handle
          key={port.id}
          id={port.id}
          type="source"
          position={Position.Right}
          style={{ top: 44 + index * 22, background: PORT_COLORS[port.kind] }}
          title={`${port.label} (${port.kind})`}
        />
      ))}
    </>
  );
}

export function NodeShell({ data, children, footer }: { data: WorkbenchNodeData; children: ReactNode; footer?: ReactNode }) {
  const spec = specFor(data.kind);
  return (
    <div className={`${styles.node} ${data.status === "error" ? styles.nodeError : ""}`}>
      <PortHandles spec={spec} />
      <header className={styles.nodeHeader}>
        <span className={styles.nodeTitle}>{spec.title}</span>
        <span className={`${styles.status} ${styles[`status_${data.status}`]}`}>{STATUS_LABEL[data.status]}</span>
      </header>
      <div className={styles.nodeBody}>{children}</div>
      {data.error && <p className={styles.errorText}>{data.error}</p>}
      {footer}
      <span className={styles.portLabels}>
        {spec.inputs.map((port) => <em key={port.id}>{port.label}</em>)}
      </span>
    </div>
  );
}

export function RunFooter({ id, data, inputImages }: { id: string; data: WorkbenchNodeData; inputImages: number }) {
  const running = useWorkbenchStore((state) => state.running);
  const estimateCost = estimateCostMap[data.kind];
  const estimate = estimateCost ? estimateCost({ params: data.params, inputImages }) : null;
  return (
    <div className={styles.runRow}>
      <button
        type="button"
        className={styles.runButton}
        disabled={running}
        onClick={() => void runNodes([id])}
      >
        Run{estimate !== null ? ` · ~${formatUsd(estimate)}` : ""}
      </button>
      {running && data.status === "running" && (
        <button type="button" className={styles.cancelButton} onClick={cancelExecution}>Cancel</button>
      )}
    </div>
  );
}

export function OutputPreview({ id, data }: { id: string; data: WorkbenchNodeData }) {
  const setActiveRun = useWorkbenchStore((state) => state.setActiveRun);
  const run = data.runs[data.activeRun];
  const image = run?.values[0]?.find((value) => value.kind === "image");
  if (!image || image.kind !== "image") return null;
  return (
    <figure className={styles.preview}>
      <img src={image.url} alt="Node output" draggable={false} />
      {data.runs.length > 1 && (
        <figcaption className={styles.history}>
          <button type="button" onClick={() => setActiveRun(id, Math.min(data.activeRun + 1, data.runs.length - 1))} disabled={data.activeRun >= data.runs.length - 1}>‹</button>
          <span>{data.runs.length - data.activeRun}/{data.runs.length}</span>
          <button type="button" onClick={() => setActiveRun(id, Math.max(data.activeRun - 1, 0))} disabled={data.activeRun <= 0}>›</button>
        </figcaption>
      )}
    </figure>
  );
}

export function useConnectedImageCount(id: string, portIds: string[]) {
  const edges = useEdges();
  return useMemo(
    () => edges.filter((edge) => edge.target === id && portIds.includes(edge.targetHandle || "")).length,
    [edges, id, portIds],
  );
}

export function GenerationSettings({ id, data }: { id: string; data: WorkbenchNodeData }) {
  const updateParams = useWorkbenchStore((state) => state.updateParams);
  return (
    <>
      <label className={styles.field}>
        <span>Size</span>
        <select className="nodrag" value={data.params.size} onChange={(event) => updateParams(id, { size: event.target.value })}>
          {GENERATION_SIZES.map((option) => <option key={option} value={option}>{option}{option === "2560x1440" ? " (2K)" : ""}</option>)}
        </select>
      </label>
      <label className={styles.field}>
        <span>Quality</span>
        <select className="nodrag" value={data.params.quality} onChange={(event) => updateParams(id, { quality: event.target.value as "low" | "medium" | "high" })}>
          {GENERATION_QUALITIES.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      </label>
    </>
  );
}

// ---------------------------------------------------------------------------
// DOM-side execution helpers (blob cache, object URLs, transport) shared by
// the execute wrappers in imageGenerate/imageEdit/saveToLibrary .tsx modules.
// ---------------------------------------------------------------------------

export function fileFromCacheKey(cacheKey: string): File {
  const blob = getBlob(cacheKey);
  if (!blob) throw new Error("An input image is no longer cached. Re-run its node.");
  return new File([blob], "input.png", { type: blob.type || "image/png" });
}

export async function blobFromImageValue(value: NodeOutputValue): Promise<File> {
  const [cacheKey] = imageCacheKeysFromValue(value);
  if (!cacheKey) throw new Error("Expected an image input.");
  return fileFromCacheKey(cacheKey);
}

// DOM-touching generation executor composing generation.ts's pure core:
// gathers cached input files, posts the request, and caches the returned
// images as object URLs.
export async function executeGeneration(ctx: ExecuteContext, options: { requireBaseImage: boolean }): Promise<void> {
  const payload = buildGenerationPayload(ctx.params, ctx.inputs("prompt"));

  const form = new FormData();
  const files: File[] = [];
  if (options.requireBaseImage) {
    const base = ctx.inputs("image");
    if (!base.length) throw new Error("Connect an input image first.");
    files.push(await blobFromImageValue(base[0]));
  }
  const references = ctx.inputs("references");
  if (references.length) {
    // Each plain image contributes one file; a references value expands to
    // its ordered image cacheKeys.
    const rawReferences = references.flatMap(imageCacheKeysFromValue).map(fileFromCacheKey);
    // The base image travels at full quality; supporting references share
    // the same transport budget the generator uses.
    const optimized = await optimizeReferencesForTransport(rawReferences);
    files.push(...optimized);
  }
  if (files.length > 16) throw new Error("A node can send at most 16 images.");

  form.append("payload", JSON.stringify(payload));
  for (const file of files) form.append("image[]", file, file.name);

  ctx.setProgress("Rendering…");
  const response = await fetch("/api/workbench/edit", { method: "POST", body: form, signal: ctx.signal })
    .then((value) => readApiResponse<{ ok: boolean; error?: string; images: string[]; mimeType: string; usage?: Record<string, unknown> }>(value));

  const runId = ctx.createRunId();
  const images: NodeOutputValue[] = response.images.map((base64, index) => {
    const cacheKey = `${ctx.nodeId}:${runId}:${index}`;
    const bytes = decodeBase64Image(base64);
    const cachedUrl = putBlob(cacheKey, new Blob([bytes], { type: response.mimeType || "image/png" }));
    return { kind: "image", url: cachedUrl, cacheKey };
  });
  ctx.applyRun({ runId, signature: ctx.signature, at: Date.now(), values: [images], usage: response.usage });
}
