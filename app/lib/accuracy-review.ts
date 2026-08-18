// Shared server-side accuracy review (QA): sends a generated image plus its
// ordered reference images to the vision model and returns a structured
// per-item verdict with normalized bounding boxes. Extracted verbatim from the
// generator's /api/generate route; the domain string only swaps the prompt's
// subject noun so interior/exterior render callers can reuse the same review.
import { combineAbortSignals, readOpenAIResponse } from "./openai-server.ts";

type OpenAIResponseOutput = {
  output_text?: string;
  output?: Array<{
    content?: Array<{ text?: string }>;
  }>;
};

export type QaItemReview = {
  id: string;
  passed: boolean;
  finding: string;
  box?: [number, number, number, number];
};

export type QaReview = {
  passed: boolean;
  score: number;
  findings: string[];
  recommendation: string;
  items: QaItemReview[];
  reviewFailed?: boolean;
};

// One reviewed item, in board order. A single item can own MULTIPLE reference
// images; referenceCount drives the "references 3-5 -> id: role" range map.
export type AccuracyReviewItem = {
  id: string;
  role: string;
  referenceCount: number;
};

// One ordered reference image. Prefer fileId (already-uploaded OpenAI file)
// over inlining the blob as base64 into the review request body.
export type AccuracyReviewReference = {
  blob: Blob;
  fileId?: string;
};

export type AccuracyReviewDomain = "material collage" | "interior render" | "exterior render";

export type AccuracyReviewRequest = {
  apiKey: string;
  imageBase64: string;
  // Ordered list of ALL expected items — drives the schema minItems/maxItems
  // and the returned items[].
  items: AccuracyReviewItem[];
  // Masked-repair subset (empty = full scoring). Filters items to the subset
  // used to number/build the reference map, switches the prompt to the
  // intermediate-masked-repair branch, and gates `passed` on the subset only.
  selectedItemIds: string[];
  // Ordered reference images matching the reference-map numbering.
  references: AccuracyReviewReference[];
  domain: AccuracyReviewDomain;
  // Optional caller signal, combined with the timeout below.
  signal?: AbortSignal;
  // Wall-clock ceiling for the review call. Undefined uses
  // ACCURACY_REVIEW_TIMEOUT_MS; NULL disables the timer entirely, for long
  // user-initiated work that must be allowed to finish.
  timeoutMs?: number | null;
};

export const ACCURACY_REVIEW_TIMEOUT_MS = 180_000;

export async function reviewGeneratedImage(request: AccuracyReviewRequest): Promise<QaReview> {
  const { apiKey, imageBase64, references, domain, signal } = request;
  const artifact = domain === "material collage" ? "collage" : domain;
  const selectedIds = new Set(request.selectedItemIds);
  const expectedItems = request.items;
  const referenceItems = selectedIds.size
    ? expectedItems.filter((item) => selectedIds.has(item.id))
    : expectedItems;
  let nextReference = 1;
  const itemMap = referenceItems.map((item) => {
    const count = item.referenceCount;
    const start = nextReference;
    const end = nextReference + count - 1;
    nextReference += count;
    const range = start === end ? `reference ${start}` : `references ${start}-${end}`;
    // Name the primary/supporting split the generator was given, so a stray
    // object built from a supporting view reads as a duplicate here instead of
    // looking like a legitimately requested second element.
    const views = count > 1
      ? ` (primary identity view: reference ${start}; supporting view${count === 2 ? "" : "s"} of this same physical item: ${start + 1 === end ? `reference ${end}` : `references ${start + 1}-${end}`})`
      : "";
    return `${range} -> ${item.id}: ${item.role}${views}`;
  }).join("\n");
  // A masked repair reviews a subset of a canvas that still carries the whole
  // board, so the object count only makes sense on a full review.
  const objectCount = selectedIds.size
    ? ""
    : ` There are exactly ${expectedItems.length} referenced object${expectedItems.length === 1 ? "" : "s"} on the canvas, one per item ID - count them.`;
  const content: Array<Record<string, unknown>> = [
    {
      type: "input_text",
      text: `Act as a meticulous architecture-magazine art director and product-reference checker.

The first image is the generated ${artifact}. Every following image is an original reference, in the same order used by the reference map below.

${itemMap}

Evaluate:
1. Every requested item is present exactly once and no unrequested material, fixture, appliance, or placeholder was added.${objectCount}
2. No object was built from a supporting view. Where several references map to one item ID they are views of a single physical item, so any second object, duplicate, mirrored twin, alternate colorway, inset, detail vignette, or spare swatch that matches one of that item's views is a defect: fail that item, and name the view it came from.
3. Each item preserves recognizable identity, geometry, finish, color, texture, grain, veining, pattern scale, and defining details from its references.
4. The ${artifact} is photorealistic, cleanly isolated, pure white, professionally lit, and editorially composed.
5. No item is badly warped, duplicated, mislabeled, recolored, hidden, or replaced by a generic substitute.

${selectedIds.size
  ? `This is an intermediate masked repair. Score only these selected items: ${Array.from(selectedIds).join(", ")}. Unselected pixels will be restored exactly after this review, so do not penalize drift in unselected items. Still locate every item.`
  : `Score the complete ${artifact}.`}

For every item ID, return an item verdict and a tight bounding box [x, y, width, height] around its visible pixels and contact shadow. Coordinates are integers normalized from 0 to 1000 relative to the ${artifact}. Include every ID exactly once. Pass only at 90 or above with no major mismatch in the scored items.`,
    },
    {
      type: "input_image",
      image_url: `data:image/png;base64,${imageBase64}`,
      detail: "original",
    },
  ];

  for (const reference of references) {
    // Reference already-uploaded files by ID (as the Economy QA does) rather
    // than inflating multi-MB blobs into base64 inside one JSON body.
    if (reference.fileId) {
      content.push({ type: "input_image", file_id: reference.fileId, detail: "original" });
    } else {
      content.push({ type: "input_image", image_url: await blobDataUrl(reference.blob), detail: "original" });
    }
  }

  const timeoutMs = request.timeoutMs === null ? undefined : request.timeoutMs ?? ACCURACY_REVIEW_TIMEOUT_MS;
  const reviewSignal = combineAbortSignals(signal, timeoutMs);
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    signal: reviewSignal,
    body: JSON.stringify({
      model: process.env.MATERIAL_COLLAGER_QA_MODEL || "gpt-5.6",
      reasoning: { effort: "low" },
      text: {
        format: {
          type: "json_schema",
          name: "collage_accuracy_review",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              passed: { type: "boolean" },
              score: { type: "integer", minimum: 0, maximum: 100 },
              findings: { type: "array", items: { type: "string" }, maxItems: 20 },
              recommendation: { type: "string" },
              items: {
                type: "array",
                minItems: expectedItems.length,
                maxItems: expectedItems.length,
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    id: { type: "string" },
                    passed: { type: "boolean" },
                    finding: { type: "string" },
                    box: {
                      type: "array",
                      items: { type: "integer", minimum: 0, maximum: 1000 },
                      minItems: 4,
                      maxItems: 4,
                    },
                  },
                  required: ["id", "passed", "finding", "box"],
                },
              },
            },
            required: ["passed", "score", "findings", "recommendation", "items"],
          },
        },
      },
      input: [{ role: "user", content }],
    }),
  });

  try {
    const json = await readOpenAIResponse<OpenAIResponseOutput>(response);
    const raw = extractOutputText(json);
    const parsed = JSON.parse(raw.replace(/^```json\s*/i, "").replace(/```$/i, "").trim()) as {
      passed?: boolean;
      score?: number;
      findings?: string[] | string;
      recommendation?: string;
      items?: Array<{ id?: unknown; passed?: unknown; finding?: unknown; box?: unknown }>;
    };
    const score = Math.max(0, Math.min(100, Math.round(Number(parsed.score) || 0)));
    const parsedItems = new Map((parsed.items ?? []).map((item) => [String(item.id || ""), item]));
    const items = expectedItems.map((item) => {
      const parsedItem = parsedItems.get(item.id);
      const box = normalizeQaBox(parsedItem?.box);
      return {
        id: item.id,
        passed: Boolean(parsedItem?.passed),
        finding: String(parsedItem?.finding || (box ? "" : "QA could not reliably locate this item.")),
        ...(box ? { box } : {}),
      };
    });
    const scoredItems = selectedIds.size ? items.filter((item) => selectedIds.has(item.id)) : items;
    return {
      passed: Boolean(parsed.passed) && score >= 90 && scoredItems.every((item) => item.passed),
      score,
      findings: Array.isArray(parsed.findings)
        ? parsed.findings.map(String)
        : parsed.findings
          ? [String(parsed.findings)]
          : [],
      recommendation: String(parsed.recommendation || ""),
      items,
      reviewFailed: false,
    };
  } catch (error) {
    return {
      passed: false,
      score: 0,
      findings: [error instanceof Error ? error.message : "Accuracy review failed."],
      recommendation: "Review the collage manually before using it.",
      items: expectedItems.map((item) => missingQaItem(item.id)),
      reviewFailed: true,
    };
  }
}

export function missingQaItem(id: string): QaItemReview {
  return { id, passed: false, finding: "QA could not reliably locate this item." };
}

export function normalizeQaBox(value: unknown): [number, number, number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 4) return undefined;
  const numbers = value.map((entry) => Math.max(0, Math.min(1000, Math.round(Number(entry) || 0))));
  const [x, y, rawWidth, rawHeight] = numbers;
  const width = Math.min(rawWidth, 1000 - x);
  const height = Math.min(rawHeight, 1000 - y);
  if (width < 5 || height < 5) return undefined;
  return [x, y, width, height];
}

async function blobDataUrl(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return `data:${blob.type || "image/png"};base64,${btoa(binary)}`;
}

function extractOutputText(response: OpenAIResponseOutput) {
  if (response.output_text) return response.output_text;
  const chunks: string[] = [];
  for (const output of response.output ?? []) {
    for (const part of output.content ?? []) {
      if (part.text) chunks.push(part.text);
    }
  }
  return chunks.join("\n");
}
