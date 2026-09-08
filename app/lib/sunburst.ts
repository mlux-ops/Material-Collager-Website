/** Shared contracts and accounting for the Sunburst image API model. */

// The floating alias. It stays the stored/UI identity: node params, saved
// workflows, plan files, and cache keys all carry this value, so an old
// workflow keeps importing and a Sunburst render keeps matching a Sunburst
// cache entry across snapshot bumps.
export const SUNBURST_MODEL = "gpt-image-2.5-sunburst" as const;

// The dated snapshot actually sent upstream. Pinning it means a silent
// server-side alias bump cannot change how a board renders underneath stored
// provenance; bumping it here is a deliberate, reviewable change.
export const SUNBURST_MODEL_SNAPSHOT = "gpt-image-2.5-sunburst-2026-09-08" as const;

export const LEGACY_IMAGE_MODEL = "gpt-image-2" as const;

/**
 * Map a stored model identity onto the exact model id to put on the wire.
 *
 * Only the Sunburst alias is redirected. A caller that already holds a dated
 * snapshot (a replayed historical job, say) keeps it, and the legacy model is
 * passed through untouched.
 */
export function resolveWireModel(model: string): string {
  return model === SUNBURST_MODEL ? SUNBURST_MODEL_SNAPSHOT : model;
}

/** True for the Sunburst alias and every dated Sunburst snapshot. */
export function isSunburstModel(model: string): boolean {
  return model === SUNBURST_MODEL || model.startsWith(`${SUNBURST_MODEL}-`);
}

/**
 * Fidelity to the input images on an edit request.
 *
 * `/v1/images/edits` accepts `input_fidelity: "high" | "low"`, but the image
 * generation guide documents the parameter only under the earlier GPT Image
 * models and states that `gpt-image-2` rejects it. Whether Sunburst honours it
 * is therefore unconfirmed by the published docs, so nothing sends it by
 * default. `scripts/probe-input-fidelity.mjs` settles it against the live API
 * for one low-quality image; flip SUNBURST_DEFAULT_INPUT_FIDELITY once it does.
 */
export const SUNBURST_INPUT_FIDELITIES = ["high", "low"] as const;
export type SunburstInputFidelity = (typeof SUNBURST_INPUT_FIDELITIES)[number];
export const SUNBURST_DEFAULT_INPUT_FIDELITY: SunburstInputFidelity | undefined = undefined;

export const SUNBURST_QUALITIES = ["low", "medium", "high", "xhigh", "max", "auto"] as const;
export type SunburstQuality = (typeof SUNBURST_QUALITIES)[number];

// Workbench remains on the legacy gpt-image-2 model until Task 3. Keep its
// pre-migration quality contract separate from the broader Sunburst contract.
export const LEGACY_IMAGE_QUALITIES = ["low", "medium", "high", "auto"] as const;
export type LegacyImageQuality = (typeof LEGACY_IMAGE_QUALITIES)[number];

export function resolveLegacyImageQuality(value: unknown): LegacyImageQuality {
  return typeof value === "string" && LEGACY_IMAGE_QUALITIES.includes(value as LegacyImageQuality)
    ? value as LegacyImageQuality
    : "medium";
}

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

export const SUNBURST_BATCH_COST_MULTIPLIER = 0.5 as const;
export type SunburstBillingMode = "standard" | "batch";
export type SunburstCostOptions =
  | SunburstBillingMode
  | { mode?: SunburstBillingMode; multiplier?: number };

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
 * The API's usage detail can vary slightly between Image API and Batch
 * responses. We accept the documented token fields and a few equivalent
 * spellings, but deliberately return null when text/image input or cache
 * allocation is incomplete. A partial subtotal must never be presented as a
 * complete cost to a user.
 */
export function calculateSunburstUsageCost(usage: unknown, options: SunburstCostOptions = "standard"): number | null {
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

  const mode = typeof options === "string" ? options : options.mode ?? "standard";
  const explicitMultiplier = typeof options === "string" ? undefined : options.multiplier;
  if (mode !== "standard" && mode !== "batch") return null;
  const multiplier = explicitMultiplier ?? (mode === "batch" ? SUNBURST_BATCH_COST_MULTIPLIER : 1);
  if (!Number.isFinite(multiplier) || multiplier < 0) return null;

  const rates = SUNBURST_RATES_USD_PER_MILLION;
  const cost = (
    (textInput - resolvedCachedText) * rates.textInput
    + resolvedCachedText * rates.cachedTextInput
    + (imageInput - resolvedCachedImage) * rates.imageInput
    + resolvedCachedImage * rates.cachedImageInput
    + imageOutput * rates.imageOutput
  ) / 1_000_000 * multiplier;
  return Number.isFinite(cost) ? cost : null;
}
