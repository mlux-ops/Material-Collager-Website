"use client";

import "@xyflow/react/dist/style.css";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type IsValidConnection,
  type OnConnectEnd,
} from "@xyflow/react";
import { useShallow } from "zustand/react/shallow";
import { NODE_KINDS, NODE_TYPES } from "./nodes/index";
import { cancelExecution, estimateStaleCost, retryFrom, runAll, unmetRequiredInputs } from "./executor";
import { confirmHighCost, formatUsd } from "./cost";
import {
  buildExportGraph,
  estimateExportSize,
  materializeImport,
  serializeExportGraph,
  triggerJsonDownload,
  validateImport,
} from "./export-import";
import { GraphManager } from "./GraphManager";
import { Inspector } from "./Inspector";
import { DEFAULT_GRAPH_ID, loadGraph, saveGraph, saveGraphStructure } from "./persistence";
import { connectionIsValid, nodeKindsForWire, useWorkbenchStore } from "./store";
import { Spotlight } from "./Spotlight";
import { instantiateTemplate, TEMPLATES, type TemplateId } from "./templates";
import styles from "./workbench.module.css";
import { acceptedKindsFor, PORT_COLORS, specFor, type NodeKind, type PortKind, type WorkbenchNode } from "./types";

function bytesLabel(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// The empty-canvas onboarding gallery (AC19): three domain presets plus a
// blank option. Picking a template hands the pre-wired subgraph to
// importGraph (additive, same primitive JSON import uses) and fits it into
// view; picking blank (or closing) just dismisses the gallery.
function TemplateGallery({ onPick, onClose }: { onPick: (id: TemplateId) => void; onClose: () => void }) {
  return (
    <div className={styles.templateOverlay} role="dialog" aria-modal="true" aria-label="Choose a starting template">
      <div className={styles.templateGallery}>
        <header className={styles.templateHeader}>
          <h2>Start a workbench</h2>
          <button type="button" className={styles.smallButton} onClick={onClose}>Skip</button>
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

  const runExport = useCallback(async () => {
    setBusy(true);
    try {
      const graph = await buildExportGraph(nodes, edges, { graphOnly });
      const json = serializeExportGraph(graph);
      const stamp = new Date().toISOString().slice(0, 10);
      triggerJsonDownload(json, `workbench-${stamp}${graphOnly ? "-structure-only" : ""}.json`);
      onClose();
    } finally {
      setBusy(false);
    }
  }, [nodes, edges, graphOnly, onClose]);

  return (
    <div className={styles.templateOverlay} role="dialog" aria-modal="true" aria-label="Export workbench">
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
          <button type="button" className="nodrag" onClick={onClose}>Cancel</button>
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

function CanvasInner({ restored }: { restored: boolean }) {
  const { nodes, edges, running, draft, setDraft, onNodesChange, onEdgesChange, onConnect, addNode, importGraph } = useWorkbenchStore(
    useShallow((state) => ({
      nodes: state.nodes,
      edges: state.edges,
      running: state.running,
      draft: state.draft,
      setDraft: state.setDraft,
      onNodesChange: state.onNodesChange,
      onEdgesChange: state.onEdgesChange,
      onConnect: state.onConnect,
      addNode: state.addNode,
      importGraph: state.importGraph,
    })),
  );
  const { screenToFlowPosition, fitView } = useReactFlow();
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
  const coloredEdges = useMemo(
    () =>
      edges.map((edge) => {
        if (edge.selected) return edge;
        const source = nodes.find((node) => node.id === edge.source);
        if (!source) return edge;
        const outputs = specFor(source.data.kind).outputs;
        const port = outputs.find((candidate) => candidate.id === edge.sourceHandle) ?? outputs[0];
        if (!port) return edge;
        return { ...edge, style: { ...edge.style, stroke: PORT_COLORS[port.kind] } };
      }),
    [nodes, edges],
  );

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
  const runDisabled = running || nodes.length === 0 || blockers.length > 0;
  const runReason = blockers.length
    ? `${blockers.length} node(s) are missing a required input — e.g. ${blockers[0].label}: ${blockers[0].missing.join(", ")}.`
    : undefined;

  const handleRunAll = useCallback(() => {
    if (!confirmHighCost(totalUsd)) return;
    void runAll();
  }, [totalUsd]);

  // aria-live run-status announcements (S29/AC24): announces workflow
  // start/finish/failure without depending on visual state alone.
  const [liveMessage, setLiveMessage] = useState("");
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

  return (
    <ReactFlow
      nodes={nodes}
      edges={coloredEdges}
      nodeTypes={NODE_TYPES}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onConnectEnd={handleConnectEnd}
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
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={22} size={1.4} />
      <Controls showInteractive={false} />
      <MiniMap pannable zoomable />
      <div aria-live="polite" role="status" className={styles.srOnly}>{liveMessage}</div>
      <Panel position="top-left">
        <div className={styles.palette}>
          <p className={styles.paletteTitle}>Add node</p>
          <Spotlight kinds={NODE_KINDS} onPick={(kind) => place(kind)} emptyHint="No node type matches that search." />
        </div>
      </Panel>
      <Panel position="top-right">
        <div className={styles.toolbar}>
          <button type="button" className={styles.toolbarButton} disabled={runDisabled} title={runReason} onClick={handleRunAll}>
            Run workflow{staleCount > 0 ? ` · ${staleCount} to run${totalUsd !== null ? ` · ~${formatUsd(totalUsd)}` : ""}` : nodes.length ? " · up to date" : ""}
          </button>
          {runReason && <span className={styles.disabledReason}>{runReason}</span>}
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
          <button type="button" className={styles.toolbarGhost} onClick={() => setManualOpen(true)}>
            Templates
          </button>
          <button type="button" className={styles.toolbarGhost} onClick={() => setGraphManagerOpen(true)}>
            Workbenches
          </button>
          <button type="button" className={styles.toolbarGhost} disabled={nodes.length === 0} onClick={() => setExportOpen(true)}>
            Export
          </button>
          <button type="button" className={styles.toolbarGhost} onClick={() => importInputRef.current?.click()}>
            Import
          </button>
          <input
            ref={importInputRef}
            type="file"
            accept="application/json"
            hidden
            onChange={(event) => { void handleImportFile(event.target.files); event.target.value = ""; }}
          />
        </div>
      </Panel>
      {galleryOpen && <TemplateGallery onPick={pickTemplate} onClose={closeGallery} />}
      {exportOpen && <ExportDialog nodes={nodes} edges={edges} onClose={() => setExportOpen(false)} />}
      {wirePrompt && (
        <div className={styles.templateOverlay} role="dialog" aria-modal="true" aria-label="Connect to a node" onClick={() => setWirePrompt(null)}>
          <div className={styles.spotlightModal} onClick={(event) => event.stopPropagation()}>
            <header className={styles.templateHeader}>
              <h2>Connect to…</h2>
              <button type="button" className={styles.smallButton} onClick={() => setWirePrompt(null)}>Close</button>
            </header>
            <Spotlight kinds={wirePrompt.kinds} onPick={pickWireTarget} title="Connect to a node" emptyHint="No compatible node type." />
          </div>
        </div>
      )}
      {graphManagerOpen && (
        <GraphManager
          activeGraphId={window.localStorage.getItem(ACTIVE_GRAPH_ID_STORAGE_KEY) || DEFAULT_GRAPH_ID}
          onSwitch={(graphId) => {
            // Simplest correct switch: persist the new active graph id and
            // reload -- WorkbenchApp's restore effect below always reads this
            // key fresh on mount, so this guarantees a clean load of the
            // target graph's structure + blobs with no stale in-memory state
            // (blob-cache object URLs, running executor state, etc.) leaking
            // across graphs.
            window.localStorage.setItem(ACTIVE_GRAPH_ID_STORAGE_KEY, graphId);
            window.location.reload();
          }}
          onClose={() => setGraphManagerOpen(false)}
        />
      )}
    </ReactFlow>
  );
}

export default function WorkbenchApp() {
  const loadIntoStore = useWorkbenchStore((state) => state.loadGraph);
  const dirtyStamp = useWorkbenchStore((state) => state.dirtyStamp);
  const blobStamp = useWorkbenchStore((state) => state.blobStamp);
  const [restored, setRestored] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const hasRestored = useRef(false);
  const graphIdRef = useRef(DEFAULT_GRAPH_ID);

  useEffect(() => {
    let cancelled = false;
    const activeGraphId = window.localStorage.getItem(ACTIVE_GRAPH_ID_STORAGE_KEY) || DEFAULT_GRAPH_ID;
    graphIdRef.current = activeGraphId;
    void navigator.storage?.persist?.();
    loadGraph(activeGraphId)
      .then((graph) => {
        if (cancelled) return;
        if (graph) loadIntoStore(graph.nodes, graph.edges);
      })
      .catch(() => {
        // Missing/blocked IndexedDB just means a fresh canvas.
      })
      .finally(() => {
        if (!cancelled) {
          hasRestored.current = true;
          setRestored(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [loadIntoStore]);

  // Structure-only autosave: fires on every dirtyStamp change, INCLUDING
  // position drags, but never touches the blob store (AC16) -- it writes
  // only the graph/meta JSON records.
  useEffect(() => {
    if (!hasRestored.current || !dirtyStamp) return;
    const timeout = window.setTimeout(() => {
      const state = useWorkbenchStore.getState();
      void saveGraphStructure(graphIdRef.current, state.nodes as WorkbenchNode[], state.edges).catch(() => {
        // Autosave is best-effort; the canvas keeps working without it.
      });
    }, 900);
    return () => window.clearTimeout(timeout);
  }, [dirtyStamp]);

  // Full blob write/GC + byte-budget autosave: fires ONLY on the new-run,
  // pin-toggle, and upload/source-change events that bump blobStamp (never on
  // a plain drag -- see store.ts). Also (redundantly but harmlessly) rewrites
  // the structure record, so this alone keeps a fresh canvas fully durable.
  useEffect(() => {
    if (!hasRestored.current || !blobStamp) return;
    const timeout = window.setTimeout(() => {
      const state = useWorkbenchStore.getState();
      void saveGraph(graphIdRef.current, state.nodes as WorkbenchNode[], state.edges)
        .then(() => setSavedAt(Date.now()))
        .catch(() => {
          // Autosave is best-effort; the canvas keeps working without it.
        });
    }, 400);
    return () => window.clearTimeout(timeout);
  }, [blobStamp]);

  return (
    <div className={styles.shell}>
      <header className="site-navigation generator-navigation">
        <Link className="site-wordmark" href="/">Material Collager</Link>
        <nav aria-label="Primary navigation">
          <Link href="/">Library</Link>
          <Link href="/generator">Generator</Link>
          <Link className="active" href="/workbench">Workbench</Link>
        </nav>
        <span className={styles.savedAt}>
          {savedAt ? `Saved ${new Date(savedAt).toLocaleTimeString()}` : restored ? "Autosaves locally" : "Loading…"}
        </span>
      </header>
      <div className={styles.canvasWrap}>
        <div className={styles.canvasFlow}>
          <ReactFlowProvider>
            <CanvasInner restored={restored} />
          </ReactFlowProvider>
        </div>
        <Inspector />
      </div>
    </div>
  );
}
