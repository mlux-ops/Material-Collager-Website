"use client";

import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { createPortal, flushSync } from "react-dom";
import { motionReduced, potatoMode } from "@/app/lib/site-settings";
import { extractFinishPalette, finishTone, paletteDistance, toggleFinishPin, type FinishTone } from "./finish-palette";
import styles from "./finish-palette.module.css";

export interface AtlasItem { id: string; title?: string; filename?: string; imageUrl: string }
const PAGE_SIZE = 8;

function sampleImage(image: HTMLImageElement) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 48;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(image, 0, 0, 48, 48);
  return context.getImageData(0, 0, 48, 48);
}

function sampleAtPointer(image: HTMLImageElement, pixels: ImageData, event: MouseEvent) {
  const box = image.getBoundingClientRect();
  const scale = Math.max(box.width / image.naturalWidth, box.height / image.naturalHeight);
  const width = image.naturalWidth * scale;
  const height = image.naturalHeight * scale;
  const x = (event.clientX - box.left + (width - box.width) / 2) / width;
  const y = (event.clientY - box.top + (height - box.height) / 2) / height;
  const col = Math.max(0, Math.min(pixels.width - 1, Math.floor(x * pixels.width)));
  const row = Math.max(0, Math.min(pixels.height - 1, Math.floor(y * pixels.height)));
  const i = 4 * (row * pixels.width + col);
  if (pixels.data[i + 3] < 192) return null;
  return finishTone(pixels.data[i], pixels.data[i + 1], pixels.data[i + 2]);
}

export function FinishPaletteAtlas({ items, selectedId, onChoose, onClose }: {
  items: AtlasItem[];
  selectedId?: string;
  onChoose: (id: string) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const samples = useRef(new Map<string, ImageData>());
  const [palettes, setPalettes] = useState<Record<string, FinishTone[]>>({});
  const [pins, setPins] = useState<FinishTone[]>([]);
  const [sampled, setSampled] = useState<Record<string, FinishTone[]>>({});
  const [broken, setBroken] = useState<Set<string>>(() => new Set());
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [scanCount, setScanCount] = useState<number | null>(null);
  const scan = useRef<AbortController | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => {
      scan.current?.abort();
      dialog?.close();
    };
  }, []);

  function close() {
    dialogRef.current?.close();
    onClose();
  }

  const ranked = useMemo(() => items.map((item, position) => {
    const tones = [...(palettes[item.id] ?? []), ...(sampled[item.id] ?? [])];
    return { item, position, score: paletteDistance(tones, pins) };
  }).sort((a, b) => a.score - b.score || a.position - b.position).slice(0, limit), [items, limit, palettes, pins, sampled]);

  function readPalette(id: string, image: HTMLImageElement) {
    if (samples.current.has(id)) return;
    try {
      const pixels = sampleImage(image);
      if (!pixels) return;
      samples.current.set(id, pixels);
      const colors = extractFinishPalette(pixels.data, pixels.width, pixels.height);
      setPalettes((old) => ({ ...old, [id]: colors }));
    } catch { /* Images with unreadable pixels can still be chosen by name. */ }
  }

  async function scanLibrary() {
    if (scan.current) return;
    const controller = new AbortController();
    scan.current = controller;
    setScanCount(0);
    // Full-resolution originals can be large. Decode just one at a time;
    // keep only the tiny sampling raster when each pass finishes.
    for (const [index, item] of items.entries()) {
      if (controller.signal.aborted) return;
      if (!samples.current.has(item.id) && !broken.has(item.id)) {
        const img = new Image();
        const abortImage = () => img.removeAttribute("src");
        controller.signal.addEventListener("abort", abortImage, { once: true });
        try {
          img.src = item.imageUrl;
          await img.decode();
          if (controller.signal.aborted) return;
          readPalette(item.id, img);
        } catch {
          if (controller.signal.aborted) return;
          setBroken((old) => new Set([...old, item.id]));
        } finally {
          controller.signal.removeEventListener("abort", abortImage);
        }
      }
      setScanCount(index + 1);
    }
  }

  function pin(tone: FinishTone, itemId?: string) {
    function update() {
      setPins((old) => toggleFinishPin(old, tone));
      if (itemId) setSampled((old) => ({
        ...old, [itemId]: [...(old[itemId] ?? []).filter((t) => t.hex !== tone.hex).slice(-5), tone],
      }));
    }
    // Scope snapshots to the photos: document transitions drive the site's
    // page-turn wipe and must never run for a picker interaction.
    const grid = gridRef.current as (HTMLDivElement & { startViewTransition?: (change: () => void) => ViewTransition }) | null;
    const trigger = document.activeElement;
    const commit = () => {
      flushSync(update);
      if (trigger instanceof HTMLElement && trigger.isConnected && document.activeElement !== trigger) {
        trigger.focus({ preventScroll: true });
      }
    };
    if (grid?.startViewTransition && !motionReduced() && !potatoMode()) {
      grid.startViewTransition(commit);
    } else {
      commit();
    }
  }

  return createPortal(
    <dialog ref={dialogRef} className={styles.dialog} aria-label="Finish palette atlas"
      onCancel={(event) => { event.preventDefault(); close(); }}
      onKeyDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <header className={styles.header}>
        <h2>Finish palette atlas</h2>
        <button type="button" className={styles.textButton} onClick={close}>Close</button>
      </header>
      <div className={styles.controls}>
        <p>Pin up to two tones from the images or swatches to find related finishes.</p>
        <div className={styles.pins} aria-label="Pinned tones">
          {pins.map((tone) => (
            <button type="button" key={tone.hex} onClick={() => pin(tone)}
              aria-label={`Remove pinned tone ${tone.hex}`} className={styles.pin}>
              <i style={{ backgroundColor: tone.hex }} aria-hidden="true" />{tone.hex}<span aria-hidden="true">×</span>
            </button>
          ))}
        </div>
      </div>
      <div className={styles.scroll}>
        {items.length === 0 && <p className={styles.empty}>The library is empty. Save or upload an image to build its palette.</p>}
        <div ref={gridRef} className={styles.grid} aria-label="Library images">
          {ranked.map(({ item, position }) => {
            const name = item.title || item.filename || item.id;
            const palette = palettes[item.id] ?? [];
            return (
              <article key={item.id} className={styles.card} aria-label={name} style={{ viewTransitionName: `atlas-item-${position}` }}>
                <button type="button" className={styles.photo} disabled={!palette.length}
                  aria-label={`Sample a tone from ${name}`}
                  onClick={(event) => {
                    const image = event.currentTarget.querySelector("img");
                    const pixels = samples.current.get(item.id);
                    const tone = event.detail && image && pixels ? sampleAtPointer(image, pixels, event) : palette[0];
                    if (tone) pin(tone, item.id);
                  }}>
                  {broken.has(item.id) ? <span>Image unavailable</span> : (
                    // eslint-disable-next-line @next/next/no-img-element -- sample the same decoded local library image that is displayed
                    <img src={item.imageUrl} alt={name} decoding="async" draggable={false}
                      onLoad={(event) => readPalette(item.id, event.currentTarget)}
                      onError={() => setBroken((old) => new Set([...old, item.id]))}
                    />
                  )}
                </button>
                <div className={styles.swatches} aria-label={`Tones from ${name}`}>
                  {palette.map((tone) => (
                    <button type="button" key={tone.hex} aria-label={`Pin ${tone.hex} from ${name}`}
                      title={tone.hex} aria-pressed={pins.some((p) => p.hex === tone.hex)}
                      style={{ backgroundColor: tone.hex }} onClick={() => pin(tone)} />
                  ))}
                </div>
                <button className={styles.choose} type="button" aria-label={`Use ${name}`}
                  onClick={() => { dialogRef.current?.close(); onChoose(item.id); }}>
                  <span>{name}</span><span aria-hidden="true">{selectedId === item.id ? "✓" : "↗"}</span>
                </button>
              </article>
            );
          })}
        </div>
        {limit < items.length && <div className={styles.actions}>
          <button type="button" className={styles.more} onClick={() => setLimit((n) => n + PAGE_SIZE)}>Show more images</button>
          {scanCount === null && <button type="button" className={styles.more} onClick={() => void scanLibrary()}>Scan all {items.length} images</button>}
        </div>}
      </div>
      <footer className={styles.footer} role="status">
        {ranked.length} of {items.length} images · {pins.length ? `Ranked by ${pins.length} ${pins.length === 1 ? "tone" : "tones"}` : "Newest first"}
        {limit < items.length && (scanCount === null ? " · Loaded palettes only" : ` · Scanned ${scanCount} of ${items.length}`)}
      </footer>
    </dialog>, document.body,
  );
}
