"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { MARKUP_MAX_BYTES, MARKUP_MAX_PIXELS } from "@/app/lib/image-edit";
import { putBlob } from "../blob-cache";
import { useWorkbenchStore } from "../store";
import { useModalDismiss } from "../useModalDismiss";
import styles from "../workbench.module.css";
import type { ExecuteContext, MaskShape } from "../types";
import {
  fitTransform,
  imageToScreen,
  MAX_ZOOM,
  MIN_ZOOM,
  panBy,
  screenToImage,
  zoomAround,
  type Point,
  type ViewTransform,
} from "./crop-geometry";
import {
  buildMarkupPrompt,
  colorsMissingInstructions,
  MARKUP_PALETTE,
  MARKUP_STROKES_MAX_LENGTH,
  markupColorHex,
  parseInstructions,
  parseStrokes,
  usedColors,
  type MarkupColorName,
  type MarkupInstructions,
  type MarkupStroke,
} from "./imageMarkup.manifest";
import { loadInputImage, traceShapesInto } from "./maskedEdit";
import {
  blobFromImageValue,
  NodeShell,
  OutputPreview,
  RunFooter,
  useConnectedImageValue,
  type WorkbenchNodeProps,
} from "./shared";

// ---------------------------------------------------------------------------
// Stroke rendering. Strokes share Masked Edit's brush geometry (normalized
// 0-1000, radius against the image width) and its tracer, drawn one at a time
// in stored order so a later stroke covers an earlier one, fully opaque.
// ---------------------------------------------------------------------------

function strokeShape(stroke: MarkupStroke): MaskShape {
  return { kind: "brush", points: stroke.points, radius: stroke.radius };
}

function drawStrokes(context: CanvasRenderingContext2D, strokes: MarkupStroke[], width: number, height: number) {
  context.globalAlpha = 1;
  context.globalCompositeOperation = "source-over";
  for (const stroke of strokes) {
    const hex = markupColorHex(stroke.color);
    context.fillStyle = hex;
    context.strokeStyle = hex;
    traceShapesInto(context, [strokeShape(stroke)], width, height);
  }
}

const BRUSH_MIN_STEP = 3; // normalized units between recorded stroke points

// ---------------------------------------------------------------------------
// Drawing modal: freehand brush in one of the palette colours over the input
// image, with the same zoom/pan model as Masked Edit's and Crop's editors
// (crop-geometry.ts). Portaled to document.body for the same reasons as
// MaskModal (maskedEdit.tsx): React Flow's node wrapper steals un-`nodrag`
// pointerdowns and its transform hijacks a fixed overlay's containing block.
// ---------------------------------------------------------------------------

function MarkupModal({
  imageUrl,
  initialStrokes,
  onCancel,
  onApply,
}: {
  imageUrl: string;
  initialStrokes: MarkupStroke[];
  onCancel: () => void;
  onApply: (strokes: MarkupStroke[]) => void;
}) {
  const areaRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null);
  const [color, setColor] = useState<MarkupColorName>(() => initialStrokes[initialStrokes.length - 1]?.color ?? "red");
  const [brushSize, setBrushSize] = useState(12);
  const [strokes, setStrokes] = useState<MarkupStroke[]>(initialStrokes);
  const [draftPoints, setDraftPoints] = useState<number[] | undefined>();
  const [cursor, setCursor] = useState<{ x: number; y: number } | undefined>();
  const [surfaceSize, setSurfaceSize] = useState({ width: 0, height: 0 });
  const [view, setView] = useState<ViewTransform>({ scale: 1, offsetX: 0, offsetY: 0 });
  const [fitted, setFitted] = useState(false);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [panning, setPanning] = useState(false);
  // The stroke in progress lives in a ref (the state copy only drives the
  // redraw) so pointer-up commits it without a side effect inside a state
  // updater, which StrictMode would run twice.
  const draftRef = useRef<number[] | undefined>(undefined);
  const panLast = useRef<Point | null>(null);
  const pendingApply = useRef<MarkupStroke[] | null>(null);
  const { closing, requestClose } = useModalDismiss(() => {
    const applied = pendingApply.current;
    if (applied) onApply(applied);
    else onCancel();
  });

  // Fit the image to the surface exactly once, from the load/resize
  // callbacks (event callbacks, not effect bodies) so no effect sets state.
  const seededRef = useRef(false);
  const latestSizes = useRef<{ image: { width: number; height: number } | null; surface: { width: number; height: number } }>({
    image: null,
    surface: { width: 0, height: 0 },
  });
  const trySeed = () => {
    const { image, surface } = latestSizes.current;
    if (seededRef.current || !image || !surface.width || !surface.height) return;
    seededRef.current = true;
    setView(fitTransform(image.width, image.height, surface.width, surface.height));
    setFitted(true);
  };

  useEffect(() => {
    let cancelled = false;
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      if (cancelled) return;
      imageRef.current = image;
      const size = { width: image.naturalWidth, height: image.naturalHeight };
      latestSizes.current.image = size;
      setImageSize(size);
      trySeed();
    };
    image.src = imageUrl;
    return () => {
      cancelled = true;
    };
  }, [imageUrl]);

  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    const observer = new ResizeObserver(() => {
      const rect = area.getBoundingClientRect();
      const size = { width: Math.round(rect.width), height: Math.round(rect.height) };
      latestSizes.current.surface = size;
      setSurfaceSize(size);
      trySeed();
    });
    observer.observe(area);
    return () => observer.disconnect();
  }, []);

  const screenPoint = useCallback((clientX: number, clientY: number): Point => {
    const box = areaRef.current?.getBoundingClientRect();
    return { x: clientX - (box?.left ?? 0), y: clientY - (box?.top ?? 0) };
  }, []);

  // Screen px -> normalized 0-1000 image units; the hover cursor is left
  // unclamped so the brush ring follows the pointer over the letterbox.
  const toNormalized = useCallback((clientX: number, clientY: number, clamp = true) => {
    const size = latestSizes.current.image;
    if (!size) return { x: 0, y: 0 };
    const image = screenToImage(screenPoint(clientX, clientY), view);
    const x = (image.x / size.width) * 1000;
    const y = (image.y / size.height) * 1000;
    if (!clamp) return { x, y };
    return {
      x: Math.round(Math.min(1000, Math.max(0, x))),
      y: Math.round(Math.min(1000, Math.max(0, y))),
    };
  }, [screenPoint, view]);

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary || !fitted) return;
    event.preventDefault();
    event.stopPropagation();
    // Space+drag, middle-drag, or right-drag pans; a primary drag paints.
    if (spaceHeld || event.button === 1 || event.button === 2) {
      event.currentTarget.setPointerCapture(event.pointerId);
      panLast.current = screenPoint(event.clientX, event.clientY);
      setPanning(true);
      return;
    }
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = toNormalized(event.clientX, event.clientY);
    draftRef.current = [point.x, point.y];
    setDraftPoints(draftRef.current);
  }, [toNormalized, screenPoint, spaceHeld, fitted]);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary) return;
    event.stopPropagation();
    if (panLast.current) {
      const screen = screenPoint(event.clientX, event.clientY);
      const last = panLast.current;
      setView((current) => panBy(current, screen.x - last.x, screen.y - last.y));
      panLast.current = screen;
      return;
    }
    setCursor(toNormalized(event.clientX, event.clientY, false));
    const points = draftRef.current;
    if (!points) return;
    const point = toNormalized(event.clientX, event.clientY);
    // Thin the stroke so long scribbles stay compact in params JSON.
    const lastX = points[points.length - 2];
    const lastY = points[points.length - 1];
    if (Math.hypot(point.x - lastX, point.y - lastY) < BRUSH_MIN_STEP) return;
    draftRef.current = [...points, point.x, point.y];
    setDraftPoints(draftRef.current);
  }, [toNormalized, screenPoint]);

  const handlePointerUp = useCallback(() => {
    if (panLast.current) {
      panLast.current = null;
      setPanning(false);
      return;
    }
    const points = draftRef.current;
    if (!points) return;
    draftRef.current = undefined;
    setDraftPoints(undefined);
    setStrokes((current) => [...current, { color, radius: brushSize, points }]);
  }, [color, brushSize]);

  const undo = useCallback(() => setStrokes((current) => current.slice(0, -1)), []);
  const clearAll = useCallback(() => {
    draftRef.current = undefined;
    setDraftPoints(undefined);
    setStrokes([]);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === "Space") {
        event.preventDefault();
        setSpaceHeld(true);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === "Space") setSpaceHeld(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  // Native, non-passive wheel listener: React's onWheel is passive, so its
  // preventDefault would be ignored and the canvas would scroll underneath.
  const fittedRef = useRef(fitted);
  useEffect(() => {
    fittedRef.current = fitted;
  }, [fitted]);
  useEffect(() => {
    const surface = areaRef.current;
    if (!surface) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (!fittedRef.current) return;
      const box = surface.getBoundingClientRect();
      const anchor = { x: event.clientX - box.left, y: event.clientY - box.top };
      const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0015));
      setView((current) => zoomAround(current, factor, anchor));
    };
    surface.addEventListener("wheel", onWheel, { passive: false });
    return () => surface.removeEventListener("wheel", onWheel);
  }, []);

  const zoomButton = (factor: number) => {
    setView((current) => zoomAround(current, factor, { x: surfaceSize.width / 2, y: surfaceSize.height / 2 }));
  };

  const fit = () => {
    if (imageSize) setView(fitTransform(imageSize.width, imageSize.height, surfaceSize.width, surfaceSize.height));
  };

  // Redraw: the bitmap under the current view, then every stroke (plus the
  // one in progress) opaque in its colour, then the brush cursor ring.
  useEffect(() => {
    const canvas = canvasRef.current;
    const image = imageRef.current;
    const { width, height } = surfaceSize;
    if (!canvas || !image || !imageSize || !width || !height) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    context.imageSmoothingEnabled = view.scale < 1;

    const origin = imageToScreen({ x: 0, y: 0 }, view);
    const drawW = imageSize.width * view.scale;
    const drawH = imageSize.height * view.scale;
    context.drawImage(image, origin.x, origin.y, drawW, drawH);

    const preview = draftPoints ? [...strokes, { color, radius: brushSize, points: draftPoints }] : strokes;
    context.save();
    context.translate(origin.x, origin.y);
    drawStrokes(context, preview, drawW, drawH);
    context.restore();

    if (cursor && !draftPoints) {
      const radius = Math.max(1, brushSize * (drawW / 1000));
      const cx = origin.x + cursor.x * (drawW / 1000);
      const cy = origin.y + cursor.y * (drawH / 1000);
      context.lineWidth = 3;
      context.strokeStyle = "#000";
      context.beginPath();
      context.arc(cx, cy, radius, 0, Math.PI * 2);
      context.stroke();
      context.lineWidth = 1.5;
      context.strokeStyle = markupColorHex(color);
      context.stroke();
    }
  }, [imageSize, strokes, draftPoints, cursor, color, brushSize, surfaceSize, view]);

  return createPortal(
    <div className={`${styles.maskModalOverlay} nodrag nopan nowheel ${closing ? styles.overlayClosing : ""}`} role="dialog" aria-modal="true" aria-label="Draw markup">
      <div className={`${styles.maskModal} ${styles.cropEditor}`}>
        <p className={styles.hint}>
          Paint over what should change, one colour per change. Only the marks are exported, on a transparent layer the size of the input image.
        </p>
        <div className={styles.maskToolbar}>
          <div className={styles.markupSwatches} role="radiogroup" aria-label="Brush colour">
            {MARKUP_PALETTE.map((entry) => (
              <button
                key={entry.name}
                type="button"
                role="radio"
                aria-checked={color === entry.name}
                aria-label={entry.name}
                title={entry.name}
                className={`nodrag ${styles.markupSwatchButton} ${color === entry.name ? styles.markupSwatchActive : ""}`}
                style={{ background: entry.hex }}
                onClick={() => setColor(entry.name)}
              />
            ))}
          </div>
          <span className={styles.markupColorName}>{color}</span>
          <label className={styles.maskBrushSize}>
            Size
            <input
              type="range"
              className="nodrag"
              min={2}
              max={80}
              value={brushSize}
              onChange={(event) => setBrushSize(Number(event.target.value))}
            />
          </label>
          <button type="button" className="nodrag" onClick={undo} disabled={!strokes.length}>Undo</button>
          <button type="button" className="nodrag" onClick={clearAll} disabled={!strokes.length}>Clear</button>
          <span className={styles.cropEditorDivider} />
          <button type="button" className="nodrag" onClick={() => zoomButton(1 / 1.25)} aria-label="Zoom out" disabled={!fitted || view.scale <= MIN_ZOOM}>−</button>
          <span className={styles.cropEditorZoom}>{Math.round(view.scale * 100)}%</span>
          <button type="button" className="nodrag" onClick={() => zoomButton(1.25)} aria-label="Zoom in" disabled={!fitted || view.scale >= MAX_ZOOM}>+</button>
          <button type="button" className="nodrag" onClick={fit} disabled={!fitted}>Fit</button>
          <button
            type="button"
            className="nodrag"
            disabled={!fitted}
            onClick={() => setView((current) => zoomAround(current, 1 / current.scale, { x: surfaceSize.width / 2, y: surfaceSize.height / 2 }))}
          >
            100%
          </button>
        </div>
        <div
          ref={areaRef}
          className={`${styles.cropEditorSurface} nodrag nopan nowheel`}
          style={{ cursor: spaceHeld || panning ? "grab" : "crosshair" }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onPointerLeave={() => setCursor(undefined)}
          onContextMenu={(event) => event.preventDefault()}
        >
          <canvas ref={canvasRef} className={styles.maskPreviewCanvas} />
          {!imageSize && <p className={styles.hint}>Loading image…</p>}
        </div>
        <div className={styles.cropEditorFooter}>
          <span className={styles.hint}>Drag to paint. Wheel zooms, Space+drag or right-drag pans.</span>
        </div>
        <div className={styles.maskModalActions}>
          <button type="button" className="nodrag" onClick={requestClose}>Cancel</button>
          <button
            type="button"
            className="nodrag"
            onClick={() => {
              pendingApply.current = strokes;
              requestClose();
            }}
          >
            Done
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Card preview: the input image with the strokes over it, drawn into a
// canvas at a fixed internal width (CSS scales it to the card).
// ---------------------------------------------------------------------------

const PREVIEW_WIDTH = 480;

function MarkupPreview({ imageUrl, strokes }: { imageUrl: string; strokes: MarkupStroke[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let cancelled = false;
    loadInputImage(imageUrl)
      .then((image) => {
        const canvas = canvasRef.current;
        if (cancelled || !canvas || !image.naturalWidth || !image.naturalHeight) return;
        const width = PREVIEW_WIDTH;
        const height = Math.max(1, Math.round((image.naturalHeight / image.naturalWidth) * width));
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) return;
        context.clearRect(0, 0, width, height);
        context.drawImage(image, 0, 0, width, height);
        drawStrokes(context, strokes, width, height);
      })
      .catch(() => {
        // The card simply shows no preview; execute reports a real read error.
      });
    return () => {
      cancelled = true;
    };
  }, [imageUrl, strokes]);
  return <canvas ref={canvasRef} className={styles.markupPreview} aria-label="Input image with markup" />;
}

export const Component = memo(function ImageMarkupNode({ id, data }: WorkbenchNodeProps) {
  const updateParams = useWorkbenchStore((state) => state.updateParams);
  const inputImage = useConnectedImageValue(id, "image");
  const inputImageUrl = inputImage?.kind === "image" ? inputImage.url : undefined;
  const [modalOpen, setModalOpen] = useState(false);

  const strokes = useMemo(() => parseStrokes(data.params.strokes), [data.params.strokes]);
  const instructions = useMemo(() => parseInstructions(data.params.instructions), [data.params.instructions]);
  const used = usedColors(strokes);
  const missing = colorsMissingInstructions(strokes, instructions);

  const promptPreview = useMemo(() => {
    try {
      return buildMarkupPrompt(strokes, instructions);
    } catch {
      return undefined;
    }
  }, [strokes, instructions]);

  const applyStrokes = useCallback((next: MarkupStroke[]) => {
    setModalOpen(false);
    const json = JSON.stringify(next);
    if (json.length > MARKUP_STROKES_MAX_LENGTH) {
      window.alert("The markup is too detailed to save. Use fewer or shorter strokes.");
      return;
    }
    updateParams(id, { strokes: json });
  }, [id, updateParams]);

  const setInstruction = (name: MarkupColorName, text: string) => {
    const next: MarkupInstructions = { ...instructions, [name]: text };
    updateParams(id, { instructions: JSON.stringify(next) });
  };

  return (
    <NodeShell data={data} footer={<RunFooter id={id} data={data} inputImages={1} />}>
      {inputImageUrl ? (
        <MarkupPreview imageUrl={inputImageUrl} strokes={strokes} />
      ) : (
        <p className={styles.hint}>Connect an image to mark up.</p>
      )}
      <button
        type="button"
        className={`nodrag ${styles.smallButton}`}
        onClick={() => setModalOpen(true)}
        disabled={!inputImageUrl}
      >
        Edit markup
      </button>
      {used.map((name) => (
        <label key={name} className={styles.markupColorRow}>
          <span className={styles.markupColorLabel}>
            <span className={styles.markupSwatch} style={{ background: markupColorHex(name) }} aria-hidden="true" />
            {name}
          </span>
          <textarea
            className={`${styles.textarea} nodrag nowheel`}
            rows={2}
            placeholder={`What should change inside the ${name} marks?`}
            value={instructions[name] ?? ""}
            onChange={(event) => setInstruction(name, event.target.value)}
          />
        </label>
      ))}
      {missing.length > 0 && (
        <p className={styles.markupSubText}>{`Add an instruction for the ${missing.join(", ")} marks before running.`}</p>
      )}
      {promptPreview && (
        <div className={styles.appendedText} aria-label="Prompt output">
          <span className={styles.appendedTextLabel}>Prompt</span>
          <p className={`${styles.appendedTextBody} nodrag nowheel`}>{promptPreview}</p>
        </div>
      )}
      <OutputPreview id={id} data={data} />
      {modalOpen && inputImageUrl && (
        <MarkupModal
          imageUrl={inputImageUrl}
          initialStrokes={strokes}
          onCancel={() => setModalOpen(false)}
          onApply={applyStrokes}
        />
      )}
    </NodeShell>
  );
});

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

// Render the strokes alone onto a transparent canvas the exact pixel size of
// the input image. The size comes from blobFromImageValue -> createImageBitmap,
// the same decode Image Edit's validateMarkupLayer (shared.tsx) runs on the
// base image, so the two always agree. Rendered from `strokes` every run --
// nothing cached in params -- so a changed upstream image re-renders at its
// own size.
export async function execute(ctx: ExecuteContext): Promise<void> {
  const value = ctx.inputs("image")[0];
  if (!value) throw new Error("Connect an input image first.");
  const strokes = parseStrokes(ctx.params.strokes);
  if (!strokes.length) throw new Error("Draw some markup first (Edit markup).");
  const text = buildMarkupPrompt(strokes, parseInstructions(ctx.params.instructions));

  const file = await blobFromImageValue(value);
  ctx.setProgress("Rendering markup…");
  const bitmap = await createImageBitmap(file);
  let width: number;
  let height: number;
  try {
    width = bitmap.width;
    height = bitmap.height;
  } finally {
    bitmap.close();
  }
  if (width * height > MARKUP_MAX_PIXELS) {
    throw new Error("The input image is over 16,777,216 pixels, the Markup layer limit. Resize it first.");
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser cannot render the markup.");
  drawStrokes(context, strokes, width, height);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((result) => (result ? resolve(result) : reject(new Error("Could not export the markup PNG."))), "image/png"),
  );
  if (blob.size > MARKUP_MAX_BYTES) throw new Error("The markup PNG is over 50 MB. Use fewer strokes.");

  const runId = ctx.createRunId();
  const cacheKey = `${ctx.nodeId}:${runId}:0`;
  const url = putBlob(cacheKey, blob);
  ctx.applyRun({
    runId,
    signature: ctx.signature,
    at: Date.now(),
    values: [
      [{ kind: "image", url, cacheKey, mimeType: "image/png", outputFormat: "png", background: "transparent" }],
      [{ kind: "text", text }],
    ],
  });
}
