// Render receipt: the one line that states what a finished image render was
// and what it cost -- "DRAFT · 0:48 · 6 REFS · $0.07".
//
// Pure logic only -- no React, no `node:` builtins, no `@/` alias -- so the
// type-stripping test runner exercises it directly
// (tests/render-receipt.test.mjs). The React side is
// app/components/ReceiptStamp.tsx.
//
// Text case: every part is produced in UPPERCASE here. The stage strip draws
// its text through DitherTextIn, which rasterizes the string onto a canvas, so
// CSS text-transform could not reach it; producing uppercase once keeps the
// stage strip, the inline form and the screen-reader text identical.
//
// Nothing is ever estimated: a part whose value is missing, null or
// non-finite is left out of the line, never shown as a dash or a guess.

import { formatElapsed } from "./render-clock.ts";
import { formatUsd } from "./image-cost.ts";

export const RECEIPT_SEPARATOR = " · ";

export type RenderReceiptInput = {
  /** The render's kind: "draft", "studio", "final", "confirm", ... */
  kind?: string | null;
  /** The Review Boards style letter ("A", "B", "C"), appended to the kind. */
  variant?: string | null;
  /** The quality tier the render was sent at ("low", "medium", "high"). */
  quality?: string | null;
  /** Wall-clock duration of the render. Left out unless finite and > 0. */
  elapsedMs?: number | null;
  /** Reference images sent. Left out unless finite and >= 1. */
  references?: number | null;
  /** What the render actually cost, as returned. Left out unless finite and > 0. */
  costUsd?: number | null;
  /** True when the render failed; the kind part then reads FAILED. */
  failed?: boolean | null;
};

export type RenderReceiptPartKey = "kind" | "quality" | "elapsed" | "references" | "cost";

export type RenderReceiptPart = {
  key: RenderReceiptPartKey;
  /** The part as displayed, uppercase ("DRAFT A", "0:48", "6 REFS", "$0.07"). */
  text: string;
  /** The raw number behind elapsed (ms), references (count) and cost (USD). */
  value?: number;
};

export type RenderReceipt = {
  parts: RenderReceiptPart[];
  /** The parts joined with RECEIPT_SEPARATOR; "" when no part is known. */
  text: string;
};

function cleanLabel(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function validElapsed(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function validReferences(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const count = Math.floor(value);
  return count >= 1 ? count : null;
}

// A cost of zero is left out along with negative ones: formatUsd renders
// anything under a cent as "<$0.01", which would claim a charge for a render
// that reported none.
function validCost(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function kindLabel(input: RenderReceiptInput): string | null {
  if (input.failed) return "FAILED";
  const kind = cleanLabel(input.kind);
  const variant = cleanLabel(input.variant);
  if (kind && variant) return `${kind} ${variant}`.toUpperCase();
  if (kind) return kind.toUpperCase();
  if (variant) return variant.toUpperCase();
  return null;
}

/**
 * The receipt line as ordered parts plus the joined string. Order is kind,
 * quality, elapsed, references, cost; any unknown part is left out.
 *
 *   { kind: "draft", elapsedMs: 48_000, references: 6, costUsd: 0.07 }
 *     -> "DRAFT · 0:48 · 6 REFS · $0.07"
 *   { kind: "draft", variant: "A", quality: "low", costUsd: 0.07 }
 *     -> "DRAFT A · LOW · $0.07"
 *   { kind: "draft", failed: true, elapsedMs: 12_000 }
 *     -> "FAILED · 0:12"
 */
export function renderReceipt(input: RenderReceiptInput): RenderReceipt {
  const parts: RenderReceiptPart[] = [];

  const kind = kindLabel(input);
  if (kind) parts.push({ key: "kind", text: kind });

  const quality = cleanLabel(input.quality);
  if (quality) parts.push({ key: "quality", text: quality.toUpperCase() });

  const elapsed = validElapsed(input.elapsedMs);
  if (elapsed !== null) parts.push({ key: "elapsed", text: formatElapsed(elapsed), value: elapsed });

  const references = validReferences(input.references);
  if (references !== null) {
    parts.push({ key: "references", text: `${references} ${references === 1 ? "REF" : "REFS"}`, value: references });
  }

  const cost = validCost(input.costUsd);
  if (cost !== null) parts.push({ key: "cost", text: formatUsd(cost), value: cost });

  return { parts, text: parts.map((part) => part.text).join(RECEIPT_SEPARATOR) };
}

/** The joined receipt line alone; "" when nothing is known. */
export function renderReceiptText(input: RenderReceiptInput): string {
  return renderReceipt(input).text;
}

function sentenceCase(value: string): string {
  const lower = value.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/**
 * The plain sentence for the page's polite activity log, announced once when
 * the receipt lands:
 *
 *   "Draft finished in 0:48, 6 references, cost $0.07."
 *   "Draft A finished, low quality, cost $0.07."
 *   "Draft failed after 0:12, 6 references."
 *
 * Same omission rules as the line. "<$0.01" is spoken as "under $0.01".
 */
export function receiptAnnouncement(input: RenderReceiptInput): string {
  const kind = cleanLabel(input.kind);
  const variant = cleanLabel(input.variant);
  const subjectBase = kind ? sentenceCase(kind) : "Render";
  const subject = variant ? `${subjectBase} ${variant.toUpperCase()}` : subjectBase;

  const elapsed = validElapsed(input.elapsedMs);
  const clause = input.failed
    ? elapsed !== null
      ? `failed after ${formatElapsed(elapsed)}`
      : "failed"
    : elapsed !== null
      ? `finished in ${formatElapsed(elapsed)}`
      : "finished";

  const details: string[] = [];
  const quality = cleanLabel(input.quality);
  if (quality) details.push(`${quality.toLowerCase()} quality`);
  const references = validReferences(input.references);
  if (references !== null) details.push(`${references} ${references === 1 ? "reference" : "references"}`);
  const cost = validCost(input.costUsd);
  if (cost !== null) {
    const usd = formatUsd(cost);
    details.push(`cost ${usd.startsWith("<") ? `under ${usd.slice(1)}` : usd}`);
  }

  return `${[`${subject} ${clause}`, ...details].join(", ")}.`;
}
