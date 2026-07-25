"use client";

import { memo } from "react";
import { useWorkbenchStore } from "../store";
import styles from "../workbench.module.css";
import { runNodes } from "../executor";
import { fileFromCacheKey, NodeShell, type WorkbenchNodeProps } from "./shared";
import { imageCacheKeysFromValue } from "./generation";
import type { ExecuteContext } from "../types";

export const Component = memo(function ExportDownloadNode({ id, data }: WorkbenchNodeProps) {
  const updateParams = useWorkbenchStore((state) => state.updateParams);
  const running = useWorkbenchStore((state) => state.running);
  return (
    <NodeShell data={data}>
      <label className={styles.field}>
        <span>Filename</span>
        <input
          className="nodrag"
          type="text"
          value={data.params.filename ?? ""}
          onChange={(event) => updateParams(id, { filename: event.target.value })}
        />
      </label>
      <label className={styles.field}>
        <span>Format</span>
        <select
          className="nodrag"
          value={data.params.exportFormat ?? "png"}
          onChange={(event) => updateParams(id, { exportFormat: event.target.value as "png" | "jpeg" })}
        >
          <option value="png">PNG</option>
          <option value="jpeg">JPEG</option>
        </select>
      </label>
      <button
        type="button"
        className={styles.smallButton}
        disabled={running}
        // N-2: marks this as an explicit single-node press so the manifest's
        // alwaysExecute flag (W-4) applies -- a second identical Download
        // press still re-downloads. A Run Workflow press (runAll(), which
        // never sets this) treats the node as ordinarily memoized instead,
        // even when it is the graph's sole terminal.
        onClick={() => void runNodes([id], { explicitSingleNode: true })}
      >
        Download
      </button>
    </NodeShell>
  );
});

// DOM-touching execute wrapper: draws the cached input image onto a canvas,
// exports it as a PNG or JPEG blob, and triggers a browser download. Terminal
// (no output ports) — no network request, no return value stored beyond a
// run marker so re-running re-triggers the download.
export async function execute(ctx: ExecuteContext): Promise<void> {
  const inputs = ctx.inputs("image");
  if (!inputs.length) throw new Error("Connect an input image first.");
  const [cacheKey] = imageCacheKeysFromValue(inputs[0]);
  if (!cacheKey) throw new Error("Connect an input image first.");
  const file = fileFromCacheKey(cacheKey);

  const format: "png" | "jpeg" = ctx.params.exportFormat === "jpeg" ? "jpeg" : "png";
  const mimeType = format === "jpeg" ? "image/jpeg" : "image/png";

  ctx.setProgress("Preparing download…");
  const bitmap = await createImageBitmap(file);
  let blob: Blob;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { alpha: format === "png" });
    if (!context) throw new Error("Could not prepare the canvas for export.");
    if (format === "jpeg") {
      // JPEG has no alpha channel — flatten onto opaque white first.
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
    }
    context.drawImage(bitmap, 0, 0);
    blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (value) => (value ? resolve(value) : reject(new Error("Could not export the image."))),
        mimeType,
        format === "jpeg" ? 0.92 : undefined,
      ),
    );
  } finally {
    bitmap.close();
  }

  const requested = (ctx.params.filename || "workbench-output").trim() || "workbench-output";
  const base = requested.replace(/\.[^./\\]+$/, "");
  const filename = `${base}.${format === "jpeg" ? "jpg" : "png"}`;

  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(url);
  }

  ctx.applyRun({ runId: ctx.createRunId(), signature: ctx.signature, at: Date.now(), values: [] });
}
