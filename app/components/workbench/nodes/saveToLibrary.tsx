"use client";

import { memo } from "react";
import { readApiResponse } from "@/app/lib/api-client";
import { runNodes } from "../executor";
import { useWorkbenchStore } from "../store";
import styles from "../workbench.module.css";
import type { ExecuteContext } from "../types";
import { buildSavePayload } from "./saveToLibrary.manifest";
import { blobFromImageValue, NodeShell, type WorkbenchNodeProps } from "./shared";

export const Component = memo(function SaveToLibraryNode({ id, data }: WorkbenchNodeProps) {
  const updateParams = useWorkbenchStore((state) => state.updateParams);
  const running = useWorkbenchStore((state) => state.running);
  const savedJobId = data.runs[0]?.usage?.jobId as string | undefined;
  return (
    <NodeShell data={data}>
      <label className={styles.field}>
        <span>Filename</span>
        <input className="nodrag" type="text" value={data.params.filename ?? ""} onChange={(event) => updateParams(id, { filename: event.target.value })} />
      </label>
      <button type="button" className={styles.smallButton} disabled={running} onClick={() => void runNodes([id])}>
        Save to Library
      </button>
      {data.status === "done" && savedJobId && <p className={styles.hint}>Saved. It will stay in the Library for 6 months.</p>}
    </NodeShell>
  );
});

// Execute wrapper: reads the input image out of the blob cache and uploads
// it, composing the manifest's pure payload-building core.
export const execute = async (ctx: ExecuteContext): Promise<void> => {
  const image = ctx.inputs("image");
  if (!image.length) throw new Error("Connect an image to save.");
  const file = await blobFromImageValue(image[0]);
  const form = new FormData();
  form.append("payload", JSON.stringify(buildSavePayload(ctx.params)));
  form.append("image", file, file.name);
  const response = await fetch("/api/workbench/save", { method: "POST", body: form, signal: ctx.signal })
    .then((value) => readApiResponse<{ ok: boolean; error?: string; jobId: string }>(value));
  ctx.applyRun({
    runId: ctx.createRunId(),
    signature: ctx.signature,
    at: Date.now(),
    values: [],
    usage: { jobId: response.jobId },
  });
};
