"use client";

// Fullscreen crop editor for the Crop node: zoom/pan over the full-resolution
// source, a handle-resizable rectangle, and a click-vertex polygon for
// non-rectangular crops. Everything is computed in image-pixel space and
// converted to fractions on apply (see crop-geometry.ts).

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { clampToValidEditSize } from "@/app/lib/image-edit";
import styles from "../workbench.module.css";
import { useModalDismiss } from "../useModalDismiss";
import {
  fitTransform,
  fractionPointsToPixels,
  fractionRectToPixels,
  imageToScreen,
  MAX_POLYGON_POINTS,
  MAX_ZOOM,
  MIN_ZOOM,
  movePixelRect,
  normalizePixelRect,
  panBy,
  pixelPointsToFraction,
  polygonBounds,
  resizePixelRect,
  screenToImage,
  zoomAround,
  type CropSelection,
  type PixelRect,
  type Point,
  type RectHandle,
  type ViewTransform,
} from "./crop-geometry";
import {
  ASPECT_PRESETS,
  constrainedDraw,
  constrainedResize,
  cropFitness,
  formatAspect,
  parseAspect,
  serializeAspect,
  snapRect,
  type AspectLock,
  type RectConstraint,
} from "./crop-constraints";

export type CropEditorResult = { kind: "rect"; rect: PixelRect } | { kind: "polygon"; points: Point[] };

type CropEditorProps = {
  imageUrl: string;
  initial: CropSelection;
  onCancel: () => void;
  onApply: (result: CropEditorResult, imageWidth: number, imageHeight: number) => void;
};

type Mode = "rect" | "polygon";

type Drag =
  | { kind: "draw"; start: Point }
  | { kind: "move"; last: Point }
  | { kind: "resize"; handle: RectHandle }
  | { kind: "vertex"; index: number }
  | { kind: "pan"; last: Point };

const HANDLES: RectHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const HANDLE_HIT = 8; // screen px
const VERTEX_HIT = 9;

export function CropEditor({ imageUrl, initial, onCancel, onApply }: CropEditorProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const pendingApply = useRef<CropEditorResult | null>(null);
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null);
  const [surfaceSize, setSurfaceSize] = useState({ width: 0, height: 0 });
  const [view, setView] = useState<ViewTransform>({ scale: 1, offsetX: 0, offsetY: 0 });
  const [mode, setMode] = useState<Mode>(initial.kind);
  const [rect, setRect] = useState<PixelRect | null>(null);
  const [polygon, setPolygon] = useState<Point[]>([]); // committed polygon (image px)
  const [draftPoints, setDraftPoints] = useState<Point[]>([]); // in-progress polygon (image px)
  const [drag, setDrag] = useState<Drag | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [cursor, setCursor] = useState<Point | null>(null);
  const [fitted, setFitted] = useState(false);
  // Rectangle constraints: an optional aspect-ratio lock and the exact-size
  // grid (edges on multiples of 16 so the output IS the crop, no resampling).
  const [aspect, setAspect] = useState<AspectLock>(null);
  const [customAspect, setCustomAspect] = useState("");
  const [gridLock, setGridLock] = useState(true);
  const constraint: RectConstraint = { lock: aspect, grid: gridLock };

  const { closing, requestClose } = useModalDismiss(() => {
    const result = pendingApply.current;
    pendingApply.current = null;
    if (result && imageSize) onApply(result, imageSize.width, imageSize.height);
    else onCancel();
  });

  // Once both the bitmap and the surface sizes are known, seed the view and
  // the initial selection exactly once. Called from the load/resize callbacks
  // below (event callbacks, not effect bodies) so no effect sets state.
  const seededRef = useRef(false);
  const latestSizes = useRef<{ image: { width: number; height: number } | null; surface: { width: number; height: number } }>({
    image: null,
    surface: { width: 0, height: 0 },
  });
  const initialRef = useRef(initial);
  const trySeed = () => {
    const { image, surface } = latestSizes.current;
    if (seededRef.current || !image || !surface.width || !surface.height) return;
    seededRef.current = true;
    const start = initialRef.current;
    setView(fitTransform(image.width, image.height, surface.width, surface.height));
    setRect(fractionRectToPixels(start.rect, image.width, image.height));
    if (start.kind === "polygon") setPolygon(fractionPointsToPixels(start.points, image.width, image.height));
    setFitted(true);
  };

  // Load the bitmap once so we know its native size.
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

  // Track the surface size (window resizes, devtools, etc.).
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const update = () => {
      const box = surface.getBoundingClientRect();
      const size = { width: Math.round(box.width), height: Math.round(box.height) };
      latestSizes.current.surface = size;
      setSurfaceSize(size);
      trySeed();
    };
    const observer = new ResizeObserver(update);
    observer.observe(surface);
    return () => observer.disconnect();
  }, []);

  const canApply = imageSize !== null && (mode === "rect" ? rect !== null : polygon.length >= 3);

  const apply = () => {
    if (!canApply || !imageSize) return;
    pendingApply.current = mode === "rect" && rect ? { kind: "rect", rect } : { kind: "polygon", points: polygon };
    requestClose();
  };

  const commitDraft = () => {
    if (draftPoints.length < 3) return;
    setPolygon(draftPoints.slice(0, MAX_POLYGON_POINTS));
    setDraftPoints([]);
  };

  // Space = temporary pan; Escape backs out of a draft polygon or cancels;
  // Enter applies (or closes a draft polygon); Backspace pops a vertex.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === "Space") {
        event.preventDefault();
        setSpaceHeld(true);
      } else if (event.key === "Escape") {
        if (draftPoints.length) setDraftPoints([]);
        else requestClose();
      } else if (event.key === "Enter") {
        if (mode === "polygon" && draftPoints.length >= 3) commitDraft();
        else apply();
      } else if (event.key === "Backspace" && mode === "polygon" && draftPoints.length) {
        event.preventDefault();
        setDraftPoints((points) => points.slice(0, -1));
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftPoints, mode, rect, polygon, imageSize, requestClose]);

  const screenPoint = (event: ReactPointerEvent<HTMLDivElement>): Point => {
    const box = surfaceRef.current?.getBoundingClientRect();
    return { x: event.clientX - (box?.left ?? 0), y: event.clientY - (box?.top ?? 0) };
  };

  const clampToImage = (point: Point): Point => {
    if (!imageSize) return point;
    return {
      x: Math.min(Math.max(point.x, 0), imageSize.width),
      y: Math.min(Math.max(point.y, 0), imageSize.height),
    };
  };

  const handleAt = (screen: Point): RectHandle | null => {
    if (!rect) return null;
    const tl = imageToScreen({ x: rect.x, y: rect.y }, view);
    const br = imageToScreen({ x: rect.x + rect.width, y: rect.y + rect.height }, view);
    const cx = (tl.x + br.x) / 2;
    const cy = (tl.y + br.y) / 2;
    const positions: Record<RectHandle, Point> = {
      nw: tl,
      n: { x: cx, y: tl.y },
      ne: { x: br.x, y: tl.y },
      e: { x: br.x, y: cy },
      se: br,
      s: { x: cx, y: br.y },
      sw: { x: tl.x, y: br.y },
      w: { x: tl.x, y: cy },
    };
    for (const handle of HANDLES) {
      const p = positions[handle];
      if (Math.abs(p.x - screen.x) <= HANDLE_HIT && Math.abs(p.y - screen.y) <= HANDLE_HIT) return handle;
    }
    return null;
  };

  const insideRect = (image: Point): boolean =>
    !!rect && image.x >= rect.x && image.x <= rect.x + rect.width && image.y >= rect.y && image.y <= rect.y + rect.height;

  const vertexAt = (screen: Point, points: Point[]): number => {
    for (let index = 0; index < points.length; index += 1) {
      const p = imageToScreen(points[index], view);
      if (Math.hypot(p.x - screen.x, p.y - screen.y) <= VERTEX_HIT) return index;
    }
    return -1;
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!imageSize || !fitted) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const screen = screenPoint(event);
    const image = screenToImage(screen, view);

    if (spaceHeld || event.button === 1 || event.button === 2) {
      setDrag({ kind: "pan", last: screen });
      return;
    }

    if (mode === "rect") {
      const handle = handleAt(screen);
      if (handle) {
        setDrag({ kind: "resize", handle });
      } else if (insideRect(image)) {
        setDrag({ kind: "move", last: image });
      } else {
        setDrag({ kind: "draw", start: clampToImage(image) });
      }
      return;
    }

    // Polygon mode: drag an existing vertex of the committed polygon, drag a
    // draft vertex, or add a new draft vertex.
    if (!draftPoints.length) {
      const index = vertexAt(screen, polygon);
      if (index >= 0) {
        setDrag({ kind: "vertex", index });
        return;
      }
    }
    if (draftPoints.length >= 3) {
      // Clicking the first draft vertex closes the shape.
      const first = imageToScreen(draftPoints[0], view);
      if (Math.hypot(first.x - screen.x, first.y - screen.y) <= VERTEX_HIT) {
        commitDraft();
        return;
      }
    }
    if (draftPoints.length < MAX_POLYGON_POINTS) setDraftPoints((points) => [...points, clampToImage(image)]);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const screen = screenPoint(event);
    setCursor(screen);
    if (!drag || !imageSize) return;
    const image = screenToImage(screen, view);
    switch (drag.kind) {
      case "pan":
        setView((current) => panBy(current, screen.x - drag.last.x, screen.y - drag.last.y));
        setDrag({ kind: "pan", last: screen });
        break;
      case "draw":
        setRect(
          constraint.lock || constraint.grid
            ? constrainedDraw(drag.start, image, imageSize.width, imageSize.height, constraint)
            : normalizePixelRect(drag.start, image, imageSize.width, imageSize.height),
        );
        break;
      case "move":
        setRect((current) => (current ? movePixelRect(current, image.x - drag.last.x, image.y - drag.last.y, imageSize.width, imageSize.height) : current));
        setDrag({ kind: "move", last: image });
        break;
      case "resize":
        setRect((current) =>
          current
            ? constraint.lock || constraint.grid
              ? constrainedResize(current, drag.handle, image, imageSize.width, imageSize.height, constraint)
              : resizePixelRect(current, drag.handle, image, imageSize.width, imageSize.height)
            : current,
        );
        break;
      case "vertex":
        setPolygon((points) => points.map((p, index) => (index === drag.index ? clampToImage(image) : p)));
        break;
    }
  };

  const onPointerUp = () => setDrag(null);

  // Native, non-passive wheel listener: React's onWheel is passive, so
  // preventDefault (needed to stop the page/canvas scrolling under the
  // modal) would be ignored and logged as an error.
  const fittedRef = useRef(fitted);
  useEffect(() => {
    fittedRef.current = fitted;
  }, [fitted]);
  useEffect(() => {
    const surface = surfaceRef.current;
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

  // Output size readout: what execute() will actually produce.
  const readout = useMemo(() => {
    if (!imageSize) return null;
    let source: PixelRect | null = null;
    if (mode === "rect") source = rect;
    else if (polygon.length >= 3) {
      const b = polygonBounds(pixelPointsToFraction(polygon, imageSize.width, imageSize.height));
      source = fractionRectToPixels(b, imageSize.width, imageSize.height);
    }
    if (!source) return null;
    const snapped = clampToValidEditSize(Math.max(1, Math.round(source.width)), Math.max(1, Math.round(source.height)));
    const fitness = cropFitness(source.width, source.height);
    return { source, snapped, fitness };
  }, [imageSize, mode, rect, polygon]);

  // Re-apply the constraint to the current rect when a lock changes.
  const applyLock = (next: RectConstraint) => {
    if (!imageSize || !rect || (!next.lock && !next.grid)) return;
    setRect(snapRect(rect, imageSize.width, imageSize.height, next));
  };
  const chooseAspect = (value: string) => {
    if (value === "__custom__") {
      setCustomAspect(customAspect || "16:10");
      const lock = parseAspect(customAspect || "16:10");
      setAspect(lock);
      applyLock({ lock, grid: gridLock });
      return;
    }
    setCustomAspect("");
    const lock = parseAspect(value);
    setAspect(lock);
    applyLock({ lock, grid: gridLock });
  };
  const aspectSelectValue = customAspect ? "__custom__" : serializeAspect(aspect);

  // Draw: image, dimmed outside, selection, handles/vertices.
  useEffect(() => {
    const canvas = canvasRef.current;
    const image = imageRef.current;
    if (!canvas || !image || !imageSize || !surfaceSize.width || !surfaceSize.height) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(surfaceSize.width * dpr);
    canvas.height = Math.round(surfaceSize.height * dpr);
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, surfaceSize.width, surfaceSize.height);
    context.imageSmoothingEnabled = view.scale < 1;

    const origin = imageToScreen({ x: 0, y: 0 }, view);
    const drawW = imageSize.width * view.scale;
    const drawH = imageSize.height * view.scale;
    context.drawImage(image, origin.x, origin.y, drawW, drawH);

    // Dim everything outside the current selection.
    const selectionPath = () => {
      const path = new Path2D();
      if (mode === "rect" && rect) {
        const tl = imageToScreen({ x: rect.x, y: rect.y }, view);
        path.rect(tl.x, tl.y, rect.width * view.scale, rect.height * view.scale);
        return path;
      }
      const points = draftPoints.length ? draftPoints : polygon;
      if (points.length >= 3) {
        points.forEach((p, index) => {
          const s = imageToScreen(p, view);
          if (index === 0) path.moveTo(s.x, s.y);
          else path.lineTo(s.x, s.y);
        });
        path.closePath();
        return path;
      }
      return null;
    };
    const path = selectionPath();
    if (path && !(mode === "polygon" && draftPoints.length)) {
      context.save();
      const outer = new Path2D();
      outer.rect(origin.x, origin.y, drawW, drawH);
      outer.addPath(path);
      context.fillStyle = "rgba(0, 0, 0, 0.55)";
      context.fill(outer, "evenodd");
      context.restore();
    }

    context.lineWidth = 2;
    context.strokeStyle = "#7c3aed";
    if (path) context.stroke(path);

    const dot = (p: Point, radius: number, fill = "#fff") => {
      context.beginPath();
      context.arc(p.x, p.y, radius, 0, Math.PI * 2);
      context.fillStyle = fill;
      context.fill();
      context.strokeStyle = "#7c3aed";
      context.lineWidth = 1.5;
      context.stroke();
    };

    if (mode === "rect" && rect) {
      const tl = imageToScreen({ x: rect.x, y: rect.y }, view);
      const br = imageToScreen({ x: rect.x + rect.width, y: rect.y + rect.height }, view);
      const cx = (tl.x + br.x) / 2;
      const cy = (tl.y + br.y) / 2;
      for (const p of [tl, { x: cx, y: tl.y }, { x: br.x, y: tl.y }, { x: br.x, y: cy }, br, { x: cx, y: br.y }, { x: tl.x, y: br.y }, { x: tl.x, y: cy }]) {
        context.fillStyle = "#fff";
        context.strokeStyle = "#7c3aed";
        context.lineWidth = 1.5;
        context.fillRect(p.x - 5, p.y - 5, 10, 10);
        context.strokeRect(p.x - 5, p.y - 5, 10, 10);
      }
    } else if (mode === "polygon") {
      const points = draftPoints.length ? draftPoints : polygon;
      if (draftPoints.length && cursor) {
        // Rubber band from the last draft vertex to the cursor.
        const last = imageToScreen(draftPoints[draftPoints.length - 1], view);
        context.save();
        context.setLineDash([6, 4]);
        context.beginPath();
        context.moveTo(last.x, last.y);
        context.lineTo(cursor.x, cursor.y);
        context.stroke();
        context.restore();
      }
      points.forEach((p, index) => dot(imageToScreen(p, view), index === 0 && draftPoints.length ? 7 : 5));
    }
  }, [imageSize, surfaceSize, view, mode, rect, polygon, draftPoints, cursor]);

  const cursorStyle = (() => {
    if (spaceHeld || drag?.kind === "pan") return "grab";
    if (mode === "rect" && cursor && rect) {
      const handle = handleAt(cursor);
      if (handle) {
        if (handle === "n" || handle === "s") return "ns-resize";
        if (handle === "e" || handle === "w") return "ew-resize";
        if (handle === "ne" || handle === "sw") return "nesw-resize";
        return "nwse-resize";
      }
      if (insideRect(screenToImage(cursor, view))) return "move";
    }
    return "crosshair";
  })();

  const modeButton = (value: Mode, label: string) => (
    <button
      type="button"
      className={`nodrag ${styles.maskToolButton} ${mode === value ? styles.maskToolActive : ""}`}
      aria-pressed={mode === value}
      onClick={() => {
        setDraftPoints([]);
        setMode(value);
      }}
    >
      {label}
    </button>
  );

  return createPortal(
    <div
      className={`${styles.maskModalOverlay} nodrag nopan nowheel ${closing ? styles.overlayClosing : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="Crop the image"
    >
      <div className={`${styles.maskModal} ${styles.cropEditor}`}>
        <div className={styles.maskToolbar}>
          {modeButton("rect", "Rectangle")}
          {modeButton("polygon", "Polygon")}
          {mode === "rect" && (
            <>
              <span className={styles.cropEditorDivider} />
              <label className={styles.cropEditorLock}>
                Ratio
                <select className="nodrag" value={aspectSelectValue} onChange={(event) => chooseAspect(event.target.value)}>
                  {ASPECT_PRESETS.map((preset) => (
                    <option key={preset.label} value={preset.value}>{preset.label}</option>
                  ))}
                  <option value="__custom__">Custom…</option>
                </select>
              </label>
              {customAspect !== "" && (
                <input
                  className={`nodrag ${styles.cropEditorAspectInput}`}
                  type="text"
                  value={customAspect}
                  placeholder="W:H"
                  aria-label="Custom aspect ratio"
                  onChange={(event) => {
                    setCustomAspect(event.target.value);
                    const lock = parseAspect(event.target.value);
                    if (lock) {
                      setAspect(lock);
                      applyLock({ lock, grid: gridLock });
                    }
                  }}
                />
              )}
              <label className={styles.cropEditorLock}>
                <input
                  className="nodrag"
                  type="checkbox"
                  checked={gridLock}
                  onChange={(event) => {
                    setGridLock(event.target.checked);
                    applyLock({ lock: aspect, grid: event.target.checked });
                  }}
                />
                Exact size (16 px grid)
              </label>
            </>
          )}
          <span className={styles.cropEditorDivider} />
          <button type="button" className="nodrag" onClick={() => zoomButton(1 / 1.25)} aria-label="Zoom out" disabled={view.scale <= MIN_ZOOM}>−</button>
          <span className={styles.cropEditorZoom}>{Math.round(view.scale * 100)}%</span>
          <button type="button" className="nodrag" onClick={() => zoomButton(1.25)} aria-label="Zoom in" disabled={view.scale >= MAX_ZOOM}>+</button>
          <button type="button" className="nodrag" onClick={fit}>Fit</button>
          <button type="button" className="nodrag" onClick={() => setView((current) => zoomAround(current, 1 / current.scale, { x: surfaceSize.width / 2, y: surfaceSize.height / 2 }))}>100%</button>
          {mode === "polygon" && draftPoints.length >= 3 && (
            <button type="button" className="nodrag" onClick={commitDraft}>Close shape</button>
          )}
          {mode === "polygon" && (draftPoints.length > 0 || polygon.length > 0) && (
            <button
              type="button"
              className="nodrag"
              onClick={() => {
                setDraftPoints([]);
                setPolygon([]);
              }}
            >
              Clear
            </button>
          )}
        </div>
        <div
          ref={surfaceRef}
          className={`${styles.cropEditorSurface} nodrag nopan nowheel`}
          style={{ cursor: cursorStyle }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={() => setCursor(null)}
          onContextMenu={(event) => event.preventDefault()}
          onDoubleClick={() => mode === "polygon" && commitDraft()}
        >
          <canvas ref={canvasRef} className={styles.maskPreviewCanvas} />
          {!imageSize && <p className={styles.hint}>Loading image…</p>}
        </div>
        <div className={styles.cropEditorFooter}>
          <span className={styles.hint}>
            {mode === "rect"
              ? "Drag to draw, drag edges to resize, drag inside to move. Wheel zooms, Space+drag or right-drag pans."
              : draftPoints.length
                ? `${draftPoints.length} point${draftPoints.length === 1 ? "" : "s"} — click to add, click the first point, double-click or Enter to close. Backspace removes the last point.`
                : polygon.length
                  ? "Drag a vertex to refine, or click to start a new shape. Pixels outside the polygon become transparent."
                  : "Click to place vertices. Wheel zooms, Space+drag pans."}
          </span>
          {readout && (
            <span className={styles.cropEditorReadout}>
              <span
                className={`${styles.cropFitBadge} ${readout.fitness.exact ? styles.cropFitOk : readout.fitness.aspectOk ? styles.cropFitWarn : styles.cropFitBad}`}
                title={
                  readout.fitness.exact
                    ? "Output is this crop pixel-for-pixel."
                    : !readout.fitness.aspectOk
                      ? "Aspect is outside Sunburst's 1:3 – 3:1 range; the output will be reshaped to fit."
                      : !readout.fitness.pixelsOk
                        ? "Outside Sunburst's pixel limits (0.66–8.3 MP, longest edge 3840); the output will be resized."
                        : "Edges are not multiples of 16; the output will be resampled to the nearest valid size."
                }
              >
                {readout.fitness.exact ? "✓ exact" : !readout.fitness.aspectOk ? "✕ aspect" : !readout.fitness.pixelsOk ? "△ size" : "△ resample"}
              </span>{" "}
              {formatAspect(readout.source.width, readout.source.height)} · {Math.round(readout.source.x)},{Math.round(readout.source.y)} · {Math.round(readout.source.width)}×{Math.round(readout.source.height)} px
              {" → "}
              output {readout.snapped.width}×{readout.snapped.height}
            </span>
          )}
        </div>
        <div className={styles.maskModalActions}>
          <button type="button" className="nodrag" onClick={requestClose}>Cancel</button>
          <button type="button" className="nodrag" disabled={!canApply} onClick={apply}>
            Apply crop
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
