"use client";

import { memo } from "react";
import { putBlob } from "../blob-cache";
import { activeRunOf, runIsComplete } from "../signature";
import { useWorkbenchStore } from "../store";
import styles from "../workbench.module.css";
import type { ExecuteContext, ImageOutputMimeType, NodeOutputValue, WorkbenchNodeData } from "../types";
import { decodeBase64Image, mimeTypeForFormat } from "./generation";
import { realSleep, sharedIpmLimiter } from "./ipm-limiter";
import {
  addUsage,
  buildMultiRunRun,
  MULTI_RUN_FORMATS,
  MULTI_RUN_IPM_DEFAULT,
  MULTI_RUN_IPM_MAX,
  MULTI_RUN_PER_CALL_MAX,
  MULTI_RUN_TOTAL_MAX,
  multiRunPayload,
  multiRunSettings,
  nextCandidateIndex,
  partialRunMessage,
  planChunks,
  resumeStateFor,
  runChunks,
  totalsOf,
  type RunChunksOutcome,
} from "./multiRun.core";
import {
  gatherReferenceFiles,
  GenerationSettings,
  NodeShell,
  OutputPreview,
  RunFooter,
  ThumbnailImage,
  useConnectedImageCount,
  type WorkbenchNodeProps,
} from "./shared";
import { useCandidatePicker } from "./variations";

function clampInput(raw: string, max: number): number {
  return Math.min(max, Math.max(1, Math.round(Number(raw)) || 1));
}

function BurstStatus({ data }: { data: WorkbenchNodeData }) {
  const run = data.runs[data.activeRun];
  if (!run || run.target === undefined || runIsComplete(run)) return null;
  const saved = run.values[0]?.length ?? 0;
  return (
    <p className={styles.hint}>
      {saved} of {run.target} images saved. Run renders only the remaining {run.target - saved}.
    </p>
  );
}

export const Component = memo(function MultiRunNode({ id, data }: WorkbenchNodeProps) {
  const updateParams = useWorkbenchStore((state) => state.updateParams);
  const updatePresentationParams = useWorkbenchStore((state) => state.updatePresentationParams);
  const inputImages = useConnectedImageCount(id, ["references"]);
  const { orderedCandidates, selectedCacheKey, selectCandidate } = useCandidatePicker(id, data);
  const settings = multiRunSettings(data.params);
  const calls = Math.ceil(settings.total / settings.perCall);
  const running = data.status === "running";

  return (
    <NodeShell data={data} footer={<RunFooter id={id} data={data} inputImages={inputImages} />}>
      <GenerationSettings id={id} data={data} formats={MULTI_RUN_FORMATS} />
      <label className={styles.field}>
        <span>Images per press</span>
        <input
          className="nodrag"
          type="number"
          min={1}
          max={MULTI_RUN_TOTAL_MAX}
          value={data.params.total ?? settings.total}
          onChange={(event) => updateParams(id, { total: clampInput(event.target.value, MULTI_RUN_TOTAL_MAX) })}
        />
      </label>
      <label className={styles.field}>
        <span>Images per call</span>
        <input
          className="nodrag"
          type="number"
          min={1}
          max={MULTI_RUN_PER_CALL_MAX}
          value={data.params.perCall ?? settings.perCall}
          onChange={(event) => updateParams(id, { perCall: clampInput(event.target.value, MULTI_RUN_PER_CALL_MAX) })}
        />
      </label>
      <label className={styles.field}>
        <span>Images per minute (cap)</span>
        <input
          className="nodrag"
          type="number"
          min={1}
          max={MULTI_RUN_IPM_MAX}
          value={data.params.ipm ?? MULTI_RUN_IPM_DEFAULT}
          // The cap only paces calls; it is not part of the signature.
          onChange={(event) => updatePresentationParams(id, { ipm: clampInput(event.target.value, MULTI_RUN_IPM_MAX) })}
        />
      </label>
      <p className={styles.hint}>
        One press renders {settings.total} {settings.total === 1 ? "image" : "images"} in {calls} {calls === 1 ? "call" : "calls"} of up to {settings.perCall}, sent together and held under {settings.ipm} images a minute across every Multi-Run node. Reference images are billed again on every call; 1 per call costs the most but lets each image fail on its own.
      </p>
      <p className={styles.hint}>
        A press can cost real money: up to {settings.total} images on your OpenAI account, and no price estimate is available. Cancel stops new calls; calls already sent still finish and are billed, so Cancel waits for them and keeps their images. Pin the output to keep a large burst across reloads.
      </p>
      <BurstStatus data={data} />
      <OutputPreview id={id} data={data} />
      {orderedCandidates.length > 1 && (
        <div className={`${styles.candidateGrid} ${styles.multiRunGrid}`}>
          {orderedCandidates.map((value) => (
            <button
              key={value.cacheKey}
              type="button"
              className={`nodrag ${styles.candidateThumb} ${value.cacheKey === selectedCacheKey ? styles.candidateThumbActive : ""}`}
              onClick={() => selectCandidate(value.cacheKey)}
              disabled={running}
              title={value.cacheKey === selectedCacheKey ? "Propagating downstream" : "Use this image downstream"}
            >
              <ThumbnailImage cacheKey={value.cacheKey} alt="Candidate" width={96} height={96} />
            </button>
          ))}
        </div>
      )}
    </NodeShell>
  );
});

// DOM-touching execute wrapper. References are read and prepared ONCE, then
// every call gets a fresh FormData built from the same files. Calls run
// concurrently, admitted by the shared images-per-minute limiter. Whatever
// comes back is applied in `finally` -- on success, on a stop and on cancel --
// so a paid image is never lost; a partial run carries its target, and the
// next press renders only the remainder and merges it into the same run.
export async function execute(ctx: ExecuteContext): Promise<void> {
  const settings = multiRunSettings(ctx.params);
  const payload = multiRunPayload(ctx.params, ctx.inputs("prompt"));
  const files = await gatherReferenceFiles(ctx.inputs("references"));
  if (files.length > 16) throw new Error("A node can send at most 16 images.");

  const active = activeRunOf(ctx.node);
  const { base, existing, remaining } = resumeStateFor(active, ctx.signature, settings.total);
  const isNewest = (runId: string) => useWorkbenchStore.getState().nodes.find((node) => node.id === ctx.nodeId)?.data.runs[0]?.runId === runId;

  if (base && remaining === 0) {
    // Already holds every image this signature asks for (it was in error for
    // some other reason): settle it without a single paid call.
    ctx.applyRun({ ...base, runId: isNewest(base.runId) ? base.runId : ctx.createRunId(), target: settings.total });
    return;
  }

  const burstId = ctx.createRunId();
  const firstIndex = nextCandidateIndex(existing);
  const added: NodeOutputValue[] = [];
  let totals = totalsOf(base);

  const buildForm = (n: number) => {
    const form = new FormData();
    form.append("payload", JSON.stringify({ ...payload, n }));
    for (const file of files) form.append("image[]", file, file.name);
    return form;
  };

  ctx.setProgress(existing.length ? `Rendering the remaining ${remaining} of ${settings.total}…` : `Rendering 0 of ${remaining}…`);
  let outcome: RunChunksOutcome = { aborted: false, delivered: 0 };
  try {
    outcome = await runChunks(planChunks(remaining, settings.perCall), {
      fetchImpl: (input, init) => fetch(input, init),
      buildForm,
      limiter: sharedIpmLimiter(),
      ipm: settings.ipm,
      signal: ctx.signal,
      sleep: realSleep,
      onChunk: (chunk, response) => {
        const mimeType = (response.mimeType || mimeTypeForFormat(payload.outputFormat)) as ImageOutputMimeType;
        response.images.forEach((base64, offset) => {
          const cacheKey = `${ctx.nodeId}:${burstId}:${firstIndex + chunk.offset + offset}`;
          const url = putBlob(cacheKey, new Blob([decodeBase64Image(base64)], { type: mimeType }));
          added.push({ kind: "image", url, cacheKey, mimeType, outputFormat: payload.outputFormat, background: payload.background, model: payload.model });
        });
        totals = addUsage(totals, response.usage, response.images.length);
      },
      onProgress: (delivered) => {
        if (!ctx.signal.aborted) ctx.setProgress(`Rendered ${delivered} of ${remaining}…`);
      },
      onCancelWait: (inFlight) => {
        if (inFlight) ctx.setProgress(`Cancelling — waiting for ${inFlight} ${inFlight === 1 ? "call" : "calls"} already sent…`);
      },
    });
  } finally {
    const run = buildMultiRunRun({
      runId: base && isNewest(base.runId) ? base.runId : ctx.createRunId(),
      signature: ctx.signature,
      existing,
      added,
      total: settings.total,
      totals,
      at: Date.now(),
    });
    if (run) ctx.applyRun(run);
  }

  if (outcome.aborted) throw new DOMException("Aborted", "AbortError");
  const saved = existing.length + added.length;
  if (outcome.stopReason !== undefined) throw new Error(partialRunMessage(saved, settings.total, outcome.stopReason));
  if (saved < settings.total) throw new Error(partialRunMessage(saved, settings.total, "OpenAI returned fewer images than were asked for"));
}
