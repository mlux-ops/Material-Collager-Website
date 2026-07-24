"use client";

// Named-graph management UI (S29/AC24, over persistence.ts's AC17 primitives):
// new/rename/delete/switch. Deliberately dumb about *how* a graph gets
// loaded/saved — it only lists meta records and calls back into
// WorkbenchApp.tsx, which owns the active graphId ref and the load/save
// effects.

import { useEffect, useState } from "react";
import { createGraph, deleteGraph, DEFAULT_GRAPH_NAME, listGraphs, renameGraph, type GraphMeta } from "./persistence";
import styles from "./workbench.module.css";

export type GraphManagerProps = {
  activeGraphId: string;
  onSwitch: (graphId: string) => void;
  onClose: () => void;
};

export function GraphManager({ activeGraphId, onSwitch, onClose }: GraphManagerProps) {
  const [graphs, setGraphs] = useState<GraphMeta[] | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = () => {
    void listGraphs().then(setGraphs).catch(() => setGraphs([]));
  };

  useEffect(refresh, []);

  const handleCreate = async () => {
    setBusy(true);
    try {
      const name = window.prompt("Name this workbench", "New workbench") || "New workbench";
      const graphId = await createGraph(name);
      refresh();
      onSwitch(graphId);
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (graphId: string) => {
    if (!window.confirm("Delete this workbench and all of its saved output? This cannot be undone.")) return;
    setBusy(true);
    try {
      await deleteGraph(graphId);
      refresh();
      if (graphId === activeGraphId) {
        // Deleting the active graph leaves nothing loaded — fall back to the
        // default graph id (a fresh/empty canvas if it too has no record).
        onSwitch("default");
      }
    } finally {
      setBusy(false);
    }
  };

  const commitRename = async (graphId: string) => {
    const name = renameValue.trim();
    setRenamingId(null);
    if (!name) return;
    await renameGraph(graphId, name);
    refresh();
  };

  return (
    <div className={styles.templateOverlay} role="dialog" aria-modal="true" aria-label="Manage workbenches" onClick={onClose}>
      <div className={styles.graphManager} onClick={(event) => event.stopPropagation()}>
        <header className={styles.templateHeader}>
          <h2>Your workbenches</h2>
          <button type="button" className={styles.smallButton} onClick={onClose}>Close</button>
        </header>
        <button type="button" className={styles.toolbarButton} disabled={busy} onClick={() => void handleCreate()}>
          + New workbench
        </button>
        <ul className={styles.graphList}>
          {(graphs ?? []).map((meta) => (
            <li key={meta.id} className={`${styles.graphRow} ${meta.id === activeGraphId ? styles.graphRowActive : ""}`}>
              {renamingId === meta.id ? (
                <input
                  className="nodrag"
                  autoFocus
                  value={renameValue}
                  onChange={(event) => setRenameValue(event.target.value)}
                  onBlur={() => void commitRename(meta.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void commitRename(meta.id);
                    if (event.key === "Escape") setRenamingId(null);
                  }}
                />
              ) : (
                <button type="button" className={styles.graphSwitchButton} onClick={() => onSwitch(meta.id)}>
                  <span>{meta.name || DEFAULT_GRAPH_NAME}</span>
                  <span className={styles.hint}>{meta.nodeCount} node(s) · saved {new Date(meta.savedAt).toLocaleString()}</span>
                </button>
              )}
              <button
                type="button"
                className={styles.smallButton}
                onClick={() => {
                  setRenamingId(meta.id);
                  setRenameValue(meta.name || "");
                }}
              >
                Rename
              </button>
              <button type="button" className={styles.smallButton} disabled={busy} onClick={() => void handleDelete(meta.id)}>
                Delete
              </button>
            </li>
          ))}
          {graphs !== null && graphs.length === 0 && <p className={styles.hint}>No saved workbenches yet.</p>}
        </ul>
      </div>
    </div>
  );
}
