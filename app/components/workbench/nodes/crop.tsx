"use client";

import { useEdges, useNodes } from "@xyflow/react";
import { memo, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { clampToValidEditSize } from "@/app/lib/image-edit";
import { putBlob } from "../blob-cache";
import { useWorkbenchStore } from "../store";
import styles from "../workbench.module.css";
import type { ExecuteContext, MaskShape, WorkbenchNode } from "../types";
import { CropEditor, type CropEditorResult } from "./crop-editor";
import {
  clampRect,
  fractionPointsToPixels,
  fractionRectToPixels,
  pixelPointsToFraction,
  pixelRectToFraction,
  selectionFromParams,
  serializePolygon,
  type CropSelection,
  type FractionRect,
} from "./crop-geometry";
import { imageCacheKeysFromValue } from "./generation";
import { fileFromCacheKey, NodeShell, OutputPreview, RunFooter, ThumbnailImage, type WorkbenchNodeProps } from "./shared";

// Crop node: a quick drag-to-select surface on the card, plus a fullscreen
// editor (crop-editor.tsx) with zoom/pan, handle-resizing, and click-vertex
// polygons for non-rectangular crops. Coordinates are stored as fractions of
// the source image so the same crop tracks any preview scale and survives a
// differently sized upstream image.
//
// Besides the cropped image, the node emits a second "Region" output: the
// exact crop shape in the mask coordinate space the Patch node draws through
// (0-1000 permille, see maskedEdit.tsx). Wire it into Patch's Region input
// and the edited crop is grafted back into precisely the pixels it came from.
export const Component = memo(function CropNode({ id, data }: WorkbenchNodeProps) {
  const updateParams = useWorkbenchStore((state) => state.updateParams);
  const nodes = useNodes<WorkbenchNode>();
  const edges = useEdges();
  const containerRef = useRef<HTMLDivElement>(null);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);

  // Sonnet NEW-1/AC20 exception: this resolves BOTH the cacheKey and the
  // tracked full-resolution URL for the connected source -- see the render
  // below for why the full-res URL is preferred here specifically.
  const source = useMemo(() => {
    const edge = edges.find((candidate) => candidate.target === id && candidate.targetHandle === "image");
    if (!edge) return undefined;
    const sourceNode = nodes.find((candidate) => candidate.id === edge.source);
    const run = sourceNode?.data.runs[sourceNode.data.activeRun];
    const value = run?.values[0]?.find((entry) => entry.kind === "image");
    return value && value.kind === "image" ? { cacheKey: value.cacheKey, url: value.url } : undefined;
  }, [edges, nodes, id]);

  const selection: CropSelection = selectionFromParams(data.params);
  const rect = selection.rect;

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
    // Drawing on the card always produces a rectangle, so a stale polygon
    // must not keep overriding it at execute time.
    updateParams(id, { cropX: next.x, cropY: next.y, cropWidth: next.width, cropHeight: next.height, cropPolygon: "" });
  };

  const stopDrag = () => setDragStart(null);

  const applyEditor = (result: CropEditorResult, imageWidth: number, imageHeight: number) => {
    setEditorOpen(false);
    if (result.kind === "rect") {
      const next = pixelRectToFraction(result.rect, imageWidth, imageHeight);
      updateParams(id, { cropX: next.x, cropY: next.y, cropWidth: next.width, cropHeight: next.height, cropPolygon: "" });
      return;
    }
    const points = pixelPointsToFraction(result.points, imageWidth, imageHeight);
    const polygon = serializePolygon(points);
    const bounds = selectionFromParams({ cropPolygon: polygon }).rect;
    updateParams(id, { cropX: bounds.x, cropY: bounds.y, cropWidth: bounds.width, cropHeight: bounds.height, cropPolygon: polygon });
  };

  return (
    <NodeShell data={data} footer={<RunFooter id={id} data={data} inputImages={1} />}>
      {source ? (
        <>
          <div
            ref={containerRef}
            className={`${styles.preview} nodrag`}
            style={{ position: "relative", cursor: "crosshair", touchAction: "none" }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={stopDrag}
            onPointerCancel={stopDrag}
          >
            {/* Sonnet NEW-1: unlike every other card preview (which
                intentionally never holds a full-res bitmap -- see
                ThumbnailImage), this IS the crop region's own interactive
                drag-to-select surface, not a passive preview -- the same
                category AC20 already carves out for maskedEdit's mask-drawing
                canvas (an "editing surface", per AC20's lightbox/editing
                exception). Precision matters for pixel-accurate region
                selection, so it renders the tracked full-resolution URL
                directly; the thumbnail is only a fallback if that URL is
                unavailable. execute() re-reads the full-res blob via
                ctx.inputs("image") regardless of what's rendered here, so this
                choice never affects crop correctness, only on-screen fidelity. */}
            {source.url ? (
              // This is the editing surface, not a card preview -- see the comment above.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={source.url}
                alt="Crop source"
                draggable={false}
                decoding="async"
                loading="lazy"
                width={256}
                height={192}
              />
            ) : (
              <ThumbnailImage cacheKey={source.cacheKey} alt="Crop source" width={256} height={192} />
            )}
            {selection.kind === "polygon" ? (
              <svg
                viewBox="0 0 1 1"
                preserveAspectRatio="none"
                style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}
                aria-hidden="true"
              >
                <polygon
                  points={selection.points.map((p) => `${p.x},${p.y}`).join(" ")}
                  fill="rgba(124, 58, 237, 0.15)"
                  stroke="#7c3aed"
                  strokeWidth={0.008}
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
            ) : (
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
            )}
          </div>
          <button type="button" className="nodrag" onClick={() => setEditorOpen(true)} disabled={!source.url}>
            {selection.kind === "polygon" ? "Edit polygon crop…" : "Edit crop full screen…"}
          </button>
        </>
      ) : (
        <p className={styles.hint}>Connect an image, then drag to select a region.</p>
      )}
      <p className={styles.hint}>
        {selection.kind === "polygon"
          ? "Polygon crop: pixels outside the shape become transparent. Sunburst treats transparency as “fill me in”, so feed this into an edit or a Patch, not a plain render."
          : "Region crop is clamped to a valid generation size. Region output feeds Patch so the edit lands exactly where the crop came from."}
      </p>
      <OutputPreview id={id} data={data} />
      {editorOpen && source?.url && (
        <CropEditor imageUrl={source.url} initial={selection} onCancel={() => setEditorOpen(false)} onApply={applyEditor} />
      )}
    </NodeShell>
  );
});

// The crop shape as Patch's mask geometry: 0-1000 permille of the SOURCE
// image, which is the same frame Patch's Original input shows.
export function regionShapesFor(selection: CropSelection): MaskShape[] {
  if (selection.kind === "polygon") {
    const points: number[] = [];
    for (const p of selection.points) points.push(p.x * 1000, p.y * 1000);
    return [{ kind: "polygon", points }];
  }
  const r: FractionRect = selection.rect;
  return [{ kind: "rect", x: r.x * 1000, y: r.y * 1000, width: r.width * 1000, height: r.height * 1000 }];
}

// DOM-touching execute wrapper: crops the cached input image to the selected
// region via canvas (polygon crops fill the outside of the shape with
// transparency), clamps the result to a valid gpt-image-2 size, then caches
// it through putBlob. Also rasterizes the region as an alpha mask at source
// size so the "Region" output survives persistence like any other blob-backed
// value. No network request.
export async function execute(ctx: ExecuteContext): Promise<void> {
  const inputs = ctx.inputs("image");
  if (!inputs.length) throw new Error("Connect an input image first.");
  const [cacheKey] = imageCacheKeysFromValue(inputs[0]);
  if (!cacheKey) throw new Error("Connect an input image first.");
  const file = fileFromCacheKey(cacheKey);

  const selection = selectionFromParams(ctx.params);

  ctx.setProgress("Cropping…");
  const bitmap = await createImageBitmap(file);
  try {
    const source = fractionRectToPixels(selection.rect, bitmap.width, bitmap.height);
    const { width, height } = clampToValidEditSize(source.width, source.height);

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not prepare the canvas for cropping.");

    if (selection.kind === "polygon") {
      // Clip to the polygon, expressed in output pixels: source pixel p maps
      // to ((p - source.origin) * output/source).
      const sx = width / source.width;
      const sy = height / source.height;
      const points = fractionPointsToPixels(selection.points, bitmap.width, bitmap.height);
      context.beginPath();
      points.forEach((p, index) => {
        const x = (p.x - source.x) * sx;
        const y = (p.y - source.y) * sy;
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      });
      context.closePath();
      context.clip();
    }
    context.drawImage(bitmap, source.x, source.y, source.width, source.height, 0, 0, width, height);

    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((value) => (value ? resolve(value) : reject(new Error("Could not crop the image."))), "image/png"),
    );

    // Region mask at source resolution: white inside the shape, transparent
    // outside -- the same convention maskedEdit's alpha masks use.
    const shapes = regionShapesFor(selection);
    const maskCanvas = document.createElement("canvas");
    maskCanvas.width = bitmap.width;
    maskCanvas.height = bitmap.height;
    const maskContext = maskCanvas.getContext("2d");
    if (!maskContext) throw new Error("Could not prepare the region mask.");
    maskContext.fillStyle = "#fff";
    for (const shape of shapes) {
      if (shape.kind === "rect") {
        maskContext.fillRect((shape.x / 1000) * bitmap.width, (shape.y / 1000) * bitmap.height, (shape.width / 1000) * bitmap.width, (shape.height / 1000) * bitmap.height);
      } else if (shape.kind === "polygon") {
        maskContext.beginPath();
        for (let index = 0; index < shape.points.length - 1; index += 2) {
          const x = (shape.points[index] / 1000) * bitmap.width;
          const y = (shape.points[index + 1] / 1000) * bitmap.height;
          if (index === 0) maskContext.moveTo(x, y);
          else maskContext.lineTo(x, y);
        }
        maskContext.closePath();
        maskContext.fill();
      }
    }
    const maskBlob = await new Promise<Blob>((resolve, reject) =>
      maskCanvas.toBlob((value) => (value ? resolve(value) : reject(new Error("Could not render the region mask."))), "image/png"),
    );

    const runId = ctx.createRunId();
    const outputKey = `${ctx.nodeId}:${runId}:0`;
    const regionKey = `${ctx.nodeId}:${runId}:1`;
    const url = putBlob(outputKey, blob);
    putBlob(regionKey, maskBlob);
    ctx.applyRun({
      runId,
      signature: ctx.signature,
      at: Date.now(),
      values: [
        [{ kind: "image", url, cacheKey: outputKey, mimeType: "image/png", outputFormat: "png" }],
        [{ kind: "mask", cacheKey: regionKey, shapes }],
      ],
    });
  } finally {
    bitmap.close();
  }
}
