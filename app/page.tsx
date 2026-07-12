/* eslint-disable @next/next/no-img-element */
"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type WheelEvent } from "react";

type LibraryItem = {
  id: string;
  title: string;
  filename: string;
  format: string;
  renderKind: "draft" | "studio" | "final" | "repair";
  collageType: string;
  mode: "economy" | "immediate";
  qa: { score?: number; passed?: boolean } | null;
  createdAt: number;
  imageUrl: string;
};

type LibraryResponse = { ok: boolean; error?: string; items?: LibraryItem[] };

export default function LibraryPage() {
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [view, setView] = useState<"overview" | "index">("overview");
  const [activeIndex, setActiveIndex] = useState(0);
  const [selected, setSelected] = useState<LibraryItem | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const cardRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef({ active: false, startX: 0, scrollLeft: 0, moved: false });

  const loadLibrary = useCallback(async () => {
    try {
      const response = await fetch("/api/library", { cache: "no-store" });
      const payload = await response.json() as LibraryResponse;
      if (!response.ok || !payload.ok) throw new Error(payload.error || "The Library could not be loaded.");
      setItems(payload.items ?? []);
      setError("");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "The Library could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadLibrary();
    const interval = window.setInterval(() => void loadLibrary(), 30000);
    return () => window.clearInterval(interval);
  }, [loadLibrary]);

  useEffect(() => {
    if (!selected) return;
    const previousOverflow = document.body.style.overflow;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.style.overflow = "hidden";
    const dialog = dialogRef.current;
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>("button, a[href], [tabindex]:not([tabindex='-1'])") ?? []);
    focusable()[0]?.focus();
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setSelected(null);
      if (event.key !== "Tab") return;
      const controls = focusable();
      if (!controls.length) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
      returnFocusRef.current?.focus();
    };
  }, [selected]);

  function updateActiveIndex() {
    const track = trackRef.current;
    if (!track || !items.length) return;
    const center = track.getBoundingClientRect().left + track.clientWidth / 2;
    let nearest = 0;
    let distance = Number.POSITIVE_INFINITY;
    cardRefs.current.forEach((card, index) => {
      if (!card) return;
      const rect = card.getBoundingClientRect();
      const nextDistance = Math.abs(rect.left + rect.width / 2 - center);
      if (nextDistance < distance) {
        distance = nextDistance;
        nearest = index;
      }
    });
    setActiveIndex(nearest);
  }

  function scrollToIndex(index: number) {
    const target = Math.max(0, Math.min(items.length - 1, index));
    cardRefs.current[target]?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    setActiveIndex(target);
  }

  function onTrackWheel(event: WheelEvent<HTMLDivElement>) {
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    event.preventDefault();
    event.currentTarget.scrollBy({ left: event.deltaY, behavior: "auto" });
  }

  function onTrackKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowRight") scrollToIndex(activeIndex + 1);
    else if (event.key === "ArrowLeft") scrollToIndex(activeIndex - 1);
    else if (event.key === "Home") scrollToIndex(0);
    else if (event.key === "End") scrollToIndex(items.length - 1);
    else return;
    event.preventDefault();
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    const track = event.currentTarget;
    dragRef.current = { active: true, startX: event.clientX, scrollLeft: track.scrollLeft, moved: false };
    track.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!dragRef.current.active) return;
    const delta = event.clientX - dragRef.current.startX;
    if (Math.abs(delta) > 5) dragRef.current.moved = true;
    event.currentTarget.scrollLeft = dragRef.current.scrollLeft - delta;
  }

  function onPointerUp(event: PointerEvent<HTMLDivElement>) {
    dragRef.current.active = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function openItem(item: LibraryItem) {
    if (dragRef.current.moved) {
      dragRef.current.moved = false;
      return;
    }
    setSelected(item);
  }

  async function removeFromLibrary(item: LibraryItem) {
    const response = await fetch(`/api/library/${encodeURIComponent(item.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visible: false }),
    });
    const payload = await response.json() as { ok?: boolean; error?: string };
    if (!response.ok || !payload.ok) {
      setError(payload.error || "The collage could not be removed.");
      return;
    }
    setSelected(null);
    setItems((current) => current.filter((candidate) => candidate.id !== item.id));
    setActiveIndex((current) => Math.max(0, Math.min(current, items.length - 2)));
  }

  const activeItem = items[activeIndex];

  return (
    <main className="library-shell">
      <SiteNavigation active="library" />

      <section className="library-stage" aria-labelledby="library-title">
        <div className="library-title-row">
          <div>
            <p>Material Collager</p>
            <h1 id="library-title">Library</h1>
          </div>
          {items.length > 0 && <span>{String(activeIndex + 1).padStart(2, "0")} / {String(items.length).padStart(2, "0")}</span>}
        </div>

        {loading ? (
          <div className="library-loading" aria-live="polite">Loading collages</div>
        ) : error && items.length === 0 ? (
          <div className="library-empty">
            <p>{error}</p>
            <button type="button" onClick={() => void loadLibrary()}>Retry</button>
          </div>
        ) : items.length === 0 ? (
          <div className="library-empty library-empty-preview">
            <div className="empty-preview-panel"><img src="/sample-collage.png" alt="Example material collage" /></div>
            <div><span>Studio sample</span><h2>Your finished collages will live here.</h2><a href="/generator">Open Generator</a></div>
          </div>
        ) : view === "overview" ? (
          <div
            className="glass-track"
            ref={trackRef}
            tabIndex={0}
            aria-label="Collage library. Use left and right arrow keys to browse."
            onScroll={updateActiveIndex}
            onWheel={onTrackWheel}
            onKeyDown={onTrackKeyDown}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            <span className="track-spacer" aria-hidden="true" />
            {items.map((item, index) => {
              const offset = index - activeIndex;
              return (
                <button
                  type="button"
                  className={`glass-panel ${index === activeIndex ? "active" : ""}`}
                  key={item.id}
                  ref={(node) => { cardRefs.current[index] = node; }}
                  style={{
                    "--panel-offset": offset,
                    "--panel-opacity": Math.max(0.28, 1 - Math.abs(offset) * 0.18),
                    zIndex: items.length - Math.abs(offset),
                  } as CSSProperties}
                  aria-label={`Open ${item.title}`}
                  onClick={() => openItem(item)}
                >
                  <img src={item.imageUrl} alt="" draggable={false} />
                </button>
              );
            })}
            <span className="track-spacer" aria-hidden="true" />
          </div>
        ) : (
          <div className="library-index" aria-label="Collage index">
            {items.map((item, index) => (
              <button type="button" key={item.id} onClick={() => { setActiveIndex(index); setSelected(item); }}>
                <img src={item.imageUrl} alt="" />
                <span>{item.title}</span>
                <small>{formatDate(item.createdAt)}</small>
              </button>
            ))}
          </div>
        )}

        {activeItem && view === "overview" && (
          <div className="active-collage-meta" aria-live="polite">
            <strong>{activeItem.title}</strong>
            <span>{label(activeItem.collageType)} / {activeItem.format} / {formatDate(activeItem.createdAt)}</span>
          </div>
        )}

        {items.length > 0 && (
          <div className="library-view-toggle" role="group" aria-label="Library view">
            <button type="button" className={view === "overview" ? "active" : ""} onClick={() => setView("overview")}>Overview</button>
            <button type="button" className={view === "index" ? "active" : ""} onClick={() => setView("index")}>Index</button>
          </div>
        )}
      </section>

      {selected && (
        <div className="collage-viewer-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelected(null); }}>
          <div className="collage-viewer" role="dialog" aria-modal="true" aria-labelledby="viewer-title" ref={dialogRef}>
            <div className="viewer-toolbar">
              <div><p>Library</p><h2 id="viewer-title">{selected.title}</h2></div>
              <button type="button" onClick={() => setSelected(null)}>Close</button>
            </div>
            <div className="viewer-image"><img src={selected.imageUrl} alt={selected.title} /></div>
            <div className="viewer-meta">
              <span>{label(selected.collageType)}</span>
              <span>{selected.format}</span>
              <span>{selected.mode === "economy" ? "Economy final" : label(selected.renderKind)}</span>
              <span>{selected.qa?.score !== undefined ? `QA ${selected.qa.score}/100` : "QA not available"}</span>
              <span>{formatDate(selected.createdAt)}</span>
            </div>
            <div className="viewer-actions">
              <a href={selected.imageUrl} download={selected.filename}>Download PNG</a>
              <button type="button" onClick={() => void removeFromLibrary(selected)}>Remove from Library</button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

function SiteNavigation({ active }: { active: "library" | "generator" }) {
  return (
    <header className="site-navigation">
      <a className="site-wordmark" href="/">Material Collager</a>
      <nav aria-label="Primary navigation">
        <a className={active === "library" ? "active" : ""} href="/">Library</a>
        <a className={active === "generator" ? "active" : ""} href="/generator">Generator</a>
      </nav>
    </header>
  );
}

function label(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDate(value: number) {
  return new Date(value).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}
