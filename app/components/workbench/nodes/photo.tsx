/* eslint-disable @next/next/no-img-element */
"use client";

import { memo, useRef } from "react";
import { fileFingerprint } from "@/app/lib/image-transport";
import { putBlob } from "../blob-cache";
import { PHOTO_SOURCE_KEY } from "../persistence";
import { useWorkbenchStore } from "../store";
import styles from "../workbench.module.css";
import { NodeShell, type WorkbenchNodeProps } from "./shared";

export const Component = memo(function PhotoNode({ id, data }: WorkbenchNodeProps) {
  const applyRun = useWorkbenchStore((state) => state.applyRun);
  const updateParams = useWorkbenchStore((state) => state.updateParams);
  const inputRef = useRef<HTMLInputElement>(null);
  const run = data.runs[data.activeRun];
  const image = run?.values[0]?.[0];

  const choose = (fileList: FileList | null) => {
    const file = fileList?.[0];
    if (!file || !file.type.startsWith("image/")) return;
    const url = putBlob(PHOTO_SOURCE_KEY(id), file);
    updateParams(id, { fileName: file.name, fileFingerprint: fileFingerprint(file) });
    applyRun(id, {
      runId: `photo-${Date.now().toString(36)}`,
      signature: `photo:${fileFingerprint(file)}`,
      at: Date.now(),
      values: [[{ kind: "image", url, cacheKey: PHOTO_SOURCE_KEY(id) }]],
    });
  };

  return (
    <NodeShell data={data}>
      {image && image.kind === "image"
        ? <figure className={styles.preview}><img src={image.url} alt={data.params.fileName || "Uploaded"} draggable={false} /></figure>
        : <p className={styles.hint}>PNG, JPEG, or WebP under 50 MB.</p>}
      <button type="button" className={styles.smallButton} onClick={() => inputRef.current?.click()}>
        {image ? "Replace image" : "Choose image"}
      </button>
      <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(event) => choose(event.target.files)} />
    </NodeShell>
  );
});
