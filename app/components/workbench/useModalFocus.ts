// Keyboard containment for an in-page modal: focus moves into it when it
// opens, Tab and Shift+Tab cycle inside it instead of reaching the page
// behind, Escape can close it, and focus goes back where it was when it
// unmounts. aria-modal="true" tells assistive tech the page behind is inert,
// but it does not stop Tab — that part is this hook's. (useModalDismiss only
// times the exit animation.) The landing lightbox does the same job with
// `inert` on its background section (SceneWheelV2); a Workbench dialog sits
// inside the app shell with no single sibling to mark, so it contains Tab
// itself.
import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function useModalFocus(
  container: RefObject<HTMLElement | null>,
  options: { initialFocus?: RefObject<HTMLElement | null>; onEscape?: () => void; restoreFocus?: boolean } = {},
) {
  // Held in a ref so a new onEscape identity on every render does not re-run
  // the effect below, which would pull focus back to the first control.
  const onEscape = useRef(options.onEscape);
  useEffect(() => {
    onEscape.current = options.onEscape;
  });
  const { initialFocus, restoreFocus = true } = options;

  useEffect(() => {
    const root = container.current;
    if (!root) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () =>
      Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((element) => element.getClientRects().length > 0);
    const frame = window.requestAnimationFrame(() => {
      (initialFocus?.current ?? focusable()[0] ?? root).focus({ preventScroll: true });
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && onEscape.current) {
        event.preventDefault();
        onEscape.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) {
        event.preventDefault();
        root.focus({ preventScroll: true });
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || !root.contains(active)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && (active === first || active === root)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown, true);
      if (restoreFocus && previouslyFocused?.isConnected && previouslyFocused !== document.body) {
        previouslyFocused.focus({ preventScroll: true });
      }
    };
  }, [container, initialFocus, restoreFocus]);
}
