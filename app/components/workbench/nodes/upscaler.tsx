"use client";

import { memo } from "react";
import { readApiResponse } from "@/app/lib/api-client";
import { putBlob } from "../blob-cache";
import { useWorkbenchStore } from "../store";
import styles from "../workbench.module.css";
import type { ExecuteContext, NodeOutputValue } from "../types";
import { GENERATION_QUALITIES, decodeBase64Image } from "./generation";
import { UPSCALE_LONG_RUN_THRESHOLD, UPSCALE_SIZES } from "./upscaler.manifest";
import { blobFromImageValue, NodeShell, OutputPreview, RunFooter, useConnectedImageCount, type WorkbenchNodeProps } from "./shared";

// A neutral, content-preserving upscale instruction — the node has no prompt
// input; it always asks for a faithful resolution increase, never a restyle.
const UPSCALE_PROMPT =
  "Upscale this image to the requested resolution. Preserve the exact composition, geometry, color, and every detail; do not add, remove, restyle, or reinterpret any content.";

function targetLongestEdge(size: string): number {
  const match = /^(\d+)x(\d+)$/.exec(size);
  if (!match) return 0;
  return Math.max(Number(match[1]), Number(match[2]));
}

export const Component = memo(function UpscalerNode({ id, data }: WorkbenchNodeProps) {
  const updateParams = useWorkbenchStore((state) => state.updateParams);
  const inputImages = useConnectedImageCount(id, ["image"]);
  const size = data.params.size || "2560x1440";
  const isLongRun = targetLongestEdge(size) >= UPSCALE_LONG_RUN_THRESHOLD;

  return (
    <NodeShell data={data} footer={<RunFooter id={id} data={data} inputImages={inputImages} />}>
      <label className={styles.field}>
        <span>Target size</span>
        <select className="nodrag" value={size} onChange={(event) => updateParams(id, { size: event.target.value })}>
          {UPSCALE_SIZES.map((option) => (
            <option key={option} value={option}>{option}{targetLongestEdge(option) >= 2048 ? " (2K+)" : ""}</option>
          ))}
        </select>
      </label>
      <label className={styles.field}>
        <span>Quality</span>
        <select
          className="nodrag"
          value={data.params.quality ?? "high"}
          onChange={(event) => updateParams(id, { quality: event.target.value as "low" | "medium" | "high" })}
        >
          {GENERATION_QUALITIES.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      </label>
      {isLongRun && (
        <p className={styles.hint}>
          2K+ buffered runs (200-250s+) may fail on idle-gateway timeouts. Streaming is planned for a later phase.
        </p>
      )}
      <OutputPreview id={id} data={data} />
    </NodeShell>
  );
});

// DOM-touching execute wrapper: buffered (no SSE) call over
// /api/workbench/edit. The executor's run AbortSignal (ctx.signal) already
// flows into this fetch, the route forwards it as request.signal, and
// image-edit.ts combines it with the 300s upstream timeout via
// AbortSignal.any — so cancelling mid-run aborts the paid OpenAI call too.
export async function execute(ctx: ExecuteContext): Promise<void> {
  const base = ctx.inputs("image");
  if (!base.length) throw new Error("Connect an input image first.");
  const file = await blobFromImageValue(base[0]);

  const size = ctx.params.size || "2560x1440";
  const quality = ctx.params.quality || "high";

  const form = new FormData();
  form.append("payload", JSON.stringify({ prompt: UPSCALE_PROMPT, size, quality, n: 1 }));
  form.append("image[]", file, "input.png");

  ctx.setProgress(`Upscaling to ${size}… long runs may take several minutes.`);
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
}
