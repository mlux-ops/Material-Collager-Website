import {
  reviewGeneratedImage,
  type AccuracyReviewDomain,
  type AccuracyReviewItem,
  type AccuracyReviewReference,
} from "@/app/lib/accuracy-review";
import { MAX_REFERENCE_IMAGES } from "@/app/lib/collage";
import { base64ToBytes } from "@/app/lib/base64";
import { errorResponse, resolveOpenAIKey } from "@/app/lib/openai-server";

export const runtime = "edge";

// Accuracy review (QA) endpoint for the workbench node editor. Unlike
// /api/generate it reviews an already-generated image: the JSON body carries
// the generated image plus its ORDERED reference images as base64 (or
// already-uploaded OpenAI file IDs) and delegates scoring to the shared
// accuracy-review lib, so multi-image items and masked-repair subsets behave
// exactly like the generator's built-in QA.
// S-2: no `fileId` field -- the workbench client always sends base64 image
// bytes, never an OpenAI file_id, so accepting one here would be undeclared
// surface letting a client name an arbitrary org file_id. app/lib/
// accuracy-review.ts still supports fileId for the generator's own path,
// which constructs its references server-side from its own upload flow.
type WorkbenchReviewPayload = {
  apiKey?: string;
  imageBase64?: string;
  items?: Array<{ id?: string; role?: string; referenceCount?: number }>;
  selectedItemIds?: string[];
  references?: Array<{ imageBase64?: string; mimeType?: string }>;
  domain?: string;
};

const DOMAINS: AccuracyReviewDomain[] = ["material collage", "interior render", "exterior render"];
const REFERENCE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"];
// The edge runtime rejects request bodies over 32 MB and base64 inflates the
// underlying bytes by ~33%, so cap the combined base64 payload at 30M
// characters (~28.6 MiB of body, ~22.5 MiB of decoded image data) to leave
// headroom for the JSON metadata around it.
const MAX_TOTAL_BASE64_CHARS = 30_000_000;

export async function POST(request: Request) {
  try {
    const payload = await request.json() as WorkbenchReviewPayload;
    const apiKey = resolveOpenAIKey(payload.apiKey);

    const imageBase64 = validBase64(payload.imageBase64, "the generated image");
    const items = validateItems(payload.items);
    const selectedItemIds = validateSelection(payload.selectedItemIds, items);
    const domain = validateDomain(payload.domain);

    const selectedIds = new Set(selectedItemIds);
    const reviewedItems = selectedIds.size ? items.filter((item) => selectedIds.has(item.id)) : items;
    const expectedReferences = reviewedItems.reduce((total, item) => total + item.referenceCount, 0);
    // N-11: cap on what THIS request actually transmits (the reviewed
    // subset), not the full board's summed referenceCount -- previously this
    // check lived inside validateItems and ran over the FULL board's total,
    // so a 2-image subset review of a 20-image board was rejected citing
    // images it never sent. When selectedItemIds is empty, reviewedItems ===
    // items, so a full-board review is capped exactly as before.
    if (expectedReferences > MAX_REFERENCE_IMAGES) {
      throw new Error(`Use no more than ${MAX_REFERENCE_IMAGES} reference images in one review.`);
    }
    const rawReferences = payload.references ?? [];
    if (rawReferences.length !== expectedReferences) {
      throw new Error("One or more reference images were missing from the review request.");
    }

    let totalBase64Chars = imageBase64.length;
    const references: AccuracyReviewReference[] = rawReferences.map((reference, index) => {
      const base64 = validBase64(reference.imageBase64, `reference image ${index + 1}`);
      totalBase64Chars += base64.length;
      const mimeType = reference.mimeType || "image/png";
      if (!REFERENCE_MIME_TYPES.includes(mimeType)) {
        throw new Error(`Reference image ${index + 1} must be a PNG, JPEG, or WebP image.`);
      }
      return { blob: decodeBase64(base64, mimeType) };
    });
    if (totalBase64Chars > MAX_TOTAL_BASE64_CHARS) {
      throw new Error("The review request is too large. Send fewer or smaller images, or upload references first and pass their file IDs.");
    }

    // E1 cancellation threading: forward the route's request.signal (aborted
    // when the client fetch is cancelled) into the shared review, which
    // combines it with its own 180s timeout via AbortSignal.any so a client
    // cancel aborts the paid upstream QA call while the timeout is preserved.
    const review = await reviewGeneratedImage({
      apiKey,
      imageBase64,
      items,
      selectedItemIds,
      references,
      domain,
      signal: request.signal,
    });

    return Response.json({
      ok: true,
      passed: review.passed,
      score: review.score,
      findings: review.findings,
      recommendation: review.recommendation,
      items: review.items,
      reviewFailed: review.reviewFailed ?? false,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

function validateItems(raw: WorkbenchReviewPayload["items"]): AccuracyReviewItem[] {
  const items = (raw ?? []).map((item) => ({
    id: String(item.id || "").trim(),
    role: String(item.role || "").trim(),
    referenceCount: Number(item.referenceCount),
  }));
  if (!items.length) throw new Error("Add at least one item with a reference image.");
  // N-11: a board-SHAPE sanity cap, distinct from the reference-BYTES cap
  // (which now applies to the reviewed SUBSET only -- see expectedReferences
  // in POST above, after reviewedItems is computed). `items` metadata (id/
  // role/referenceCount) costs no image bytes, but an unbounded item count
  // would still inflate the shared lib's response schema (minItems/maxItems
  // == items.length) -- no legitimate board approaches this: every preset in
  // app/lib/collage.ts's ITEM_PRESETS has a handful of named material/
  // fixture slots.
  if (items.length > MAX_REFERENCE_IMAGES) {
    throw new Error(`Describe no more than ${MAX_REFERENCE_IMAGES} items in one review.`);
  }
  const ids = new Set<string>();
  for (const item of items) {
    if (!item.id) throw new Error(`Give ${item.role || "each item"} a unique ID.`);
    if (ids.has(item.id)) throw new Error(`Item ID "${item.id}" is used more than once.`);
    ids.add(item.id);
    if (!item.role) throw new Error(`Item ${item.id} needs a role.`);
    if (!Number.isInteger(item.referenceCount) || item.referenceCount < 1 || item.referenceCount > MAX_REFERENCE_IMAGES) {
      throw new Error(`Item ${item.id} needs between 1 and ${MAX_REFERENCE_IMAGES} reference images.`);
    }
  }
  return items;
}

function validateSelection(raw: string[] | undefined, items: AccuracyReviewItem[]): string[] {
  const ids = new Set(items.map((item) => item.id));
  const selection = Array.from(new Set((raw ?? []).map((id) => String(id || "").trim()).filter(Boolean)));
  for (const id of selection) {
    if (!ids.has(id)) throw new Error(`Selected item "${id}" is not in the reviewed board.`);
  }
  return selection;
}

function validateDomain(raw: string | undefined): AccuracyReviewDomain {
  if (!raw) return "material collage";
  const domain = DOMAINS.find((entry) => entry === raw);
  if (!domain) throw new Error("Choose a supported review domain.");
  return domain;
}

function validBase64(value: string | undefined, label: string) {
  const base64 = value?.trim() || "";
  if (!base64) throw new Error(`Add ${label} before running the review.`);
  if (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw new Error(`The data for ${label} is not valid base64.`);
  }
  return base64;
}

function decodeBase64(base64: string, mimeType: string) {
  return new Blob([base64ToBytes(base64)], { type: mimeType });
}
