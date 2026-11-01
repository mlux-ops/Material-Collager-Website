"use client";

/**
 * usePrintInLater — the IntersectionObserver pass behind the gallery
 * print-in split (app/lib/print-in.ts, effects.css `mc-print-later`).
 *
 * Every element under `containerRef` carrying `data-print-id` is observed
 * ONCE, the first time it appears (re-scanned whenever `scanKey` changes, so
 * photos added later are picked up too), then unobserved. The ids that were
 * off screen at that first look come back as a set; the caller adds
 * `mc-print-later` to those, and CSS binds their dissolve to scroll. The rest
 * keep the load-time dissolve.
 *
 * The decision is made through a class, not a DOM mutation, so React's own
 * className updates (e.g. the archive's reveal) never wipe it.
 */

import { useEffect, useRef, useState, type RefObject } from "react";
import { mergePrintLater, partitionPrintIn } from "@/app/lib/print-in";

const EMPTY: ReadonlySet<string> = new Set();

export function usePrintInLater(
  containerRef: RefObject<HTMLElement | null>,
  scanKey: string,
): ReadonlySet<string> {
  const [later, setLater] = useState<ReadonlySet<string>>(EMPTY);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const seenRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) observer.unobserve(entry.target);
      const ids = partitionPrintIn(
        entries.map((entry) => ({
          id: (entry.target as HTMLElement).dataset.printId ?? "",
          isIntersecting: entry.isIntersecting,
        })),
      );
      if (ids.size > 0) setLater((prev) => mergePrintLater(prev, ids));
    });
    observerRef.current = observer;
    return () => {
      observer.disconnect();
      observerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const root = containerRef.current;
    const observer = observerRef.current;
    if (!root || !observer) return;
    const seen = seenRef.current;
    for (const element of root.querySelectorAll<HTMLElement>("[data-print-id]")) {
      const id = element.dataset.printId;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      observer.observe(element);
    }
  }, [containerRef, scanKey]);

  return later;
}
