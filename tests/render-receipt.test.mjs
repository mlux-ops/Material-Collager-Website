import assert from "node:assert/strict";
import test from "node:test";

import {
  RECEIPT_SEPARATOR,
  receiptAnnouncement,
  renderReceipt,
  renderReceiptText,
} from "../app/lib/render-receipt.ts";

// --- the documented examples -------------------------------------------------

test("a draft with time, references and cost", () => {
  assert.equal(
    renderReceiptText({ kind: "draft", elapsedMs: 48_000, references: 6, costUsd: 0.07 }),
    "DRAFT · 0:48 · 6 REFS · $0.07",
  );
});

test("a final with time, references and cost", () => {
  assert.equal(
    renderReceiptText({ kind: "final", elapsedMs: 125_000, references: 9, costUsd: 0.31 }),
    "FINAL · 2:05 · 9 REFS · $0.31",
  );
});

test("a Review Boards cell: kind + variant, quality, cost, no time", () => {
  assert.equal(
    renderReceiptText({ kind: "draft", variant: "A", quality: "low", costUsd: 0.07 }),
    "DRAFT A · LOW · $0.07",
  );
});

test("no cost known leaves the dollars part out", () => {
  assert.equal(renderReceiptText({ kind: "draft", elapsedMs: 48_000, references: 6 }), "DRAFT · 0:48 · 6 REFS");
  assert.equal(
    renderReceiptText({ kind: "draft", elapsedMs: 48_000, references: 6, costUsd: null }),
    "DRAFT · 0:48 · 6 REFS",
  );
});

test("one reference is singular, more are plural", () => {
  assert.equal(renderReceiptText({ kind: "draft", references: 1 }), "DRAFT · 1 REF");
  assert.equal(renderReceiptText({ kind: "draft", references: 2 }), "DRAFT · 2 REFS");
});

test("a failure reads FAILED with its time", () => {
  assert.equal(renderReceiptText({ kind: "draft", failed: true, elapsedMs: 12_000 }), "FAILED · 0:12");
});

test("a failure keeps the references part when known", () => {
  assert.equal(
    renderReceiptText({ kind: "draft", failed: true, elapsedMs: 12_000, references: 6 }),
    "FAILED · 0:12 · 6 REFS",
  );
});

test("a failure shows dollars only when a cost was actually returned", () => {
  assert.equal(renderReceiptText({ kind: "final", failed: true, elapsedMs: 12_000, costUsd: null }), "FAILED · 0:12");
  assert.equal(renderReceiptText({ kind: "final", failed: true, elapsedMs: 12_000, costUsd: 0 }), "FAILED · 0:12");
  assert.equal(
    renderReceiptText({ kind: "final", failed: true, elapsedMs: 12_000, costUsd: 0.05 }),
    "FAILED · 0:12 · $0.05",
  );
});

// --- structure ---------------------------------------------------------------

test("parts come back in order with keys and raw values, joined by ' · '", () => {
  assert.equal(RECEIPT_SEPARATOR, " · ");
  const receipt = renderReceipt({ kind: "studio", quality: "high", elapsedMs: 48_000, references: 6, costUsd: 0.07 });
  assert.deepEqual(
    receipt.parts.map((part) => part.key),
    ["kind", "quality", "elapsed", "references", "cost"],
  );
  assert.deepEqual(
    receipt.parts.map((part) => part.text),
    ["STUDIO", "HIGH", "0:48", "6 REFS", "$0.07"],
  );
  assert.equal(receipt.parts[2].value, 48_000);
  assert.equal(receipt.parts[3].value, 6);
  assert.equal(receipt.parts[4].value, 0.07);
  assert.equal(receipt.text, receipt.parts.map((part) => part.text).join(" · "));
});

test("the line is uppercase throughout", () => {
  const { text } = renderReceipt({ kind: "Draft", variant: "b", quality: "Medium", references: 3 });
  assert.equal(text, "DRAFT B · MEDIUM · 3 REFS");
  assert.equal(text, text.toUpperCase());
});

test("a cost under a cent uses formatUsd's '<$0.01'", () => {
  assert.equal(renderReceiptText({ kind: "draft", costUsd: 0.004 }), "DRAFT · <$0.01");
});

// --- omission of each missing part --------------------------------------------

test("each missing part is left out on its own", () => {
  const full = { kind: "draft", quality: "low", elapsedMs: 48_000, references: 6, costUsd: 0.07 };
  assert.equal(renderReceiptText({ ...full, kind: undefined }), "LOW · 0:48 · 6 REFS · $0.07");
  assert.equal(renderReceiptText({ ...full, quality: undefined }), "DRAFT · 0:48 · 6 REFS · $0.07");
  assert.equal(renderReceiptText({ ...full, elapsedMs: undefined }), "DRAFT · LOW · 6 REFS · $0.07");
  assert.equal(renderReceiptText({ ...full, references: undefined }), "DRAFT · LOW · 0:48 · $0.07");
  assert.equal(renderReceiptText({ ...full, costUsd: undefined }), "DRAFT · LOW · 0:48 · 6 REFS");
});

test("null and blank labels are left out", () => {
  assert.equal(renderReceiptText({ kind: null, quality: null, variant: null, references: 2 }), "2 REFS");
  assert.equal(renderReceiptText({ kind: "  ", quality: "", variant: " ", references: 2 }), "2 REFS");
});

test("a variant without a kind still shows", () => {
  assert.equal(renderReceiptText({ variant: "C", costUsd: 0.07 }), "C · $0.07");
});

test("nothing known gives no parts and an empty string, never dashes", () => {
  const receipt = renderReceipt({});
  assert.deepEqual(receipt.parts, []);
  assert.equal(receipt.text, "");
  assert.equal(renderReceiptText({ elapsedMs: Number.NaN, references: 0, costUsd: null }), "");
});

// --- zero / negative / NaN ----------------------------------------------------

test("zero, negative and non-finite elapsed are left out", () => {
  for (const elapsedMs of [0, -1, -48_000, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, null]) {
    assert.equal(renderReceiptText({ kind: "draft", elapsedMs }), "DRAFT", String(elapsedMs));
  }
});

test("zero, negative, fractional-below-one and non-finite references are left out", () => {
  for (const references of [0, -1, -6, 0.5, Number.NaN, Number.POSITIVE_INFINITY, null]) {
    assert.equal(renderReceiptText({ kind: "draft", references }), "DRAFT", String(references));
  }
});

test("a fractional reference count rounds down", () => {
  assert.equal(renderReceiptText({ kind: "draft", references: 6.9 }), "DRAFT · 6 REFS");
  assert.equal(renderReceiptText({ kind: "draft", references: 1.4 }), "DRAFT · 1 REF");
});

test("zero, negative and non-finite cost are left out", () => {
  for (const costUsd of [0, -0.07, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, null]) {
    assert.equal(renderReceiptText({ kind: "draft", costUsd }), "DRAFT", String(costUsd));
  }
});

// --- announcement sentence ----------------------------------------------------

test("the announcement for a finished draft", () => {
  assert.equal(
    receiptAnnouncement({ kind: "draft", elapsedMs: 48_000, references: 6, costUsd: 0.07 }),
    "Draft finished in 0:48, 6 references, cost $0.07.",
  );
});

test("the announcement for a Review Boards cell names the variant and quality", () => {
  assert.equal(
    receiptAnnouncement({ kind: "draft", variant: "a", quality: "LOW", costUsd: 0.07 }),
    "Draft A finished, low quality, cost $0.07.",
  );
});

test("the announcement uses singular for one reference", () => {
  assert.equal(
    receiptAnnouncement({ kind: "final", elapsedMs: 125_000, references: 1 }),
    "Final finished in 2:05, 1 reference.",
  );
});

test("the announcement for a failure", () => {
  assert.equal(
    receiptAnnouncement({ kind: "draft", failed: true, elapsedMs: 12_000, references: 6 }),
    "Draft failed after 0:12, 6 references.",
  );
  assert.equal(receiptAnnouncement({ kind: "draft", failed: true }), "Draft failed.");
  assert.equal(
    receiptAnnouncement({ kind: "final", failed: true, elapsedMs: 12_000, costUsd: 0.05 }),
    "Final failed after 0:12, cost $0.05.",
  );
});

test("the announcement falls back to 'Render' and omits unknown parts", () => {
  assert.equal(receiptAnnouncement({}), "Render finished.");
  assert.equal(
    receiptAnnouncement({ elapsedMs: Number.NaN, references: 0, costUsd: -1 }),
    "Render finished.",
  );
});

test("the announcement speaks '<$0.01' as 'under $0.01'", () => {
  assert.equal(receiptAnnouncement({ kind: "draft", costUsd: 0.004 }), "Draft finished, cost under $0.01.");
});
