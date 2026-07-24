"use client";

import { memo } from "react";
import { clampToValidEditSize } from "@/app/lib/image-edit";
import { putBlob } from "../blob-cache";
import { useWorkbenchStore } from "../store";
import styles from "../workbench.module.css";
import type { ExecuteContext } from "../types";
import { imageCacheKeysFromValue } from "./generation";
import { fileFromCacheKey, NodeShell, OutputPreview, RunFooter, type WorkbenchNodeProps } from "./shared";

export const Component = memo(function ResizeNode({ id, data }: WorkbenchNodeProps) {
  const updateParams = useWorkbenchStore((state) => state.updateParams);
  return (
    <NodeShell data={data} footer={<RunFooter id={id} data={data} inputImages={1} />}>
      <label className={styles.field}>
        <span>Width</span>
        <input
          className="nodrag"
          type="number"
          value={data.params.targetWidth ?? 1536}
          onChange={(event) => updateParams(id, { targetWidth: Number(event.target.value) || 0 })}
        />
      </label>
      <label className={styles.field}>
        <span>Height</span>
        <input
          className="nodrag"
          type="number"
          value={data.params.targetHeight ?? 1024}
          onChange={(event) => updateParams(id, { targetHeight: Number(event.target.value) || 0 })}
        />
      </label>
      <p className={styles.hint}>Conforms to gpt-image-2 size rules — zero API cost.</p>
      <OutputPreview id={id} data={data} />
    </NodeShell>
  );
});

// DOM-touching execute wrapper: createImageBitmap + canvas conform the cached
// input image to a valid gpt-image-2 size, then cache the result through
// putBlob. No network request — this node never spends a paid round trip.
export async function execute(ctx: ExecuteContext): Promise<void> {
  const inputs = ctx.inputs("image");
  if (!inputs.length) throw new Error("Connect an input image first.");
  const [cacheKey] = imageCacheKeysFromValue(inputs[0]);
  if (!cacheKey) throw new Error("Connect an input image first.");
  const file = fileFromCacheKey(cacheKey);

  ctx.setProgress("Resizing…");
  const bitmap = await createImageBitmap(file);
  try {
    const requestedWidth = Number(ctx.params.targetWidth) || bitmap.width;
    const requestedHeight = Number(ctx.params.targetHeight) || bitmap.height;
    const { width, height } = clampToValidEditSize(requestedWidth, requestedHeight);

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not prepare the canvas for resizing.");
    context.drawImage(bitmap, 0, 0, width, height);

    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((value) => (value ? resolve(value) : reject(new Error("Could not resize the image."))), "image/png"),
    );

    const runId = ctx.createRunId();
    const outputKey = `${ctx.nodeId}:${runId}:0`;
    const url = putBlob(outputKey, blob);
    ctx.applyRun({
      runId,
      signature: ctx.signature,
      at: Date.now(),
      values: [[{ kind: "image", url, cacheKey: outputKey }]],
    });
  } finally {
    bitmap.close();
  }
}
