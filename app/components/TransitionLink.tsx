"use client";

/**
 * TransitionLink
 * --------------
 * A next/link that routes through the browser's View Transitions API so the
 * move between Library / Generator / Workbench reads as one continuous sheet
 * being drawn, not as a hard cut.
 *
 * Next 16.2 has no first-class <ViewTransition> (that lands in 16.3), so this
 * drives document.startViewTransition by hand. The transition's callback
 * resolves when the destination page declares itself painted via the
 * route-ready registry (app/lib/route-ready.ts) — the Library signals on its
 * scene's first rendered frame — bounded by READY_BUDGET_MS so a route that
 * never signals can't freeze the page on a stale snapshot.
 *
 * Direction: the wipe encodes movement along the nav order (see
 * app/lib/nav-direction.ts). It is exposed two ways so effects.css can select
 * on either — transition types (vt.types, Baseline Jan 2026) and a
 * data-nav-direction attribute on <html> for engines with the API but not
 * types. Browsers without the API, and anyone on prefers-reduced-motion, fall
 * straight through to a normal client navigation. Known scope edge: browser
 * back/forward is handled by the router internally and currently navigates
 * without a wipe; Next 16.3's <ViewTransition> covers traversal natively.
 */

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { type ComponentProps, type MouseEvent } from "react";
import { navDirection, shouldStartViewTransition } from "@/app/lib/nav-direction.ts";
import { awaitRouteReady, READY_BUDGET_MS, setActiveTransition } from "@/app/lib/route-ready.ts";
import { motionReduced } from "@/app/lib/site-settings.ts";
import { logTransition, observeTransition } from "@/app/lib/transition-debug.ts";

type Props = ComponentProps<typeof Link> & { href: string };

// NOTE: no unmount cleanup of the readiness wait — the OLD page's links
// unmount as part of the very navigation the wait belongs to. The registry is
// navigation-scoped: supersession and the budget are its only cancellations.

export function TransitionLink({ href, onClick, ...rest }: Props) {
  const router = useRouter();
  const pathname = usePathname();

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);

    const proceed = shouldStartViewTransition({
      defaultPrevented: event.defaultPrevented,
      modifierPressed: event.metaKey || event.ctrlKey || event.shiftKey || event.altKey,
      button: event.button,
      samePath: href === pathname,
      hasViewTransitionAPI: typeof document.startViewTransition === "function",
      prefersReducedMotion: motionReduced(),
    });
    if (!proceed) {
      if (event.defaultPrevented) return;
      if (!document.startViewTransition) logTransition("no-view-transition-api");
      else if (motionReduced()) logTransition("reduced-motion");
      return; // plain navigation (next/link or the browser handles it)
    }

    event.preventDefault();

    const direction = navDirection(pathname, href);
    const root = document.documentElement;
    root.dataset.navDirection = direction;

    const vt = document.startViewTransition(async () => {
      router.push(href);
      const outcome = await awaitRouteReady(href, READY_BUDGET_MS);
      logTransition(outcome, href);
      // One macrotask so any effects queued behind the readiness mark flush.
      // NOT requestAnimationFrame: rendering is suspended inside this update
      // callback, so rAF would deadlock until the browser's own transition
      // timeout (research.md T016).
      await new Promise<void>((r) => setTimeout(r, 0));
    });

    // Transition types drive :active-view-transition-type() selectors where
    // supported; the data attribute above covers engines without types.
    if (direction !== "none") {
      vt.types?.add(direction === "forward" ? "nav-forward" : "nav-back");
    }
    observeTransition(vt);
    setActiveTransition(vt.finished);
    // finished REJECTS when a transition is skipped or times out; .finally
    // would re-propagate that as an unhandled rejection in production (dev
    // attaches a catch via observeTransition). Clean up on both settlements.
    const clearDirection = () => {
      if (root.dataset.navDirection === direction) delete root.dataset.navDirection;
    };
    vt.finished.then(clearDirection, clearDirection);
  };

  return <Link href={href} onClick={handleClick} {...rest} />;
}

export default TransitionLink;
