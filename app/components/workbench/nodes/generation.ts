// Framework-free pure core shared by the imageGenerate/imageEdit manifests
// and their DOM-side execute wrappers: request building and response mapping
// only. This module must stay importable by Node's --experimental-strip-types
// test runner, so runtime imports carry explicit .ts extensions and nothing
// here touches the DOM at module scope.

import { clampToValidEditSize, smallestValidEditSize, validateEditSize } from "../../../lib/image-edit.ts";
import { estimateOutputOnlyUsd } from "../cost.ts";
import {
  SUNBURST_BACKGROUNDS,
  SUNBURST_MODEL,
  SUNBURST_QUALITIES,
  type SunburstBackground,
  type SunburstQuality,
} from "../../../lib/sunburst.ts";
import { estimateRunUsd } from "../cost.ts";
import type { CostEstimateInput, ImportParamRule, NodeOutputValue, ReferenceItem, WorkbenchParams } from "../types";

export const GENERATION_SIZES = ["1024x1024", "1536x1024", "1024x1536", "2048x2048", "2560x1440"] as const;
export const GENERATION_QUALITIES = SUNBURST_QUALITIES;
export const GENERATION_BACKGROUNDS = SUNBURST_BACKGROUNDS;
export const GENERATION_FORMATS = ["png", "webp", "jpeg"] as const;
// How params.size is chosen. params.size itself always holds a concrete
// "WxH" string so cost, draft override, signature and the route keep reading
// one field:
//   preset -- one of GENERATION_SIZES
//   input  -- follow the connected input image's exact dimensions, snapped to
//             a valid Sunburst size (GenerationSettings re-resolves whenever
//             that input changes, so a Crop upstream drives the size)
//   custom -- typed width/height, validated by validateEditSize
export const GENERATION_SIZE_MODES = ["preset", "input", "custom"] as const;
export type GenerationSizeMode = (typeof GENERATION_SIZE_MODES)[number];
// Longest legal size string is "3840x2160"-shaped: 4+1+4 = 9 chars.
export const SIZE_STRING_MAX_LENGTH = 9;

export function parseSize(size: unknown): { width: number; height: number } | null {
  if (typeof size !== "string") return null;
  const match = /^(\d{1,4})x(\d{1,4})$/.exec(size.trim());
  if (!match) return null;
  return { width: Number(match[1]), height: Number(match[2]) };
}

// The size a render should use to match an input image of these dimensions:
// the exact size when Sunburst accepts it, otherwise the nearest valid one.
export function sizeForInput(width: number, height: number): string {
  const snapped = clampToValidEditSize(Math.max(1, Math.round(width)), Math.max(1, Math.round(height)));
  return `${snapped.width}x${snapped.height}`;
}

// Validation message for a typed custom size, or null when it is renderable.
export function customSizeError(size: unknown): string | null {
  const parsed = parseSize(size);
  if (!parsed) return "Size must look like 1536x1024.";
  return validateEditSize(`${parsed.width}x${parsed.height}`);
}

// Import-validation rules shared by both generation-shaped nodes.
export const GENERATION_PARAM_RULES = {
  // Any "WxH" string: presets, input-matched and custom sizes all land here.
  // The edit route re-validates against Sunburst's limits before spending.
  size: { type: "string", optional: true, maxLength: SIZE_STRING_MAX_LENGTH },
  sizeMode: { type: "enum", optional: true, values: GENERATION_SIZE_MODES },
  quality: { type: "enum", optional: true, values: GENERATION_QUALITIES },
  candidates: { type: "number", optional: true, integer: true, min: 1, max: 4 },
  model: { type: "enum", optional: true, values: [SUNBURST_MODEL] },
  background: { type: "enum", optional: true, values: GENERATION_BACKGROUNDS },
  outputFormat: { type: "enum", optional: true, values: GENERATION_FORMATS },
} satisfies Record<string, ImportParamRule>;

export type GenerationPayload = {
  prompt: string;
  size: string;
  quality: SunburstQuality;
  n: number;
  model: typeof SUNBURST_MODEL;
  background: SunburstBackground;
  outputFormat: (typeof GENERATION_FORMATS)[number];
};

export function promptTextsFrom(values: NodeOutputValue[]): string[] {
  return values.map((value) => (value.kind === "text" ? value.text : "")).filter(Boolean);
}

// Pure request-building core: validates the prompt inputs and shapes the
// /api/workbench/edit payload from the node's (effective) params.
export function buildGenerationPayload(params: WorkbenchParams, promptValues: NodeOutputValue[]): GenerationPayload {
  const promptParts = promptTextsFrom(promptValues);
  if (!promptParts.length) throw new Error("Connect a prompt (Text or Prompt Builder) first.");
  const background = params.background || "opaque";
  const outputFormat = params.outputFormat === "jpeg" || params.outputFormat === "webp" ? params.outputFormat : "png";
  if (background === "transparent" && outputFormat === "jpeg") {
    throw new Error("Transparent output requires PNG or WebP; choose a compatible format before generating.");
  }
  return {
    prompt: promptParts.join("\n"),
    size: params.size || "1536x1024",
    quality: (params.quality || "medium") as SunburstQuality,
    n: params.candidates || 1,
    model: SUNBURST_MODEL,
    background,
    outputFormat,
  };
}

// Pure response-mapping core: one base64 payload entry to raw bytes.
export function decodeBase64Image(base64: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

// Ordered blob-cache keys behind one upstream value: an image passes its own
// cacheKey through; a references value expands to its items' imageKeys,
// following the value's `order` (item ids). Other kinds carry no image data.
export function imageCacheKeysFromValue(value: NodeOutputValue): string[] {
  if (value.kind === "image") return [value.cacheKey];
  if (value.kind === "references") {
    const byId = new Map(value.items.map((item) => [item.id, item]));
    const orderedIds = value.order.length ? value.order : value.items.map((item) => item.id);
    const keys: string[] = [];
    const seen = new Set<string>();
    for (const id of orderedIds) {
      const item = byId.get(id);
      if (!item || seen.has(id)) continue;
      seen.add(id);
      keys.push(...item.imageKeys);
    }
    return keys;
  }
  return [];
}

// Normalizes a mixed reference-input port (acceptedKinds ["image",
// "references"]) into one ordered ReferenceItem list: a references bundle
// contributes its items in the bundle's own order (deduped, empty items
// skipped), and a plain image value becomes a one-image synthetic item — so
// nodes that consume reference items (Collage Board, Accuracy Reviewer) take
// direct Photo/Generate outputs without routing through a References node.
// Synthetic ids reuse the image's cacheKey, which is stable per output run,
// so params that reference item ids (e.g. selectedItemIds) stay valid across
// renders of the same run.
export function referenceItemsFromValues(values: NodeOutputValue[]): ReferenceItem[] {
  const items: ReferenceItem[] = [];
  const seen = new Set<string>();
  let imageIndex = 0;
  for (const value of values) {
    if (value.kind === "image") {
      imageIndex += 1;
      if (seen.has(value.cacheKey)) continue;
      seen.add(value.cacheKey);
      items.push({ id: value.cacheKey, role: `reference image ${imageIndex}`, imageKeys: [value.cacheKey] });
    } else if (value.kind === "references") {
      const byId = new Map(value.items.map((item) => [item.id, item]));
      const orderedIds = value.order.length ? value.order : value.items.map((item) => item.id);
      for (const id of orderedIds) {
        const item = byId.get(id);
        if (!item || !item.imageKeys.length || seen.has(id)) continue;
        seen.add(id);
        items.push(item);
      }
    }
  }
  return items;
}

export function estimateGenerationCost({ params, inputImages }: CostEstimateInput): number | null {
  return estimateRunUsd({
    size: params.size || "1536x1024",
    quality: params.quality || "medium",
    candidates: params.candidates || 1,
    inputImages,
  });
}

/**
 * Output-token cost for a Sunburst-backed node, learned from what runs at this
 * exact (model, size, quality) actually reported. Null until one has run.
 *
 * Output only, and the UI labels it as such: image input dominates a render's
 * bill and depends on the input images' tile coverage, which is not knowable
 * before the provider responds. A partial subtotal must never be presented as
 * a complete pre-render price.
 */
export function estimateSunburstCost({ params }: CostEstimateInput): number | null {
  return estimateOutputOnlyUsd({
    model: typeof params.model === "string" ? params.model : undefined,
    size: params.size,
    quality: params.quality,
    // Variations names its fan-out `n`; the generation nodes call it candidates.
    candidates: (params.candidates as number | undefined) ?? (params.n as number | undefined) ?? 1,
  });
}

// Draft mode's cheaper variant (AC22/issue-3): lowest quality tier AND the
// smallest valid gpt-image-2 size at the CURRENT size's aspect ratio (not
// just quality, which left large sizes -- including 2K+ Upscaler targets --
// unchanged). The same effective params (this function's output) drive
// execution, the memoization signature, and both cost displays, since
// draftOverrideMap is applied uniformly by executor.ts/signature.ts/
// estimateStaleCost -- so signing this size change is automatic, not a
// separate wiring step.
export function generationDraftOverride(params: WorkbenchParams): WorkbenchParams {
  const [rawWidth, rawHeight] = (params.size || "1536x1024").split("x").map(Number);
  const small = smallestValidEditSize(rawWidth || 1536, rawHeight || 1024);
  return { ...params, quality: "low", size: `${small.width}x${small.height}` };
}
