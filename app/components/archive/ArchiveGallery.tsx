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

const COLUMNS = 3;

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
  const columns = useMemo(() => {
    const buckets: ArchiveItem[][] = Array.from({ length: COLUMNS }, () => []);
    (items ?? []).forEach((item, index) => buckets[index % COLUMNS].push(item));
    return buckets;
  }, [items]);

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
        <div className={styles.grid}>
          {columns.map((column, index) => (
            <div className={styles.column} key={index}>
              {column.map((item) => (
                <ArchivePlate key={item.id} item={item} />
              ))}
            </div>
          ))}
        </div>
      )}
    </main>
  );
}

function ArchivePlate({ item }: { item: ArchiveItem }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [inView, setInView] = useState(false);
  const [loaded, setLoaded] = useState(false);
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
      { rootMargin: "300px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const revealed = inView && loaded;

  return (
    <figure className={styles.item}>
      <div ref={ref} className={styles.plate} style={{ aspectRatio: String(ratio) }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={item.imageUrl}
          alt={item.title}
          loading="lazy"
          decoding="async"
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
