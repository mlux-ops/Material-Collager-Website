/* eslint-disable @next/next/no-img-element */
"use client";

import { useEdges, useNodes } from "@xyflow/react";
import { memo, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { clampToValidEditSize } from "@/app/lib/image-edit";
import { putBlob } from "../blob-cache";
import { useWorkbenchStore } from "../store";
import styles from "../workbench.module.css";
import type { ExecuteContext, WorkbenchNode } from "../types";
import { imageCacheKeysFromValue } from "./generation";
import { fileFromCacheKey, NodeShell, OutputPreview, RunFooter, type WorkbenchNodeProps } from "./shared";

type FractionRect = { x: number; y: number; width: number; height: number };

const MIN_FRACTION = 0.02;

function clampRect(rect: FractionRect): FractionRect {
  const x = Math.min(Math.max(rect.x, 0), 1 - MIN_FRACTION);
  const y = Math.min(Math.max(rect.y, 0), 1 - MIN_FRACTION);
  const width = Math.min(Math.max(rect.width, MIN_FRACTION), 1 - x);
  const height = Math.min(Math.max(rect.height, MIN_FRACTION), 1 - y);
  return { x, y, width, height };
}

// Placeholder card region: drag inside the connected image to draw a crop
// box (rectangle/region only — freehand is deferred). Coordinates are
// fractions of the source image, so the box tracks correctly however the
// preview is scaled. Masking/cropping this way is guidance, not pixel-exact.
export const Component = memo(function CropNode({ id, data }: WorkbenchNodeProps) {
  const updateParams = useWorkbenchStore((state) => state.updateParams);
  const nodes = useNodes<WorkbenchNode>();
  const edges = useEdges();
  const containerRef = useRef<HTMLDivElement>(null);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);

  const sourceUrl = useMemo(() => {
    const edge = edges.find((candidate) => candidate.target === id && candidate.targetHandle === "image");
    if (!edge) return undefined;
    const source = nodes.find((candidate) => candidate.id === edge.source);
    const run = source?.data.runs[source.data.activeRun];
    const value = run?.values[0]?.find((entry) => entry.kind === "image");
    return value && value.kind === "image" ? value.url : undefined;
  }, [edges, nodes, id]);

  const rect: FractionRect = {
    x: data.params.cropX ?? 0,
    y: data.params.cropY ?? 0,
    width: data.params.cropWidth ?? 1,
    height: data.params.cropHeight ?? 1,
  };

  const fractionFromEvent = (event: ReactPointerEvent<HTMLDivElement>) => {
    const box = containerRef.current?.getBoundingClientRect();
    if (!box || !box.width || !box.height) return { x: 0, y: 0 };
    return {
      x: Math.min(Math.max((event.clientX - box.left) / box.width, 0), 1),
      y: Math.min(Math.max((event.clientY - box.top) / box.height, 0), 1),
    };
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragStart(fractionFromEvent(event));
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragStart) return;
    const point = fractionFromEvent(event);
    const next = clampRect({
      x: Math.min(dragStart.x, point.x),
      y: Math.min(dragStart.y, point.y),
      width: Math.abs(point.x - dragStart.x),
      height: Math.abs(point.y - dragStart.y),
    });
    updateParams(id, { cropX: next.x, cropY: next.y, cropWidth: next.width, cropHeight: next.height });
  };

  const stopDrag = () => setDragStart(null);

  return (
    <NodeShell data={data} footer={<RunFooter id={id} data={data} inputImages={1} />}>
      {sourceUrl ? (
        <div
          ref={containerRef}
          className={`${styles.preview} nodrag`}
          style={{ position: "relative", cursor: "crosshair", touchAction: "none" }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={stopDrag}
          onPointerCancel={stopDrag}
        >
          <img src={sourceUrl} alt="Crop source" draggable={false} />
          <div
            style={{
              position: "absolute",
              left: `${rect.x * 100}%`,
              top: `${rect.y * 100}%`,
              width: `${rect.width * 100}%`,
              height: `${rect.height * 100}%`,
              border: "2px solid #7c3aed",
              background: "rgba(124, 58, 237, 0.15)",
              pointerEvents: "none",
            }}
          />
        </div>
      ) : (
        <p className={styles.hint}>Connect an image, then drag to select a region.</p>
      )}
      <p className={styles.hint}>Region crop is guidance, clamped to a valid generation size.</p>
      <OutputPreview id={id} data={data} />
    </NodeShell>
  );
});

// DOM-touching execute wrapper: crops the cached input image to the selected
// region via canvas, clamps the result to a valid gpt-image-2 size, then
// caches it through putBlob. No network request.
export async function execute(ctx: ExecuteContext): Promise<void> {
  const inputs = ctx.inputs("image");
  if (!inputs.length) throw new Error("Connect an input image first.");
  const [cacheKey] = imageCacheKeysFromValue(inputs[0]);
  if (!cacheKey) throw new Error("Connect an input image first.");
  const file = fileFromCacheKey(cacheKey);

  const rect = clampRect({
    x: Number(ctx.params.cropX) || 0,
    y: Number(ctx.params.cropY) || 0,
    width: Number(ctx.params.cropWidth) || 1,
    height: Number(ctx.params.cropHeight) || 1,
  });

  ctx.setProgress("Cropping…");
  const bitmap = await createImageBitmap(file);
  try {
    const sourceX = Math.round(rect.x * bitmap.width);
    const sourceY = Math.round(rect.y * bitmap.height);
    const sourceWidth = Math.max(1, Math.round(rect.width * bitmap.width));
    const sourceHeight = Math.max(1, Math.round(rect.height * bitmap.height));
    const { width, height } = clampToValidEditSize(sourceWidth, sourceHeight);

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not prepare the canvas for cropping.");
    context.drawImage(bitmap, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, width, height);

    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((value) => (value ? resolve(value) : reject(new Error("Could not crop the image."))), "image/png"),
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
