"use client";

/**
 * ArchiveGallery — /archive
 * -------------------------
 * Every library image on one scrollable page, in the owner's referenced
 * gallery format: three columns of aspect-ratio boxes with even gaps and
 * rounded corners, each photo revealing itself once it scrolls into view.
 *
 * Adapted from that reference rather than vendored, because its stack isn't
 * this codebase's: `useInView` (framer-motion) is an IntersectionObserver
 * here, Radix `AspectRatio` is the CSS aspect-ratio property, `cn` +
 * Tailwind classes are a CSS module — and the reveal is the house Bayer
 * dissolve (mc-bayer-dissolve in effects.css) instead of a plain opacity
 * fade, so the archive speaks the same visual language as the library
 * placeholders and the workbench nodes.
 *
 * Cost is the point of the rewrite: the first version gave every photo its
 * own canvas dither (DitherReveal), each holding a full-resolution bitmap
 * plus a permanent rAF loop, and probed every image's natural size with a
 * second decode — sixty of those locked the main thread until everything
 * had loaded, which is the freeze the owner hit. Now the boxes come from
 * the API's aspect ratios (no probing), the browser schedules the fetches
 * (loading="lazy"), and the reveal is a compositor-only mask animation that
 * ends. The nav bar is rendered here and stays fixed while the page
 * scrolls, per the persistent-header rule.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { RouteReady } from "../RouteReady";
import { SiteNavigation } from "../SiteNavigation";
import { awaitTransitionSettled } from "@/app/lib/route-ready";
import { motionReduced, potatoMode } from "@/app/lib/site-settings";
import styles from "./archive.module.css";

type ArchiveItem = {
  id: string;
  title: string;
  imageUrl: string;
  /** width / height, served by /api/library so boxes are right before load. */
  aspectRatio?: number;
};

/* Column count by viewport. The referenced gallery is three columns at its
   demo width; on a 2560px display that left the archive as a narrow strip
   with more empty margin than content, so wide screens get a fourth (and
   the CSS widens the grid to match). Kept in JS because the round-robin
   distribution below has to agree with the CSS column count. */
const COLUMN_QUERIES: [string, number][] = [
  ["(min-width: 1700px)", 4],
  ["(max-width: 620px)", 1],
  ["(max-width: 900px)", 2],
];

function useColumnCount(): number {
  const [columns, setColumns] = useState(3);
  useEffect(() => {
    const lists = COLUMN_QUERIES.map(([query, count]) => [window.matchMedia(query), count] as const);
    const sync = () => setColumns(lists.find(([list]) => list.matches)?.[1] ?? 3);
    sync();
    for (const [list] of lists) list.addEventListener("change", sync);
    return () => {
      for (const [list] of lists) list.removeEventListener("change", sync);
    };
  }, []);
  return columns;
}

export function ArchiveGallery() {
  const [items, setItems] = useState<ArchiveItem[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Deferred until the wipe settles: fetching and decoding mid-transition
    // reads as a stutter on the incoming page.
    void awaitTransitionSettled().then(async () => {
      if (cancelled) return;
      try {
        const response = await fetch("/api/library", { cache: "no-store" });
        const payload = (await response.json()) as { ok?: boolean; items?: ArchiveItem[] };
        if (cancelled) return;
        if (payload?.ok && Array.isArray(payload.items)) setItems(payload.items);
        else setFailed(true);
      } catch {
        if (!cancelled) setFailed(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Round-robin into columns (the reference's own structure): each column is
  // an independent stack, so mixed portrait/landscape ratios never fight a
  // shared row height.
  const columnCount = useColumnCount();
  const columns = useMemo(() => {
    const buckets: ArchiveItem[][] = Array.from({ length: columnCount }, () => []);
    (items ?? []).forEach((item, index) => buckets[index % columnCount].push(item));
    return buckets;
  }, [items, columnCount]);

  return (
    <main className={styles.page}>
      <RouteReady path="/archive" />
      <SiteNavigation
        active={null}
        className="generator-navigation"
        right={
          <div className="generator-status" aria-label="Archive size">
            <span>{items ? `${items.length} collage${items.length === 1 ? "" : "s"}` : "Loading…"}</span>
          </div>
        }
      />
      <header className={styles.head}>
        <h1 className={styles.title}>Archive</h1>
        <p className={styles.subtitle}>Every collage in the library, newest first.</p>
      </header>
      {failed ? (
        <p className={styles.notice}>The archive could not be loaded. Refresh to try again.</p>
      ) : items && items.length === 0 ? (
        <p className={styles.notice}>Nothing in the library yet — generated collages land here.</p>
      ) : (
        <div className={styles.grid} style={{ gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))` }}>
          {columns.map((column, index) => (
            <div className={styles.column} key={index}>
              {column.map((item, row) => (
                // The first row of every column loads eagerly: those are
                // on screen immediately, and waiting for the lazy scheduler
                // there is a visible delay on arrival.
                <ArchivePlate key={item.id} item={item} eager={row === 0} />
              ))}
            </div>
          ))}
        </div>
      )}
    </main>
  );
}

function ArchivePlate({ item, eager }: { item: ArchiveItem; eager?: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [inView, setInView] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  // Ratio from the API, refined from the decoded image if it disagrees (a
  // workbench-saved render has no orientation in its payload, so it lands on
  // the default until its own dimensions are known).
  const [ratio, setRatio] = useState(item.aspectRatio && item.aspectRatio > 0 ? item.aspectRatio : 1536 / 1024);
  const [plain] = useState(() => motionReduced() || potatoMode());

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setInView(true);
          observer.disconnect();
        }
      },
      // Generous: a full-resolution collage takes real time to arrive, and
      // an empty plate scrolling into view reads as missing content rather
      // than as something still loading. Start well before it is seen.
      { rootMargin: "1400px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // An image already in the browser cache finishes BEFORE React attaches its
  // onLoad handler, so that event never arrives and the photo stays at
  // opacity 0 forever — which is why a revisit (or anything the library had
  // already fetched) showed only some of the collages. Ask the element
  // directly instead of waiting to be told.
  useEffect(() => {
    const image = imgRef.current;
    if (!image || loaded) return;
    if (image.complete) {
      if (image.naturalWidth > 0) {
        const actual = image.naturalWidth / image.naturalHeight;
        if (Math.abs(actual - ratio) / ratio > 0.02) setRatio(actual);
        setLoaded(true);
      } else {
        setFailed(true); // completed with no pixels = it errored
      }
    }
  }, [loaded, ratio]);

  const revealed = inView && loaded;

  return (
    <figure className={styles.item}>
      <div ref={ref} className={styles.plate} style={{ aspectRatio: String(ratio) }}>
        {/* An un-arrived photo says so. Before this, a plate whose image was
            still in flight (or lazily not yet requested) was an empty white
            frame — indistinguishable from a collage that had gone missing. */}
        {!loaded && !failed && <span className={styles.pending} aria-hidden="true" />}
        {failed && <span className={styles.unavailable}>Preview unavailable</span>}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={imgRef}
          src={item.imageUrl}
          alt={item.title}
          loading={eager ? "eager" : "lazy"}
          decoding="async"
          onError={() => setFailed(true)}
          className={[
            styles.image,
            revealed ? styles.imageIn : "",
            // Global class, not a module one — see archive.module.css.
            revealed && !plain ? "archive-image-dither" : "",
          ].filter(Boolean).join(" ")}
          onLoad={(event) => {
            const image = event.currentTarget;
            if (image.naturalWidth > 0 && image.naturalHeight > 0) {
              const actual = image.naturalWidth / image.naturalHeight;
              // Only correct a real disagreement: a needless setState per
              // image is exactly the kind of cost this page can't afford.
              if (Math.abs(actual - ratio) / ratio > 0.02) setRatio(actual);
            }
            setLoaded(true);
          }}
        />
      </div>
      <figcaption className={styles.caption}>{item.title}</figcaption>
    </figure>
  );
}

export default ArchiveGallery;
