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
} from "@xyflow/react";
import { useShallow } from "zustand/react/shallow";
import { NODE_KINDS, NODE_SPECS, NODE_TYPES } from "./nodes/index";
import { cancelExecution, runAll } from "./executor";
import { loadGraph, saveGraph } from "./persistence";
import { connectionIsValid, useWorkbenchStore } from "./store";
import styles from "./workbench.module.css";
import { PORT_COLORS, specFor, type NodeKind, type WorkbenchNode } from "./types";

function CanvasInner() {
  const { nodes, edges, running, onNodesChange, onEdgesChange, onConnect, addNode } = useWorkbenchStore(
    useShallow((state) => ({
      nodes: state.nodes,
      edges: state.edges,
      running: state.running,
      onNodesChange: state.onNodesChange,
      onEdgesChange: state.onEdgesChange,
      onConnect: state.onConnect,
      addNode: state.addNode,
    })),
  );
  const { screenToFlowPosition } = useReactFlow();
  const placedCount = useRef(0);

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

  const place = useCallback((kind: NodeKind) => {
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
    addNode(kind, position);
  }, [addNode, screenToFlowPosition]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={coloredEdges}
      nodeTypes={NODE_TYPES}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
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
      <Panel position="top-left">
        <div className={styles.palette}>
          <p className={styles.paletteTitle}>Add node</p>
          {NODE_KINDS.map((kind) => (
            <button key={kind} type="button" className={styles.paletteButton} onClick={() => place(kind)} title={NODE_SPECS[kind].description}>
              {NODE_SPECS[kind].title}
            </button>
          ))}
        </div>
      </Panel>
      <Panel position="top-right">
        <div className={styles.toolbar}>
          <button type="button" className={styles.toolbarButton} disabled={running || nodes.length === 0} onClick={() => void runAll()}>
            Run workflow
          </button>
          {running && (
            <button type="button" className={styles.toolbarGhost} onClick={cancelExecution}>
              Cancel
            </button>
          )}
        </div>
      </Panel>
    </ReactFlow>
  );
}

export default function WorkbenchApp() {
  const loadIntoStore = useWorkbenchStore((state) => state.loadGraph);
  const dirtyStamp = useWorkbenchStore((state) => state.dirtyStamp);
  const [restored, setRestored] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const hasRestored = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void navigator.storage?.persist?.();
    loadGraph()
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

  useEffect(() => {
    if (!hasRestored.current || !dirtyStamp) return;
    const timeout = window.setTimeout(() => {
      const state = useWorkbenchStore.getState();
      void saveGraph(state.nodes as WorkbenchNode[], state.edges)
        .then(() => setSavedAt(Date.now()))
        .catch(() => {
          // Autosave is best-effort; the canvas keeps working without it.
        });
    }, 900);
    return () => window.clearTimeout(timeout);
  }, [dirtyStamp]);

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
        <ReactFlowProvider>
          <CanvasInner />
        </ReactFlowProvider>
      </div>
    </div>
  );
}
