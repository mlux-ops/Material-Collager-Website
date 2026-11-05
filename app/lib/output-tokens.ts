/**
 * A learned lookup of Sunburst's output-token count, keyed by exactly the
 * three things it depends on.
 *
 * Sunburst publishes no output-token formula, and the two data points we have
 * across sizes do not fit a clean law -- pixels grow 2.34x between 1536x1024
 * and 2560x1440 at `max` while tokens grow only 1.34x. Fitting a curve to that
 * would produce a guess wearing a decimal point, which is what the old
 * gpt-image-2 QUALITY_FACTOR table turned into once the model changed.
 *
 * What the measurements do show is that the count is *exactly* deterministic:
 * 18 renders at 1536x1024 `low`, spread across different boards, runs and
 * days, all reported 158 output tokens. Same for every other combination
 * observed. So no model is needed. Record what a completed render actually
 * reported, and reuse it for the next render with the same (model, size,
 * quality). That is correct by construction rather than approximately right,
 * needs no calibration, and cannot drift.
 *
 * A combination never rendered has no entry, and callers must present that as
 * unavailable rather than substituting a neighbour. The table fills itself as
 * work happens.
 *
 * The model is part of the key on purpose: a model bump (2.5 -> 2.6
 * Sunburst) or a pinned snapshot bump is exactly the event that would
 * invalidate every recorded count, and keying by it makes
 * the old entries fall out of use instead of quietly misreporting.
 *
 * An optional fourth part, the render VARIANT, separates requests whose output
 * is not the plain raster image the three-part key was learned from: SVG
 * output, an animated GIF (keyed with its frame count, since every frame is
 * output), and a non-default 2.6 `complexity`. Complexity has no separate fee,
 * but whether its planning changes the reported output count is unverified;
 * without its own key, one `low` run would overwrite the default entry
 * ("later observation wins") and misprice every default run after it. Unset
 * and "high" are the same request (high is the API default), so they keep the
 * three-part key and every entry recorded before complexity existed stays
 * valid -- including the autoboard writer, which never sets a variant.
 */

import { SUNBURST_RATES_USD_PER_MILLION } from "./sunburst.ts";

export type OutputTokenTable = Record<string, number>;

/** An observation only counts when all three key parts and a count are known. */
export type OutputTokenObservation = {
  model?: string | null;
  size?: string | null;
  quality?: string | null;
  // See outputTokenVariant; empty/absent for a default raster render.
  variant?: string | null;
  outputTokens?: number | null;
};

export function outputTokenKey(model: string, size: string, quality: string, variant?: string | null): string {
  const base = `${model}|${size}|${quality}`;
  return variant ? `${base}|${variant}` : base;
}

/**
 * The variant part of a render's key, from its params. "" for a default
 * raster render (png/jpeg/webp at the default complexity).
 */
export function outputTokenVariant(params: {
  complexity?: unknown;
  outputFormat?: unknown;
  frameCount?: unknown;
}): string {
  const parts: string[] = [];
  if (params.complexity === "low" || params.complexity === "medium") parts.push(`complexity=${params.complexity}`);
  if (params.outputFormat === "svg") parts.push("svg");
  if (params.outputFormat === "gif") {
    const frames = typeof params.frameCount === "number" && Number.isInteger(params.frameCount) ? params.frameCount : 9;
    parts.push(`gif=${frames}`);
  }
  return parts.join(",");
}

/** Pull the image-output token count out of a raw OpenAI usage block. */
export function outputTokensFromUsage(usage: unknown): number | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const record = usage as Record<string, unknown>;
  const details = record.output_tokens_details;
  const nested = details && typeof details === "object"
    ? (details as Record<string, unknown>).image_tokens
    : undefined;
  // Image models report their image output in output_tokens on the Image API,
  // so the nested detail is preferred but the flat total is a valid fallback.
  for (const value of [nested, record.output_tokens]) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  }
  return undefined;
}

/**
 * Fold one completed render into the table, returning whether it changed.
 *
 * A later observation wins. The counts are deterministic, so a differing value
 * means the upstream behaviour changed rather than that this sample is noise,
 * and the newer number is the one worth keeping.
 */
export function recordOutputTokens(table: OutputTokenTable, observation: OutputTokenObservation): boolean {
  const { model, size, quality, variant, outputTokens } = observation;
  if (!model || !size || !quality) return false;
  if (typeof outputTokens !== "number" || !Number.isFinite(outputTokens) || outputTokens <= 0) return false;
  const key = outputTokenKey(model, size, quality, variant);
  if (table[key] === outputTokens) return false;
  table[key] = outputTokens;
  return true;
}

/** The observed count, or undefined when this combination has never rendered. */
export function lookupOutputTokens(
  table: OutputTokenTable,
  model: string | null | undefined,
  size: string | null | undefined,
  quality: string | null | undefined,
  variant?: string | null,
): number | undefined {
  if (!model || !size || !quality) return undefined;
  return table[outputTokenKey(model, size, quality, variant)];
}

export function outputTokensToUsd(tokens: number): number {
  return tokens * SUNBURST_RATES_USD_PER_MILLION.imageOutput / 1_000_000;
}

/**
 * Output-token cost for a planned render, or null when unknown.
 *
 * Output only. Image input dominates a board's bill and depends on the
 * reference set, so a caller must label this as the output share rather than
 * presenting it as the render's total.
 */
export function estimateOutputUsd(
  table: OutputTokenTable,
  options: { model?: string | null; size?: string | null; quality?: string | null; variant?: string | null; count?: number },
): number | null {
  const tokens = lookupOutputTokens(table, options.model, options.size, options.quality, options.variant);
  if (tokens === undefined) return null;
  const count = options.count ?? 1;
  if (!Number.isInteger(count) || count < 1) return null;
  return outputTokensToUsd(tokens) * count;
}
