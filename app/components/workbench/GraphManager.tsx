"use client";

// Named-graph management UI (S29/AC24, over persistence.ts's AC17 primitives):
// new/rename/delete/switch. Deliberately dumb about *how* a graph gets
// loaded/saved — it only lists meta records and calls back into
// WorkbenchApp.tsx, which owns the active graphId ref and the load/save
// effects.

import { useEffect, useState } from "react";
import {
  createGraph,
  deleteGraph,
  DEFAULT_GRAPH_NAME,
  getGraphThumbnailBlob,
  graphThumbnailSource,
  listGraphs,
  renameGraph,
  type GraphMeta,
} from "./persistence";
import { useModalDismiss } from "./useModalDismiss";
import styles from "./workbench.module.css";

// issue-1: switching graphs may need to flush a pending debounced autosave
// for the CURRENT graph first (see WorkbenchApp.tsx's switchGraph) -- that
// is genuinely asynchronous and can fail, so this contract lets the caller
// report the outcome instead of GraphManager assuming an instant, infallible
// switch. `skipSave` is for the ONE case where saving the current in-memory
// canvas would be actively wrong: falling back after deleting the graph
// that's currently open (that state belongs to the just-deleted graph --
// flushing it would resurrect the very record the user just deleted).
export type SwitchGraphOptions = { skipSave?: boolean };

export type GraphManagerProps = {
  activeGraphId: string;
  onSwitch: (graphId: string, options?: SwitchGraphOptions) => Promise<void>;
  // N-17: cancels the ACTIVE graph's pending debounced autosave timers
  // synchronously, with no save attempt -- used by handleDelete BEFORE its
  // own destructive `await deleteGraph(...)`, not only inside a later
  // skipSave switch, so a timer that was already armed cannot fire during
  // that await and resurrect the graph being deleted.
  onCancelPendingSaves: () => void;
  onClose: () => void;
};

// issue-2/AC17: a graph-list thumbnail's bytes never live in React state or
// as inline base64 -- this fetches the graph's OWN namespaced thumbnail Blob
// on demand, mints a short-lived object URL for display, and revokes it on
// cleanup (graphId change or unmount -- including a graph disappearing from
// the list on delete), mirroring nodes/shared.tsx's ThumbnailImage for the
// exact same reason.
function GraphThumbnail({ graphId }: { graphId: string }) {
  const [url, setUrl] = useState<string | undefined>(undefined);

  useEffect(() => {
    let objectUrl: string | undefined;
    let cancelled = false;
    void getGraphThumbnailBlob(graphId)
      .then((blob) => {
        if (cancelled || !blob) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      // NEW-3: unlike ensureThumbnail (which guarantees it never rejects,
      // via its own internal try/catch), getGraphThumbnailBlob CAN reject
      // (its transaction's onerror/onabort, or a failing openDatabase). A
      // rare IDB failure for one listed graph's thumbnail should just leave
      // it showing the placeholder -- exactly as if it had no thumbnail yet
      // -- not an unhandled-rejection console warning, matching this same
      // file's own refresh() pattern just above.
      .catch(() => {});
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [graphId]);

  if (!url) return <span className={styles.graphThumbPlaceholder} aria-hidden="true" />;
  // A locally-minted object URL, not a next/image-optimizable remote/static asset.
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt="" width={48} height={36} className={styles.graphThumb} decoding="async" loading="lazy" />;
}

export function GraphManager({ activeGraphId, onSwitch, onCancelPendingSaves, onClose }: GraphManagerProps) {
  const [graphs, setGraphs] = useState<GraphMeta[] | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [busy, setBusy] = useState(false);
  // issue-1: a switch is now an async flush-then-navigate -- disable every
  // switch/create/delete control while one is in flight so a double-click
  // can't overlap two switches, and so the UI stays responsive (re-enabled)
  // if the flush fails and onSwitch declines to actually navigate away.
  const [switching, setSwitching] = useState(false);
  const { closing, requestClose } = useModalDismiss(onClose);

  const refresh = () => {
    void listGraphs().then(setGraphs).catch(() => setGraphs([]));
  };

  useEffect(refresh, []);

  const doSwitch = async (graphId: string, options?: SwitchGraphOptions) => {
    setSwitching(true);
    try {
      await onSwitch(graphId, options);
    } finally {
      // Only reached if onSwitch resolved WITHOUT navigating away (the flush
      // failed and WorkbenchApp declined to switch, surfacing its own
      // alert) -- a successful switch reloads the page, making this
      // unreachable in practice, but it's here so the dialog never gets
      // stuck disabled if that ever changes.
      setSwitching(false);
    }
  };

  const handleCreate = async () => {
    setBusy(true);
    try {
      const name = window.prompt("Name this workbench", "New workbench") || "New workbench";
      const graphId = await createGraph(name);
      refresh();
      await doSwitch(graphId);
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (graphId: string) => {
    if (!window.confirm("Delete this workbench and all of its saved output? This cannot be undone.")) return;
    // N-17: cancel the ACTIVE graph's pending debounced autosave timers
    // BEFORE the destructive await below, not only inside the skipSave
    // switch that (maybe) runs after it. deleteGraph's own first line
    // (openDatabase) yields to the event loop, and window.confirm above
    // blocks the main thread -- so a timer that had already expired while
    // the user was reading the confirm dialog is queued and fires at
    // EXACTLY that yield. If it fired there it would save to the active
    // graph, which -- when deleting the active graph -- IS the graph about
    // to be deleted, resurrecting graph:<id>/meta:<id>/its resident blobs
    // right after deleteGraph removes them. Deleting a DIFFERENT
    // (non-active) graph must NOT cancel the active graph's own pending
    // work, which stays entirely legitimate.
    if (graphId === activeGraphId) onCancelPendingSaves();
    setBusy(true);
    try {
      await deleteGraph(graphId);
      refresh();
      if (graphId === activeGraphId) {
        // Deleting the active graph leaves nothing loaded — fall back to the
        // default graph id (a fresh/empty canvas if it too has no record).
        // skipSave: the canvas currently in memory still belongs to the
        // graph we just deleted, so flushing its pending autosave here would
        // resurrect the very record the user just asked to delete. The
        // timers were already cancelled above (before deleteGraph even
        // started), so this is now just the already-safe fallback switch.
        await doSwitch("default", { skipSave: true });
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
    <div className={`${styles.templateOverlay} ${closing ? styles.overlayClosing : ""}`} role="dialog" aria-modal="true" aria-label="Manage workbenches" onClick={requestClose}>
      <div className={styles.graphManager} onClick={(event) => event.stopPropagation()}>
        <header className={styles.templateHeader}>
          <h2>Your workbenches</h2>
          <button type="button" className={styles.smallButton} onClick={requestClose}>Close</button>
        </header>
        <button type="button" className={styles.toolbarButton} disabled={busy || switching} onClick={() => void handleCreate()}>
          + New workbench
        </button>
        <ul className={styles.graphList}>
          {(graphs ?? []).map((meta) => {
            const thumbSource = graphThumbnailSource(meta);
            return (
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
                  <button type="button" className={styles.graphSwitchButton} disabled={switching} onClick={() => void doSwitch(meta.id)}>
                    {/* issue-2/AC17: bytes for either thumbnail shape never
                        live inline here -- the current (blob-keyed) shape
                        fetches on demand through a tracked, revoked object
                        URL; a legacy (pre-fix) inline data-URL record is
                        tolerated read-only since it needs no such lifecycle;
                        absent both, a plain placeholder. */}
                    {thumbSource.kind === "key" ? (
                      <GraphThumbnail graphId={meta.id} />
                    ) : thumbSource.kind === "legacy" ? (
                      // A legacy inline data URL, not a next/image-optimizable asset.
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={thumbSource.dataUrl} alt="" width={48} height={36} className={styles.graphThumb} decoding="async" loading="lazy" />
                    ) : (
                      <span className={styles.graphThumbPlaceholder} aria-hidden="true" />
                    )}
                    <span className={styles.graphSwitchLabel}>
                      <span>{meta.name || DEFAULT_GRAPH_NAME}</span>
                      <span className={styles.hint}>{meta.nodeCount} node(s) · saved {new Date(meta.savedAt).toLocaleString()}</span>
                    </span>
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
                <button type="button" className={styles.smallButton} disabled={busy || switching} onClick={() => void handleDelete(meta.id)}>
                  Delete
                </button>
              </li>
            );
          })}
          {graphs !== null && graphs.length === 0 && <p className={styles.hint}>No saved workbenches yet.</p>}
        </ul>
      </div>
    </div>
  );
}
