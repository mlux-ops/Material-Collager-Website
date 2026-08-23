"use client";

// transitions-dev 06-modal close half: instead of unmounting an overlay the
// instant it is dismissed, requestClose flips `closing` (the caller appends
// styles.overlayClosing so the scrim fades and the dialog scales down), then
// fires the real onClose once the exit animation has played.

import { useCallback, useEffect, useRef, useState } from "react";
import { motionReduced } from "@/app/lib/site-settings";

// Mirrors --modal-close-dur in app/motion-tokens.css (150ms). Kept as a
// constant rather than read via getComputedStyle so the hook stays sync-safe.
const MODAL_CLOSE_MS = 150;

export function useModalDismiss(onClose: () => void): { closing: boolean; requestClose: () => void } {
  const [closing, setClosing] = useState(false);
  const timeoutRef = useRef<number | null>(null);
  const onCloseRef = useRef(onClose);

  // Keep the ref in sync via an effect rather than mutating it directly in
  // the render body -- refs must not be written during render (React can
  // call a render function more than once for the same commit), and this
  // still updates onCloseRef.current before any subsequent event handler
  // (requestClose's setTimeout callback or its reduced-motion branch) can
  // read it, since effects always run after the render they follow.
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(
    () => () => {
      if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    },
    [],
  );

  const requestClose = useCallback(() => {
    if (timeoutRef.current !== null) return; // already closing — ignore repeat dismissals
    if (motionReduced()) {
      onCloseRef.current();
      return;
    }
    setClosing(true);
    timeoutRef.current = window.setTimeout(() => {
      timeoutRef.current = null;
      // Reset so hosts that stay mounted (per-node lightboxes, WorkbenchApp's
      // wire-drop prompt) reopen clean without a stale closing class.
      setClosing(false);
      onCloseRef.current();
    }, MODAL_CLOSE_MS);
  }, []);

  return { closing, requestClose };
}
