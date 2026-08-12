"use client";

import { useEdges, useNodes } from "@xyflow/react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { readApiResponse } from "@/app/lib/api-client";
import type { NormalizedBox } from "@/app/lib/selective-edit";
import { getBlob, putBlob } from "../blob-cache";
import { recordUsageCalibration } from "../cost";
import { activeRunOf } from "../signature";
import { useWorkbenchStore } from "../store";
import { useModalDismiss } from "../useModalDismiss";
import styles from "../workbench.module.css";
import type { ExecuteContext, MaskShape, NodeOutputValue, WorkbenchNode, WorkbenchParams } from "../types";
import { buildGenerationPayload, decodeBase64Image } from "./generation";
import {
  buildMaskedReferencePrompt,
  clampFluxGuidance,
  FLUX_FILL_GUIDANCE_DEFAULT,
  FLUX_FILL_GUIDANCE_MAX,
  FLUX_FILL_GUIDANCE_MIN,
  FLUX_FILL_SEED_MAX,
  maskedReferenceSupported,
  normalizeFluxSeed,
} from "./maskedEdit.manifest";
import { outputValuesFor, specFor } from "./manifests";
import {
  blobFromImageValue,
  GenerationSettings,
  NodeShell,
  OutputPreview,
  RunFooter,
  useConnectedImageCount,
  type WorkbenchNodeProps,
} from "./shared";

// ---------------------------------------------------------------------------
// Mask geometry. All coordinates are normalized 0-1000 against the image's
// width (x) and height (y) — the same convention as NormalizedBox — so the
// same shapes render identically onto the preview overlay, the full-res
// OpenAI mask, each engine's working-size inpaint mask, and the compositor.
// ---------------------------------------------------------------------------

type MaskTool = "rect" | "brush" | "polygon";

function regionFromParams(params: WorkbenchParams): NormalizedBox | undefined {
  if (
    params.maskRegionX === undefined ||
    params.maskRegionY === undefined ||
    params.maskRegionWidth === undefined ||
    params.maskRegionHeight === undefined
  ) {
    return undefined;
  }
  return [params.maskRegionX, params.maskRegionY, params.maskRegionWidth, params.maskRegionHeight];
}

// Shapes are the source of truth; the bbox params are derived (kept for the
// import schema, cost paths, and pre-shapes graphs). Old graphs carry only
// maskRegion*, which degrades to a single rect shape — bit-identical to the
// old behavior.
// The mask geometry, the drawing modal, and the canvas helpers below are
// exported for the Patch node (patch.tsx), which reuses them verbatim rather
// than growing a second copy that would drift from this one. The import
// direction is one-way: patch.tsx -> maskedEdit.tsx.
export function shapesFromParams(params: WorkbenchParams): MaskShape[] | undefined {
  if (params.maskShapes) {
    try {
      const parsed = JSON.parse(params.maskShapes) as MaskShape[];
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch {
      // fall through to the bbox
    }
  }
  const region = regionFromParams(params);
  if (region) return [{ kind: "rect", x: region[0], y: region[1], width: region[2], height: region[3] }];
  return undefined;
}

export function shapesBounds(shapes: MaskShape[]): NormalizedBox {
  let minX = 1000, minY = 1000, maxX = 0, maxY = 0;
  const stretch = (x: number, y: number, pad = 0) => {
    minX = Math.min(minX, x - pad);
    minY = Math.min(minY, y - pad);
    maxX = Math.max(maxX, x + pad);
    maxY = Math.max(maxY, y + pad);
  };
  for (const shape of shapes) {
    if (shape.kind === "rect") {
      stretch(shape.x, shape.y);
      stretch(shape.x + shape.width, shape.y + shape.height);
    } else {
      const pad = shape.kind === "brush" ? shape.radius : 0;
      for (let index = 0; index < shape.points.length - 1; index += 2) {
        stretch(shape.points[index], shape.points[index + 1], pad);
      }
    }
  }
  minX = Math.max(0, minX);
  minY = Math.max(0, minY);
  maxX = Math.min(1000, Math.max(maxX, minX + 1));
  maxY = Math.min(1000, Math.max(maxY, minY + 1));
  return [minX, minY, maxX - minX, maxY - minY];
}

// Draw every shape filled/stroked into the context at the given pixel size,
// using whatever fillStyle/strokeStyle/composite op the caller configured.
function traceShapesInto(context: CanvasRenderingContext2D, shapes: MaskShape[], width: number, height: number) {
  const sx = width / 1000;
  const sy = height / 1000;
  context.lineCap = "round";
  context.lineJoin = "round";
  for (const shape of shapes) {
    if (shape.kind === "rect") {
      context.fillRect(shape.x * sx, shape.y * sy, shape.width * sx, shape.height * sy);
    } else if (shape.kind === "polygon") {
      if (shape.points.length < 6) continue;
      context.beginPath();
      context.moveTo(shape.points[0] * sx, shape.points[1] * sy);
      for (let index = 2; index < shape.points.length - 1; index += 2) {
        context.lineTo(shape.points[index] * sx, shape.points[index + 1] * sy);
      }
      context.closePath();
      context.fill();
    } else {
      const radius = Math.max(1, shape.radius * sx);
      if (shape.points.length <= 2) {
        context.beginPath();
        context.arc(shape.points[0] * sx, shape.points[1] * sy, radius, 0, Math.PI * 2);
        context.fill();
        continue;
      }
      context.lineWidth = radius * 2;
      context.beginPath();
      context.moveTo(shape.points[0] * sx, shape.points[1] * sy);
      for (let index = 2; index < shape.points.length - 1; index += 2) {
        context.lineTo(shape.points[index] * sx, shape.points[index + 1] * sy);
      }
      context.stroke();
    }
  }
}

// White shapes on transparent — the alpha layer every mask/composite render
// derives from.
export function shapesAlphaCanvas(shapes: MaskShape[], width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser cannot render the mask.");
  context.fillStyle = "#fff";
  context.strokeStyle = "#fff";
  traceShapesInto(context, shapes, width, height);
  return canvas;
}

// OpenAI mask convention: opaque black = protected, transparent = editable.
function renderOpenAiMask(shapes: MaskShape[], width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser cannot render the mask.");
  context.fillStyle = "#000";
  context.fillRect(0, 0, width, height);
  context.globalCompositeOperation = "destination-out";
  context.drawImage(shapesAlphaCanvas(shapes, width, height), 0, 0);
  return canvas;
}

// SD/FLUX mask convention: white = repaint, black = keep.
function renderInpaintMask(shapes: MaskShape[], width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser cannot render the mask.");
  context.fillStyle = "#000";
  context.fillRect(0, 0, width, height);
  context.drawImage(shapesAlphaCanvas(shapes, width, height), 0, 0);
  return canvas;
}

// Stable content hash for the shape set — keys the cached mask blob and, via
// maskCacheKey/maskShapes params, the run memoization signature.
function shapesHash(json: string): string {
  let hash = 5381;
  for (let index = 0; index < json.length; index += 1) {
    hash = ((hash << 5) + hash + json.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(36);
}

export function loadInputImage(url: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.decoding = "async";
  return new Promise((resolve, reject) => {
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not read the input image."));
    image.src = url;
  });
}

export function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((value) => (value ? resolve(value) : reject(new Error("Could not build the mask."))), "image/png"),
  );
}

// ---------------------------------------------------------------------------
// Mask editor modal: rectangle drag, freehand brush, and click-vertex polygon
// over the input image, previewed on a canvas overlay. Pointer events (not
// mouse-only) so every tool works with mouse, touch, and stylus.
//
// Rendered through createPortal(document.body): the node component lives
// inside a React Flow node wrapper, which (a) owns a native d3-drag listener
// that treats any un-`nodrag`-classed pointerdown as "drag the node" — it
// steals the pointer before a single move event reaches the drawing surface —
// and (b) is `transform`-positioned, which hijacks the fixed overlay's
// containing block. Portaling out of the wrapper fixes both; the nodrag/
// nopan/nowheel classes below are defense in depth should the portal target
// ever change.
// ---------------------------------------------------------------------------

const POLYGON_CLOSE_DISTANCE = 25; // normalized units to the first vertex
const BRUSH_MIN_STEP = 3; // normalized units between recorded stroke points

export function MaskModal({
  imageUrl,
  initialShapes,
  pixelExact,
  onCancel,
  onApply,
}: {
  imageUrl: string;
  initialShapes?: MaskShape[];
  pixelExact: boolean;
  onCancel: () => void;
  onApply: (shapes: MaskShape[]) => void;
}) {
  const areaRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [tool, setTool] = useState<MaskTool>("rect");
  const [brushSize, setBrushSize] = useState(30);
  const [shapes, setShapes] = useState<MaskShape[]>(() => initialShapes ?? []);
  const [draftRect, setDraftRect] = useState<{ x: number; y: number; width: number; height: number } | undefined>();
  const [brushPoints, setBrushPoints] = useState<number[] | undefined>();
  const [polygonPoints, setPolygonPoints] = useState<number[]>([]);
  const [cursor, setCursor] = useState<{ x: number; y: number } | undefined>();
  const [surfaceSize, setSurfaceSize] = useState({ width: 0, height: 0 });
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  // Both dismissal paths animate out: Apply stashes its shapes here so the
  // shared exit animation runs before onApply/onCancel fires.
  const pendingApply = useRef<MaskShape[] | null>(null);
  const { closing, requestClose } = useModalDismiss(() => {
    const applied = pendingApply.current;
    if (applied) onApply(applied);
    else onCancel();
  });

  // Keep the overlay canvas bitmap in sync with the displayed image size.
  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    const observer = new ResizeObserver(() => {
      const rect = area.getBoundingClientRect();
      setSurfaceSize({ width: Math.round(rect.width), height: Math.round(rect.height) });
    });
    observer.observe(area);
    return () => observer.disconnect();
  }, []);

  const toNormalized = useCallback((clientX: number, clientY: number) => {
    const rect = areaRef.current?.getBoundingClientRect();
    if (!rect || !rect.width || !rect.height) return { x: 0, y: 0 };
    return {
      x: Math.round(Math.min(1000, Math.max(0, ((clientX - rect.left) / rect.width) * 1000))),
      y: Math.round(Math.min(1000, Math.max(0, ((clientY - rect.top) / rect.height) * 1000))),
    };
  }, []);

  const commitPolygon = useCallback(() => {
    setPolygonPoints((points) => {
      if (points.length >= 6) {
        setShapes((current) => [...current, { kind: "polygon", points }]);
      }
      return [];
    });
  }, []);

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    // Primary pointer only: ignore right/middle clicks and multi-touch
    // secondaries so a stray second finger can't corrupt the shape.
    if (!event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) return;
    // preventDefault kills native image ghost-drag/text selection;
    // stopPropagation keeps the gesture out of any ancestor handlers.
    event.preventDefault();
    event.stopPropagation();
    const point = toNormalized(event.clientX, event.clientY);
    if (tool === "polygon") {
      // Clicking near the first vertex closes the ring (min 3 vertices).
      setPolygonPoints((points) => {
        if (points.length >= 6 && Math.hypot(point.x - points[0], point.y - points[1]) <= POLYGON_CLOSE_DISTANCE) {
          setShapes((current) => [...current, { kind: "polygon", points }]);
          return [];
        }
        return [...points, point.x, point.y];
      });
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    dragStart.current = point;
    if (tool === "rect") setDraftRect({ x: point.x, y: point.y, width: 0, height: 0 });
    else setBrushPoints([point.x, point.y]);
  }, [tool, toNormalized]);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary) return;
    event.stopPropagation();
    const point = toNormalized(event.clientX, event.clientY);
    setCursor(point);
    const start = dragStart.current;
    if (!start) return;
    if (tool === "rect") {
      setDraftRect({
        x: Math.min(start.x, point.x),
        y: Math.min(start.y, point.y),
        width: Math.abs(point.x - start.x),
        height: Math.abs(point.y - start.y),
      });
    } else if (tool === "brush") {
      // Thin the stroke so long scribbles stay compact in params JSON.
      setBrushPoints((points) => {
        if (!points) return points;
        const lastX = points[points.length - 2];
        const lastY = points[points.length - 1];
        if (Math.hypot(point.x - lastX, point.y - lastY) < BRUSH_MIN_STEP) return points;
        return [...points, point.x, point.y];
      });
    }
  }, [tool, toNormalized]);

  const handlePointerUp = useCallback(() => {
    if (!dragStart.current) return;
    dragStart.current = null;
    if (tool === "rect") {
      setDraftRect((draft) => {
        if (draft && draft.width > 4 && draft.height > 4) {
          setShapes((current) => [...current, { kind: "rect", ...draft }]);
        }
        return undefined;
      });
    } else if (tool === "brush") {
      setBrushPoints((points) => {
        if (points) setShapes((current) => [...current, { kind: "brush", points, radius: brushSize }]);
        return undefined;
      });
    }
  }, [tool, brushSize]);

  const undo = useCallback(() => {
    if (polygonPoints.length) setPolygonPoints((points) => points.slice(0, -2));
    else setShapes((current) => current.slice(0, -1));
  }, [polygonPoints.length]);

  const clearAll = useCallback(() => {
    setPolygonPoints([]);
    setDraftRect(undefined);
    setBrushPoints(undefined);
    setShapes([]);
  }, []);

  // Escape backs out of an in-progress polygon without touching the modal.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPolygonPoints([]);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Redraw the overlay: committed + in-progress shapes as one translucent
  // purple layer (flattened first so overlaps don't double-darken), then the
  // in-progress outlines (dashed rect, polygon rubber band, brush cursor).
  useEffect(() => {
    const canvas = canvasRef.current;
    const { width, height } = surfaceSize;
    if (!canvas || !width || !height) return;
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return;

    const preview: MaskShape[] = [...shapes];
    if (draftRect) preview.push({ kind: "rect", ...draftRect });
    if (brushPoints) preview.push({ kind: "brush", points: brushPoints, radius: brushSize });
    const layer = document.createElement("canvas");
    layer.width = width;
    layer.height = height;
    const layerContext = layer.getContext("2d");
    if (!layerContext) return;
    layerContext.fillStyle = "#7c3aed";
    layerContext.strokeStyle = "#7c3aed";
    traceShapesInto(layerContext, preview, width, height);
    context.globalAlpha = 0.35;
    context.drawImage(layer, 0, 0);
    context.globalAlpha = 1;

    const sx = width / 1000;
    const sy = height / 1000;
    context.strokeStyle = "#7c3aed";
    context.lineWidth = 2;
    if (draftRect) {
      context.setLineDash([6, 4]);
      context.strokeRect(draftRect.x * sx, draftRect.y * sy, draftRect.width * sx, draftRect.height * sy);
      context.setLineDash([]);
    }
    if (polygonPoints.length) {
      context.beginPath();
      context.moveTo(polygonPoints[0] * sx, polygonPoints[1] * sy);
      for (let index = 2; index < polygonPoints.length - 1; index += 2) {
        context.lineTo(polygonPoints[index] * sx, polygonPoints[index + 1] * sy);
      }
      if (cursor) context.lineTo(cursor.x * sx, cursor.y * sy);
      context.stroke();
      for (let index = 0; index < polygonPoints.length - 1; index += 2) {
        context.beginPath();
        context.arc(polygonPoints[index] * sx, polygonPoints[index + 1] * sy, index === 0 ? 6 : 3.5, 0, Math.PI * 2);
        context.fillStyle = index === 0 ? "#fff" : "#7c3aed";
        context.fill();
        if (index === 0) {
          context.stroke();
        }
      }
    }
    if (tool === "brush" && cursor && !brushPoints) {
      context.beginPath();
      context.arc(cursor.x * sx, cursor.y * sy, Math.max(1, brushSize * sx), 0, Math.PI * 2);
      context.stroke();
    }
  }, [shapes, draftRect, brushPoints, polygonPoints, cursor, tool, brushSize, surfaceSize]);

  const canApply = shapes.length > 0;
  const toolButton = (value: MaskTool, label: string) => (
    <button
      type="button"
      className={`nodrag ${styles.maskToolButton} ${tool === value ? styles.maskToolActive : ""}`}
      aria-pressed={tool === value}
      onClick={() => {
        setPolygonPoints([]);
        setTool(value);
      }}
    >
      {label}
    </button>
  );

  return createPortal(
    <div className={`${styles.maskModalOverlay} nodrag nopan nowheel ${closing ? styles.overlayClosing : ""}`} role="dialog" aria-modal="true" aria-label="Draw the mask to edit">
      <div className={styles.maskModal}>
        <p className={styles.hint}>
          Paint, outline, or box the area to edit — everything outside is protected.{" "}
          {pixelExact ? "Only the masked pixels are repainted." : "Masking is guidance, not pixel-exact."}
        </p>
        <div className={styles.maskToolbar}>
          {toolButton("rect", "Rectangle")}
          {toolButton("brush", "Brush")}
          {toolButton("polygon", "Polygon")}
          {tool === "brush" && (
            <label className={styles.maskBrushSize}>
              Size
              <input
                type="range"
                className="nodrag"
                min={8}
                max={120}
                value={brushSize}
                onChange={(event) => setBrushSize(Number(event.target.value))}
              />
            </label>
          )}
          {tool === "polygon" && polygonPoints.length >= 6 && (
            <button type="button" className="nodrag" onClick={commitPolygon}>Close shape</button>
          )}
          <button type="button" className="nodrag" onClick={undo} disabled={!shapes.length && !polygonPoints.length}>Undo</button>
          <button type="button" className="nodrag" onClick={clearAll} disabled={!shapes.length && !polygonPoints.length}>Clear</button>
        </div>
        <div
          ref={areaRef}
          className={`${styles.maskCanvasArea} nodrag nopan nowheel`}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onPointerLeave={() => setCursor(undefined)}
          onDoubleClick={commitPolygon}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={imageUrl} alt="Node input" draggable={false} />
          <canvas ref={canvasRef} className={styles.maskPreviewCanvas} />
        </div>
        <div className={styles.maskModalActions}>
          <button type="button" className="nodrag" onClick={requestClose}>Cancel</button>
          <button
            type="button"
            className="nodrag"
            disabled={!canApply}
            onClick={() => {
              pendingApply.current = shapes;
              requestClose();
            }}
          >
            Apply mask
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// Clamping guidance on every keystroke would make values above the 1.5 minimum
// untypable: "15" passes through "1", which would snap to 1.5 and strand the
// caret mid-edit. Accept any numeric value while typing and clamp on blur —
// /api/workbench/inpaint clamps independently, so an out-of-range value left
// in an unblurred field can never reach BFL.
function typedFluxGuidance(value: string): number {
  if (value === "") return FLUX_FILL_GUIDANCE_DEFAULT;
  const guidance = Number(value);
  return Number.isFinite(guidance) ? guidance : FLUX_FILL_GUIDANCE_DEFAULT;
}

export const Component = memo(function MaskedEditNode({ id, data }: WorkbenchNodeProps) {
  const updateParams = useWorkbenchStore((state) => state.updateParams);
  const touchBlobs = useWorkbenchStore((state) => state.touchBlobs);
  const inputImages = useConnectedImageCount(id, ["image", "reference"]);
  const edges = useEdges();
  const nodes = useNodes<WorkbenchNode>();
  const [modalOpen, setModalOpen] = useState(false);

  const inputImageUrl = useMemo(() => {
    const edge = edges.find((candidate) => candidate.target === id && candidate.targetHandle === "image");
    if (!edge) return undefined;
    const source = nodes.find((candidate) => candidate.id === edge.source);
    const run = source ? activeRunOf(source) : undefined;
    const fallbackPort = source ? specFor(source.data.kind).outputs[0]?.id ?? "" : "";
    const value = source && run
      ? outputValuesFor(source, run, edge.sourceHandle ?? fallbackPort).find((entry) => entry.kind === "image")
      : undefined;
    return value && value.kind === "image" ? value.url : undefined;
  }, [edges, nodes, id]);

  const existingShapes = shapesFromParams(data.params);
  const engine = data.params.engine || "gpt-image";
  const referenceConnected = edges.some((edge) => edge.target === id && edge.targetHandle === "reference");

  const applyMask = useCallback(async (shapes: MaskShape[]) => {
    setModalOpen(false);
    if (!inputImageUrl || !shapes.length) return;
    const json = JSON.stringify(shapes);
    if (json.length > 39_000) {
      window.alert("The mask is too detailed to save. Use fewer or simpler strokes.");
      return;
    }
    const [x, y, width, height] = shapesBounds(shapes);
    const cacheKey = `${id}:mask:${shapesHash(json)}`;

    const image = await loadInputImage(inputImageUrl);
    const blob = await canvasToBlob(renderOpenAiMask(shapes, image.naturalWidth, image.naturalHeight));
    if (blob.size >= 4 * 1024 * 1024) {
      window.alert("The mask rendered over 4MB. Draw a simpler mask.");
      return;
    }

    putBlob(cacheKey, blob);
    updateParams(id, {
      maskCacheKey: cacheKey,
      maskShapes: json,
      maskRegionX: x,
      maskRegionY: y,
      maskRegionWidth: width,
      maskRegionHeight: height,
    });
    // The mask is a SOURCE upload (persistBlobKeys declares maskCacheKey),
    // but it's created via updateParams alone, not applyRun -- so it needs
    // its own explicit blob-ownership-changed event (AC16) to get the old
    // mask GC'd and the new one durably written promptly.
    touchBlobs();
  }, [id, inputImageUrl, touchBlobs, updateParams]);

  return (
    <NodeShell data={data} footer={<RunFooter id={id} data={data} inputImages={inputImages} />}>
      <p className={styles.hint}>
        {engine === "workers-ai" && "Pixel-exact: only the masked pixels are repainted (free; best at removal/fill)."}
        {engine === "flux-fill" && "Pixel-exact: only the masked pixels are repainted (FLUX, ~$0.05/run)."}
        {engine === "gpt-image" && "Masking is guidance, not pixel-exact."}
      </p>
      <label className={styles.field}>
        <span>Engine</span>
        <select
          className="nodrag"
          value={engine}
          onChange={(event) => updateParams(id, { engine: event.target.value as "gpt-image" | "workers-ai" | "flux-fill" })}
        >
          <option value="gpt-image">gpt-image-2 — guidance mask (paid)</option>
          <option value="workers-ai">Workers AI SD 1.5 — exact mask (free)</option>
          <option value="flux-fill">FLUX Fill pro — exact mask (~$0.05)</option>
        </select>
      </label>
      {engine === "flux-fill" && (
        <>
          <label className={styles.field}>
            <span>Prompt adherence (guidance)</span>
            <input
              className="nodrag"
              type="number"
              min={FLUX_FILL_GUIDANCE_MIN}
              max={FLUX_FILL_GUIDANCE_MAX}
              step={0.5}
              value={data.params.fluxGuidance ?? FLUX_FILL_GUIDANCE_DEFAULT}
              onChange={(event) => updateParams(id, { fluxGuidance: typedFluxGuidance(event.target.value) })}
              onBlur={(event) => updateParams(id, { fluxGuidance: clampFluxGuidance(event.target.value) })}
            />
          </label>
          <p className={styles.hint}>
            {`${FLUX_FILL_GUIDANCE_MIN}–${FLUX_FILL_GUIDANCE_MAX}. Low (20–35) blends a material or texture into its surroundings; high (50–60) renders the prompt literally, which is right when the region should become a specific new object. Describe what the patch should contain, never what to remove — a “remove the metal” prompt puts metal back.`}
          </p>
          <label className={styles.field}>
            <span>Seed (blank = random)</span>
            <input
              className="nodrag"
              type="number"
              min={0}
              max={FLUX_FILL_SEED_MAX}
              step={1}
              placeholder="random"
              value={data.params.fluxSeed ?? ""}
              onChange={(event) => updateParams(id, { fluxSeed: normalizeFluxSeed(event.target.value) })}
            />
          </label>
          <p className={styles.hint}>Fix the seed to make a re-run reproducible, so changing the prompt or guidance is the only variable.</p>
        </>
      )}
      <label className={styles.field}>
        <span>Reference guidance (GPT Image only)</span>
        <textarea
          className={`${styles.textarea} nodrag nowheel`}
          rows={3}
          placeholder="e.g. Match the reference's veining and satin finish, but keep the base image's scale and perspective."
          value={data.params.referenceInstruction ?? ""}
          disabled={!maskedReferenceSupported(engine)}
          onChange={(event) => updateParams(id, { referenceInstruction: event.target.value })}
        />
      </label>
      <p className={styles.hint}>
        {maskedReferenceSupported(engine)
          ? "Optional: connect Reference image. GPT Image receives it as the second image; the mask remains attached to the base image."
          : referenceConnected
            ? "The connected reference image cannot be used by this engine. Choose GPT Image or disconnect it before running."
            : "Workers AI and FLUX Fill do not support a second reference image; choose GPT Image to use reference guidance."}
      </p>
      <button type="button" className="nodrag" onClick={() => setModalOpen(true)} disabled={!inputImageUrl}>
        {existingShapes ? "Edit mask…" : "Draw mask…"}
      </button>
      {/* Size/quality are gpt-image-2 knobs; the inpaint engines derive their
          working size from the input image, so hide them there. */}
      {engine === "gpt-image" && <GenerationSettings id={id} data={data} />}
      <OutputPreview id={id} data={data} />
      {modalOpen && inputImageUrl && (
        <MaskModal
          imageUrl={inputImageUrl}
          initialShapes={existingShapes}
          pixelExact={engine !== "gpt-image"}
          onCancel={() => setModalOpen(false)}
          onApply={applyMask}
        />
      )}
    </NodeShell>
  );
});

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

// Composite the edited result back over the full-resolution original through
// the actual shape mask: edited pixels fade in across a feather band just
// inside the mask edge, and everything outside stays bit-identical (the
// blurred blend layer is clipped by the hard mask, so no edited pixel leaks
// past the drawn boundary).
async function compositeShapesEdit(originalUrl: string, editedUrl: string, shapes: MaskShape[]): Promise<Blob> {
  const [original, edited] = await Promise.all([loadInputImage(originalUrl), loadInputImage(editedUrl)]);
  const width = original.naturalWidth;
  const height = original.naturalHeight;
  const feather = Math.max(8, Math.min(28, Math.round(Math.min(width, height) * 0.009)));

  const hard = shapesAlphaCanvas(shapes, width, height);
  const blend = document.createElement("canvas");
  blend.width = width;
  blend.height = height;
  const blendContext = blend.getContext("2d");
  if (!blendContext) throw new Error("This browser cannot merge the masked edit.");
  blendContext.filter = `blur(${feather}px)`;
  blendContext.drawImage(hard, 0, 0);
  blendContext.filter = "none";
  blendContext.globalCompositeOperation = "destination-in";
  blendContext.drawImage(hard, 0, 0);

  const editedLayer = document.createElement("canvas");
  editedLayer.width = width;
  editedLayer.height = height;
  const editedContext = editedLayer.getContext("2d");
  if (!editedContext) throw new Error("This browser cannot merge the masked edit.");
  editedContext.drawImage(edited, 0, 0, width, height);
  editedContext.globalCompositeOperation = "destination-in";
  editedContext.drawImage(blend, 0, 0);

  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  const outContext = out.getContext("2d");
  if (!outContext) throw new Error("This browser cannot merge the masked edit.");
  outContext.drawImage(original, 0, 0);
  outContext.drawImage(editedLayer, 0, 0);
  return canvasToBlob(out);
}

// Composite each returned candidate and cache the results. Shared by all
// engines — it's what makes protection pixel-exact regardless of what the
// model returned or at what size.
async function compositedOutputs(
  ctx: ExecuteContext,
  runId: string,
  base64Images: string[],
  mimeType: string,
  originalUrl: string,
  shapes: MaskShape[],
): Promise<NodeOutputValue[]> {
  const images: NodeOutputValue[] = [];
  for (let index = 0; index < base64Images.length; index += 1) {
    const cacheKey = `${ctx.nodeId}:${runId}:${index}`;
    const bytes = decodeBase64Image(base64Images[index]);
    const editedUrl = URL.createObjectURL(new Blob([bytes], { type: mimeType || "image/png" }));
    try {
      const compositedBlob = await compositeShapesEdit(originalUrl, editedUrl, shapes);
      images.push({ kind: "image", url: putBlob(cacheKey, compositedBlob), cacheKey });
    } finally {
      URL.revokeObjectURL(editedUrl);
    }
  }
  return images;
}

// Per-engine working sizes; the full-resolution original is composited back
// over the result, so only the edited region pays the downscale. SD 1.5's
// quality sweet spot is 1024; FLUX Fill holds up at 2048 (and is priced flat
// per image, so the larger canvas costs nothing extra).
const INPAINT_LONG_EDGE = { "workers-ai": 1024, "flux-fill": 2048 } as const;

// Mask-conditioned engines (Workers AI SD 1.5 / FLUX Fill): rebuild the base
// image + a white-on-black mask (white = repaint) at the engine's working
// size, straight from the shape params — no dependency on the cached
// OpenAI-convention mask blob.
async function executeInpaintEngine(
  ctx: ExecuteContext,
  engine: keyof typeof INPAINT_LONG_EDGE,
  prompt: string,
  originalUrl: string,
  shapes: MaskShape[],
): Promise<void> {
  const image = await loadInputImage(originalUrl);
  const scale = Math.min(1, INPAINT_LONG_EDGE[engine] / Math.max(image.naturalWidth, image.naturalHeight, 1));
  // Model bounds: 256-2048, dimensions divisible by 8.
  const toDimension = (value: number) => Math.min(2048, Math.max(256, Math.round((value * scale) / 8) * 8));
  const width = toDimension(image.naturalWidth);
  const height = toDimension(image.naturalHeight);

  const baseCanvas = document.createElement("canvas");
  baseCanvas.width = width;
  baseCanvas.height = height;
  const baseContext = baseCanvas.getContext("2d");
  if (!baseContext) throw new Error("This browser cannot prepare the image for inpainting.");
  baseContext.imageSmoothingQuality = "high";
  baseContext.drawImage(image, 0, 0, width, height);

  const [baseBlob, maskBlob] = await Promise.all([
    canvasToBlob(baseCanvas),
    canvasToBlob(renderInpaintMask(shapes, width, height)),
  ]);
  // guidance/seed are FLUX-only knobs; the Workers AI path has its own fixed
  // guidance, and sending them there would only perturb the payload.
  const tuning = engine === "flux-fill"
    ? { guidance: clampFluxGuidance(ctx.params.fluxGuidance), seed: normalizeFluxSeed(ctx.params.fluxSeed) }
    : {};
  const form = new FormData();
  form.append("payload", JSON.stringify({ engine, prompt, width, height, ...tuning }));
  form.append("image", new File([baseBlob], "input.png", { type: "image/png" }), "input.png");
  form.append("mask", new File([maskBlob], "mask.png", { type: "image/png" }), "mask.png");

  ctx.setProgress(engine === "flux-fill" ? "Inpainting region (FLUX)…" : "Inpainting region…");
  const response = await fetch("/api/workbench/inpaint", { method: "POST", body: form, signal: ctx.signal })
    .then((value) => readApiResponse<{ ok: boolean; images: string[]; mimeType: string }>(value));

  const runId = ctx.createRunId();
  const images = await compositedOutputs(ctx, runId, response.images, response.mimeType, originalUrl, shapes);
  ctx.applyRun({ runId, signature: ctx.signature, at: Date.now(), values: [images] });
}

// DOM-touching execute wrapper. gpt-image engine: uploads the cached PNG mask
// (<4MB, opaque elsewhere / transparent inside the drawn shapes) alongside
// the base image to /api/workbench/edit. Inpaint engines:
// executeInpaintEngine above. All engines composite the edited result back
// over the original through the shape mask (feathered inward, bit-identical
// outside).
export async function execute(ctx: ExecuteContext): Promise<void> {
  const basePayload = buildGenerationPayload(ctx.params, ctx.inputs("prompt"));
  const base = ctx.inputs("image");
  if (!base.length) throw new Error("Connect an input image first.");
  const baseValue = base[0];
  if (baseValue.kind !== "image") throw new Error("Connect an input image first.");
  const references = ctx.inputs("reference");
  if (references.length && !maskedReferenceSupported(ctx.params.engine)) {
    throw new Error("Reference images are supported only by the GPT Image engine. Switch engines or disconnect the reference image.");
  }
  const referenceValue = references[0];
  if (referenceValue && referenceValue.kind !== "image") throw new Error("Connect a photo to the Reference image input.");
  const payload = {
    ...basePayload,
    prompt: buildMaskedReferencePrompt(
      basePayload.prompt,
      ctx.params.referenceInstruction,
      Boolean(referenceValue),
    ),
  };
  if (payload.prompt.length > 32_000) {
    throw new Error("The prompt plus reference guidance exceeds the 32,000 character limit.");
  }

  const shapes = shapesFromParams(ctx.params);
  if (!shapes) throw new Error("Draw a mask first.");

  if (ctx.params.engine === "workers-ai" || ctx.params.engine === "flux-fill") {
    await executeInpaintEngine(ctx, ctx.params.engine, payload.prompt, baseValue.url, shapes);
    return;
  }

  const maskCacheKey = ctx.params.maskCacheKey;
  if (!maskCacheKey) throw new Error("Draw a mask first.");
  const maskBlob = getBlob(maskCacheKey);
  if (!maskBlob) throw new Error("The mask is no longer cached. Redraw the mask.");
  if (maskBlob.size >= 4 * 1024 * 1024) throw new Error("The mask exceeds the 4MB limit; draw a simpler mask.");

  const baseFile = await blobFromImageValue(baseValue);
  const maskFile = new File([maskBlob], "mask.png", { type: "image/png" });

  const form = new FormData();
  form.append("payload", JSON.stringify(payload));
  form.append("image[]", baseFile, "input.png");
  if (referenceValue?.kind === "image") {
    form.append("image[]", await blobFromImageValue(referenceValue), "reference.png");
  }
  form.append("mask", maskFile, "mask.png");

  ctx.setProgress("Editing region…");
  const response = await fetch("/api/workbench/edit", { method: "POST", body: form, signal: ctx.signal })
    .then((value) => readApiResponse<{ ok: boolean; images: string[]; mimeType: string; usage?: Record<string, unknown> }>(value));

  const runId = ctx.createRunId();
  const images = await compositedOutputs(ctx, runId, response.images, response.mimeType, baseValue.url, shapes);
  ctx.applyRun({ runId, signature: ctx.signature, at: Date.now(), values: [images], usage: response.usage });
  recordUsageCalibration(payload.size, payload.quality, response.usage, 1);
}
