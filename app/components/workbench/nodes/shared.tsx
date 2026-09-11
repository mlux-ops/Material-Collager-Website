/* eslint-disable @next/next/no-img-element */
"use client";

import type { Edge } from "@xyflow/react";
import {
  Handle,
  NodeToolbar,
  Position,
  useEdges,
  useNodeId,
  useNodes,
  useReactFlow,
  useUpdateNodeInternals,
  type NodeProps,
} from "@xyflow/react";
import { memo, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { readApiResponse } from "@/app/lib/api-client";
import { optimizeReferencesForTransport } from "@/app/lib/image-transport";
import { ensureThumbnail, getBlob, getBlobUrl, putBlob } from "../blob-cache";
import { confirmHighCost, formatOutputUsd } from "../cost";
import { cancelExecution, estimateStaleCost, retryFrom, runNodes } from "../executor";
import { MAX_IMAGE_BYTES } from "../export-import";
import { activeRunOf, signatureFor, type SignatureContext } from "../signature";
import { useWorkbenchStore } from "../store";
import { useModalDismiss } from "../useModalDismiss";
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
  customSizeError,
  decodeBase64Image,
  GENERATION_QUALITIES,
  GENERATION_BACKGROUNDS,
  GENERATION_FORMATS,
  GENERATION_SIZES,
  imageCacheKeysFromValue,
  parseSize,
  sizeForInput,
  type GenerationSizeMode,
} from "./generation";
import { draftOverrideMap, estimateCostMap, outputValuesFor, paidMap, specFor } from "./manifests";

export type WorkbenchNodeProps = NodeProps<WorkbenchNode>;

// issue-9: Photo/References upload inputs advertise "PNG, JPEG, or WebP
// under 50 MB" in their own card copy, but previously only checked
// `file.type.startsWith("image/")` (accepting e.g. GIF/BMP/SVG) with no size
// check at all -- the HTML <input accept="..."> attribute is a picker HINT
// only, never a validation boundary (drag-drop and "all files" bypass it).
// Enforces the SAME MIME allowlist and byte cap the import validator already
// does (MAX_IMAGE_BYTES, from export-import.ts) so the live-upload boundary
// and the import path agree.
export const ALLOWED_UPLOAD_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
export const MAX_UPLOAD_IMAGE_BYTES = MAX_IMAGE_BYTES;

// Returns an actionable rejection message for a single file, or null when
// it's acceptable. Callers surface a non-null result via setStatus(id,
// "error", message) so it renders through NodeShell's existing error text.
export function validateUploadFile(file: File): string | null {
  if (!ALLOWED_UPLOAD_MIME_TYPES.has(file.type)) return `"${file.name}" must be a PNG, JPEG, or WebP image.`;
  if (file.size > MAX_UPLOAD_IMAGE_BYTES) return `"${file.name}" exceeds the 50MB limit.`;
  return null;
}

const STATUS_LABEL: Record<WorkbenchNodeData["status"], string> = {
  idle: "Idle",
  running: "Running",
  done: "Done",
  error: "Error",
  stale: "Stale",
  "needs-selection": "Needs Selection",
};

function PortHandles({ spec, visibleOutputIds }: { spec: NodeSpec; visibleOutputIds?: readonly string[] }) {
  const nodeId = useNodeId();
  const updateNodeInternals = useUpdateNodeInternals();
  const visible = useMemo(() => visibleOutputIds ? new Set(visibleOutputIds) : undefined, [visibleOutputIds]);
  const outputs = useMemo(
    () => visible ? spec.outputs.filter((port) => visible.has(port.id)) : spec.outputs,
    [spec.outputs, visible],
  );
  const outputKey = outputs.map((port) => port.id).join("|");

  // React Flow caches handle geometry. Re-measure whenever Variations reveals
  // or hides its optional per-candidate handles so new wires start at the
  // actual rendered positions.
  useEffect(() => {
    if (nodeId) updateNodeInternals(nodeId);
  }, [nodeId, outputKey, updateNodeInternals]);

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
      {outputs.map((port, index) => (
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

// Corner delete affordance, revealed by CSS only while the node is selected.
// Routed through deleteElements so it takes exactly the same path as the
// Backspace/Delete key: connected edges are removed alongside the node, and
// the store's "remove" handler releases its cached blobs and marks the graph
// dirty. Reads its own id from context so it needs no props and works both
// inside NodeShell and in the note kind's hand-rolled root.
export function NodeDeleteButton() {
  const id = useNodeId();
  const { deleteElements } = useReactFlow();
  if (!id) return null;
  return (
    <button
      type="button"
      // nodrag/nopan: pressing the button must not start a node drag or a pan.
      className={`nodrag nopan ${styles.nodeDelete}`}
      aria-label="Delete node"
      title="Delete node"
      onClick={(event) => {
        event.stopPropagation();
        void deleteElements({ nodes: [{ id }] });
      }}
    >
      ×
    </button>
  );
}

// Floating quick-action pill above the selected node (React Flow
// <NodeToolbar>: rendered into a portal at canvas level, so it never clips
// against the card or its neighbors, and only shows while the node is
// selected). Run mirrors RunFooter's semantics via the same executor path —
// estimateStaleCost gives the draft-aware price for the confirmHighCost gate.
function NodeQuickActions() {
  const id = useNodeId();
  const { deleteElements } = useReactFlow();
  const duplicateNode = useWorkbenchStore((state) => state.duplicateNode);
  const running = useWorkbenchStore((state) => state.running);
  if (!id) return null;
  return (
    <NodeToolbar position={Position.Top} offset={10} className={styles.nodeToolbar}>
      <button
        type="button"
        className="nodrag nopan"
        disabled={running}
        onClick={() => {
          const { totalUsd } = estimateStaleCost([id]);
          if (!confirmHighCost(totalUsd)) return;
          void runNodes([id]);
        }}
      >
        Run
      </button>
      <button type="button" className="nodrag nopan" onClick={() => duplicateNode(id)}>
        Duplicate
      </button>
      <button type="button" className="nodrag nopan" onClick={() => void deleteElements({ nodes: [{ id }] })}>
        Delete
      </button>
    </NodeToolbar>
  );
}

export function NodeShell({
  data,
  children,
  footer,
  visibleOutputIds,
}: {
  data: WorkbenchNodeData;
  children: ReactNode;
  footer?: ReactNode;
  visibleOutputIds?: readonly string[];
}) {
  const spec = specFor(data.kind);
  return (
    <div className={`${styles.node} ${data.status === "error" ? styles.nodeError : ""}`}>
      <NodeQuickActions />
      <PortHandles spec={spec} visibleOutputIds={visibleOutputIds} />
      <NodeDeleteButton />
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
      // C1: a required port can also be satisfied by a param value with no
      // connection at all (e.g. Reference Finder's query override).
      const params = state.nodes.find((node) => node.id === id)?.data.params;
      return required.filter((port) => !connected.has(port.id) && !(params && port.satisfiedByParams?.(params)));
    }),
  );
}

export function RunFooter({ id, data, inputImages }: { id: string; data: WorkbenchNodeData; inputImages: number }) {
  const running = useWorkbenchStore((state) => state.running);
  const draft = useWorkbenchStore((state) => state.draft);
  // N-7: apply the SAME effective (draft-overridden) params executor.ts's
  // estimateStaleCost and executeNode already do, so this per-node price and
  // the confirmHighCost gate below can never disagree with what a Run press
  // will actually execute, sign, and bill -- before this fix, a large node's
  // button kept showing (and confirming) its full non-draft price even
  // though Draft mode would run it at a fraction of the cost, contradicting
  // useCacheHit just below, which was already draft-aware.
  const override = draft ? draftOverrideMap[data.kind] : undefined;
  const effectiveParams = override ? override(data.params) : data.params;
  const estimateCost = estimateCostMap[data.kind];
  const estimate = estimateCost ? estimateCost({ params: effectiveParams, inputImages }) : null;
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
        className={`nodrag ${styles.runButton}`}
        disabled={running || Boolean(disabledReason)}
        title={disabledReason
          || (estimate !== null
            ? `Output-token cost only, learned from a previous run at this size and quality. Input images are billed on top and are not known until the run finishes.`
            : undefined)}
        onClick={runNow}
      >
        Run{cacheHit ? "" : estimate !== null ? ` · output ~${formatOutputUsd(estimate)}` : paidMap[data.kind] ? " · usage-based" : ""}
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
        <button type="button" className={`nodrag ${styles.cancelButton}`} onClick={cancelExecution}>Cancel</button>
      )}
    </div>
  );
}

// AC20/issue-4: node cards never hold a full-res bitmap, not even
// transiently while the thumbnail is still generating -- renders a neutral,
// same-dimensioned placeholder until ensureThumbnail resolves, then the
// thumbnail itself. Every card preview (OutputPreview below, Variations'
// candidate grid, Photo/References/Crop source previews, the Inspector's
// reference thumbnails) renders through this one component so "full
// resolution only in a lightbox or an editing surface" holds uniformly
// everywhere. memo()-wrapped to match every other node component's
// convention (also independently reasonable for a component instantiated
// many times per card, e.g. Variations' grid).
export const ThumbnailImage = memo(function ThumbnailImage({
  cacheKey,
  alt,
  width = 256,
  height = 192,
  className,
  style,
}: {
  cacheKey: string | undefined;
  alt: string;
  width?: number;
  height?: number;
  className?: string;
  style?: CSSProperties;
}) {
  // N-9: `undefined` = still generating (or not started yet); `null` =
  // generation genuinely FAILED (ensureThumbnail resolved with no url) --
  // kept distinct from "still generating" so a permanent failure never
  // renders an eternal, indistinguishable-from-loading empty box. Before
  // this fix, the user's own uploaded source (Photo/References/Crop) could
  // silently show a blank placeholder forever with no way to tell "still
  // working" from "this will never load".
  const [thumbUrl, setThumbUrl] = useState<string | null | undefined>(undefined);
  const [thumbKey, setThumbKey] = useState<string | undefined>(cacheKey);

  // Adjust state during render (React's documented pattern) so a stale
  // thumbnail from a previous cacheKey never flashes.
  if (thumbKey !== cacheKey) {
    setThumbKey(cacheKey);
    setThumbUrl(undefined);
  }

  useEffect(() => {
    if (!cacheKey) return undefined;
    let cancelled = false;
    void ensureThumbnail(cacheKey).then((url) => {
      if (!cancelled) setThumbUrl(url ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [cacheKey]);

  if (!cacheKey) return null;

  // N-13: decorative usage (e.g. Inspector's per-item reference thumbnails,
  // which pass alt="" because the surrounding row already labels the item)
  // must stay silent in every state below -- previously the placeholder
  // always announced role="img" + "<alt> (loading)" even for alt="", so up
  // to 16 per-item placeholders could announce as an image labelled just
  // " (loading)". A non-empty alt is informative content and gets a role/
  // label appropriate to its actual state, matching the real <img> branch's
  // existing (correct) alt="" handling.
  const decorative = alt === "";

  if (thumbUrl === undefined) {
    // aspectRatio only (not a fixed width/height, which would override a
    // responsive `width:100%` class -- e.g. thumbImg/candidateThumb -- and
    // could overflow a narrower container): the placeholder should size the
    // same way the eventual <img> does, constrained by className/CSS, with
    // this just supplying the ratio those layouts need to compute a height
    // from a 100%-wide box.
    return (
      <div
        className={`${styles.thumbPlaceholder} ${className ?? ""}`}
        style={{ aspectRatio: `${width} / ${height}`, ...style }}
        {...(decorative ? { "aria-hidden": "true" as const } : { role: "img" as const, "aria-label": `${alt} (loading)` })}
      />
    );
  }

  if (thumbUrl === null) {
    // issue-4/N-9: thumbnail generation genuinely failed (corrupt/oversized
    // source, no createImageBitmap, no 2d canvas context, or toBlob returned
    // null). Fall back to the tracked full-resolution URL -- if the source
    // blob is still resident -- as a LAST RESORT only, never as the routine
    // loading path above. If even that is unavailable, render a visibly
    // distinct "preview unavailable" affordance rather than a box
    // indistinguishable from "still loading".
    const fallbackUrl = getBlobUrl(cacheKey);
    if (fallbackUrl) {
      return (
        <img
          src={fallbackUrl}
          alt={alt}
          draggable={false}
          decoding="async"
          loading="lazy"
          width={width}
          height={height}
          className={className}
          style={style}
        />
      );
    }
    return (
      <div
        className={`${styles.thumbPlaceholder} ${styles.thumbFailed} ${className ?? ""}`}
        style={{ aspectRatio: `${width} / ${height}`, ...style }}
        {...(decorative
          ? { "aria-hidden": "true" as const }
          : { role: "img" as const, "aria-label": `${alt} (preview unavailable)` })}
      />
    );
  }

  return (
    <img
      src={thumbUrl}
      alt={alt}
      draggable={false}
      decoding="async"
      loading="lazy"
      width={width}
      height={height}
      className={className}
      style={style}
    />
  );
});

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
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const { closing, requestClose } = useModalDismiss(() => setLightboxOpen(false));

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
        className={`nodrag ${styles.thumbButton}`}
        onClick={() => setLightboxOpen(true)}
        aria-label="Open full-resolution image"
      >
        <ThumbnailImage cacheKey={cacheKey} alt="Node output" width={256} height={192} className={styles.thumbImg} />
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
          <button type="button" className="nodrag" onClick={() => setActiveRun(id, Math.min(data.activeRun + 1, data.runs.length - 1))} disabled={data.activeRun >= data.runs.length - 1}>‹</button>
          <span>{data.runs.length - data.activeRun}/{data.runs.length}{hasPin && !pinnedHere ? " (pinned elsewhere)" : ""}</span>
          <button type="button" className="nodrag" onClick={() => setActiveRun(id, Math.max(data.activeRun - 1, 0))} disabled={data.activeRun <= 0}>›</button>
        </figcaption>
      )}
      {lightboxOpen && (
        <div className={`${styles.lightboxOverlay} ${closing ? styles.overlayClosing : ""}`} onClick={requestClose} role="presentation">
          <img
            src={image.url}
            alt="Full-resolution node output"
            className={styles.lightboxImage}
            onClick={(event) => event.stopPropagation()}
          />
          <button type="button" className={`nodrag ${styles.lightboxClose}`} onClick={requestClose}>
            Close
          </button>
        </div>
      )}
    </figure>
  );
}

// issue-6: the ACTUAL number of images a node's inputs currently carry, not
// "how many edges" -- a single References edge can expand to many images,
// so this resolves each matching edge's live upstream value and expands it
// via imageCacheKeysFromValue (an image value contributes 1, a references
// bundle contributes its own item count). Shares this exact expansion logic
// with executor.ts's estimateStaleCost so the toolbar's stale-run aggregate
// and this per-node display always agree on what a run would actually bill.
export function useConnectedImageCount(id: string, portIds: string[]) {
  const edges = useEdges();
  const nodes = useNodes<WorkbenchNode>();
  return useMemo(() => {
    let total = 0;
    for (const edge of edges) {
      if (edge.target !== id || !portIds.includes(edge.targetHandle || "")) continue;
      const source = nodes.find((candidate) => candidate.id === edge.source);
      if (!source) continue;
      const run = activeRunOf(source);
      if (!run) continue;
      const value = outputValuesFor(source, run, edge.sourceHandle ?? specFor(source.data.kind).outputs[0]?.id ?? "")[0];
      if (!value) continue;
      total += imageCacheKeysFromValue(value).length;
    }
    return total;
  }, [edges, nodes, id, portIds]);
}

// The cacheKey of the single image on one input port, for UI that needs the
// input's pixel dimensions (GenerationSettings' "Match input image" size).
export function useConnectedImageCacheKey(id: string, portId: string | undefined): string | undefined {
  const edges = useEdges();
  const nodes = useNodes<WorkbenchNode>();
  return useMemo(() => {
    if (!portId) return undefined;
    const edge = edges.find((candidate) => candidate.target === id && candidate.targetHandle === portId);
    if (!edge) return undefined;
    const source = nodes.find((candidate) => candidate.id === edge.source);
    if (!source) return undefined;
    const run = activeRunOf(source);
    if (!run) return undefined;
    const value = outputValuesFor(source, run, edge.sourceHandle ?? specFor(source.data.kind).outputs[0]?.id ?? "")[0];
    return value ? imageCacheKeysFromValue(value)[0] : undefined;
  }, [edges, nodes, id, portId]);
}

const SIZE_MODE_INPUT = "__input__";
const SIZE_MODE_CUSTOM = "__custom__";

export function GenerationSettings({ id, data, inputPortId }: { id: string; data: WorkbenchNodeData; inputPortId?: string }) {
  const updateParams = useWorkbenchStore((state) => state.updateParams);
  const background = data.params.background ?? "opaque";
  const requestedFormat = data.params.outputFormat ?? "png";
  const outputFormat = background === "transparent" && requestedFormat === "jpeg" ? "png" : requestedFormat;

  const size = data.params.size || "1536x1024";
  const sizeMode: GenerationSizeMode = data.params.sizeMode ?? ((GENERATION_SIZES as readonly string[]).includes(size) ? "preset" : "custom");
  const inputCacheKey = useConnectedImageCacheKey(id, inputPortId);
  // Dimensions are stored with the cacheKey they were measured from, so a
  // changed/disconnected input simply stops matching -- no reset needed.
  const [measured, setMeasured] = useState<{ key: string; width: number; height: number } | null>(null);
  const inputSize = measured && measured.key === inputCacheKey ? measured : null;

  // Read the connected input's dimensions whenever it changes; in "input"
  // mode, write the matched size into params so every reader of params.size
  // (payload, cost, draft override, signature) sees a concrete value.
  useEffect(() => {
    if (!inputCacheKey) return;
    const blob = getBlob(inputCacheKey);
    if (!blob || typeof createImageBitmap !== "function") return;
    let cancelled = false;
    createImageBitmap(blob)
      .then((bitmap) => {
        const dims = { key: inputCacheKey, width: bitmap.width, height: bitmap.height };
        bitmap.close();
        if (cancelled) return;
        setMeasured(dims);
        if (sizeMode === "input") {
          const matched = sizeForInput(dims.width, dims.height);
          if (matched !== size) updateParams(id, { size: matched });
        }
      })
      .catch(() => {
        // Unreadable blob: leave the previous measurement (if any) in place.
      });
    return () => {
      cancelled = true;
    };
  }, [inputCacheKey, sizeMode, size, id, updateParams]);

  const selectValue = sizeMode === "input" ? SIZE_MODE_INPUT : sizeMode === "custom" ? SIZE_MODE_CUSTOM : size;
  const parsed = parseSize(size) ?? { width: 1536, height: 1024 };
  const customError = sizeMode === "custom" ? customSizeError(size) : null;
  const snapped = customError ? sizeForInput(parsed.width, parsed.height) : null;
  const inputExact = inputSize ? sizeForInput(inputSize.width, inputSize.height) === `${inputSize.width}x${inputSize.height}` : true;

  const onSizeSelect = (value: string) => {
    if (value === SIZE_MODE_INPUT) {
      const matched = inputSize ? sizeForInput(inputSize.width, inputSize.height) : size;
      updateParams(id, { sizeMode: "input", size: matched });
    } else if (value === SIZE_MODE_CUSTOM) {
      updateParams(id, { sizeMode: "custom", size });
    } else {
      updateParams(id, { sizeMode: "preset", size: value });
    }
  };

  const onCustomDimension = (axis: "width" | "height", raw: string) => {
    const next = Math.max(0, Math.min(9999, Math.floor(Number(raw) || 0)));
    const width = axis === "width" ? next : parsed.width;
    const height = axis === "height" ? next : parsed.height;
    updateParams(id, { sizeMode: "custom", size: `${width}x${height}` });
  };

  return (
    <>
      <label className={styles.field}>
        <span>Size</span>
        <select className="nodrag" value={selectValue} onChange={(event) => onSizeSelect(event.target.value)}>
          {GENERATION_SIZES.map((option) => <option key={option} value={option}>{option}{option === "2560x1440" ? " (2K)" : ""}</option>)}
          {inputPortId && (
            <option value={SIZE_MODE_INPUT} disabled={!inputCacheKey}>
              Match input image{inputSize ? ` (${sizeForInput(inputSize.width, inputSize.height)})` : inputCacheKey ? "" : " — connect an image"}
            </option>
          )}
          <option value={SIZE_MODE_CUSTOM}>Custom…</option>
        </select>
      </label>
      {sizeMode === "input" && inputSize && !inputExact && (
        <p className={styles.hint}>
          Input is {inputSize.width}×{inputSize.height}; Sunburst needs multiples of 16 within its limits, so the render uses {sizeForInput(inputSize.width, inputSize.height)}.
        </p>
      )}
      {sizeMode === "custom" && (
        <>
          <div className={styles.sizeCustomRow}>
            <label className={styles.field}>
              <span>Width</span>
              <input className="nodrag" type="number" min={16} max={3840} step={16} value={parsed.width || ""} onChange={(event) => onCustomDimension("width", event.target.value)} />
            </label>
            <span className={styles.sizeCustomTimes}>×</span>
            <label className={styles.field}>
              <span>Height</span>
              <input className="nodrag" type="number" min={16} max={3840} step={16} value={parsed.height || ""} onChange={(event) => onCustomDimension("height", event.target.value)} />
            </label>
          </div>
          {customError ? (
            <p className={`${styles.hint} ${styles.sizeCustomError}`}>
              {customError}{" "}
              {snapped && (
                <button type="button" className="nodrag" onClick={() => updateParams(id, { sizeMode: "custom", size: snapped })}>
                  Use {snapped}
                </button>
              )}
            </p>
          ) : (
            <p className={styles.hint}>Multiples of 16, aspect 1:3–3:1, longest edge ≤ 3840, 0.66–8.3 MP.</p>
          )}
        </>
      )}
      <label className={styles.field}>
        <span>Quality</span>
        <select className="nodrag" value={data.params.quality ?? "medium"} onChange={(event) => updateParams(id, { quality: event.target.value as WorkbenchParams["quality"] })}>
          {GENERATION_QUALITIES.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      </label>
      <label className={styles.field}>
        <span>Background</span>
        <select className="nodrag" value={background} onChange={(event) => {
          const next = event.target.value as WorkbenchParams["background"];
          updateParams(id, { background: next, ...(next === "transparent" && outputFormat === "jpeg" ? { outputFormat: "png" } : {}) });
        }}>
          {GENERATION_BACKGROUNDS.map((option) => <option key={option} value={option}>{option === "opaque" ? "Opaque (white)" : "Transparent"}</option>)}
        </select>
      </label>
      <label className={styles.field}>
        <span>Output format</span>
        <select className="nodrag" value={outputFormat} onChange={(event) => updateParams(id, { outputFormat: event.target.value as WorkbenchParams["outputFormat"] })}>
          {GENERATION_FORMATS.map((option) => (
            <option key={option} value={option} disabled={background === "transparent" && option === "jpeg"}>
              {option.toUpperCase()}{background === "transparent" && option === "jpeg" ? " (not available with transparency)" : ""}
            </option>
          ))}
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
  const extension = blob.type === "image/jpeg" ? "jpg" : blob.type === "image/webp" ? "webp" : "png";
  return new File([blob], `input.${extension}`, { type: blob.type || "image/png" });
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
  // The "image" port is the primary image: required for edit-shaped nodes,
  // optional for Image Generation (where, when connected, it sets the size
  // via "Match input image" and leads the reference set at full quality).
  const base = ctx.inputs("image");
  if (options.requireBaseImage && !base.length) throw new Error("Connect an input image first.");
  if (base.length) files.push(await blobFromImageValue(base[0]));
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
    const mimeType = response.mimeType || (payload.outputFormat === "jpeg" ? "image/jpeg" : payload.outputFormat === "webp" ? "image/webp" : "image/png");
    const cachedUrl = putBlob(cacheKey, new Blob([bytes], { type: mimeType }));
    return { kind: "image", url: cachedUrl, cacheKey, mimeType: mimeType as "image/png" | "image/jpeg" | "image/webp", outputFormat: payload.outputFormat, background: payload.background, model: payload.model };
  });
  ctx.applyRun({ runId, signature: ctx.signature, at: Date.now(), values: [images], usage: response.usage });

  // Self-calibration (S27/AC21/issue-6): learn the real per-input-image USD
  // cost from this run's actual usage detail, replacing the flat $0.02/image
  // seed for this (size, quality) bucket. A run with no input images or no
  // usage detail from the upstream API is a no-op inside
  // recordImageTokenCalibration.
  // Sunburst exposes authoritative usage for completed calls. The legacy
  // token estimator/calibration must never learn from or price this model.
}
