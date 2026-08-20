"use client";

import "@xyflow/react/dist/style.css";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  getBezierPath,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  ViewportPortal,
  type ConnectionLineComponentProps,
  type IsValidConnection,
  type NodeChange,
  type OnConnectEnd,
} from "@xyflow/react";
import { useShallow } from "zustand/react/shallow";
import { NODE_KINDS, NODE_TYPES } from "./nodes/index";
import { cancelExecution, estimateStaleCost, retryFrom, runAll, unmetRequiredInputs } from "./executor";
import {
  autoSaveFinalOutputs,
  readAutoSaveFinalPreference,
  writeAutoSaveFinalPreference,
} from "./auto-save-final";
import { confirmHighCost, formatUsd } from "./cost";
import {
  buildExportGraph,
  estimateExportSize,
  materializeImport,
  serializeExportGraph,
  triggerJsonDownload,
  validateImport,
} from "./export-import";
import { GraphManager, type SwitchGraphOptions } from "./GraphManager";
import { computeHelperLines, tidyLayout, type HelperLines } from "./layout";
import { Inspector } from "./Inspector";
import { BlockedUpgradeError, decidePendingSave, DEFAULT_GRAPH_ID, loadGraph, saveGraph, saveGraphStructure } from "./persistence";
import { connectionIsValid, nodeKindsForWire, useWorkbenchStore } from "./store";
import { Spotlight } from "./Spotlight";
import { instantiateTemplate, TEMPLATES, type TemplateId } from "./templates";
import { useModalDismiss } from "./useModalDismiss";
import { SiteNavigation } from "../SiteNavigation";
import styles from "./workbench.module.css";
import { acceptedKindsFor, PORT_COLORS, specFor, type NodeKind, type PortKind, type WorkbenchNode } from "./types";

function bytesLabel(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// The in-flight wire while dragging a connection: same bezier as settled
// edges, dashed, and colored by the port kind it started from (source OR
// target handle — a drag can begin at either end), so the wire telegraphs
// its data kind before it lands.
function WireConnectionLine({ fromX, fromY, toX, toY, fromPosition, toPosition, fromNode, fromHandle }: ConnectionLineComponentProps) {
  let stroke = "#999";
  const data = fromNode?.data as WorkbenchNode["data"] | undefined;
  if (data && fromHandle?.id) {
    const spec = specFor(data.kind);
    const ports = fromHandle.type === "source" ? spec.outputs : spec.inputs;
    const port = ports.find((candidate) => candidate.id === fromHandle.id);
    if (port) stroke = PORT_COLORS[port.kind];
  }
  const [path] = getBezierPath({
    sourceX: fromX,
    sourceY: fromY,
    sourcePosition: fromPosition,
    targetX: toX,
    targetY: toY,
    targetPosition: toPosition,
  });
  return (
    <g>
      <path d={path} fill="none" stroke={stroke} strokeWidth={2} strokeDasharray="6 4" />
      <circle cx={toX} cy={toY} r={4} fill="#fff" stroke={stroke} strokeWidth={1.5} />
    </g>
  );
}

// The empty-canvas onboarding gallery (AC19): three domain presets plus a
// blank option. Picking a template hands the pre-wired subgraph to
// importGraph (additive, same primitive JSON import uses) and fits it into
// view; picking blank (or closing) just dismisses the gallery.
function TemplateGallery({ onPick, onClose }: { onPick: (id: TemplateId) => void; onClose: () => void }) {
  const { closing, requestClose } = useModalDismiss(onClose);
  return (
    <div className={`${styles.templateOverlay} ${closing ? styles.overlayClosing : ""}`} role="dialog" aria-modal="true" aria-label="Choose a starting template">
      <div className={styles.templateGallery}>
        <header className={styles.templateHeader}>
          <h2>Start a workbench</h2>
          <button type="button" className={styles.smallButton} onClick={requestClose}>Skip</button>
        </header>
        <div className={styles.templateGrid}>
          {TEMPLATES.map((template) => (
            <button
              key={template.id}
              type="button"
              className={styles.templateCard}
              onClick={() => onPick(template.id)}
            >
              {template.flagship && <span className={styles.templateFlagship}>Flagship</span>}
              <span className={styles.templateCardTitle}>{template.title}</span>
              <span className={styles.templateCardDescription}>{template.description}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function ExportDialog({ nodes, edges, onClose }: { nodes: WorkbenchNode[]; edges: import("@xyflow/react").Edge[]; onClose: () => void }) {
  const [graphOnly, setGraphOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const estimate = useMemo(() => estimateExportSize(nodes), [nodes]);
  const { closing, requestClose } = useModalDismiss(onClose);

  const runExport = useCallback(async () => {
    setBusy(true);
    try {
      const graph = await buildExportGraph(nodes, edges, { graphOnly });
      const json = serializeExportGraph(graph);
      const stamp = new Date().toISOString().slice(0, 10);
      triggerJsonDownload(json, `workbench-${stamp}${graphOnly ? "-structure-only" : ""}.json`);
      requestClose();
    } finally {
      setBusy(false);
    }
  }, [nodes, edges, graphOnly, requestClose]);

  return (
    <div className={`${styles.templateOverlay} ${closing ? styles.overlayClosing : ""}`} role="dialog" aria-modal="true" aria-label="Export workbench">
      <div className={styles.exportDialog}>
        <h2>Export workbench</h2>
        <p className={styles.hint}>
          {estimate.imageCount > 0
            ? `${estimate.imageCount} uploaded image(s), ~${bytesLabel(estimate.totalBytes)} embedded as a self-contained JSON file.`
            : "No uploaded images to embed."}
        </p>
        {estimate.overWarnThreshold && !graphOnly && (
          <p className={styles.exportWarning}>
            This export is large ({bytesLabel(estimate.totalBytes)}). Consider graph-only if you do not need the images baked in.
          </p>
        )}
        <label className={styles.field} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <input className="nodrag" type="checkbox" checked={graphOnly} onChange={(event) => setGraphOnly(event.target.checked)} />
          <span>Graph only (no embedded images — smaller file, re-upload images after import)</span>
        </label>
        <div className={styles.maskModalActions}>
          <button type="button" className="nodrag" onClick={requestClose}>Cancel</button>
          <button type="button" className="nodrag" disabled={busy} onClick={() => void runExport()}>
            {busy ? "Preparing…" : "Download JSON"}
          </button>
        </div>
      </div>
    </div>
  );
}

// Drag-wire-to-empty-canvas prompt (S29/AC24): captured from onConnectEnd when
// a connection is released over the pane instead of a handle. `kinds` is the
// registry-derived compatible subset (nodeKindsForWire) -- Spotlight never
// offers a kind that couldn't actually be wired.
type WirePrompt = {
  position: { x: number; y: number };
  sourceNodeId: string;
  sourceHandleId: string;
  handleType: "source" | "target";
  portKind: PortKind;
  kinds: NodeKind[];
};

// Points at the single graph WorkbenchApp autosaves/restores. Defaults to
// DEFAULT_GRAPH_ID, which is exactly the id an existing v1 user's migrated
// 'current' graph lands under (persistence.ts's migrateV1ToV2), so their
// canvas keeps loading automatically with no picker required.
const ACTIVE_GRAPH_ID_STORAGE_KEY = "mc.workbench.activeGraphId";

// N-18: how long switchGraph waits for flushPendingSaves before giving up.
// Generous -- a flush is normally near-instant, and switching graphs is a
// rare, deliberate action -- but bounded, so a wedged IndexedDB promise (a
// version-blocked open from another tab now rejects via persistence.ts's
// onblocked handler, but this is also a defensive backstop against any
// other never-settling case) cannot suspend the graph-switch UI forever.
const FLUSH_TIMEOUT_MS = 15_000;

// A promise that only ever REJECTS, after `ms` -- raced against the real
// flush below so a timeout routes through the exact same failure path as
// any other flush error (switchGraph's alert + no-switch), never resolving
// and never clearing the dirty refs itself.
function rejectAfter(ms: number, message: string): Promise<never> {
  return new Promise((_resolve, reject) => {
    window.setTimeout(() => reject(new Error(message)), ms);
  });
}

// Narrow-viewport / touch chrome. The desktop layout docks a 264px palette
// top-left, a seven-button toolbar top-right, a 200x150 minimap bottom-right
// and a 280px inspector down the side; on a 360-420px Android viewport those
// overlays cover the whole canvas, so the graph is unreachable rather than
// merely cramped. In the compact branch the palette collapses to a single
// "Add node" button that opens the same Spotlight as a modal, the toolbar's
// secondary controls move into a dropdown, and the minimap is dropped.
//
// MUST stay identical to the matching media queries in workbench.module.css
// (which own the layout half: the inspector bottom sheet, panel margins and
// the .toolbarSecondary dropdown) -- a mismatch would render compact chrome
// inside the desktop layout, or the reverse.
const COMPACT_QUERY = "(max-width: 760px), (pointer: coarse) and (max-width: 1024px)";

function useIsCompact(): boolean {
  // Starts false and settles on mount: matchMedia has no server-side
  // answer, and this tree is already client-only (workbench/page.tsx loads
  // it with ssr:false), so there is no hydration mismatch to guard beyond
  // not touching `window` during render.
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const query = window.matchMedia(COMPACT_QUERY);
    const sync = () => setCompact(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  return compact;
}

function CanvasInner({
  restored,
  switchGraph,
  cancelPendingSaves,
}: {
  restored: boolean;
  // issue-1: owned by WorkbenchApp (the debounce timers/dirty bookkeeping
  // live there) -- flushes any pending autosave for the CURRENT graph before
  // actually switching, so changes still inside the debounce window are
  // never silently lost to an immediate reload.
  switchGraph: (graphId: string, options?: SwitchGraphOptions) => Promise<void>;
  // N-17: lets GraphManager cancel the CURRENT graph's pending debounce
  // timers BEFORE a destructive operation (deleting the active graph) that
  // itself yields to the event loop, rather than only when a subsequent
  // skipSave switch happens to run afterward -- see GraphManager.tsx's
  // handleDelete for the exact race this closes.
  cancelPendingSaves: () => void;
}) {
  const { nodes, edges, running, restoreBlocked, draft, setDraft, onNodesChange, onEdgesChange, onConnect, addNode, importGraph } = useWorkbenchStore(
    useShallow((state) => ({
      nodes: state.nodes,
      edges: state.edges,
      running: state.running,
      restoreBlocked: state.restoreBlocked,
      draft: state.draft,
      setDraft: state.setDraft,
      onNodesChange: state.onNodesChange,
      onEdgesChange: state.onEdgesChange,
      onConnect: state.onConnect,
      addNode: state.addNode,
      importGraph: state.importGraph,
    })),
  );
  const { screenToFlowPosition, fitView, deleteElements } = useReactFlow();
  const placedCount = useRef(0);
  // Auto-offer is entirely DERIVED from render inputs (restored/nodes.length/
  // dismissed) rather than toggled from an effect: once restored settles
  // true, the gallery just appears on its own next render if the canvas is
  // still empty -- no setState-in-effect cascade, and `dismissed` (set by
  // closing or picking any template, including "blank") keeps it from
  // reappearing the moment the user later deletes their last node. The
  // toolbar's "Templates" button can still force it open at any time via
  // `manualOpen`, independent of that auto-offer/dismiss state.
  const [dismissed, setDismissed] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const galleryOpen = manualOpen || (restored && nodes.length === 0 && !dismissed);
  const [exportOpen, setExportOpen] = useState(false);
  const [graphManagerOpen, setGraphManagerOpen] = useState(false);
  const [wirePrompt, setWirePrompt] = useState<WirePrompt | null>(null);
  const compact = useIsCompact();
  // Compact-only chrome state: the tap-to-open add-node Spotlight, and the
  // dropdown holding whichever toolbar controls no longer fit inline.
  const [addOpen, setAddOpen] = useState(false);
  const [toolbarMenuOpen, setToolbarMenuOpen] = useState(false);
  const [autoSaveFinal, setAutoSaveFinal] = useState(readAutoSaveFinalPreference);
  const [autoSaving, setAutoSaving] = useState(false);
  const [liveMessage, setLiveMessage] = useState("");
  // Crossing the compact boundary (rotating an Android phone into landscape,
  // resizing a tablet) must not leave the dropdown open into a layout that
  // has nowhere to render it. Adjusted during render -- React's documented
  // pattern, the same one ThumbnailImage uses for its cacheKey resets --
  // rather than from an effect, which would cascade an extra render.
  const [menuLayout, setMenuLayout] = useState(compact);
  if (menuLayout !== compact) {
    setMenuLayout(compact);
    setToolbarMenuOpen(false);
  }
  // Exit animation for the wire-drop prompt below; picking a target
  // (pickWireTarget) still dismisses instantly so node creation stays snappy.
  const { closing: wireClosing, requestClose: requestWireClose } = useModalDismiss(() => setWirePrompt(null));
  const importInputRef = useRef<HTMLInputElement>(null);

  const closeGallery = useCallback(() => {
    setManualOpen(false);
    setDismissed(true);
  }, []);

  const fitSoon = useCallback(() => {
    window.setTimeout(() => void fitView({ maxZoom: 1, padding: 0.25 }), 0);
  }, [fitView]);

  const pickTemplate = useCallback((id: TemplateId) => {
    closeGallery();
    const graph = instantiateTemplate(id);
    if (graph) {
      importGraph(graph.nodes, graph.edges);
      fitSoon();
    }
  }, [importGraph, fitSoon, closeGallery]);

  const handleImportFile = useCallback(async (fileList: FileList | null) => {
    const file = fileList?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const raw = JSON.parse(text);
      const validated = validateImport(raw);
      const { nodes: importedNodes, edges: importedEdges } = materializeImport(validated);
      importGraph(importedNodes, importedEdges);
      fitSoon();
      if (validated.warnings.length) {
        window.alert(`Imported with ${validated.warnings.length} item(s) skipped:\n${validated.warnings.slice(0, 12).join("\n")}`);
      }
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Could not import this file.");
    }
  }, [importGraph, fitSoon]);

  // Edge color is derived on every render from the SOURCE handle's port kind
  // in the node registry — nothing is persisted on the edge itself, so graphs
  // reloaded from storage (whose edges carry no style metadata) recolor
  // themselves the same way. Selected edges keep React Flow's highlight.
  // Edges into a currently-running node animate (React Flow's marching
  // dashes), so during a workflow run the canvas shows where data is flowing.
  const coloredEdges = useMemo(
    () =>
      edges.map((edge) => {
        const animated = nodes.find((node) => node.id === edge.target)?.data.status === "running";
        if (edge.selected) return edge.animated === animated ? edge : { ...edge, animated };
        const source = nodes.find((node) => node.id === edge.source);
        if (!source) return edge;
        const outputs = specFor(source.data.kind).outputs;
        const port = outputs.find((candidate) => candidate.id === edge.sourceHandle) ?? outputs[0];
        if (!port) return edge;
        return { ...edge, animated, style: { ...edge.style, stroke: PORT_COLORS[port.kind] } };
      }),
    [nodes, edges],
  );

  // Drag-time alignment guides: intercept single-node position changes,
  // snap to a nearby edge/center alignment with another card, and remember
  // the guide coordinates for the <ViewportPortal> lines below. Multi-select
  // drags pass through untouched (several cards moving at once has no single
  // meaningful alignment).
  const [helperLines, setHelperLines] = useState<HelperLines>({});
  const handleNodesChange = useCallback((changes: NodeChange<WorkbenchNode>[]) => {
    const positionChanges = changes.filter((change) => change.type === "position");
    const dragging = positionChanges.some((change) => change.type === "position" && change.dragging);
    let next = changes;
    if (dragging && positionChanges.length === 1) {
      const change = positionChanges[0];
      if (change.type === "position" && change.position) {
        const state = useWorkbenchStore.getState();
        const node = state.nodes.find((candidate) => candidate.id === change.id);
        const moving = {
          x: change.position.x,
          y: change.position.y,
          width: node?.measured?.width ?? 232,
          height: node?.measured?.height ?? 200,
        };
        const others = state.nodes
          .filter((candidate) => candidate.id !== change.id)
          .map((candidate) => ({
            x: candidate.position.x,
            y: candidate.position.y,
            width: candidate.measured?.width ?? 232,
            height: candidate.measured?.height ?? 200,
          }));
        const { snapX, snapY, lines } = computeHelperLines(moving, others);
        setHelperLines(lines);
        next = changes.map((candidate) =>
          candidate === change
            ? { ...change, position: { x: snapX ?? moving.x, y: snapY ?? moving.y } }
            : candidate,
        );
      }
    } else if (helperLines.vertical !== undefined || helperLines.horizontal !== undefined) {
      setHelperLines({});
    }
    onNodesChange(next);
  }, [onNodesChange, helperLines]);

  const tidy = useCallback(() => {
    const state = useWorkbenchStore.getState();
    const placed = tidyLayout(state.nodes as WorkbenchNode[], state.edges);
    if (!placed.length) return;
    onNodesChange(placed.map((entry) => ({ id: entry.id, type: "position" as const, position: entry.position })));
    fitSoon();
  }, [onNodesChange, fitSoon]);

  const isValidConnection: IsValidConnection = useCallback(
    (connection) => {
      const state = useWorkbenchStore.getState();
      return connectionIsValid(state.nodes as WorkbenchNode[], state.edges, connection);
    },
    [],
  );

  const place = useCallback((kind: NodeKind, at?: { x: number; y: number }) => {
    if (at) return addNode(kind, at);
    // Lay new nodes out on a loose grid around the viewport center. Offsets
    // are in flow units (node cards are 232 wide) so cards never cover each
    // other's ports regardless of zoom.
    const slot = placedCount.current % 9;
    placedCount.current += 1;
    const center = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2.4 });
    // Offsets are multiples of the 22px grid, and the final position is snapped
    // to it, so a freshly placed node doesn't jump on its first drag.
    const snap = (value: number) => Math.round(value / 22) * 22;
    const position = {
      x: snap(center.x + ((slot % 3) - 1) * 308),
      y: snap(center.y + (Math.floor(slot / 3) - 1) * 264),
    };
    return addNode(kind, position);
  }, [addNode, screenToFlowPosition]);

  // Drag-wire-to-empty-canvas (S29/AC24): a connection dropped on the pane
  // (not a handle -- `connectionState.toNode` stays null) opens Spotlight
  // filtered to registry-derived compatible kinds instead of silently
  // discarding the drag.
  const handleConnectEnd: OnConnectEnd = useCallback(
    (event, connectionState) => {
      if (connectionState.toNode || !connectionState.fromNode || !connectionState.fromHandle) return;
      const fromNode = connectionState.fromNode;
      const fromHandle = connectionState.fromHandle;
      if (!fromHandle.type || !fromHandle.id) return;
      // ReactFlow's own generics don't flow through onConnectEnd cleanly, so
      // fromNode.data comes back as the library's generic NodeBase shape --
      // safe to narrow here since every node in this app is a WorkbenchNode.
      const spec = specFor((fromNode.data as unknown as WorkbenchNode["data"]).kind);
      const ports = fromHandle.type === "source" ? spec.outputs : spec.inputs;
      const port = ports.find((candidate) => candidate.id === fromHandle.id);
      if (!port) return;
      const kinds = nodeKindsForWire(fromHandle.type, port.kind);
      if (!kinds.length) return;
      const point = "changedTouches" in event ? event.changedTouches[0] : event;
      const position = screenToFlowPosition({ x: point.clientX, y: point.clientY });
      setWirePrompt({ position, sourceNodeId: fromNode.id, sourceHandleId: fromHandle.id, handleType: fromHandle.type, portKind: port.kind, kinds });
    },
    [screenToFlowPosition],
  );

  const pickWireTarget = useCallback((kind: NodeKind) => {
    if (!wirePrompt) return;
    const newId = place(kind, wirePrompt.position);
    const spec = specFor(kind);
    if (wirePrompt.handleType === "source") {
      const targetPort = spec.inputs.find((port) => acceptedKindsFor(port).includes(wirePrompt.portKind));
      if (targetPort) {
        onConnect({ source: wirePrompt.sourceNodeId, sourceHandle: wirePrompt.sourceHandleId, target: newId, targetHandle: targetPort.id });
      }
    } else {
      const sourcePort = spec.outputs.find((port) => port.kind === wirePrompt.portKind);
      if (sourcePort) {
        onConnect({ source: newId, sourceHandle: sourcePort.id, target: wirePrompt.sourceNodeId, targetHandle: wirePrompt.sourceHandleId });
      }
    }
    setWirePrompt(null);
  }, [wirePrompt, place, onConnect]);

  // Aggregate run-cost estimate (S27/AC21) over ONLY the stale terminal
  // subtree, plus any unmet-required-input blockers (S29/AC24) -- both
  // recomputed from the live graph on every relevant change so the toolbar
  // never shows a stale number.
  const terminalIds = useMemo(() => {
    const withOutgoing = new Set(edges.map((edge) => edge.source));
    return nodes.filter((node) => !withOutgoing.has(node.id) && node.data.kind !== "note").map((node) => node.id);
  }, [nodes, edges]);
  const { totalUsd, staleCount } = useMemo(
    () => estimateStaleCost(terminalIds),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [terminalIds, nodes, edges, draft],
  );
  const blockers = useMemo(
    () => unmetRequiredInputs(terminalIds),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [terminalIds, nodes, edges],
  );
  // round 7 issue-1: executor.ts's runNodes already refuses to execute
  // anything while restoreBlocked (the actual guarantee -- no paid call can
  // fire regardless of UI state), but disabling the button too means a
  // click doesn't silently no-op; the blocking overlay covers the canvas
  // either way, so this is defense-in-depth, not the primary protection.
  const runDisabled = running || autoSaving || restoreBlocked || nodes.length === 0 || blockers.length > 0;
  const runReason = autoSaving
    ? "Saving final outputs to the library."
    : restoreBlocked
    ? "Your workbench could not be loaded -- see the message above."
    : blockers.length
      ? `${blockers.length} node(s) are missing a required input — e.g. ${blockers[0].label}: ${blockers[0].missing.join(", ")}.`
      : undefined;

  const handleRunAll = useCallback(() => {
    if (!confirmHighCost(totalUsd)) return;
    void (async () => {
      await runAll();
      if (!autoSaveFinal) return;
      const state = useWorkbenchStore.getState();
      const incomplete =
        estimateStaleCost(terminalIds).staleCount > 0 ||
        state.nodes.some((node) =>
          node.data.status === "error" || node.data.status === "needs-selection" || node.data.status === "running",
        );
      if (incomplete) return;

      setAutoSaving(true);
      try {
        const result = await autoSaveFinalOutputs(state.nodes as WorkbenchNode[], state.edges);
        if (result.failures.length) {
          const summary = `Automatic library save completed with ${result.failures.length} failure(s).`;
          setLiveMessage(summary);
          window.alert(`${summary}\n${result.failures.slice(0, 6).join("\n")}`);
        } else if (result.saved > 0) {
          setLiveMessage(`Workflow complete. Automatically saved ${result.saved} final image${result.saved === 1 ? "" : "s"} to the library.`);
        } else if (result.skipped > 0) {
          setLiveMessage("Workflow complete. Final outputs were already saved to the library.");
        } else {
          setLiveMessage("Workflow complete. No terminal image output was available to save.");
        }
      } finally {
        setAutoSaving(false);
      }
    })();
  }, [autoSaveFinal, terminalIds, totalUsd]);

  // aria-live run-status announcements (S29/AC24): announces workflow
  // start/finish/failure without depending on visual state alone.
  const wasRunning = useRef(false);
  useEffect(() => {
    if (running && !wasRunning.current) setLiveMessage("Workflow running.");
    if (!running && wasRunning.current) {
      const failed = nodes.find((node) => node.data.status === "error");
      setLiveMessage(failed ? `Workflow stopped: ${failed.data.error ?? "a node failed."}` : "Workflow complete.");
    }
    wasRunning.current = running;
  }, [running, nodes]);
  const firstFailed = nodes.find((node) => node.data.status === "error");

  // Deleting a WIRE has only ever been reachable through deleteKeyCode
  // (Backspace/Delete) -- there is no on-canvas edge affordance the way
  // nodes have their corner button. On a phone there is no keyboard, so a
  // mis-drawn wire was permanent: onConnect (store.ts) replaces the edge on
  // a single-input port, but a multi:true port just accumulates them
  // forever. This is the same deleteElements path the key press and the
  // node corner button already take -- compact-only, since a keyboard
  // makes it redundant on desktop.
  const selectedEdges = useMemo(() => edges.filter((edge) => edge.selected).map((edge) => ({ id: edge.id })), [edges]);
  const toggleAutoSaveFinal = useCallback(() => {
    const next = !autoSaveFinal;
    setAutoSaveFinal(next);
    writeAutoSaveFinalPreference(next);
  }, [autoSaveFinal]);
  const clearAllNodes = useCallback(() => {
    if (!nodes.length || running || autoSaving) return;
    if (!window.confirm(`Clear all ${nodes.length} node${nodes.length === 1 ? "" : "s"} and every connected wire?`)) return;
    setToolbarMenuOpen(false);
    void deleteElements({ nodes: nodes.map((node) => ({ id: node.id })) });
  }, [autoSaving, deleteElements, nodes, running]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={coloredEdges}
      nodeTypes={NODE_TYPES}
      onNodesChange={handleNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onConnectEnd={handleConnectEnd}
      connectionLineComponent={WireConnectionLine}
      isValidConnection={isValidConnection}
      snapToGrid
      snapGrid={[22, 22]}
      deleteKeyCode={["Backspace", "Delete"]}
      onInit={(instance) => {
        // Fit only when restoring a saved graph; a reactive fitView would
        // re-center the viewport every time the first node is added.
        if (useWorkbenchStore.getState().nodes.length) {
          void instance.fitView({ maxZoom: 1, padding: 0.25 });
        }
      }}
      minZoom={0.2}
      maxZoom={2}
      // Touch ergonomics. A fingertip never lands perfectly still, and the
      // library's default 1px drag threshold turns that wobble into a node
      // drag -- which swallows the tap on every in-card control. 5px is
      // below the browser's own tap-slop so a deliberate drag still feels
      // immediate. connectionRadius is the snap distance when a wire is
      // released near a port: 20px is a mouse figure, and the ports are only
      // 15px across even after the coarse-pointer bump in the stylesheet.
      // Both are compact-only so the desktop feel is unchanged.
      nodeDragThreshold={compact ? 5 : undefined}
      connectionRadius={compact ? 34 : undefined}
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={22} size={1.4} color="#d0d0d0" />
      <Controls showInteractive={false} />
      {/* The minimap is a 200x150 opaque overlay -- a sixth of a 360x640
          Android viewport -- and its own drag gesture competes with panning
          the canvas underneath. Dropped entirely in the compact layout.
          Status-tinted cards: running nodes glow violet, errors red, so the
          minimap doubles as a workflow progress readout. */}
      {!compact && (
        <MiniMap
          pannable
          zoomable
          nodeBorderRadius={10}
          nodeStrokeColor="rgba(0, 0, 0, 0.2)"
          maskColor="rgba(0, 0, 0, 0.07)"
          nodeColor={(node) => {
            const status = (node as WorkbenchNode).data?.status;
            if (status === "running") return "#8b5cf6";
            if (status === "error") return "#dc2626";
            if (status === "done") return "#cfcfcf";
            return "#e8e8e8";
          }}
        />
      )}
      {/* Alignment guides while dragging a card (flow-coordinate space via
          ViewportPortal, so they pan/zoom with the canvas). */}
      <ViewportPortal>
        {helperLines.vertical !== undefined && (
          <div className={styles.helperLineVertical} style={{ transform: `translate(${helperLines.vertical}px, -50000px)` }} />
        )}
        {helperLines.horizontal !== undefined && (
          <div className={styles.helperLineHorizontal} style={{ transform: `translate(-50000px, ${helperLines.horizontal}px)` }} />
        )}
      </ViewportPortal>
      <div aria-live="polite" role="status" className={styles.srOnly}>{liveMessage}</div>
      <Panel position="top-left">
        {compact ? (
          <button type="button" className={`nopan ${styles.compactAdd}`} onClick={() => setAddOpen(true)} aria-label="Add node">
            + Add
          </button>
        ) : (
          <div className={styles.palette}>
            <p className={styles.paletteTitle}>Add node</p>
            <Spotlight kinds={NODE_KINDS} onPick={(kind) => place(kind)} emptyHint="No node type matches that search." />
          </div>
        )}
      </Panel>
      <Panel position="top-right">
        <div className={styles.toolbar}>
          <button type="button" className={styles.toolbarButton} disabled={runDisabled} title={runReason} onClick={handleRunAll}>
            {/* The full desktop label ("Run workflow · 4 to run · ~$0.12")
                is wider than the whole toolbar has to spare next to the
                "+ Add" button at 360px, so the compact label keeps only the
                count -- the per-node Run buttons still show their price, and
                confirmHighCost still gates an expensive run. */}
            {compact
              ? `Run${staleCount > 0 ? ` · ${staleCount}` : ""}`
              : `Run workflow${staleCount > 0 ? ` · ${staleCount} to run${totalUsd !== null ? ` · ~${formatUsd(totalUsd)}` : ""}` : nodes.length ? " · up to date" : ""}`}
          </button>
          {compact && selectedEdges.length > 0 && (
            <button
              type="button"
              className={styles.toolbarGhost}
              onClick={() => void deleteElements({ edges: selectedEdges })}
            >
              Delete wire{selectedEdges.length > 1 ? "s" : ""}
            </button>
          )}
          {compact && (
            <button
              type="button"
              className={styles.toolbarGhost}
              aria-expanded={toolbarMenuOpen}
              onClick={() => setToolbarMenuOpen((open) => !open)}
            >
              {toolbarMenuOpen ? "Close" : "Menu"}
            </button>
          )}
          {/* Stays inline (not inside the dropdown) on every layout: `title`
              never surfaces on touch, so this text is the ONLY explanation a
              phone user gets for a disabled Run button. Rendered after the
              Menu toggle because .disabledReason is flex-basis:100% and so
              forces a line break for everything that follows it (which is
              exactly the existing desktop behaviour, unchanged: the toggle
              does not render there). */}
          {runReason && <span className={styles.disabledReason}>{runReason}</span>}
          {/* display:contents on desktop, so these stay direct flex children
              of .toolbar and the row is laid out exactly as before; in the
              compact layout the same wrapper becomes the dropdown panel.
              nopan/nowheel are compact-only for the same reason: on desktop
              the wrapper box is gone but React Flow's closest() lookups
              would still find the classes, silently changing how the
              existing toolbar row responds to wheel and drag. */}
          {(!compact || toolbarMenuOpen) && (
            <div className={`${compact ? "nopan nowheel " : ""}${styles.toolbarSecondary}`}>
              {running && (
                <button type="button" className={styles.toolbarGhost} onClick={cancelExecution}>
                  Cancel
                </button>
              )}
              {firstFailed && !running && (
                <button
                  type="button"
                  className={styles.toolbarGhost}
                  onClick={() => void retryFrom(firstFailed.id)}
                  title="Re-run from the first failed node onward, reusing every already-succeeded ancestor's cached output."
                >
                  Retry failed
                </button>
              )}
              <button
                type="button"
                className={`${styles.toolbarGhost} ${styles.draftToggle}`}
                aria-pressed={draft}
                onClick={() => setDraft(!draft)}
                title="Draft mode: draft-capable paid nodes run at low quality/small size for cheap iteration. Turning it off re-bills them at full quality."
              >
                Draft {draft ? "On" : "Off"}
              </button>
              <button
                type="button"
                className={`${styles.toolbarGhost} ${styles.autoSaveToggle}`}
                aria-label="Automatically save final output to library"
                aria-pressed={autoSaveFinal}
                disabled={running || autoSaving}
                onClick={toggleAutoSaveFinal}
                title="Automatically save successful terminal image outputs to the six-month library after Run workflow."
              >
                Auto-save final {autoSaveFinal ? "On" : "Off"}
              </button>
              <button
                type="button"
                className={styles.toolbarGhost}
                disabled={nodes.length < 2}
                onClick={() => { setToolbarMenuOpen(false); tidy(); }}
                title="Auto-arrange the graph left-to-right by data flow."
              >
                Tidy
              </button>
              <button
                type="button"
                className={styles.toolbarGhost}
                disabled={nodes.length === 0 || running || autoSaving}
                onClick={clearAllNodes}
                title="Remove every node and connected wire from this workbench."
              >
                Clear all nodes
              </button>
              <button type="button" className={styles.toolbarGhost} onClick={() => { setToolbarMenuOpen(false); setManualOpen(true); }}>
                Templates
              </button>
              <button type="button" className={styles.toolbarGhost} onClick={() => { setToolbarMenuOpen(false); setGraphManagerOpen(true); }}>
                Workbenches
              </button>
              <button type="button" className={styles.toolbarGhost} disabled={nodes.length === 0} onClick={() => { setToolbarMenuOpen(false); setExportOpen(true); }}>
                Export
              </button>
              <button type="button" className={styles.toolbarGhost} onClick={() => { setToolbarMenuOpen(false); importInputRef.current?.click(); }}>
                Import
              </button>
            </div>
          )}
          {/* Kept OUTSIDE the collapsible wrapper: the Import button closes
              the dropdown before calling .click(), so the input must not
              unmount in the same commit. */}
          <input
            ref={importInputRef}
            type="file"
            accept="application/json"
            hidden
            onChange={(event) => { void handleImportFile(event.target.files); event.target.value = ""; }}
          />
        </div>
      </Panel>
      {compact && addOpen && (
        <Spotlight
          kinds={NODE_KINDS}
          onPick={(kind) => { setAddOpen(false); place(kind); }}
          onClose={() => setAddOpen(false)}
          emptyHint="No node type matches that search."
        />
      )}
      {galleryOpen && <TemplateGallery onPick={pickTemplate} onClose={closeGallery} />}
      {exportOpen && <ExportDialog nodes={nodes} edges={edges} onClose={() => setExportOpen(false)} />}
      {wirePrompt && (
        <div className={`${styles.templateOverlay} ${wireClosing ? styles.overlayClosing : ""}`} role="dialog" aria-modal="true" aria-label="Connect to a node" onClick={requestWireClose}>
          <div className={styles.spotlightModal} onClick={(event) => event.stopPropagation()}>
            <header className={styles.templateHeader}>
              <h2>Connect to…</h2>
              <button type="button" className={styles.smallButton} onClick={requestWireClose}>Close</button>
            </header>
            <Spotlight kinds={wirePrompt.kinds} onPick={pickWireTarget} title="Connect to a node" emptyHint="No compatible node type." />
          </div>
        </div>
      )}
      {graphManagerOpen && (
        <GraphManager
          activeGraphId={window.localStorage.getItem(ACTIVE_GRAPH_ID_STORAGE_KEY) || DEFAULT_GRAPH_ID}
          onSwitch={switchGraph}
          onCancelPendingSaves={cancelPendingSaves}
          onClose={() => setGraphManagerOpen(false)}
        />
      )}
    </ReactFlow>
  );
}

export default function WorkbenchApp() {
  const loadIntoStore = useWorkbenchStore((state) => state.loadGraph);
  const setRestoreBlockedInStore = useWorkbenchStore((state) => state.setRestoreBlocked);
  const dirtyStamp = useWorkbenchStore((state) => state.dirtyStamp);
  const blobStamp = useWorkbenchStore((state) => state.blobStamp);
  const [restored, setRestored] = useState(false);
  // round 7 issue-1: null = no failure (either still loading, or already
  // restored); a string = the restore FAILED with this actionable message,
  // and the canvas must stay locked until a retry succeeds.
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [retryToken, setRetryToken] = useState(0);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const hasRestored = useRef(false);
  const graphIdRef = useRef(DEFAULT_GRAPH_ID);

  // issue-1: pending-autosave bookkeeping so a graph switch/create can flush
  // instead of silently losing whatever's still inside a debounce window.
  // Refs (not state) so switchGraph -- a useCallback with a stable identity
  // -- always reads the LATEST values when it's actually invoked, however
  // long after it was defined.
  const structureTimeoutRef = useRef<number | null>(null);
  const blobTimeoutRef = useRef<number | null>(null);
  // True from the moment a save is SCHEDULED until it is actually ATTEMPTED
  // (by its own debounce timer firing, or by an early flush) -- cleared only
  // on a SUCCESSFUL attempt, so a failed attempt leaves it set and a later
  // switch's flush tries again rather than silently skipping it.
  const structureDirtyRef = useRef(false);
  const blobDirtyRef = useRef(false);

  // round 7 issue-1 (root fix): openDatabase can now REJECT a version-blocked
  // v1->v2 open (round 6's onblocked handler) instead of hanging forever --
  // but the OLD restore path caught every rejection the same as a legitimate
  // loadGraph() null result (no graph saved yet) and just showed a fresh,
  // editable, autosave-eligible canvas either way. That turned round 6's
  // fixed hang into something worse: real migrated data sitting blocked
  // behind another tab, silently overwritten by a blank canvas's own
  // autosave the instant that tab closed. Now: hasRestored/restored/
  // restoreBlocked are set ONLY after loadGraph either resolves (a graph was
  // found, or one was confirmed NOT to exist yet -- both legitimate) --
  // NEVER on a rejection. A rejection instead sets restoreError (rendered as
  // a blocking, non-dismissable overlay below) and restoreBlocked (a store
  // flag executor.ts's runNodes also checks), leaving hasRestored.current
  // false so BOTH autosave effects stay inert -- no scheduling, no writes of
  // any kind -- until a Retry attempt actually succeeds.
  useEffect(() => {
    let cancelled = false;
    const activeGraphId = window.localStorage.getItem(ACTIVE_GRAPH_ID_STORAGE_KEY) || DEFAULT_GRAPH_ID;
    graphIdRef.current = activeGraphId;
    void navigator.storage?.persist?.();
    loadGraph(activeGraphId)
      .then((graph) => {
        if (cancelled) return;
        if (graph) loadIntoStore(graph.nodes, graph.edges);
        hasRestored.current = true;
        setRestoreBlockedInStore(false);
        setRestoreError(null);
        setRetrying(false);
        setRestored(true);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setRestoreBlockedInStore(true);
        setRetrying(false);
        setRestoreError(
          error instanceof BlockedUpgradeError
            ? error.message
            : `Could not load your saved workbench (${error instanceof Error ? error.message : "unknown error"}).`,
        );
      });
    return () => {
      cancelled = true;
    };
    // retryToken has no meaning of its own -- bumping it is exactly how the
    // Retry button below re-triggers this same effect.
  }, [loadIntoStore, setRestoreBlockedInStore, retryToken]);

  const retryRestore = useCallback(() => {
    setRetrying(true);
    setRetryToken((token) => token + 1);
  }, []);

  // Structure-only autosave: fires on every dirtyStamp change, INCLUDING
  // position drags, but never touches the blob store (AC16) -- it writes
  // only the graph/meta JSON records.
  useEffect(() => {
    if (!hasRestored.current || !dirtyStamp) return;
    structureDirtyRef.current = true;
    const timeout = window.setTimeout(() => {
      structureTimeoutRef.current = null;
      const state = useWorkbenchStore.getState();
      void saveGraphStructure(graphIdRef.current, state.nodes as WorkbenchNode[], state.edges)
        .then(() => {
          structureDirtyRef.current = false;
        })
        .catch(() => {
          // Autosave is best-effort; the canvas keeps working without it.
          // Leaves structureDirtyRef set so a later graph-switch flush still
          // attempts this save rather than silently skipping it.
        });
    }, 900);
    structureTimeoutRef.current = timeout;
    return () => window.clearTimeout(timeout);
  }, [dirtyStamp]);

  // Full blob write/GC + byte-budget autosave: fires ONLY on the new-run,
  // pin-toggle, and upload/source-change events that bump blobStamp (never on
  // a plain drag -- see store.ts). Also (redundantly but harmlessly) rewrites
  // the structure record, so this alone keeps a fresh canvas fully durable.
  useEffect(() => {
    if (!hasRestored.current || !blobStamp) return;
    blobDirtyRef.current = true;
    const timeout = window.setTimeout(() => {
      blobTimeoutRef.current = null;
      const state = useWorkbenchStore.getState();
      void saveGraph(graphIdRef.current, state.nodes as WorkbenchNode[], state.edges)
        .then(() => {
          blobDirtyRef.current = false;
          // saveGraph also rewrites the structure record in the same
          // transaction (see its own comment), so a structure-only save is
          // no longer separately outstanding either.
          structureDirtyRef.current = false;
          setSavedAt(Date.now());
        })
        .catch(() => {
          // Autosave is best-effort; the canvas keeps working without it.
        });
    }, 400);
    blobTimeoutRef.current = timeout;
    return () => window.clearTimeout(timeout);
  }, [blobStamp]);

  // issue-1: cancels whatever debounce timers are still pending -- their own
  // deferred calls must never fire AFTER a deliberate flush/skip-save (which
  // could otherwise re-save stale closed-over nodes/edges, or resurrect a
  // just-deleted graph's record, well after this function returns).
  const cancelPendingTimers = useCallback(() => {
    if (structureTimeoutRef.current !== null) {
      window.clearTimeout(structureTimeoutRef.current);
      structureTimeoutRef.current = null;
    }
    if (blobTimeoutRef.current !== null) {
      window.clearTimeout(blobTimeoutRef.current);
      blobTimeoutRef.current = null;
    }
  }, []);

  // issue-1: performs, RIGHT NOW, whatever save is still owed for the
  // CURRENT graph instead of waiting out its debounce window --
  // decidePendingSave (persistence.ts) picks structure-only/full/none from
  // the two dirty flags so this can never fire a redundant double save (see
  // its own doc comment). Throws on failure (propagated from saveGraph/
  // saveGraphStructure) WITHOUT clearing the dirty flag, so switchGraph's
  // caller can abort the switch and a later retry still attempts the save.
  const flushPendingSaves = useCallback(async (): Promise<void> => {
    cancelPendingTimers();
    const decision = decidePendingSave(structureDirtyRef.current, blobDirtyRef.current);
    if (decision === "none") return;
    const state = useWorkbenchStore.getState();
    const nodes = state.nodes as WorkbenchNode[];
    const edges = state.edges;
    const graphId = graphIdRef.current;
    if (decision === "full") {
      await saveGraph(graphId, nodes, edges);
      blobDirtyRef.current = false;
      structureDirtyRef.current = false;
      setSavedAt(Date.now());
      return;
    }
    await saveGraphStructure(graphId, nodes, edges);
    structureDirtyRef.current = false;
  }, [cancelPendingTimers]);

  // issue-1 (root fix): graph creation/switching used to update the active
  // graph id and reload IMMEDIATELY, so an edit still inside the 900ms
  // structure or 400ms blob debounce window was silently discarded by the
  // reload before its timer ever fired. Now: cancel the pending timers,
  // flush/await whatever save is actually owed for the CURRENT graph (a
  // no-op if nothing is dirty -- the common case incurs no extra latency),
  // and only THEN update localStorage and reload. A failed flush surfaces an
  // alert and does NOT switch, so the user's pending change is never lost
  // silently -- they stay on the same graph with the same in-memory state
  // and can retry. `skipSave` (used only when falling back after deleting
  // the currently-open graph) cancels the timers but deliberately skips the
  // save entirely, since the in-memory canvas belongs to the graph that was
  // just deleted and flushing it would resurrect that record. N-18: the
  // flush is bounded by rejectAfter(FLUSH_TIMEOUT_MS) via Promise.race, so a
  // wedged IndexedDB promise (see persistence.ts's onblocked/onabort
  // additions) surfaces through this SAME alert-and-stay path instead of
  // hanging switchGraph -- and therefore every switch/create/delete control
  // -- forever. Promise.race doesn't cancel the loser, so `flush.catch(() =>
  // {})` swallows a rejection that arrives after the timeout has already
  // decided the race (otherwise a slow-but-eventually-failing flush would
  // surface as an unhandled rejection well after this function returned).
  const switchGraph = useCallback(async (graphId: string, options?: SwitchGraphOptions): Promise<void> => {
    if (options?.skipSave) {
      cancelPendingTimers();
    } else {
      try {
        const flush = flushPendingSaves();
        flush.catch(() => {});
        await Promise.race([
          flush,
          rejectAfter(FLUSH_TIMEOUT_MS, "saving is taking longer than expected -- close other Material Collager tabs and try again"),
        ]);
      } catch (error) {
        window.alert(
          `Could not save your current changes before switching workbenches (${error instanceof Error ? error.message : "unknown error"}). Staying on this workbench so nothing is lost -- try again in a moment.`,
        );
        return;
      }
    }
    window.localStorage.setItem(ACTIVE_GRAPH_ID_STORAGE_KEY, graphId);
    window.location.reload();
  }, [cancelPendingTimers, flushPendingSaves]);

  return (
    <div className={styles.shell}>
      <SiteNavigation
        active="workbench"
        className="generator-navigation"
        right={
          <div className="generator-status" aria-label="Workbench save state">
          <span className={styles.savedAt}>
            {restoreError ? "Could not load" : savedAt ? `Saved ${new Date(savedAt).toLocaleTimeString()}` : restored ? "Autosaves locally" : "Loading…"}
          </span>
          </div>
        }
      />
      <div className={styles.canvasWrap}>
        <div className={styles.canvasFlow}>
          <ReactFlowProvider>
            <CanvasInner restored={restored} switchGraph={switchGraph} cancelPendingSaves={cancelPendingTimers} />
          </ReactFlowProvider>
          {/* round 7 issue-1: a hard, non-dismissable lock -- unlike every
              other overlay in this app (TemplateGallery, ExportDialog, ...),
              there is deliberately no useModalDismiss/backdrop-click/Escape
              path out of this one. The ONLY way past it is a Retry that
              actually succeeds; showing (and functionally covering) the
              canvas underneath while its true state is unknown is exactly
              the risk this fix closes. */}
          {restoreError && (
            <div className={styles.templateOverlay} role="alertdialog" aria-modal="true" aria-label="Could not load your workbench">
              <div className={styles.exportDialog}>
                <h2>Could not load your workbench</h2>
                <p className={styles.hint}>{restoreError}</p>
                <p className={styles.hint}>Your workbench stays locked (no edits are saved and no node can run) until this succeeds, so nothing already saved can be silently overwritten.</p>
                <div className={styles.maskModalActions}>
                  <button type="button" className="nodrag" disabled={retrying} onClick={retryRestore}>
                    {retrying ? "Retrying…" : "Retry"}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
        <Inspector />
      </div>
    </div>
  );
}
