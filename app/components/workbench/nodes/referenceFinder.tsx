/* eslint-disable @next/next/no-img-element */
"use client";

import { memo, useState } from "react";
import { putBlob } from "../blob-cache";
import { runNodes } from "../executor";
import { useWorkbenchStore } from "../store";
import styles from "../workbench.module.css";
import type { ReferenceMatchCandidate } from "../types";
import { NodeShell, RunFooter, useConnectedImageCount, type WorkbenchNodeProps } from "./shared";

function createRunId() {
  return globalThis.crypto?.randomUUID?.().slice(0, 8) ?? `${Date.now()}`;
}

export const Component = memo(function ReferenceFinderNode({ id, data }: WorkbenchNodeProps) {
  const updateParams = useWorkbenchStore((state) => state.updateParams);
  const applyRun = useWorkbenchStore((state) => state.applyRun);
  const setStatus = useWorkbenchStore((state) => state.setStatus);
  const inputImages = useConnectedImageCount(id, ["query"]);
  const [importingUrl, setImportingUrl] = useState<string | undefined>(undefined);

  const pending = data.pendingSelection;
  const awaitingSelection = data.status === "needs-selection" && pending;

  const pick = async (candidate: ReferenceMatchCandidate) => {
    if (!candidate.imageUrl) return;
    setImportingUrl(candidate.imageUrl);
    try {
      const response = await fetch("/api/references/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageUrl: candidate.imageUrl }),
      });
      if (!response.ok) {
        const text = await response.text();
        let message = text || "Could not import the selected image.";
        try {
          const parsed = JSON.parse(text) as { error?: string };
          message = parsed.error || message;
        } catch {
          // Non-JSON error body: fall back to the raw text above.
        }
        setStatus(id, "error", message);
        return;
      }
      // The import route returns RAW image bytes, not a JSON envelope.
      const blob = await response.blob();
      const runId = createRunId();
      const cacheKey = `${id}:${runId}`;
      const url = putBlob(cacheKey, blob);
      applyRun(id, {
        runId,
        signature: pending?.signature ?? "",
        at: Date.now(),
        values: [[{ kind: "image", url, cacheKey }]],
      });
      // Resume the paused run: cached ancestors (including this node's just
      // applied output) are reused, and the previously idle downstream
      // subtree now executes.
      if (pending?.resumeTargets.length) void runNodes(pending.resumeTargets);
    } finally {
      setImportingUrl(undefined);
    }
  };

  return (
    <NodeShell data={data} footer={<RunFooter id={id} data={data} inputImages={inputImages} />}>
      <label className={styles.field}>
        <span>Query override</span>
        <input
          className="nodrag"
          type="text"
          placeholder="Falls back to the connected query"
          value={data.params.matchQuery ?? ""}
          onChange={(event) => updateParams(id, { matchQuery: event.target.value })}
        />
      </label>

      {awaitingSelection ? (
        <div className={styles.candidateList}>
          <p className={styles.hint}>Pick a candidate to import ({pending.candidates.length} found):</p>
          {pending.candidates.length === 0 && <p className={styles.hint}>No confident matches found. Try a different query.</p>}
          {pending.candidates.map((candidate) => (
            <div key={candidate.pageUrl} className={styles.candidateCard}>
              {candidate.imageUrl
                ? <img className={styles.candidateThumb} src={candidate.imageUrl} alt={candidate.title} draggable={false} />
                : <span className={styles.candidateThumb} />}
              <div className={styles.candidateMeta}>
                <span className={styles.candidateTitle}>
                  {candidate.title}
                  {candidate.official && <span className={styles.officialBadge}>Official</span>}
                </span>
                <span>{candidate.sourceLabel} · {candidate.confidence}%</span>
              </div>
              <button
                type="button"
                className={`nodrag ${styles.smallButton}`}
                disabled={!candidate.imageUrl || importingUrl === candidate.imageUrl}
                onClick={() => void pick(candidate)}
              >
                {importingUrl === candidate.imageUrl ? "Importing…" : "Use this"}
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className={styles.hint}>Searches the web for a matching product image.</p>
      )}
    </NodeShell>
  );
});
