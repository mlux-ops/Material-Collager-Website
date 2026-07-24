"use client";

import { memo, useEffect, useState } from "react";
import { putBlob } from "../blob-cache";
import { useWorkbenchStore } from "../store";
import styles from "../workbench.module.css";
import type { ExecuteContext } from "../types";
import { NodeShell, OutputPreview, RunFooter, type WorkbenchNodeProps } from "./shared";

type LibraryItem = { id: string; title?: string; filename?: string; createdAt?: number; imageUrl: string };
type LibraryListResponse = { ok: boolean; error?: string; items?: LibraryItem[] };

export const Component = memo(function LibraryPickNode({ id, data }: WorkbenchNodeProps) {
  const updateParams = useWorkbenchStore((state) => state.updateParams);
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const refresh = async () => {
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetch("/api/library");
      const payload = (await response.json()) as LibraryListResponse;
      if (!response.ok || !payload.ok) throw new Error(payload.error || "Could not load the library.");
      setItems(payload.items ?? []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load the library.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <NodeShell data={data} footer={<RunFooter id={id} data={data} inputImages={0} />}>
      <button type="button" className={styles.smallButton} onClick={() => void refresh()} disabled={loading}>
        {loading ? "Loading…" : "Refresh library"}
      </button>
      {error && <p className={styles.errorText}>{error}</p>}
      <label className={styles.field}>
        <span>Saved image</span>
        <select
          className="nodrag"
          value={data.params.selectedLibraryId ?? ""}
          onChange={(event) => updateParams(id, { selectedLibraryId: event.target.value })}
        >
          <option value="">Choose a saved image…</option>
          {items.map((item) => <option key={item.id} value={item.id}>{item.title || item.filename || item.id}</option>)}
        </select>
      </label>
      <OutputPreview id={id} data={data} />
    </NodeShell>
  );
});

// DOM-touching execute wrapper: fetches the selected item's raw image bytes
// into the blob cache and emits it as this node's image output.
export const execute = async (ctx: ExecuteContext): Promise<void> => {
  const selectedId = ctx.params.selectedLibraryId;
  if (!selectedId) throw new Error("Pick a saved image from the library first.");

  ctx.setProgress("Fetching…");
  const response = await fetch(`/api/library/${encodeURIComponent(selectedId)}/image`, { signal: ctx.signal });
  if (!response.ok) throw new Error("The selected library image is no longer available.");
  const blob = await response.blob();

  const runId = ctx.createRunId();
  const cacheKey = `${ctx.nodeId}:${runId}`;
  const url = putBlob(cacheKey, blob);
  ctx.applyRun({
    runId,
    signature: ctx.signature,
    at: Date.now(),
    values: [[{ kind: "image", url, cacheKey }]],
  });
};
