/* eslint-disable @next/next/no-img-element */
"use client";

import { memo, useMemo, useState } from "react";
import { readApiResponse } from "@/app/lib/api-client";
import { putBlob } from "../blob-cache";
import { recordUsageCalibration } from "../cost";
import { useWorkbenchStore } from "../store";
import { useModalDismiss } from "../useModalDismiss";
import styles from "../workbench.module.css";
import type { ExecuteContext, NodeOutputValue } from "../types";
import { buildGenerationPayload, decodeBase64Image } from "./generation";
import {
  blobFromImageValue,
  GenerationSettings,
  NodeShell,
  RunFooter,
  ThumbnailImage,
  useConnectedImageCount,
  type WorkbenchNodeProps,
} from "./shared";

function createSelectionRunId() {
  return globalThis.crypto?.randomUUID?.().slice(0, 8) ?? `sel-${Date.now()}`;
}

// Candidate cacheKeys are `${nodeId}:${runId}:${index}` — sort the browsing
// grid by that trailing index so re-selecting doesn't reshuffle the grid.
function candidateIndex(cacheKey: string): number {
  const parts = cacheKey.split(":");
  return Number(parts[parts.length - 1]) || 0;
}

export const Component = memo(function VariationsNode({ id, data }: WorkbenchNodeProps) {
  const updateParams = useWorkbenchStore((state) => state.updateParams);
  const applyRun = useWorkbenchStore((state) => state.applyRun);
  const setPinned = useWorkbenchStore((state) => state.setPinned);
  const inputImages = useConnectedImageCount(id, ["image"]);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const { closing: lightboxClosing, requestClose: requestLightboxClose } = useModalDismiss(() => setLightboxOpen(false));
  const run = data.runs[data.activeRun];
  const candidates = useMemo(() => run?.values[0] ?? [], [run]);
  const orderedCandidates = useMemo(
    () =>
      [...candidates]
        .filter((value): value is Extract<NodeOutputValue, { kind: "image" }> => value.kind === "image")
        .sort((a, b) => candidateIndex(a.cacheKey) - candidateIndex(b.cacheKey)),
    [candidates],
  );
  // The value propagated downstream is always whatever sits at values[0][0]
  // (the executor's inputValues() always resolves candidates[0]); selecting a
  // different candidate reorders it there under a fresh runId, so the pick
  // (not always index 0) propagates and downstream signatures invalidate.
  const activeValue = candidates[0];
  const selectedCacheKey = activeValue && activeValue.kind === "image" ? activeValue.cacheKey : undefined;

  function selectCandidate(cacheKey: string) {
    if (!run || cacheKey === selectedCacheKey) return;
    const selected = candidates.find((value) => value.kind === "image" && value.cacheKey === cacheKey);
    if (!selected) return;
    const reordered = [selected, ...candidates.filter((value) => value !== selected)];

    // W-1: reselecting a candidate reorders the SAME already-generated
    // output under a fresh runId -- it is not a new paid run, so a pin the
    // user set before clicking a different candidate must survive it
    // (AC15's "will not re-run or re-bill" guarantee). store.ts's applyRun
    // unconditionally clears any pin because a genuinely new run usually
    // DOES supersede old pinned content, which isn't true here.
    const pinnedIndex = data.pinnedOutput;
    const pinWasOnThisRun = pinnedIndex !== undefined && pinnedIndex !== null && pinnedIndex === data.activeRun;
    const pinnedElsewhereRunId =
      !pinWasOnThisRun && pinnedIndex !== undefined && pinnedIndex !== null ? data.runs[pinnedIndex]?.runId : undefined;

    applyRun(id, { runId: createSelectionRunId(), signature: run.signature, at: Date.now(), values: [reordered], usage: run.usage });

    if (pinWasOnThisRun) {
      // applyRun always prepends, so the reordered run always lands at 0.
      setPinned(id, 0);
    } else if (pinnedElsewhereRunId) {
      // store.ts's eviction guard exempts the pinned run from the 8-run cap
      // precisely so this lookup always finds it (even if a slot had to be
      // evicted to make room for this reorder's new entry); guard anyway
      // rather than ever pin an invalid index. { browse: false } (N-1):
      // setPinned normally ALSO browses to the pinned index -- here that
      // would silently jump the CARD away from the candidate just clicked to
      // the unrelated older pinned run (applyRun above already put activeRun
      // at 0, showing the new selection). Downstream propagation still
      // correctly stays frozen on the pinned run either way (activeRunOf
      // honors the pin over activeRun, which is exactly AC15's "will not
      // re-run" guarantee) -- only the card's own browse position was the
      // unintended side effect being fixed here.
      const fresh = useWorkbenchStore.getState().nodes.find((node) => node.id === id);
      const shiftedIndex = fresh?.data.runs.findIndex((candidateRun) => candidateRun.runId === pinnedElsewhereRunId) ?? -1;
      if (shiftedIndex >= 0) setPinned(id, shiftedIndex, { browse: false });
    }
  }

  return (
    <NodeShell data={data} footer={<RunFooter id={id} data={data} inputImages={inputImages} />}>
      <GenerationSettings id={id} data={data} />
      <label className={styles.field}>
        <span>Candidates (n)</span>
        <input
          className="nodrag"
          type="number"
          min={1}
          max={10}
          value={data.params.n ?? 4}
          onChange={(event) => updateParams(id, { n: Math.min(10, Math.max(1, Number(event.target.value) || 1)) })}
        />
      </label>
      {activeValue && activeValue.kind === "image" && (
        <figure className={styles.preview}>
          <button
            type="button"
            className={`nodrag ${styles.thumbButton}`}
            onClick={() => setLightboxOpen(true)}
            aria-label="Open full-resolution image"
          >
            <ThumbnailImage
              cacheKey={activeValue.cacheKey}
              alt="Selected candidate"
              width={256}
              height={192}
              className={styles.thumbImg}
            />
          </button>
        </figure>
      )}
      {run && (
        <button
          type="button"
          className={`nodrag ${styles.smallButton} ${styles.pinToggle}`}
          onClick={() => setPinned(id, data.pinnedOutput === data.activeRun ? null : data.activeRun)}
          aria-pressed={data.pinnedOutput === data.activeRun}
        >
          {data.pinnedOutput === data.activeRun ? "Unpin output" : "Pin this output"}
        </button>
      )}
      {orderedCandidates.length > 1 && (
        <div className={styles.candidateGrid}>
          {orderedCandidates.map((value) => (
            <button
              key={value.cacheKey}
              type="button"
              className={`nodrag ${styles.candidateThumb} ${value.cacheKey === selectedCacheKey ? styles.candidateThumbActive : ""}`}
              onClick={() => selectCandidate(value.cacheKey)}
              title={value.cacheKey === selectedCacheKey ? "Propagating downstream" : "Use this candidate downstream"}
            >
              <ThumbnailImage cacheKey={value.cacheKey} alt="Candidate" width={96} height={96} />
            </button>
          ))}
        </div>
      )}
      {lightboxOpen && activeValue && activeValue.kind === "image" && (
        <div className={`${styles.lightboxOverlay} ${lightboxClosing ? styles.overlayClosing : ""}`} onClick={requestLightboxClose} role="presentation">
          <img
            src={activeValue.url}
            alt="Full-resolution selected candidate"
            className={styles.lightboxImage}
            onClick={(event) => event.stopPropagation()}
          />
          <button type="button" className={`nodrag ${styles.lightboxClose}`} onClick={requestLightboxClose}>
            Close
          </button>
        </div>
      )}
    </NodeShell>
  );
});

// DOM-touching execute wrapper: a single /api/workbench/edit call with n
// (clamped 1-10) candidates — input tokens billed once, output scaled by n.
// The executor maps response.images to distinct cacheKeys
// `${nodeId}:${runId}:${index}`; the candidate grid above resolves the
// active-candidate selection.
export async function execute(ctx: ExecuteContext): Promise<void> {
  const payload = buildGenerationPayload(ctx.params, ctx.inputs("prompt"));
  const base = ctx.inputs("image");
  if (!base.length) throw new Error("Connect an input image first.");
  const n = Math.min(10, Math.max(1, Math.round(ctx.params.n ?? 4)));

  const form = new FormData();
  form.append("payload", JSON.stringify({ ...payload, n }));
  form.append("image[]", await blobFromImageValue(base[0]), "input.png");

  ctx.setProgress(`Generating ${n} variations…`);
  const response = await fetch("/api/workbench/edit", { method: "POST", body: form, signal: ctx.signal })
    .then((value) => readApiResponse<{ ok: boolean; images: string[]; mimeType: string; usage?: Record<string, unknown> }>(value));

  const runId = ctx.createRunId();
  const images: NodeOutputValue[] = response.images.map((base64, index) => {
    const cacheKey = `${ctx.nodeId}:${runId}:${index}`;
    const bytes = decodeBase64Image(base64);
    const cachedUrl = putBlob(cacheKey, new Blob([bytes], { type: response.mimeType || "image/png" }));
    return { kind: "image", url: cachedUrl, cacheKey };
  });
  ctx.applyRun({ runId, signature: ctx.signature, at: Date.now(), values: [images], usage: response.usage });
  recordUsageCalibration(payload.size, payload.quality, response.usage, 1);
}
