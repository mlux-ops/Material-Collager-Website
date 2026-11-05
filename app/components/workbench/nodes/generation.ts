// Framework-free pure core shared by the imageGenerate/imageEdit manifests
// and their DOM-side execute wrappers: request building and response mapping
// only. This module must stay importable by Node's --experimental-strip-types
// test runner, so runtime imports carry explicit .ts extensions and nothing
// here touches the DOM at module scope.

import {
  GIF_FRAME_COUNT_DEFAULT,
  GIF_FRAME_COUNT_MAX,
  GIF_FRAME_COUNT_MIN,
  GIF_FRAME_DURATION_DEFAULT_MS,
  GIF_FRAME_DURATION_MAX_MS,
  GIF_FRAME_DURATION_MIN_MS,
  MARKUP_MAX_BYTES,
  MARKUP_MAX_PIXELS,
  clampToValidEditSize,
  gifFrameParamsError,
  roundFrameDuration,
  smallestValidEditSize,
  validateEditSize,
  validateGifSize,
} from "../../../lib/image-edit.ts";
import { estimateOutputOnlyUsd } from "../cost.ts";
import {
  SUNBURST_BACKGROUNDS,
  SUNBURST_COMPLEXITIES,
  SUNBURST_MODEL,
  SUNBURST_QUALITIES,
  isSunburstComplexity,
  modelSupports,
  type AllowedImageModel,
  type SunburstBackground,
  type SunburstComplexity,
  type SunburstQuality,
} from "../../../lib/sunburst.ts";
import { estimateRunUsd } from "../cost.ts";
import type {
  CostEstimateInput,
  ImageOutputFormat,
  ImageOutputMimeType,
  ImportParamRule,
  NodeOutputValue,
  ReferenceItem,
  WorkbenchParams,
} from "../types";

export const GENERATION_SIZES = ["1024x1024", "1536x1024", "1024x1536", "2048x2048", "2560x1440"] as const;
// Animated GIF presets. Every frame is rendered, and frames x pixels x n must
// fit the model's pixel budget, so these stay small (OpenAI's guide uses
// 512x512); the regular presets above would exceed it at the default 9 frames.
export const GIF_SIZES = ["512x512", "768x512", "512x768", "768x768"] as const;
export const GIF_DEFAULT_SIZE = "512x512";
export const GENERATION_QUALITIES = SUNBURST_QUALITIES;
export const GENERATION_BACKGROUNDS = SUNBURST_BACKGROUNDS;
// Raster formats every generation-shaped node offers (edits return only these).
export const GENERATION_FORMATS = ["png", "webp", "jpeg"] as const;
// Image Generation alone adds SVG and animated GIF: text-to-image on 2.6
// only, from /v1/images/generations.
export const IMAGE_GENERATE_FORMATS = ["png", "webp", "jpeg", "svg", "gif"] as const;
export const GENERATION_COMPLEXITIES = SUNBURST_COMPLEXITIES;
export {
  gifFrameParamsError,
  GIF_FRAME_COUNT_DEFAULT,
  GIF_FRAME_COUNT_MAX,
  GIF_FRAME_COUNT_MIN,
  GIF_FRAME_DURATION_DEFAULT_MS,
  GIF_FRAME_DURATION_MAX_MS,
  GIF_FRAME_DURATION_MIN_MS,
};

export function isVectorOrAnimatedFormat(format: unknown): format is "svg" | "gif" {
  return format === "svg" || format === "gif";
}

const MIME_BY_FORMAT: Record<ImageOutputFormat, ImageOutputMimeType> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
  svg: "image/svg+xml",
  gif: "image/gif",
};

export function mimeTypeForFormat(format: ImageOutputFormat): ImageOutputMimeType {
  return MIME_BY_FORMAT[format];
}

// File extension for a cached image's MIME type (downloads, uploads).
export function extensionForMimeType(mimeType: string | undefined): string {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/svg+xml") return "svg";
  if (mimeType === "image/gif") return "gif";
  return "png";
}

/**
 * Why a cached image cannot be sent on to a model, or null when it can.
 * SVG is never an image-model input (the edit endpoint refuses it), and GIF
 * input is not documented, so both are refused with the fix spelled out.
 */
export function modelInputTypeError(mimeType: string | undefined): string | null {
  if (mimeType === "image/svg+xml") {
    return "This input is an SVG. Image and vision models can’t take SVG input, and only View Image, Compare and Export/Download accept it. Set the upstream Image Generation’s output format to PNG or WebP.";
  }
  if (mimeType === "image/gif") {
    return "This input is an animated GIF. Image and vision models don’t document GIF input, and only View Image, Compare and Export/Download accept it. Set the upstream Image Generation’s output format to PNG or WebP.";
  }
  return null;
}

/**
 * The Markup layer's checks, each applied once its facts are known: a PNG of
 * at most 50 MB, the same width and height as the first input image, at most
 * 16,777,216 pixels, and some transparent pixels (OpenAI's documented
 * requirements). Pure, so the rules are unit-tested; the browser supplies the
 * decoded dimensions and the transparency scan.
 */
export function markupLayerError(facts: {
  type: string;
  bytes: number;
  markupWidth?: number;
  markupHeight?: number;
  baseWidth?: number;
  baseHeight?: number;
  maxPixels?: number;
  hasTransparency?: boolean;
}): string | null {
  if (facts.type !== "image/png") {
    return "The Markup input must be a PNG with a transparent background (draw on a transparent layer, then export PNG).";
  }
  if (facts.bytes > MARKUP_MAX_BYTES) return "The Markup layer must be 50 MB or smaller.";
  if (facts.markupWidth !== undefined && facts.markupHeight !== undefined
    && facts.baseWidth !== undefined && facts.baseHeight !== undefined
    && (facts.markupWidth !== facts.baseWidth || facts.markupHeight !== facts.baseHeight)) {
    return `The Markup layer is ${facts.markupWidth}×${facts.markupHeight}, but the input image is ${facts.baseWidth}×${facts.baseHeight}. Export the markup at exactly the input image’s size.`;
  }
  if (facts.markupWidth !== undefined && facts.markupHeight !== undefined
    && facts.markupWidth * facts.markupHeight > (facts.maxPixels ?? MARKUP_MAX_PIXELS)) {
    return "The Markup layer can be at most 16,777,216 pixels.";
  }
  if (facts.hasTransparency === false) {
    return "The Markup layer has no transparent pixels. Draw the marks on a transparent layer, not over a copy of the photo.";
  }
  return null;
}
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
// A GIF follows its own rule (no per-image pixel floor; see validateGifSize).
export function customSizeError(size: unknown, outputFormat?: unknown): string | null {
  const parsed = parseSize(size);
  if (!parsed) return "Size must look like 1536x1024.";
  const normalized = `${parsed.width}x${parsed.height}`;
  return outputFormat === "gif" ? validateGifSize(normalized) : validateEditSize(normalized);
}

// Import-validation rules shared by the generation-shaped 2.6 nodes. The Test
// node (2.5) removes `complexity` from its copy; Image Generation extends
// `outputFormat` with svg/gif and adds the GIF frame params.
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
  complexity: { type: "enum", optional: true, values: GENERATION_COMPLEXITIES },
} satisfies Record<string, ImportParamRule>;

export const IMAGE_GENERATE_PARAM_RULES = {
  ...GENERATION_PARAM_RULES,
  outputFormat: { type: "enum", optional: true, values: IMAGE_GENERATE_FORMATS },
  frameCount: { type: "number", optional: true, integer: true, min: GIF_FRAME_COUNT_MIN, max: GIF_FRAME_COUNT_MAX },
  frameDurationMs: { type: "number", optional: true, min: GIF_FRAME_DURATION_MIN_MS, max: GIF_FRAME_DURATION_MAX_MS },
} satisfies Record<string, ImportParamRule>;

export type GenerationPayload = {
  prompt: string;
  size: string;
  quality: SunburstQuality;
  n: number;
  model: AllowedImageModel;
  background: SunburstBackground;
  outputFormat: ImageOutputFormat;
  // Present only when the node set it and the model takes it.
  complexity?: SunburstComplexity;
  // Present only for GIF output.
  frameCount?: number;
  frameDurationMs?: number;
};

// The complexity a node's params ask for, or undefined when nothing should be
// sent: unset, not one of the enum values, or a model that does not take it
// (the Test node's 2.5 snapshot).
export function complexityFor(params: WorkbenchParams, model: AllowedImageModel = SUNBURST_MODEL): SunburstComplexity | undefined {
  return isSunburstComplexity(params.complexity) && modelSupports(model, "complexity") ? params.complexity : undefined;
}

export function promptTextsFrom(values: NodeOutputValue[]): string[] {
  return values.map((value) => (value.kind === "text" ? value.text : "")).filter(Boolean);
}

// Pure request-building core: validates the prompt inputs and shapes the
// /api/workbench/edit payload from the node's (effective) params. The model is
// chosen by the node KIND (the caller), never read from params, so only the
// Test node can ask for TEST_MODEL_2_5.
//
// `allowVectorAndAnimated` is set only by Image Generation: SVG/GIF pass
// through when the model supports them; on any other node (or the Test node)
// they fall back to PNG, the same as any unknown format. SVG forces n=1, and
// the GIF frame params ride along only with GIF.
export function buildGenerationPayload(
  params: WorkbenchParams,
  promptValues: NodeOutputValue[],
  model: AllowedImageModel = SUNBURST_MODEL,
  options: { allowVectorAndAnimated?: boolean } = {},
): GenerationPayload {
  const promptParts = promptTextsFrom(promptValues);
  if (!promptParts.length) throw new Error("Connect a prompt (Text or Prompt Builder) first.");
  const background = params.background || "opaque";
  const requested = params.outputFormat;
  const outputFormat: ImageOutputFormat = requested === "jpeg" || requested === "webp"
    ? requested
    : isVectorOrAnimatedFormat(requested) && options.allowVectorAndAnimated && modelSupports(model, requested)
      ? requested
      : "png";
  if (background === "transparent" && outputFormat === "jpeg") {
    throw new Error("Transparent output requires PNG or WebP; choose a compatible format before generating.");
  }
  const complexity = complexityFor(params, model);
  let frames: { frameCount?: number; frameDurationMs?: number } = {};
  if (outputFormat === "gif") {
    const frameError = gifFrameParamsError(params.frameCount, params.frameDurationMs);
    if (frameError) throw new Error(frameError);
    frames = {
      frameCount: params.frameCount ?? GIF_FRAME_COUNT_DEFAULT,
      frameDurationMs: roundFrameDuration(params.frameDurationMs ?? GIF_FRAME_DURATION_DEFAULT_MS),
    };
  }
  return {
    prompt: promptParts.join("\n"),
    size: params.size || (outputFormat === "gif" ? GIF_DEFAULT_SIZE : "1536x1024"),
    quality: (params.quality || "medium") as SunburstQuality,
    n: outputFormat === "svg" ? 1 : params.candidates || 1,
    model,
    background,
    outputFormat,
    ...(complexity !== undefined ? { complexity } : {}),
    ...frames,
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
    // Complexity has no fee of its own, but SVG/GIF and a non-default
    // complexity learn under their own table key (outputTokenVariant).
    complexity: params.complexity,
    outputFormat: params.outputFormat,
    frameCount: params.outputFormat === "gif" ? params.frameCount ?? GIF_FRAME_COUNT_DEFAULT : undefined,
    // Variations names its fan-out `n`; the generation nodes call it
    // candidates. SVG is always one image.
    candidates: params.outputFormat === "svg"
      ? 1
      : (params.candidates as number | undefined) ?? (params.n as number | undefined) ?? 1,
  });
}

// Draft mode's cheaper variant (AC22/issue-3): lowest quality tier AND the
// smallest valid Sunburst size at the CURRENT size's aspect ratio (not
// just quality, which left large sizes -- including 2K+ Upscaler targets --
// unchanged). The same effective params (this function's output) drive
// execution, the memoization signature, and both cost displays, since
// draftOverrideMap is applied uniformly by executor.ts/signature.ts/
// estimateStaleCost -- so signing this size change is automatic, not a
// separate wiring step.
export function generationDraftOverride(params: WorkbenchParams): WorkbenchParams {
  // A GIF is already small (its frames share the pixel budget), and the
  // smallest valid still size (>= 655,360 px) would be LARGER than its
  // 512x512 default, so draft mode only lowers its quality.
  if (params.outputFormat === "gif") return { ...params, quality: "low" };
  const [rawWidth, rawHeight] = (params.size || "1536x1024").split("x").map(Number);
  const small = smallestValidEditSize(rawWidth || 1536, rawHeight || 1024);
  return { ...params, quality: "low", size: `${small.width}x${small.height}` };
}
