"use client";

/**
 * TransitionLink
 * --------------
 * A next/link that routes through the browser's View Transitions API so the
 * move between Library / Generator / Workbench reads as one continuous sheet
 * being drawn, not as a hard cut.
 *
 * Next 16.2 has no first-class <ViewTransition> (that lands in 16.3), so this
 * drives document.startViewTransition by hand: the transition's callback
 * resolves when the pathname actually changes, with a hard cap so a slow route
 * (the Library's three.js scene) can never freeze the page on a stale
 * snapshot. Browsers without the API, and anyone on prefers-reduced-motion,
 * fall straight through to a normal client navigation.
 */

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, type ComponentProps, type MouseEvent } from "react";

// The old snapshot is held for at most this long. Past it the new route is
// shown as-is rather than leaving the page apparently frozen. Sized against
// the slowest route: the Library's three.js scene took ~790ms to put a painted
// canvas on screen from a cold dev chunk. Releasing earlier than that wiped in
// a blank page, which looked like a bug rather than a transition.
const MAX_HOLD_MS = 850;

type Props = ComponentProps<typeof Link> & { href: string };

export function TransitionLink({ href, onClick, ...rest }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const pending = useRef<(() => void) | null>(null);
  const timer = useRef<number | null>(null);

  const settle = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    const resolve = pending.current;
    pending.current = null;
    resolve?.();
  };

  // The pathname changing only means the route committed - the new page has
  // not painted yet. Give it two frames before handing the screen over.
  useEffect(() => {
    if (!pending.current) return;
    const outer = requestAnimationFrame(() => requestAnimationFrame(settle));
    return () => cancelAnimationFrame(outer);
  }, [pathname]);

  useEffect(() => () => settle(), []);

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented) return;
    // Let the browser handle modified clicks (new tab, download, etc.).
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    if (href === pathname) return;

    const startViewTransition = document.startViewTransition?.bind(document);
    if (!startViewTransition) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    event.preventDefault();
    startViewTransition(
      () =>
        new Promise<void>((resolve) => {
          pending.current = resolve;
          timer.current = window.setTimeout(settle, MAX_HOLD_MS);
          router.push(href);
        }),
    );
  };

  return <Link href={href} onClick={handleClick} {...rest} />;
}

export default TransitionLink;
