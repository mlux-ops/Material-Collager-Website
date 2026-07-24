/* eslint-disable @next/next/no-img-element */
"use client";

import type { Edge } from "@xyflow/react";
import { Handle, Position, useEdges, type NodeProps } from "@xyflow/react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { readApiResponse } from "@/app/lib/api-client";
import { optimizeReferencesForTransport } from "@/app/lib/image-transport";
import { ensureThumbnail, getBlob, putBlob } from "../blob-cache";
import { confirmHighCost, formatUsd, recordImageTokenCalibration } from "../cost";
import { cancelExecution, retryFrom, runNodes } from "../executor";
import { activeRunOf, signatureFor, type SignatureContext } from "../signature";
import { useWorkbenchStore } from "../store";
import styles from "../workbench.module.css";
import {
  acceptedKindsFor,
  PORT_COLORS,
  type ExecuteContext,
  type NodeKind,
  type NodeOutputValue,
  type NodeSpec,
  type PortSpec,
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
import { estimateCostMap, paidMap, specFor } from "./manifests";

export type WorkbenchNodeProps = NodeProps<WorkbenchNode>;

const STATUS_LABEL: Record<WorkbenchNodeData["status"], string> = {
  idle: "Idle",
  running: "Running",
  done: "Done",
  error: "Error",
  stale: "Stale",
  "needs-selection": "Needs Selection",
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
        <span className={styles.headerBadges}>
          {/* Output pinning (AC15): a pin is never silent -- this badge is the
              single place every node kind surfaces it, regardless of whether
              that kind also exposes a pin/unpin control of its own. */}
          {data.pinnedOutput !== undefined && data.pinnedOutput !== null && (
            <span className={styles.pinBadge} title="This output is pinned: it will not re-run or re-bill.">Pinned</span>
          )}
          <span className={`${styles.status} ${styles[`status_${data.status}`]}`}>{STATUS_LABEL[data.status]}</span>
        </span>
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

// Whether running this node right now would be a cache hit (paid, done, and
// its current output's signature already matches what the live graph would
// compute) -- drives the "Cached — no charge" badge (S27/AC21) so the badge
// never lies about whether the next Run press actually bills.
export function useCacheHit(id: string): boolean {
  return useWorkbenchStore(
    useShallow((state) => {
      const node = state.nodes.find((candidate) => candidate.id === id);
      if (!node || node.data.status !== "done" || !paidMap[node.data.kind]) return false;
      const incoming = new Map<string, Edge[]>();
      for (const edge of state.edges) {
        const list = incoming.get(edge.target) ?? [];
        list.push(edge);
        incoming.set(edge.target, list);
      }
      const context: SignatureContext = {
        incoming,
        liveNode: (candidateId) => state.nodes.find((candidate) => candidate.id === candidateId),
        draft: state.draft,
      };
      const signature = signatureFor(context, node);
      const active = activeRunOf(node);
      return Boolean(active && active.signature === signature);
    }),
  );
}

// Required input ports (per the registry spec) with no edge connected yet --
// drives the disabled-Run-with-reason UI (S29/AC24), generic over every node
// kind (no per-kind port-name knowledge needed here).
export function useMissingRequiredInputs(id: string, kind: NodeKind): PortSpec[] {
  return useWorkbenchStore(
    useShallow((state) => {
      const required = specFor(kind).inputs.filter((port) => port.required);
      if (!required.length) return [];
      const connected = new Set(state.edges.filter((edge) => edge.target === id).map((edge) => edge.targetHandle));
      return required.filter((port) => !connected.has(port.id));
    }),
  );
}

export function RunFooter({ id, data, inputImages }: { id: string; data: WorkbenchNodeData; inputImages: number }) {
  const running = useWorkbenchStore((state) => state.running);
  const estimateCost = estimateCostMap[data.kind];
  const estimate = estimateCost ? estimateCost({ params: data.params, inputImages }) : null;
  const cacheHit = useCacheHit(id);
  const missing = useMissingRequiredInputs(id, data.kind);
  const disabledReason = missing.length ? `Missing required input: ${missing.map((port) => port.label).join(", ")}` : undefined;
  const failed = data.status === "error";

  const runNow = () => {
    if (!cacheHit && !confirmHighCost(estimate)) return;
    void runNodes([id]);
  };

  return (
    <div className={styles.runRow}>
      <button
        type="button"
        className={styles.runButton}
        disabled={running || Boolean(disabledReason)}
        title={disabledReason}
        onClick={runNow}
      >
        Run{cacheHit ? "" : estimate !== null ? ` · ~${formatUsd(estimate)}` : ""}
      </button>
      {cacheHit && <span className={styles.cacheBadge} title="This node's output is already up to date — running again will not re-bill it.">Cached — no charge</span>}
      {disabledReason && <span className={styles.disabledReason}>{disabledReason}</span>}
      {failed && !running && (
        <button
          type="button"
          className={`nodrag ${styles.toolbarGhost}`}
          onClick={() => void retryFrom(id)}
          title="Re-run from this node onward, reusing every already-succeeded ancestor's cached output."
        >
          Retry
        </button>
      )}
      {running && data.status === "running" && (
        <button type="button" className={styles.cancelButton} onClick={cancelExecution}>Cancel</button>
      )}
    </div>
  );
}

// Node cards render a <=256px thumbnail (AC20) — never the full-res bitmap —
// generated lazily and cached alongside the full-res blob (see
// blob-cache.ts's ensureThumbnail). Full resolution opens only in the
// lightbox this component owns.
export function OutputPreview({ id, data }: { id: string; data: WorkbenchNodeData }) {
  const setActiveRun = useWorkbenchStore((state) => state.setActiveRun);
  const setPinned = useWorkbenchStore((state) => state.setPinned);
  const run = data.runs[data.activeRun];
  const image = run?.values[0]?.find((value) => value.kind === "image");
  const cacheKey = image && image.kind === "image" ? image.cacheKey : undefined;
  const [thumbUrl, setThumbUrl] = useState<string | undefined>(undefined);
  const [thumbKey, setThumbKey] = useState<string | undefined>(cacheKey);
  const [lightboxOpen, setLightboxOpen] = useState(false);

  // Reset the resolved thumbnail during render when the source key changes
  // (React's documented "adjust state during render" pattern) so a stale thumb
  // never flashes and we avoid setState-in-effect.
  if (thumbKey !== cacheKey) {
    setThumbKey(cacheKey);
    setThumbUrl(undefined);
  }

  useEffect(() => {
    if (!cacheKey) return undefined;
    let cancelled = false;
    void ensureThumbnail(cacheKey).then((url) => {
      if (!cancelled) setThumbUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [cacheKey]);

  if (!image || image.kind !== "image") return null;

  // Output pinning (AC15): the currently-browsed history entry (data.activeRun)
  // is what "promote to pinned" pins -- so browsing to an older entry with the
  // history nav below, then pinning, pins exactly that entry.
  const pinnedHere = data.pinnedOutput !== undefined && data.pinnedOutput !== null && data.pinnedOutput === data.activeRun;
  const hasPin = data.pinnedOutput !== undefined && data.pinnedOutput !== null;

  return (
    <figure className={styles.preview}>
      <button
        type="button"
        className={styles.thumbButton}
        onClick={() => setLightboxOpen(true)}
        aria-label="Open full-resolution image"
      >
        <img
          src={thumbUrl ?? image.url}
          alt="Node output"
          draggable={false}
          decoding="async"
          loading="lazy"
          width={256}
          height={192}
          className={styles.thumbImg}
        />
      </button>
      <button
        type="button"
        className={`nodrag ${styles.smallButton} ${styles.pinToggle}`}
        onClick={() => setPinned(id, pinnedHere ? null : data.activeRun)}
        aria-pressed={pinnedHere}
      >
        {pinnedHere ? "Unpin output" : "Pin this output"}
      </button>
      {data.runs.length > 1 && (
        <figcaption className={styles.history}>
          <button type="button" onClick={() => setActiveRun(id, Math.min(data.activeRun + 1, data.runs.length - 1))} disabled={data.activeRun >= data.runs.length - 1}>‹</button>
          <span>{data.runs.length - data.activeRun}/{data.runs.length}{hasPin && !pinnedHere ? " (pinned elsewhere)" : ""}</span>
          <button type="button" onClick={() => setActiveRun(id, Math.max(data.activeRun - 1, 0))} disabled={data.activeRun <= 0}>›</button>
        </figcaption>
      )}
      {lightboxOpen && (
        <div className={styles.lightboxOverlay} onClick={() => setLightboxOpen(false)} role="presentation">
          <img
            src={image.url}
            alt="Full-resolution node output"
            className={styles.lightboxImage}
            onClick={(event) => event.stopPropagation()}
          />
          <button type="button" className={styles.lightboxClose} onClick={() => setLightboxOpen(false)}>
            Close
          </button>
        </div>
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

  // Self-calibration (S27/AC21): learn the real per-input-image USD cost from
  // this run's actual usage detail, replacing the flat $0.02/image seed for
  // this (size, quality) bucket. A run with no input images or no usage
  // detail from the upstream API is a no-op inside recordImageTokenCalibration.
  const imageTokens = (response.usage as { input_tokens_details?: { image_tokens?: number } } | undefined)?.input_tokens_details?.image_tokens;
  recordImageTokenCalibration(payload.size, payload.quality, imageTokens, files.length);
}
