"use client";

import { createPortal } from "react-dom";
import { memo, useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useModalDismiss } from "../useModalDismiss";
import styles from "../workbench.module.css";
import type { NodeOutputValue } from "../types";
import {
  columnsFor,
  SHEET_DEFAULT_SIZE_INDEX,
  SHEET_SIZES,
  stepIndex,
  stepLarge,
  type SheetKey,
} from "./contact-sheet";
import { ThumbnailImage } from "./shared";

type ImageValue = Extract<NodeOutputValue, { kind: "image" }>;

const NAV_KEYS = new Set<string>(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]);

// A grid cell that only builds its thumbnail once it has scrolled near the
// viewport, so opening a 150-image sheet generates (and holds) only the
// thumbnails actually looked at, never 150 decodes at once.
const SheetCell = memo(function SheetCell({
  value,
  index,
  total,
  selected,
  focusable,
  root,
  onOpen,
  onFocusCell,
}: {
  value: ImageValue;
  index: number;
  total: number;
  selected: boolean;
  focusable: boolean;
  root: HTMLElement | null;
  onOpen: (index: number) => void;
  onFocusCell: (index: number) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined");

  useEffect(() => {
    const node = ref.current;
    if (!node || near) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { root, rootMargin: "300px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [near, root]);

  return (
    <button
      ref={ref}
      type="button"
      data-sheet-index={index}
      tabIndex={focusable ? 0 : -1}
      className={`nodrag ${styles.sheetCell} ${selected ? styles.sheetCellSelected : ""}`}
      aria-label={`Image ${index + 1} of ${total}${selected ? ", selected" : ""}`}
      onClick={() => onOpen(index)}
      onFocus={() => onFocusCell(index)}
    >
      {near ? <ThumbnailImage cacheKey={value.cacheKey} alt="" width={256} height={256} /> : <span className={styles.sheetPlaceholder} />}
    </button>
  );
});

export function ContactSheet({
  candidates,
  selectedCacheKey,
  canPick,
  onPick,
  onClose,
}: {
  candidates: ImageValue[];
  selectedCacheKey: string | undefined;
  canPick: boolean;
  onPick: (cacheKey: string) => void;
  onClose: () => void;
}) {
  const { closing, requestClose } = useModalDismiss(onClose);
  const total = candidates.length;
  const [sizeIndex, setSizeIndex] = useState(SHEET_DEFAULT_SIZE_INDEX);
  const [focusIndex, setFocusIndex] = useState(() => Math.max(0, candidates.findIndex((value) => value.cacheKey === selectedCacheKey)));
  const [largeIndex, setLargeIndex] = useState<number | null>(null);
  const [gridWidth, setGridWidth] = useState(0);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  const largeOpen = largeIndex !== null;
  const gridMounted = !largeOpen;
  const columns = columnsFor(gridWidth, SHEET_SIZES[sizeIndex]);

  useEffect(() => {
    overlayRef.current?.focus();
  }, []);

  useEffect(() => {
    const node = gridRef.current;
    if (!node) return undefined;
    setGridWidth(node.clientWidth);
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => setGridWidth(node.clientWidth));
    observer.observe(node);
    return () => observer.disconnect();
  }, [gridMounted]);

  const focusCell = useCallback((index: number) => {
    setFocusIndex(index);
    window.setTimeout(() => {
      const cell = gridRef.current?.querySelector<HTMLElement>(`[data-sheet-index="${index}"]`);
      cell?.focus();
      cell?.scrollIntoView({ block: "nearest" });
    }, 0);
  }, []);

  const openLarge = useCallback((index: number) => setLargeIndex(index), []);
  const closeLarge = useCallback(() => {
    if (largeIndex !== null) focusCell(largeIndex);
    setLargeIndex(null);
  }, [focusCell, largeIndex]);

  // The clicked grid cell unmounts when the large view opens, which drops
  // focus to <body>; put it back on the dialog so ←/→/Esc keep working.
  useEffect(() => {
    if (largeOpen) overlayRef.current?.focus();
  }, [largeOpen]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (largeIndex !== null) closeLarge();
      else requestClose();
      return;
    }
    if (largeIndex !== null) {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        setLargeIndex(stepLarge(largeIndex, -1, total));
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        setLargeIndex(stepLarge(largeIndex, 1, total));
      }
      return;
    }
    if (NAV_KEYS.has(event.key) && (event.target as HTMLElement).dataset.sheetIndex !== undefined) {
      event.preventDefault();
      focusCell(stepIndex(focusIndex, event.key as SheetKey, columns, total));
    }
  }

  const large = largeIndex !== null ? candidates[largeIndex] : undefined;
  const largeSelected = large !== undefined && large.cacheKey === selectedCacheKey;

  // Portaled to <body>: a React Flow node is transformed, which would pin
  // this position:fixed overlay to the node instead of the viewport.
  return createPortal(
    <div
      ref={overlayRef}
      className={`${styles.sheetOverlay} ${closing ? styles.overlayClosing : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={`All ${total} images`}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <div className={styles.sheetBar}>
        <span className={styles.sheetTitle}>{large ? `Image ${largeIndex! + 1} / ${total}` : `${total} images`}</span>
        {large ? (
          <>
            <button type="button" className={`nodrag ${styles.sheetButton}`} onClick={closeLarge}>Back to grid</button>
            <button
              type="button"
              className={`nodrag ${styles.sheetButton}`}
              disabled={!canPick || largeSelected}
              onClick={() => onPick(large.cacheKey)}
            >
              {largeSelected ? "In use downstream" : "Use this one"}
            </button>
          </>
        ) : (
          <label className={styles.sheetSize}>
            <span>Size</span>
            <input
              className="nodrag"
              type="range"
              min={0}
              max={SHEET_SIZES.length - 1}
              step={1}
              value={sizeIndex}
              onChange={(event) => setSizeIndex(Number(event.target.value))}
              aria-label="Thumbnail size"
            />
          </label>
        )}
        <button type="button" className={`nodrag ${styles.sheetButton}`} onClick={requestClose}>Close</button>
      </div>
      {large ? (
        <div className={styles.sheetLarge}>
          <button
            type="button"
            className={`nodrag ${styles.sheetStep}`}
            aria-label="Previous image"
            disabled={largeIndex === 0}
            onClick={() => setLargeIndex(stepLarge(largeIndex!, -1, total))}
          >
            ‹
          </button>
          <img src={large.url} alt={`Image ${largeIndex! + 1} of ${total}`} className={styles.sheetLargeImage} />
          <button
            type="button"
            className={`nodrag ${styles.sheetStep}`}
            aria-label="Next image"
            disabled={largeIndex === total - 1}
            onClick={() => setLargeIndex(stepLarge(largeIndex!, 1, total))}
          >
            ›
          </button>
        </div>
      ) : (
        <div ref={setScroller} className={styles.sheetScroller}>
          <div
            ref={gridRef}
            className={styles.sheetGrid}
            style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
          >
            {candidates.map((value, index) => (
              <SheetCell
                key={value.cacheKey}
                value={value}
                index={index}
                total={total}
                selected={value.cacheKey === selectedCacheKey}
                focusable={index === focusIndex}
                root={scroller}
                onOpen={openLarge}
                onFocusCell={setFocusIndex}
              />
            ))}
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}
