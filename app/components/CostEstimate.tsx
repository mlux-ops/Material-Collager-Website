"use client";

/**
 * Cost estimate -- the live dollar figure on a paid render button and the
 * input/output split beneath it, shared by the Generator and Review Boards.
 * (The Workbench prints its own `Run · output ~$0.07` label from the same
 * estimator.)
 *
 * The numbers come from app/lib/image-cost.ts (the one estimator) via
 * app/lib/collage-cost.ts (what a collage render is billed on); this file
 * only displays them.
 *
 * Accessibility: the figure tweens between values, so it is aria-hidden and
 * never read out mid-tween. The button that holds it must carry the settled
 * value in its accessible name -- describeCostEstimate() in image-cost.ts
 * gives the words, e.g. aria-label="Generate Collage, estimated cost about $0.07".
 */

import { useEffect, useState, type ReactNode } from "react";
import { motionReduced } from "@/app/lib/site-settings";
import { formatCostFigure, formatCostSplit, type RunCostBreakdown } from "@/app/lib/image-cost";
import styles from "./CostEstimate.module.css";

// The same duration and easing as CountUp (--duration-slow, easeOutCubic
// standing in for cubic-bezier(0.22,1,0.36,1)). CountUp itself is not used:
// it rounds to integers and runs once, on entering the viewport, while this
// figure is fractional dollars and re-tweens on every change.
const TWEEN_MS = 400;

type Tween = { from: number; to: number };

/**
 * The value to print this frame. A change between two numbers tweens from
 * whatever is on screen (mid-tween included); a change to or from null, the
 * first render, and reduced motion all jump straight to the new value.
 */
function useTweenedUsd(usd: number | null): number | null {
  const [previous, setPrevious] = useState(usd);
  const [shown, setShown] = useState(usd);
  const [tween, setTween] = useState<Tween | null>(null);

  // Adjusting state during render (not in an effect), so the first paint
  // after a change already shows the old value rather than flashing the new
  // one for a frame before the tween starts.
  // Object.is, not !==, so a NaN can never read as "changed" on every render.
  if (!Object.is(usd, previous)) {
    setPrevious(usd);
    const onScreen = tween ? shown : previous;
    if (usd !== null && onScreen !== null && !motionReduced()) {
      setShown(onScreen);
      setTween({ from: onScreen, to: usd });
    } else {
      setTween(null);
    }
  }

  useEffect(() => {
    if (!tween) return;
    let frame = 0;
    const startedAt = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, Math.max(0, (now - startedAt) / TWEEN_MS));
      const eased = 1 - Math.pow(1 - t, 3);
      setShown(tween.from + (tween.to - tween.from) * eased);
      if (t < 1) {
        frame = requestAnimationFrame(tick);
      } else {
        setTween(null);
      }
    };
    frame = requestAnimationFrame(tick);
    // A hidden tab or pane runs no animation frames; settle on the real value
    // anyway rather than leaving a stale figure on the button.
    const settle = window.setTimeout(() => setTween(null), TWEEN_MS + 100);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(settle);
    };
  }, [tween]);

  return tween ? shown : usd;
}

export type CostFigurePlacement = "inset" | "inset-tight" | "inline";

const PLACEMENT_CLASS: Record<CostFigurePlacement, string> = {
  // Right-aligned inside a button with 12px side padding (the generator's
  // primary and draft buttons); the host must carry costHostClassName.
  inset: styles.inset,
  // The same for a button with 7px padding (the generator's Final button).
  "inset-tight": styles.insetTight,
  // In the flow after the label, for buttons that size to their content.
  inline: styles.inline,
};

/**
 * "~$0.07", or "usage-based" when usd is null. Inherits the button's font
 * and colour; only the figures are pinned to tabular widths.
 */
export function CostFigure({
  usd,
  placement = "inset",
  className,
}: {
  usd: number | null;
  placement?: CostFigurePlacement;
  className?: string;
}) {
  const shown = useTweenedUsd(usd);
  return (
    <span aria-hidden="true" className={`${styles.figure} ${PLACEMENT_CLASS[placement]}${className ? ` ${className}` : ""}`}>
      {shown === null ? "usage-based" : formatCostFigure(shown)}
    </span>
  );
}

/** "6 references · input $0.067 + output $0.005", as 10px #657069 sub text. */
export function CostSplit({
  references,
  breakdown,
  perStyle = false,
  extra,
  className,
}: {
  references: number;
  breakdown: RunCostBreakdown;
  perStyle?: boolean;
  /** An extra image sent beside the references ("layout", "draft"); see formatCostSplit. */
  extra?: string;
  className?: string;
}) {
  return (
    <span className={`${styles.split}${className ? ` ${className}` : ""}`}>
      {formatCostSplit(references, breakdown, { perStyle, extra })}
    </span>
  );
}

/** Add to a button that holds an inset CostFigure, so the figure anchors to it. */
export const costHostClassName: string = styles.host;

/**
 * A paid button with its split line under it, occupying the grid cell the
 * button alone used to. `span="full"` spans every column, as the generator's
 * primary button does.
 */
export function CostStack({ span, children }: { span?: "full"; children: ReactNode }) {
  return <div className={`${styles.stack}${span === "full" ? ` ${styles.stackFull}` : ""}`}>{children}</div>;
}

/**
 * For a button that shares a grid row with a CostStack: keeps it at its own
 * height instead of stretching to the stack's (button plus split line).
 */
export const costRowNeighbourClassName: string = styles.rowNeighbour;
