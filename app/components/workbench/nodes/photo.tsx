"use client";

import { memo, useRef } from "react";
import { fileFingerprint } from "@/app/lib/image-transport";
import { putBlob } from "../blob-cache";
import { PHOTO_SOURCE_KEY } from "../persistence";
import { useWorkbenchStore } from "../store";
import styles from "../workbench.module.css";
import { NodeShell, ThumbnailImage, validateUploadFile, type WorkbenchNodeProps } from "./shared";

export const Component = memo(function PhotoNode({ id, data }: WorkbenchNodeProps) {
  const applyRun = useWorkbenchStore((state) => state.applyRun);
  const updateParams = useWorkbenchStore((state) => state.updateParams);
  const setStatus = useWorkbenchStore((state) => state.setStatus);
  const inputRef = useRef<HTMLInputElement>(null);
  const run = data.runs[data.activeRun];
  const image = run?.values[0]?.[0];

  const choose = (fileList: FileList | null) => {
    const file = fileList?.[0];
    if (!file) return;
    // issue-9: enforce the advertised PNG/JPEG/WebP + 50MB limits at the
    // upload boundary itself (the accept="" attribute on the <input> below
    // is only a picker hint, not a validation boundary), with an actionable
    // error surfaced on the node via NodeShell's existing error display.
    const rejection = validateUploadFile(file);
    if (rejection) {
      setStatus(id, "error", rejection);
      return;
    }
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
        ? (
          <figure className={styles.preview}>
            <ThumbnailImage cacheKey={image.cacheKey} alt={data.params.fileName || "Uploaded"} width={256} height={192} />
          </figure>
        )
        : <p className={styles.hint}>PNG, JPEG, or WebP under 50 MB.</p>}
      <button type="button" className={styles.smallButton} onClick={() => inputRef.current?.click()}>
        {image ? "Replace image" : "Choose image"}
      </button>
      <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(event) => choose(event.target.files)} />
    </NodeShell>
  );
});
