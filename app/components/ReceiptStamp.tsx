"use client";

/**
 * ReceiptStamp
 * ------------
 * The one-line receipt for a finished image render -- "DRAFT · 0:48 · 6 REFS
 * · $0.07" -- in two presentations of the same data:
 *
 *   variant="stage"  a white strip pinned inside the bottom edge of its
 *                    positioned parent (the result stage). On mount the text
 *                    arrives through DitherTextIn (420ms) and the dollars count
 *                    up from zero through CountUp (400ms), both inside the
 *                    image's 620ms dissolve. Re-mount it with a new `key` to
 *                    replay the arrival; playArrival={false} mounts it
 *                    settled instead.
 *   variant="inline" the bare text for a history row or a render cell, no box
 *                    and no animation, inheriting the surrounding font.
 *
 * The line itself comes from app/lib/render-receipt.ts; unknown parts are left
 * out, never estimated. Renders nothing when no part is known.
 *
 * Accessibility: the strip is role="note", never aria-live -- the page's own
 * polite activity log announces the receipt once (receiptAnnouncement). The
 * animated text and digits are aria-hidden; the settled line is real text in a
 * visually hidden span. Reduced motion is handled by DitherTextIn and CountUp
 * themselves (both render their final state at once); this component adds no
 * motion of its own.
 */

import { CountUp } from "@/app/components/CountUp";
import { DitherTextIn } from "@/app/components/DitherTextIn";
import { formatUsd } from "@/app/lib/image-cost";
import { RECEIPT_SEPARATOR, renderReceipt } from "@/app/lib/render-receipt";
import type { RenderReceiptInput } from "@/app/lib/render-receipt";
import styles from "./ReceiptStamp.module.css";

export { receiptAnnouncement, renderReceipt, renderReceiptText } from "@/app/lib/render-receipt";
export type { RenderReceipt, RenderReceiptInput, RenderReceiptPart } from "@/app/lib/render-receipt";

export type ReceiptStampProps = {
  variant: "stage" | "inline";
  receipt: RenderReceiptInput;
  className?: string;
  /** Tooltip on the root element, e.g. the precise four-decimal cost. */
  title?: string;
  /**
   * Stage variant only. Default true: the line dithers in and the dollars
   * count up on mount. False renders the strip already settled -- for a
   * receipt that is being shown again (re-mounted after the stage was busy)
   * rather than arriving.
   */
  playArrival?: boolean;
};

// House label type: 8.4px/500, letter-spacing 0.1575px, black.
const LABEL_FONT_SIZE = 8.4;
const LABEL_FONT_WEIGHT = 500;
const LABEL_LETTER_SPACING = 0.1575;
const INK = "#000000";
// DitherTextIn's own default; well inside the image's 620ms dissolve.
const ARRIVAL_MS = 420;
// DitherTextIn's settled block height for this font size.
const SETTLED_BOX_H = Math.ceil(LABEL_FONT_SIZE * 1.3);

function joinClassNames(...names: Array<string | undefined | false>): string {
  return names.filter(Boolean).join(" ");
}

export function ReceiptStamp({ variant, receipt, className, title, playArrival = true }: ReceiptStampProps) {
  const { parts, text } = renderReceipt(receipt);
  if (!parts.length) return null;

  if (variant === "inline") {
    return (
      <span className={joinClassNames(styles.inline, className)} title={title}>
        {text}
      </span>
    );
  }

  const costPart = parts.find((part) => part.key === "cost");
  const leadText = parts
    .filter((part) => part.key !== "cost")
    .map((part) => part.text)
    .join(RECEIPT_SEPARATOR);

  // The dollars count up in whole cents. A cost under half a cent rounds to
  // zero cents and has nothing to count, so it is shown settled.
  const cents = costPart && typeof costPart.value === "number" ? Math.round(costPart.value * 100) : 0;
  const settledCost = costPart ? costPart.text : "";
  const formatCents = (n: number) => (n >= cents ? settledCost : n <= 0 ? "$0.00" : formatUsd(n / 100));

  return (
    <div className={joinClassNames(styles.stage, className)} role="note" title={title}>
      <span className={styles.visuallyHidden}>{text}</span>
      <span className={styles.line} aria-hidden="true">
        {leadText && !playArrival ? (
          // DitherTextIn's own settled markup, so a settled strip and an
          // arrived one are pixel-identical.
          <span
            className={styles.dither}
            style={{
              display: "block",
              height: SETTLED_BOX_H,
              fontSize: LABEL_FONT_SIZE,
              fontWeight: LABEL_FONT_WEIGHT,
              letterSpacing: LABEL_LETTER_SPACING,
              color: INK,
              lineHeight: `${SETTLED_BOX_H}px`,
            }}
          >
            {leadText}
          </span>
        ) : null}
        {leadText && playArrival ? (
          <DitherTextIn
            text={leadText}
            duration={ARRIVAL_MS}
            fontSize={LABEL_FONT_SIZE}
            letterSpacing={LABEL_LETTER_SPACING}
            fontWeight={LABEL_FONT_WEIGHT}
            ink={INK}
            className={styles.dither}
          />
        ) : null}
        {leadText && costPart ? <span className={styles.separator}>{RECEIPT_SEPARATOR}</span> : null}
        {costPart ? (
          playArrival && cents >= 1 ? (
            <CountUp value={cents} from={0} format={formatCents} className={styles.cost} />
          ) : (
            <span className={styles.cost}>{settledCost}</span>
          )
        ) : null}
      </span>
    </div>
  );
}

export default ReceiptStamp;
