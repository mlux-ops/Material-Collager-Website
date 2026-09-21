"use client";

/**
 * A pure viewer: connect an image, click its thumbnail, inspect it full
 * size in a zoomable, pannable overlay. No execute, no output — same
 * "passive" shape as Compare.
 *
 * The overlay reuses the exact zoom/pan math the Crop and Masked Edit
 * editors already use (crop-geometry.ts's ViewTransform/fitTransform/
 * zoomAround/panBy), rendering it onto a plain <img> via a CSS transform
 * instead of onto a canvas — there is nothing here to draw over the image,
 * only to look at it. It's portaled to document.body, the same fix
 * CropEditor uses, so position:fixed measures the real viewport rather than
 * whatever transformed ancestor React Flow's canvas pane happens to be.
 */

import { memo, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { useModalDismiss } from "../useModalDismiss";
import styles from "../workbench.module.css";
import { fitTransform, MAX_ZOOM, MIN_ZOOM, panBy, zoomAround, type Point, type ViewTransform } from "./crop-geometry";
import { NodeShell, ThumbnailImage, useConnectedImageValue, type WorkbenchNodeProps } from "./shared";

const ZOOM_BUTTON_FACTOR = 1.25;

function ViewImageLightbox({ url, onClose }: { url: string; onClose: () => void }) {
  const { closing, requestClose } = useModalDismiss(onClose);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null);
  const [surfaceSize, setSurfaceSize] = useState({ width: 0, height: 0 });
  const [view, setView] = useState<ViewTransform>({ scale: 1, offsetX: 0, offsetY: 0 });
  const [panFrom, setPanFrom] = useState<Point | null>(null); // last pointer position while dragging

  // Seed the fit-to-screen view once both the image's natural size (from the
  // <img>'s onLoad) and the surface's own size (from the ResizeObserver
  // below) are known — either can settle first, so both paths funnel through
  // the same ref-backed trySeed, exactly like CropEditor's identical race.
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
  };

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
    update();
    const observer = new ResizeObserver(update);
    observer.observe(surface);
    return () => observer.disconnect();
  }, []);

  // Native, non-passive wheel listener: React's onWheel is passive, so
  // preventDefault (needed to stop the page scrolling behind the overlay)
  // would be ignored and logged as an error — the same fix crop-editor.tsx
  // and maskedEdit.tsx already use for this identical problem.
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (!imageSize) return;
      const box = surface.getBoundingClientRect();
      const anchor = { x: event.clientX - box.left, y: event.clientY - box.top };
      const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0015));
      setView((current) => zoomAround(current, factor, anchor));
    };
    surface.addEventListener("wheel", onWheel, { passive: false });
    return () => surface.removeEventListener("wheel", onWheel);
  }, [imageSize]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [requestClose]);

  const screenPoint = (event: ReactPointerEvent<HTMLDivElement>): Point => {
    const box = surfaceRef.current?.getBoundingClientRect();
    return { x: event.clientX - (box?.left ?? 0), y: event.clientY - (box?.top ?? 0) };
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!imageSize) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setPanFrom(screenPoint(event));
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!panFrom) return;
    const screen = screenPoint(event);
    setView((current) => panBy(current, screen.x - panFrom.x, screen.y - panFrom.y));
    setPanFrom(screen);
  };
  const endPan = () => setPanFrom(null);

  const zoomButton = (factor: number) => {
    setView((current) => zoomAround(current, factor, { x: surfaceSize.width / 2, y: surfaceSize.height / 2 }));
  };
  const fit = () => {
    if (imageSize) setView(fitTransform(imageSize.width, imageSize.height, surfaceSize.width, surfaceSize.height));
  };

  return createPortal(
    <div
      className={`${styles.lightboxOverlay} nodrag nopan nowheel ${closing ? styles.overlayClosing : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="Full-resolution image"
    >
      {/* No click-to-dismiss here, unlike the simpler OutputPreview lightbox:
          this surface covers the whole overlay (there is no separate
          "backdrop" region left to click), and a plain click is also the
          first half of the double-click that resets to fit — the two would
          fight over the same gesture. Close button and Escape (below)
          dismiss instead. */}
      <div
        ref={surfaceRef}
        className={styles.viewImageSurface}
        style={{ cursor: panFrom ? "grabbing" : "grab" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPan}
        onPointerCancel={endPan}
        onDoubleClick={fit}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- full-res blob-cache object URL, not a Next asset */}
        <img
          src={url}
          alt="Full-resolution connected image"
          draggable={false}
          className={styles.viewImageImg}
          onLoad={(event) => {
            const target = event.currentTarget;
            const size = { width: target.naturalWidth, height: target.naturalHeight };
            latestSizes.current.image = size;
            setImageSize(size);
            trySeed();
          }}
          style={
            imageSize
              ? {
                  width: imageSize.width,
                  height: imageSize.height,
                  transform: `translate(${view.offsetX}px, ${view.offsetY}px) scale(${view.scale})`,
                }
              : { display: "none" }
          }
        />
      </div>
      <div className={`${styles.viewImageControls} nodrag`}>
        <button type="button" className={styles.smallButton} onClick={() => zoomButton(1 / ZOOM_BUTTON_FACTOR)} aria-label="Zoom out" disabled={view.scale <= MIN_ZOOM}>
          −
        </button>
        <span className={styles.viewImageZoom}>{Math.round(view.scale * 100)}%</span>
        <button type="button" className={styles.smallButton} onClick={() => zoomButton(ZOOM_BUTTON_FACTOR)} aria-label="Zoom in" disabled={view.scale >= MAX_ZOOM}>
          +
        </button>
        <button type="button" className={styles.smallButton} onClick={fit}>
          Fit
        </button>
      </div>
      <button type="button" className={`nodrag ${styles.lightboxClose}`} onClick={requestClose}>
        Close
      </button>
    </div>,
    document.body,
  );
}

export const Component = memo(function ViewImageNode({ id, data }: WorkbenchNodeProps) {
  const value = useConnectedImageValue(id, "image");
  const cacheKey = value?.kind === "image" ? value.cacheKey : undefined;
  const fullUrl = value?.kind === "image" ? value.url : undefined;
  const [open, setOpen] = useState(false);

  return (
    <NodeShell data={data}>
      {cacheKey ? (
        <figure className={styles.preview}>
          <button type="button" className={`nodrag ${styles.thumbButton}`} onClick={() => setOpen(true)} aria-label="Open full size, zoomable view">
            <ThumbnailImage cacheKey={cacheKey} alt="Connected image" width={256} height={192} className={styles.thumbImg} />
          </button>
        </figure>
      ) : (
        <p className={styles.hint}>Connect an image to view it.</p>
      )}
      {open && fullUrl && <ViewImageLightbox url={fullUrl} onClose={() => setOpen(false)} />}
    </NodeShell>
  );
});
