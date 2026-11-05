/** Shared contracts and accounting for the Sunburst image API model. */

// The only image model the site renders with. It is both the stored/UI
// identity (node params, saved workflows, plan files, cache keys) and the id
// put on the wire: OpenAI lists no dated snapshot for gpt-image-2.6-sunburst
// (2026-11-04), only this alias, so there is nothing to pin. If a dated
// snapshot appears later, pin it in resolveWireModel, not here.
export const SUNBURST_MODEL = "gpt-image-2.6-sunburst" as const;

// The one exception: the Workbench's "Test" node renders on the previous
// Sunburst, pinned to the dated snapshot the site sent until 2026-11-04 (its
// input_fidelity behaviour was verified live on 2026-09-08, see below). Only
// this exact dated id survives on the wire. The bare 2.5 alias
// ("gpt-image-2.5-sunburst"), which is what stale tabs and saved workflows
// carry, still becomes SUNBURST_MODEL, so nothing reaches 2.5 by accident.
export const TEST_MODEL_2_5 = "gpt-image-2.5-sunburst-2026-09-08" as const;

export type AllowedImageModel = typeof SUNBURST_MODEL | typeof TEST_MODEL_2_5;

/**
 * Map any stored or requested model identity onto the exact model id to put
 * on the wire. TEST_MODEL_2_5 (the Test node) is passed through; every other
 * value -- gpt-image-2, the bare gpt-image-2.5-sunburst alias, other dated
 * snapshots, any flare id, an empty string, garbage -- becomes SUNBURST_MODEL.
 * A stale tab, an old saved workflow or a replayed job can therefore never
 * send a retired model upstream.
 */
export function resolveWireModel(model: unknown): AllowedImageModel {
  return model === TEST_MODEL_2_5 ? TEST_MODEL_2_5 : SUNBURST_MODEL;
}

/**
 * Map a stored model value (a node param, a plan file, an imported workflow)
 * onto the current identity, for use on load/import. TEST_MODEL_2_5 is kept so
 * a saved Test node keeps rendering on 2.5. Legacy values -- gpt-image-2, the
 * bare 2.5 alias, any other snapshot -- become SUNBURST_MODEL, so a signature
 * or cache key computed from the normalized params no longer matches a run
 * rendered by the old model. Same answer as resolveWireModel; kept separate
 * because the two answer different questions (what to store vs. what to send)
 * and may diverge if a 2.6 snapshot is pinned.
 */
export function normalizeStoredModel(value: unknown): AllowedImageModel {
  return value === TEST_MODEL_2_5 ? TEST_MODEL_2_5 : SUNBURST_MODEL;
}

/**
 * Normalize a params record's `model` field, but only when it holds an
 * OpenAI image-model id (`gpt-image-*`). Text-model params (the AI Assistant's
 * `gpt-5.4-mini`, a CLI node's model) are returned untouched, as is a record
 * with no string `model`. Returns the same object when nothing changes.
 */
export function normalizeImageModelParams<T extends Record<string, unknown>>(params: T): T {
  const model = params.model;
  if (typeof model !== "string" || !model.startsWith("gpt-image-")) return params;
  const normalized = normalizeStoredModel(model);
  return normalized === model ? params : { ...params, model: normalized };
}

/**
 * True for a Sunburst identity, current or historical: the 2.6 and 2.5
 * aliases and any dated snapshot of either. For reading history records and
 * accepting a stale client's request (which is then sent as SUNBURST_MODEL);
 * never for choosing what goes on the wire.
 */
export function isSunburstModel(model: string): boolean {
  return ["gpt-image-2.6-sunburst", "gpt-image-2.5-sunburst"].some(
    (alias) => model === alias || model.startsWith(`${alias}-`),
  );
}

/**
 * Sunburst does not accept `input_fidelity`. Settled against the live API on
 * 2026-09-08: `gpt-image-2.5-sunburst-2026-09-08` answers HTTP 400
 * `invalid_input_fidelity_model` -- "The model ... does not support the
 * 'input_fidelity' parameter." (request req_09bf853876cf4fbd82bf32d27daf0cba).
 *
 * The `/v1/images/edits` schema lists the field without a model restriction,
 * and the image generation guide documents it only under earlier GPT Image
 * models, so the schema alone is misleading. gpt-image-2 rejected it too.
 *
 * gpt-image-2.6-sunburst (current, 2026-11-04) does not document the field at
 * all, so it is never sent: no model this app uses takes it. Reference
 * fidelity is the model's own decision and is not available as a cost or
 * quality lever. (2.6 also adds an optional `complexity` parameter -- see
 * SUNBURST_COMPLEXITIES below -- which is a different control.)
 *
 * tests/image-efficiency.test.mjs pins that nothing ever puts it on the wire.
 */
export const SUNBURST_SUPPORTS_INPUT_FIDELITY = false as const;

/**
 * 2.6-only planning depth: how much the model plans before rendering. OpenAI
 * documents "high" as the default when the field is omitted (both 2.6
 * models), and no separate fee. The app sends it ONLY when a node sets it, so
 * an unset value keeps the API default. Documented for 2.6 only: never sent to
 * TEST_MODEL_2_5 (see modelSupports).
 */
export const SUNBURST_COMPLEXITIES = ["low", "medium", "high"] as const;
export type SunburstComplexity = (typeof SUNBURST_COMPLEXITIES)[number];

export function isSunburstComplexity(value: unknown): value is SunburstComplexity {
  return typeof value === "string" && (SUNBURST_COMPLEXITIES as readonly string[]).includes(value);
}

/**
 * Features a model may or may not take. `complexity`, SVG and animated GIF
 * output are documented for gpt-image-2.6-sunburst only; `markup` (an
 * annotation layer on edits) is documented for both 2.5 and 2.6 Sunburst.
 * Anything that is not TEST_MODEL_2_5 renders on 2.6 (resolveWireModel), so
 * it is answered as 2.6.
 */
export type SunburstFeature = "complexity" | "svg" | "gif" | "markup";

export function modelSupports(model: unknown, feature: SunburstFeature): boolean {
  if (feature === "markup") return true;
  return resolveWireModel(model) !== TEST_MODEL_2_5;
}

export const SUNBURST_QUALITIES = ["low", "medium", "high", "xhigh", "max", "auto"] as const;
export type SunburstQuality = (typeof SUNBURST_QUALITIES)[number];

// The Generator intentionally offers an explicit opaque or transparent choice.
// OpenAI's automatic background mode is not exposed as a third UI state, which
// keeps old drafts deterministic and makes the white default unambiguous.
export const SUNBURST_BACKGROUNDS = ["opaque", "transparent"] as const;
export type SunburstBackground = (typeof SUNBURST_BACKGROUNDS)[number];

export const SUNBURST_RATES_USD_PER_MILLION = {
  textInput: 5,
  cachedTextInput: 1.25,
  imageInput: 8,
  cachedImageInput: 2,
  imageOutput: 30,
} as const;

type UsageRecord = Record<string, unknown>;

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function numberFrom(record: UsageRecord | undefined, keys: string[]): number | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = finiteNumber(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function recordFrom(value: unknown): UsageRecord | undefined {
  return value && typeof value === "object" ? value as UsageRecord : undefined;
}

/**
 * Calculate a completed Sunburst request's actual token cost.
 *
 * The API's usage detail can vary slightly between responses. We accept the
 * documented token fields and a few equivalent spellings, but deliberately return null when text/image input or cache
 * allocation is incomplete. A partial subtotal must never be presented as a
 * complete cost to a user.
 */
export function calculateSunburstUsageCost(usage: unknown): number | null {
  const root = recordFrom(usage);
  if (!root) return null;
  const inputDetails = recordFrom(root.input_tokens_details ?? root.inputTokenDetails);
  const outputDetails = recordFrom(root.output_tokens_details ?? root.outputTokenDetails);

  const totalInput = numberFrom(root, ["input_tokens", "inputTokens"]);
  const imageInput = numberFrom(inputDetails, ["image_tokens", "imageTokens", "image_input_tokens", "imageInputTokens"])
    ?? numberFrom(root, ["image_input_tokens", "imageInputTokens"]);
  const explicitTextInput = numberFrom(inputDetails, ["text_tokens", "textTokens", "text_input_tokens", "textInputTokens"])
    ?? numberFrom(root, ["text_input_tokens", "textInputTokens"]);

  // Image input is explicit in the usage details. If the API omits text input
  // details, derive it only from a complete input total; otherwise accounting
  // is incomplete and stays unavailable.
  const textInput = explicitTextInput ?? (
    totalInput !== undefined && imageInput !== undefined ? totalInput - imageInput : undefined
  );
  if (imageInput === undefined || textInput === undefined || textInput < 0) return null;

  const aggregateCached = numberFrom(inputDetails, ["cached_tokens", "cachedTokens"])
    ?? numberFrom(root, ["cached_input_tokens", "cachedInputTokens"])
    ?? 0;
  const cachedText = numberFrom(inputDetails, ["cached_text_tokens", "cachedTextTokens"])
    ?? numberFrom(root, ["cached_text_input_tokens", "cachedTextInputTokens"]);
  const cachedImage = numberFrom(inputDetails, ["cached_image_tokens", "cachedImageTokens"])
    ?? numberFrom(root, ["cached_image_input_tokens", "cachedImageInputTokens"]);

  // An aggregate cache count cannot be priced without knowing which modality
  // it belongs to. Zero is safe; a non-zero incomplete split is not.
  if ((cachedText === undefined || cachedImage === undefined) && aggregateCached > 0) return null;
  const resolvedCachedText = cachedText ?? 0;
  const resolvedCachedImage = cachedImage ?? 0;
  if (resolvedCachedText > textInput || resolvedCachedImage > imageInput) return null;
  if (resolvedCachedText + resolvedCachedImage !== aggregateCached && aggregateCached > 0) return null;

  const imageOutput = numberFrom(outputDetails, ["image_tokens", "imageTokens", "image_output_tokens", "imageOutputTokens"])
    ?? numberFrom(root, ["image_output_tokens", "imageOutputTokens"])
    // Image models report output_tokens for their image output in the Image API.
    ?? numberFrom(root, ["output_tokens", "outputTokens"]);
  if (imageOutput === undefined) return null;

  const rates = SUNBURST_RATES_USD_PER_MILLION;
  const cost = (
    (textInput - resolvedCachedText) * rates.textInput
    + resolvedCachedText * rates.cachedTextInput
    + (imageInput - resolvedCachedImage) * rates.imageInput
    + resolvedCachedImage * rates.cachedImageInput
    + imageOutput * rates.imageOutput
  ) / 1_000_000;
  return Number.isFinite(cost) ? cost : null;
}
