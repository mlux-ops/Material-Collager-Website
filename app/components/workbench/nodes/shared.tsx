/* eslint-disable @next/next/no-img-element */
"use client";

import type { Edge } from "@xyflow/react";
import {
  Handle,
  NodeToolbar,
  Position,
  useConnection,
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
import { MARKUP_MAX_PIXELS, validateEditSize } from "@/app/lib/image-edit";
import { classifySize } from "@/app/lib/image-model-limits";
import { optimizeReferencesForTransport } from "@/app/lib/image-transport";
import type { AllowedImageModel } from "@/app/lib/sunburst";
import { sanitizeSvg, SvgSanitizeError } from "@/app/lib/svg-sanitize";
import { ensureThumbnail, getBlob, getBlobUrl, putBlob, putSvgBlob } from "../blob-cache";
import { confirmHighCost, formatOutputUsd } from "../cost";
import { cancelExecution, estimateStaleCost, retryFrom, runNodes } from "../executor";
import { MAX_IMAGE_BYTES } from "../export-import";
import { activeRunOf, signatureFor, type SignatureContext } from "../signature";
import { useWorkbenchStore } from "../store";
import { useModalDismiss } from "../useModalDismiss";
import styles from "../workbench.module.css";
import {
  acceptedKindsFor,
  type ExecuteContext,
  type ImageOutputFormat,
  type ImageOutputMimeType,
  type NodeKind,
  type NodeOutputValue,
  type PortKind,
  type PortSpec,
  type WorkbenchNode,
  type WorkbenchNodeData,
  type WorkbenchParams,
} from "../types";
import { compatiblePorts } from "../wiring";
import {
  buildGenerationPayload,
  customSizeError,
  decodeBase64Image,
  extensionForMimeType,
  GENERATION_COMPLEXITIES,
  GENERATION_QUALITIES,
  GENERATION_BACKGROUNDS,
  GENERATION_FORMATS,
  GENERATION_SIZES,
  GIF_DEFAULT_SIZE,
  GIF_FRAME_COUNT_DEFAULT,
  GIF_FRAME_COUNT_MAX,
  GIF_FRAME_COUNT_MIN,
  GIF_FRAME_DURATION_DEFAULT_MS,
  GIF_FRAME_DURATION_MAX_MS,
  GIF_FRAME_DURATION_MIN_MS,
  GIF_SIZES,
  gifFrameParamsError,
  imageCacheKeysFromValue,
  isVectorOrAnimatedFormat,
  markupLayerError,
  mimeTypeForFormat,
  modelInputTypeError,
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

// --- Wire-drag state -------------------------------------------------------
// While a wire is being dragged every card answers one question: could this
// wire land on me, and on which ports? The answer drives the drag-time
// highlighting (compatible ports grow and ring, the rest dim, cards with
// nothing to offer fade) and the drop-target hover outline the canvas-root
// `.wiring` class gates in the stylesheet.

// The handle a wire is being dragged from, as one primitive string ("" while
// no drag is in progress). useConnection re-renders its caller whenever its
// selector's result changes, and `to`/`pointer` change on every pointer move,
// so the selector reads only the fixed end: each card re-renders exactly
// twice per drag, when it starts and when it ends. Node and port ids never
// contain "|" (kind-uuid ids, manifest port ids).
function useWireDragKey(): string {
  return useConnection((connection) =>
    connection.inProgress
      ? `${connection.fromHandle.type}|${connection.fromHandle.nodeId}|${connection.fromHandle.id ?? ""}`
      : "",
  );
}

type WireDragState =
  | { phase: "idle" }
  // The card the drag started on: rendered exactly as normal, so the port the
  // wire is coming out of stays legible (no port on it can take the wire --
  // connectionIsValid refuses self-wires).
  | { phase: "origin" }
  // Any other card, with the ids of its ports the wire could validly land on
  // (possibly none) and the side they are on: inputs for a drag that started
  // on an output, outputs for one dragged backwards from an input. The side
  // matters because ids repeat across sides (Image Edit has an "image" input
  // AND an "image" output) -- an id match alone would light up the wrong one.
  | { phase: "drop"; side: "in" | "out"; compatible: ReadonlySet<string> };

const IDLE_DRAG: WireDragState = { phase: "idle" };

function useWireDragState(nodeId: string | null): WireDragState {
  const dragKey = useWireDragKey();
  // A primitive again ("" | "origin" | "drop:<in|out>:<ids>"), so the card
  // only re-renders when its answer actually changes. Returns "" before
  // touching the graph whenever no drag is in progress: this selector runs
  // on every store update, node drags included.
  const answer = useWorkbenchStore((state) => {
    if (!dragKey || !nodeId) return "";
    const [handleType, fromNodeId, fromHandleId] = dragKey.split("|");
    if (fromNodeId === nodeId) return "origin";
    const self = state.nodes.find((node) => node.id === nodeId);
    if (!self) return "";
    const from = { nodeId: fromNodeId, handleId: fromHandleId || null, handleType: handleType as "source" | "target" };
    const side = from.handleType === "source" ? "in" : "out";
    return `drop:${side}:${compatiblePorts(state.nodes, state.edges, from, self).map((port) => port.id).join(",")}`;
  });
  return useMemo<WireDragState>(() => {
    if (answer === "origin") return { phase: "origin" };
    if (!answer.startsWith("drop:")) return IDLE_DRAG;
    const side = answer.startsWith("drop:in:") ? "in" : "out";
    const ids = answer.slice(`drop:${side}:`.length);
    return { phase: "drop", side, compatible: new Set(ids ? ids.split(",") : []) };
  }, [answer]);
}

// --- Port strip ------------------------------------------------------------

// Port glyphs by data kind. Every port is the same plotter-ink black
// (PORT_COLORS), so the SHAPE carries the kind the way PORT_DASHES does for
// wires: image ● circle, text ■ square, references ◆ diamond, mask ▲
// triangle. Hollow until the port has a wire, filled once it has one. Drawn
// in a 10-unit box inset by half the 1.5-unit stroke so the outline is never
// clipped; round joins (a plotter pen is round) keep the diamond's and the
// triangle's points inside the box too. The <svg> fills its handle, which
// must itself stay glyph-sized: React Flow takes a wire's endpoint from the
// handle element's own box, so this is what makes wires meet the glyph's
// outer edge. Every scale (hover, compatible-port highlight) is applied to
// this <svg>, never to the handle element, whose transform React Flow owns
// for positioning and whose box it re-measures.
function PortGlyph({ kind, filled }: { kind: PortKind; filled: boolean }) {
  return (
    <svg
      className={`${styles.portGlyph}${filled ? ` ${styles.portGlyphFilled}` : ""}`}
      viewBox="0 0 10 10"
      aria-hidden="true"
      focusable="false"
    >
      {kind === "image" && <circle cx="5" cy="5" r="4.25" />}
      {kind === "text" && <rect x="1.25" y="1.25" width="7.5" height="7.5" />}
      {kind === "references" && <path d="M5 0.75 9.25 5 5 9.25 0.75 5Z" />}
      {kind === "mask" && <path d="M5 0.9 9.25 9.1H0.75Z" />}
    </svg>
  );
}

function inputPortTitle(port: PortSpec): string {
  return `${port.label} (${acceptedKindsFor(port).join(" | ")}${port.multi ? ", multiple" : ""}${port.required ? ", required" : ""})`;
}

function outputPortTitle(port: PortSpec): string {
  return `${port.label} (${port.kind})`;
}

// The drag-time treatment for one port: on a card a wire could land on, its
// compatible ports are highlighted and every other port (incompatible, or on
// the wrong side for this drag) dims. Idle and origin cards get neither.
function dragPortClass(drag: WireDragState, side: "in" | "out", portId: string): string {
  if (drag.phase !== "drop") return "";
  return side === drag.side && drag.compatible.has(portId) ? styles.portCompatible : styles.portDimmed;
}

// The card's ports, named, directly under its header: one row per port
// index, inputs on the left edge and outputs on the right. Each row spans the
// card's full border-box width (negative margins cancel its padding and
// border) and is the containing block for its <Handle>s, so React Flow's own
// left:0/right:0 + translate(-50%,-50%) centres each glyph on the card's
// border line -- no hand-maintained pixel offsets that drift whenever the
// header changes.
function PortStrip({
  nodeId,
  kind,
  visibleOutputIds,
  drag,
}: {
  nodeId: string | null;
  kind: NodeKind;
  visibleOutputIds?: readonly string[];
  drag: WireDragState;
}) {
  const spec = specFor(kind);
  const updateNodeInternals = useUpdateNodeInternals();
  const visible = useMemo(() => visibleOutputIds ? new Set(visibleOutputIds) : undefined, [visibleOutputIds]);
  const outputs = useMemo(
    () => visible ? spec.outputs.filter((port) => visible.has(port.id)) : spec.outputs,
    [spec.outputs, visible],
  );
  const outputKey = outputs.map((port) => port.id).join("|");

  // React Flow caches handle geometry. Re-measure whenever Variations reveals
  // or hides its optional per-candidate handles so new wires start at the
  // actual rendered positions. (Anything that MOVES the strip -- the header
  // wrapping, a row added -- also resizes the card, and React Flow's own
  // ResizeObserver re-measures on that.)
  useEffect(() => {
    if (nodeId) updateNodeInternals(nodeId);
  }, [nodeId, outputKey, updateNodeInternals]);

  // Wires per declared port, inputs first then outputs, in one shallow-
  // compared array so the strip re-renders only when a count changes. A
  // null handle id is React Flow's "first handle of that type", so it counts
  // against the first declared port, like coloredEdges' fallback.
  const wireCounts = useWorkbenchStore(
    useShallow((state) => {
      const counts: number[] = new Array(spec.inputs.length + spec.outputs.length).fill(0);
      if (!nodeId) return counts;
      for (const edge of state.edges) {
        if (edge.target === nodeId) {
          const index = edge.targetHandle ? spec.inputs.findIndex((port) => port.id === edge.targetHandle) : 0;
          if (index >= 0 && index < spec.inputs.length) counts[index] += 1;
        }
        if (edge.source === nodeId) {
          const index = edge.sourceHandle ? spec.outputs.findIndex((port) => port.id === edge.sourceHandle) : 0;
          if (index >= 0 && index < spec.outputs.length) counts[spec.inputs.length + index] += 1;
        }
      }
      return counts;
    }),
  );
  // The same unmet-required rule the disabled Run button uses, so a required
  // port satisfied by a param instead of a wire (Reference Finder's query
  // override) never reads as missing here while Run is enabled.
  const missing = useMissingRequiredInputs(nodeId ?? "", kind);
  const missingIds = useMemo(() => new Set(missing.map((port) => port.id)), [missing]);

  const rows = Math.max(spec.inputs.length, outputs.length);
  if (!rows) return null;

  return (
    <div className={styles.portStrip}>
      {Array.from({ length: rows }, (_, index) => {
        const input = spec.inputs[index];
        const output = outputs[index];
        const inputCount = input ? wireCounts[index] : 0;
        const outputCount = output ? wireCounts[spec.inputs.length + spec.outputs.indexOf(output)] : 0;
        // Ink only: black once wired, the chrome grey while optional and
        // empty, the card's error red while required and empty (the same
        // fact as RunFooter's "Missing required input", shown at the port).
        const inputTone = !input
          ? ""
          : inputCount > 0
            ? styles.portLabelConnected
            : missingIds.has(input.id)
              ? styles.portLabelMissing
              : "";
        return (
          <div key={index} className={styles.portRow}>
            {input && (
              <>
                <Handle
                  id={input.id}
                  type="target"
                  position={Position.Left}
                  className={`${styles.portHandle} ${dragPortClass(drag, "in", input.id)}`}
                  title={inputPortTitle(input)}
                >
                  <PortGlyph kind={input.kind} filled={inputCount > 0} />
                </Handle>
                <span
                  className={`${styles.portLabel} ${inputTone} ${dragPortClass(drag, "in", input.id)}`}
                  title={inputPortTitle(input)}
                >
                  {input.label}{input.multi && inputCount > 0 ? ` · ${inputCount}` : ""}
                </span>
              </>
            )}
            {output && (
              <>
                <span
                  className={`${styles.portLabel} ${styles.portLabelOut} ${outputCount > 0 ? styles.portLabelConnected : ""} ${dragPortClass(drag, "out", output.id)}`}
                  title={outputPortTitle(output)}
                >
                  {output.label}
                </span>
                <Handle
                  id={output.id}
                  type="source"
                  position={Position.Right}
                  className={`${styles.portHandle} ${dragPortClass(drag, "out", output.id)}`}
                  title={outputPortTitle(output)}
                >
                  <PortGlyph kind={output.kind} filled={outputCount > 0} />
                </Handle>
              </>
            )}
          </div>
        );
      })}
    </div>
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
  const nodeId = useNodeId();
  const drag = useWireDragState(nodeId);
  // While a wire is being dragged, a card it could land on becomes a drop
  // target (the hover outline, gated on the canvas-root .wiring class) and a
  // card with nothing to offer fades back. The origin card stays as it is.
  const dragClass = drag.phase !== "drop" ? "" : drag.compatible.size ? styles.nodeDropTarget : styles.nodeFaded;
  return (
    <div className={`${styles.node} ${data.status === "error" ? styles.nodeError : ""} ${dragClass}`}>
      <NodeQuickActions />
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
      <PortStrip nodeId={nodeId} kind={data.kind} visibleOutputIds={visibleOutputIds} drag={drag} />
      <div className={styles.nodeBody}>{children}</div>
      {data.error && <p className={styles.errorText}>{data.error}</p>}
      {footer}
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
  // SVG and animated GIF are shown from their own bytes: the canvas thumbnail
  // path cannot rasterize an SVG reliably and would freeze a GIF on its first
  // frame. Both are rendered only through <img>, which never runs SVG script.
  const mimeType = image.mimeType ?? (cacheKey ? getBlob(cacheKey)?.type : undefined);
  const showsOwnBytes = mimeType === "image/svg+xml" || mimeType === "image/gif";

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
        {showsOwnBytes ? (
          <img src={image.url} alt="Node output" draggable={false} decoding="async" width={256} height={192} className={styles.thumbImg} />
        ) : (
          <ThumbnailImage cacheKey={cacheKey} alt="Node output" width={256} height={192} className={styles.thumbImg} />
        )}
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

// The same ordered expansion as useConnectedImageCount, but keeping each
// image's identity and the node it came from. Prompt Builder needs this to
// show WHICH photo is "Image 2": the numbering is edge order, which is
// invisible on the canvas, so a row has to name its source to be usable.
export function useConnectedReferenceSlots(id: string, portIds: string[]) {
  const edges = useEdges();
  const nodes = useNodes<WorkbenchNode>();
  return useMemo(() => {
    const slots: Array<{ cacheKey: string; sourceNodeId: string; sourceTitle: string }> = [];
    for (const edge of edges) {
      if (edge.target !== id || !portIds.includes(edge.targetHandle || "")) continue;
      const source = nodes.find((candidate) => candidate.id === edge.source);
      if (!source) continue;
      const run = activeRunOf(source);
      if (!run) continue;
      const value = outputValuesFor(source, run, edge.sourceHandle ?? specFor(source.data.kind).outputs[0]?.id ?? "")[0];
      if (!value) continue;
      const sourceTitle = specFor(source.data.kind).title;
      for (const cacheKey of imageCacheKeysFromValue(value)) {
        slots.push({ cacheKey, sourceNodeId: source.id, sourceTitle });
      }
    }
    return slots;
  }, [edges, nodes, id, portIds]);
}

// Same resolution as useConnectedImageCacheKey just below, but returns the
// whole value (url AND cacheKey) rather than only the cacheKey -- View Image
// needs both: the cacheKey for its card thumbnail (ThumbnailImage), the url
// for its full-resolution lightbox, the same field OutputPreview's own
// lightbox already reads directly rather than round-tripping through
// blob-cache's getBlobUrl (that fallback path is for a failed thumbnail, not
// the routine "show the full image" case).
export function useConnectedImageValue(id: string, portId: string | undefined): NodeOutputValue | undefined {
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
    return value?.kind === "image" ? value : undefined;
  }, [edges, nodes, id, portId]);
}

// The live text arriving on one input port (several connections join with a
// newline, matching what a text-consuming execute() does), or undefined when
// nothing is connected or the upstream node has not produced text yet.
export function useConnectedText(id: string, portId: string): string | undefined {
  const edges = useEdges();
  const nodes = useNodes<WorkbenchNode>();
  return useMemo(() => {
    const parts: string[] = [];
    for (const edge of edges) {
      if (edge.target !== id || edge.targetHandle !== portId) continue;
      const source = nodes.find((candidate) => candidate.id === edge.source);
      const run = source ? activeRunOf(source) : undefined;
      if (!source || !run) continue;
      const value = outputValuesFor(source, run, edge.sourceHandle ?? specFor(source.data.kind).outputs[0]?.id ?? "")[0];
      if (value?.kind === "text" && value.text) parts.push(value.text);
    }
    return parts.length ? parts.join("\n") : undefined;
  }, [edges, nodes, id, portId]);
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
const COMPLEXITY_DEFAULT = "";

// 2.6's planning-depth control, shared by every 2.6 render node. The empty
// option leaves the param unset, so nothing is sent and the API default
// ("high") applies. Not rendered on the Test node (2.5 has no such setting).
export function ComplexityField({ id, value }: { id: string; value: WorkbenchParams["complexity"] }) {
  const updateParams = useWorkbenchStore((state) => state.updateParams);
  return (
    <label className={styles.field}>
      <span>Complexity</span>
      <select
        className="nodrag"
        value={value ?? COMPLEXITY_DEFAULT}
        onChange={(event) => {
          const next = event.target.value;
          updateParams(id, { complexity: next === COMPLEXITY_DEFAULT ? undefined : next as WorkbenchParams["complexity"] });
        }}
      >
        <option value={COMPLEXITY_DEFAULT}>Default (high)</option>
        {GENERATION_COMPLEXITIES.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    </label>
  );
}

const FORMAT_LABELS: Record<ImageOutputFormat, string> = {
  png: "PNG",
  webp: "WEBP",
  jpeg: "JPEG",
  svg: "SVG (vector)",
  gif: "GIF (animated)",
};

export function GenerationSettings({
  id,
  data,
  inputPortId,
  showComplexity = true,
  formats = GENERATION_FORMATS,
}: {
  id: string;
  data: WorkbenchNodeData;
  inputPortId?: string;
  // False only on the Test node, which renders on the 2.5 snapshot.
  showComplexity?: boolean;
  // Image Generation passes IMAGE_GENERATE_FORMATS (adds svg/gif); every
  // other node keeps the raster formats an edit can return.
  formats?: readonly ImageOutputFormat[];
}) {
  const updateParams = useWorkbenchStore((state) => state.updateParams);
  const background = data.params.background ?? "opaque";
  const requestedFormat: ImageOutputFormat = data.params.outputFormat && formats.includes(data.params.outputFormat)
    ? data.params.outputFormat
    : "png";
  const outputFormat = background === "transparent" && requestedFormat === "jpeg" ? "png" : requestedFormat;
  const isGif = outputFormat === "gif";
  const presets: readonly string[] = isGif ? GIF_SIZES : GENERATION_SIZES;

  const size = data.params.size || (isGif ? GIF_DEFAULT_SIZE : "1536x1024");
  const sizeMode: GenerationSizeMode = data.params.sizeMode ?? (presets.includes(size) ? "preset" : "custom");
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

  // A preset that is not on the current list (a still preset after switching
  // to GIF, say) shows as Custom so the select never claims a missing option.
  const selectValue = sizeMode === "input"
    ? SIZE_MODE_INPUT
    : sizeMode === "custom" || !presets.includes(size) ? SIZE_MODE_CUSTOM : size;
  const parsed = parseSize(size) ?? { width: 1536, height: 1024 };
  const customError = selectValue === SIZE_MODE_CUSTOM ? customSizeError(size, outputFormat) : null;
  const snapped = customError && !isGif ? sizeForInput(parsed.width, parsed.height) : null;
  const frameError = isGif ? gifFrameParamsError(data.params.frameCount, data.params.frameDurationMs) : null;

  const onFormatSelect = (next: ImageOutputFormat) => {
    const patch: Partial<WorkbenchParams> = { outputFormat: next };
    if (next === "gif" && !isGif) {
      // Every frame is rendered and they share the pixel budget, so start a
      // GIF at the guide's 512x512 rather than a still-image size.
      patch.sizeMode = "preset";
      patch.size = GIF_DEFAULT_SIZE;
    } else if (next !== "gif" && isGif && validateEditSize(size) !== null) {
      // A GIF size is usually below the still-image pixel floor.
      patch.sizeMode = "preset";
      patch.size = "1536x1024";
    }
    // SVG is always one image (OpenAI: n must be 1).
    if (next === "svg") patch.candidates = 1;
    updateParams(id, patch);
  };

  const onFrameParam = (key: "frameCount" | "frameDurationMs", raw: string) => {
    const trimmed = raw.trim();
    updateParams(id, { [key]: trimmed === "" ? undefined : Number(trimmed) });
  };
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
          {presets.map((option) => {
            const label = `${option}${option === "2560x1440" ? " (2K)" : ""}`;
            return (
              <option key={option} value={option}>
                {classifySize(option).experimental ? `${label} (experimental)` : label}
              </option>
            );
          })}
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
      {selectValue === SIZE_MODE_CUSTOM && (
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
            <p className={styles.hint}>
              {isGif
                ? "Multiples of 16, aspect 1:3–3:1, longest edge ≤ 3840. Frames × pixels must fit the model’s pixel budget."
                : "Multiples of 16, aspect 1:3–3:1, longest edge ≤ 3840, 0.66–8.3 MP."}
            </p>
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
        <select className="nodrag" value={outputFormat} onChange={(event) => onFormatSelect(event.target.value as ImageOutputFormat)}>
          {formats.map((option) => (
            <option key={option} value={option} disabled={background === "transparent" && option === "jpeg"}>
              {FORMAT_LABELS[option]}{background === "transparent" && option === "jpeg" ? " (not available with transparency)" : ""}
            </option>
          ))}
        </select>
      </label>
      {isVectorOrAnimatedFormat(outputFormat) && (
        <p className={styles.hint}>
          {outputFormat === "svg"
            ? "SVG is a single vector image (one candidate). "
            : "GIF renders every frame, so keep the size small. "}
          Text-to-image only: disconnect Image Reference inputs. Edit, Variations and other model nodes can’t take {outputFormat.toUpperCase()} as an input; render PNG or WebP for those.
        </p>
      )}
      {isGif && (
        <>
          <div className={styles.sizeCustomRow}>
            <label className={styles.field}>
              <span>Frames</span>
              <input
                className="nodrag"
                type="number"
                min={GIF_FRAME_COUNT_MIN}
                max={GIF_FRAME_COUNT_MAX}
                step={1}
                placeholder={String(GIF_FRAME_COUNT_DEFAULT)}
                value={data.params.frameCount ?? ""}
                onChange={(event) => onFrameParam("frameCount", event.target.value)}
              />
            </label>
            <label className={styles.field}>
              <span>Frame ms</span>
              <input
                className="nodrag"
                type="number"
                min={GIF_FRAME_DURATION_MIN_MS}
                max={GIF_FRAME_DURATION_MAX_MS}
                step={10}
                placeholder={String(GIF_FRAME_DURATION_DEFAULT_MS)}
                value={data.params.frameDurationMs ?? ""}
                onChange={(event) => onFrameParam("frameDurationMs", event.target.value)}
              />
            </label>
          </div>
          <p className={`${styles.hint} ${frameError ? styles.sizeCustomError : ""}`}>
            {frameError ?? `Frames ${GIF_FRAME_COUNT_MIN}–${GIF_FRAME_COUNT_MAX} (default ${GIF_FRAME_COUNT_DEFAULT}); ${GIF_FRAME_DURATION_MIN_MS}–${GIF_FRAME_DURATION_MAX_MS} ms per frame, rounded to 10 (default ${GIF_FRAME_DURATION_DEFAULT_MS}).`}
          </p>
        </>
      )}
      {showComplexity && <ComplexityField id={id} value={data.params.complexity} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// DOM-side execution helpers (blob cache, object URLs, transport) shared by
// the execute wrappers in imageGenerate/imageEdit/saveToLibrary .tsx modules.
// ---------------------------------------------------------------------------

// Reads a cached image as a File for a node to send on. By default it refuses
// SVG and GIF bytes (an Image Generation output in those formats): no image
// or vision model this app calls takes them, and the canvas nodes cannot
// decode an SVG reliably. Because the guard sits here, every caller that
// sends pixels on gets it, including nodes added later. Only nodes that
// hand the original bytes back to the user (Export/Download) opt out.
export function fileFromCacheKey(cacheKey: string, options: { allowVectorAndAnimated?: boolean } = {}): File {
  const blob = getBlob(cacheKey);
  if (!blob) throw new Error("An input image is no longer cached. Re-run its node.");
  const type = blob.type || "image/png";
  if (!options.allowVectorAndAnimated) {
    const refusal = modelInputTypeError(type);
    if (refusal) throw new Error(refusal);
  }
  return new File([blob], `input.${extensionForMimeType(type)}`, { type });
}

export async function blobFromImageValue(value: NodeOutputValue, options: { allowVectorAndAnimated?: boolean } = {}): Promise<File> {
  const [cacheKey] = imageCacheKeysFromValue(value);
  if (!cacheKey) throw new Error("Expected an image input.");
  return fileFromCacheKey(cacheKey, options);
}

// Model-returned SVG never reaches the cache raw: it is sanitized
// (svg-sanitize.ts) and cached under a data: URL (putSvgBlob). An SVG that
// cannot be parsed, or is not an SVG, fails the run rather than being shown.
function cacheSanitizedSvg(cacheKey: string, bytes: Uint8Array): string {
  try {
    return putSvgBlob(cacheKey, sanitizeSvg(new TextDecoder().decode(bytes)));
  } catch (error) {
    if (error instanceof SvgSanitizeError) throw new Error(`The model returned an SVG that can't be shown safely: ${error.message}`);
    throw error;
  }
}

// True when any pixel of the bitmap is less than fully opaque. Scanned in row
// strips so a 16-megapixel layer never needs one 64 MB readback, and stops at
// the first transparent pixel.
function bitmapHasTransparency(bitmap: ImageBitmap): boolean {
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Could not read the Markup layer's pixels.");
  context.drawImage(bitmap, 0, 0);
  const strip = 256;
  for (let top = 0; top < bitmap.height; top += strip) {
    const rows = Math.min(strip, bitmap.height - top);
    const { data } = context.getImageData(0, top, bitmap.width, rows);
    for (let index = 3; index < data.length; index += 4) {
      if (data[index] < 255) return true;
    }
  }
  return false;
}

// Browser-side Markup checks the edge route cannot make without decoding:
// the layer must match the FIRST input image's width and height exactly and
// actually contain transparent pixels. Type, byte and pixel caps come from
// generation.ts's markupLayerError so they are unit-tested.
async function validateMarkupLayer(markup: File, base: File): Promise<void> {
  const early = markupLayerError({ type: markup.type, bytes: markup.size });
  if (early) throw new Error(early);
  const [layer, image] = await Promise.all([createImageBitmap(markup), createImageBitmap(base)]);
  try {
    const sizeError = markupLayerError({
      type: markup.type,
      bytes: markup.size,
      markupWidth: layer.width,
      markupHeight: layer.height,
      baseWidth: image.width,
      baseHeight: image.height,
      maxPixels: MARKUP_MAX_PIXELS,
    });
    if (sizeError) throw new Error(sizeError);
    const transparencyError = markupLayerError({ type: markup.type, bytes: markup.size, hasTransparency: bitmapHasTransparency(layer) });
    if (transparencyError) throw new Error(transparencyError);
  } finally {
    layer.close();
    image.close();
  }
}

// DOM-touching generation executor composing generation.ts's pure core:
// gathers cached input files, posts the request, and caches the returned
// images as object URLs.
export async function executeGeneration(
  ctx: ExecuteContext,
  options: {
    requireBaseImage: boolean;
    model?: AllowedImageModel;
    // Image Generation only: SVG/GIF output may pass through.
    allowVectorAndAnimated?: boolean;
    // Image Edit only: read the optional "markup" port.
    markup?: boolean;
  },
): Promise<void> {
  const payload = buildGenerationPayload(ctx.params, ctx.inputs("prompt"), options.model, {
    allowVectorAndAnimated: options.allowVectorAndAnimated,
  });

  const form = new FormData();
  const files: File[] = [];
  if (options.requireBaseImage) {
    const base = ctx.inputs("image");
    if (!base.length) throw new Error("Connect an input image first.");
    files.push(await blobFromImageValue(base[0]));
  }
  // The Markup layer goes up as its own raw PNG -- never through the
  // reference transport below, whose re-encode can flatten its alpha -- and
  // is checked against the raw base image, which is what is actually sent.
  let markupFile: File | undefined;
  if (options.markup) {
    const markupValues = ctx.inputs("markup");
    if (markupValues.length) {
      if (!files.length) throw new Error("Markup needs an input image to annotate.");
      markupFile = await blobFromImageValue(markupValues[0]);
      ctx.setProgress("Checking markup…");
      await validateMarkupLayer(markupFile, files[0]);
    }
  }
  // Image Generation's "size" port is deliberately NOT read here: it only
  // drives params.size via "Match input image" (GenerationSettings) and is
  // never sent to the model, so it costs no image-input tokens.
  const references = ctx.inputs("references");
  if (references.length) {
    // Each plain image contributes one file; a references value expands to
    // its ordered image cacheKeys. fileFromCacheKey refuses SVG/GIF here,
    // BEFORE the transport step, which would otherwise re-encode a GIF into
    // a still and let it through.
    const rawReferences = references.flatMap(imageCacheKeysFromValue).map((key) => fileFromCacheKey(key));
    // The base image travels at full quality; supporting references share
    // the same transport budget the generator uses.
    const optimized = await optimizeReferencesForTransport(rawReferences);
    files.push(...optimized);
  }
  if (files.length > 16) throw new Error("A node can send at most 16 images.");
  if (isVectorOrAnimatedFormat(payload.outputFormat) && files.length) {
    throw new Error(`${payload.outputFormat.toUpperCase()} output is text-to-image only; disconnect the Image Reference inputs or choose PNG or WebP.`);
  }

  form.append("payload", JSON.stringify(payload));
  for (const file of files) form.append("image[]", file, file.name);
  if (markupFile) form.append("markup", markupFile, "markup.png");

  ctx.setProgress("Rendering…");
  const response = await fetch("/api/workbench/edit", { method: "POST", body: form, signal: ctx.signal })
    .then((value) => readApiResponse<{ ok: boolean; error?: string; images: string[]; mimeType: string; usage?: Record<string, unknown> }>(value));

  const runId = ctx.createRunId();
  const images: NodeOutputValue[] = response.images.map((base64, index) => {
    const cacheKey = `${ctx.nodeId}:${runId}:${index}`;
    const bytes = decodeBase64Image(base64);
    const mimeType = (response.mimeType || mimeTypeForFormat(payload.outputFormat)) as ImageOutputMimeType;
    const cachedUrl = mimeType === "image/svg+xml"
      ? cacheSanitizedSvg(cacheKey, bytes)
      : putBlob(cacheKey, new Blob([bytes], { type: mimeType }));
    return { kind: "image", url: cachedUrl, cacheKey, mimeType, outputFormat: payload.outputFormat, background: payload.background, model: payload.model };
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
