"use client";

/**
 * ArchiveGallery — /archive
 * -------------------------
 * Every library image on one scrollable page. Reached from the wordmark
 * menu's ARCHIVE row through the same plotter wipe as the main routes
 * (/archive sits at the end of NAV_ORDER, so entering wipes forward and
 * leaving wipes back), and each photo dithers into existence exactly in
 * place: DitherReveal draws the Bayer-dithered image in the same box the
 * final <img> settles into, so there is no placement jump — the library
 * treatment, in document flow.
 *
 * Adapted from the owner's chosen gallery component. That source assumed
 * Tailwind/shadcn/framer-motion/radix, none of which this codebase uses —
 * its two behaviors (in-view gating, aspect boxes) are IntersectionObserver
 * and the CSS aspect-ratio property here, and the fade-on-load became the
 * house dither-in instead.
 *
 * Loading order: the page shell paints immediately (markRouteReady via
 * <RouteReady/>), the item list is fetched only after the wipe settles
 * (awaitTransitionSettled — network + decode mid-wipe reads as stutter),
 * and each image is probed lazily as it scrolls near the viewport.
 */

import { useEffect, useRef, useState } from "react";
import { DitherReveal } from "../DitherReveal";
import { RouteReady } from "../RouteReady";
import { SiteNavigation } from "../SiteNavigation";
import { awaitTransitionSettled } from "@/app/lib/route-ready";
import styles from "./archive.module.css";

type ArchiveItem = {
  id: string;
  title: string;
  imageUrl: string;
};

export function ArchiveGallery() {
  const [items, setItems] = useState<ArchiveItem[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
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
        <p className={styles.subtitle}>Every collage in the library, oldest at the bottom.</p>
      </header>
      {failed ? (
        <p className={styles.notice}>The archive could not be loaded. Refresh to try again.</p>
      ) : items && items.length === 0 ? (
        <p className={styles.notice}>Nothing in the library yet — generated collages land here.</p>
      ) : (
        <div className={styles.grid}>
          {(items ?? []).map((item) => (
            <ArchivePlate key={item.id} item={item} />
          ))}
        </div>
      )}
    </main>
  );
}

function ArchivePlate({ item }: { item: ArchiveItem }) {
  const ref = useRef<HTMLElement | null>(null);
  const [inView, setInView] = useState(false);
  // Natural dimensions, probed before the reveal mounts: DitherReveal's
  // pre-settle canvas and settled <img> must share one aspect box or the
  // handoff jumps (the same box-mismatch class of bug as the library
  // placeholders). The probe warms the browser cache, so the reveal's own
  // load is instant.
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setInView(true);
          observer.disconnect();
        }
      },
      { rootMargin: "320px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!inView) return;
    let cancelled = false;
    const probe = new Image();
    probe.decoding = "async";
    // Same CORS mode as DitherReveal's own loader, so this probe and the
    // reveal share one cache entry instead of fetching the bytes twice.
    probe.crossOrigin = "anonymous";
    probe.onload = () => {
      if (!cancelled && probe.naturalWidth > 0 && probe.naturalHeight > 0) {
        setDims({ w: probe.naturalWidth, h: probe.naturalHeight });
      }
    };
    probe.src = item.imageUrl;
    return () => {
      cancelled = true;
    };
  }, [inView, item.imageUrl]);

  return (
    <figure ref={ref} className={styles.item}>
      <div
        className={styles.plate}
        style={{ aspectRatio: dims ? `${dims.w} / ${dims.h}` : "3 / 2" }}
      >
        {dims ? (
          <DitherReveal
            src={item.imageUrl}
            alt={item.title}
            progress={1}
            colorize
            cell={2}
            width={dims.w}
            height={dims.h}
            ink="#000000"
            paper="#ffffff"
            style={{ width: "100%", height: "100%" }}
          />
        ) : null}
      </div>
      <figcaption className={styles.caption}>{item.title}</figcaption>
    </figure>
  );
}

export default ArchiveGallery;
