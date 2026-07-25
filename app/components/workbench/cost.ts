// Deterministic client-side cost estimate for gpt-image-2 output tokens,
// validated against OpenAI's own calculator (see
// docs/workbench-node-editor-design.md §4). Input-image tokens have no
// published formula; we seed a conservative per-input estimate and then
// self-calibrate it from each run's actual
// `usage.input_tokens_details.image_tokens` (S27/AC21).

const QUALITY_FACTOR: Record<string, number> = { low: 16, medium: 48, high: 96 };
const OUTPUT_USD_PER_TOKEN = 30 / 1_000_000;
const ESTIMATED_INPUT_USD_PER_IMAGE = 0.02;

export function outputTokensFor(size: string, quality: string): number | null {
  const match = /^(\d+)x(\d+)$/.exec(size);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  const q = QUALITY_FACTOR[quality] ?? QUALITY_FACTOR.medium;
  const longest = Math.max(width, height);
  const shortest = Math.min(width, height);
  const scaled = Math.floor((2 * q * shortest + longest) / (2 * longest));
  return Math.ceil((q * scaled * (2_000_000 + width * height)) / 4_000_000);
}

// ---------------------------------------------------------------------------
// Self-calibrating input-image cost (S27, W6): a BOUNDED, versioned
// exponential moving average (EMA) of the real per-input-image USD cost,
// bucketed by (size, quality) -- a small fixed cross-product, so this record
// can never grow unbounded across sessions -- persisted to localStorage so it
// survives reload and keeps converging across sessions. On a schemaVersion
// mismatch the whole record is dropped and calibration reseeds from the flat
// ESTIMATED_INPUT_USD_PER_IMAGE seed until each bucket accrues fresh samples.
// ---------------------------------------------------------------------------

export const CALIBRATION_STORAGE_KEY = "mc.workbench.imageTokenCalibration.v1";
const CALIBRATION_SCHEMA_VERSION = 1;
// Weight given to each new sample -- low enough that one noisy run can't
// whipsaw the estimate, high enough to converge within a handful of runs.
const CALIBRATION_EMA_ALPHA = 0.2;

type CalibrationBucket = { usdPerImage: number; samples: number };

type CalibrationRecord = {
  schemaVersion: number;
  buckets: Record<string, CalibrationBucket>;
};

// Storage is injected (get/set/remove) rather than hardcoded to
// window.localStorage so this persistence path is REALLY exercised under
// Node's --experimental-strip-types test runner (no window/localStorage
// there): tests inject an in-memory adapter and verify actual EMA writes,
// bucket bounds, a simulated reload, and the schemaVersion-mismatch reset --
// not merely that the no-window no-op path doesn't throw.
export type CalibrationStorageAdapter = {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
};

const noopStorageAdapter: CalibrationStorageAdapter = {
  get: () => null,
  set: () => {},
  remove: () => {},
};

const windowLocalStorageAdapter: CalibrationStorageAdapter = {
  get: (key) => window.localStorage.getItem(key),
  set: (key, value) => window.localStorage.setItem(key, value),
  remove: (key) => window.localStorage.removeItem(key),
};

function defaultStorageAdapter(): CalibrationStorageAdapter {
  return typeof window !== "undefined" && window.localStorage ? windowLocalStorageAdapter : noopStorageAdapter;
}

let calibrationStorage: CalibrationStorageAdapter = defaultStorageAdapter();

// Injects a custom storage adapter (e.g. an in-memory Map-backed one in
// tests). Passing null/undefined restores the default window.localStorage-
// when-present/no-op-otherwise behavior.
export function setCalibrationStorageAdapter(adapter?: CalibrationStorageAdapter | null): void {
  calibrationStorage = adapter ?? defaultStorageAdapter();
}

function emptyCalibration(): CalibrationRecord {
  return { schemaVersion: CALIBRATION_SCHEMA_VERSION, buckets: {} };
}

function bucketKey(size: string, quality: string): string {
  return `${size}|${quality}`;
}

// S-10: a hand-edited or corrupted localStorage record can carry a bucket
// whose usdPerImage is non-numeric, negative, NaN, or absurdly large.
// Without validating each bucket's VALUE (schemaVersion/buckets-shape alone
// isn't enough), a corrupted entry flows straight into
// calibratedInputUsdPerImage -> estimateRunUsd, producing a NaN total
// rendered as "$NaN" on the money display and the high-cost guardrail.
// Same-origin storage means an attacker would already need XSS, so this is
// robustness rather than security -- but the calibration record directly
// feeds the money display, so corrupted buckets are dropped rather than
// trusted.
const MAX_SANE_USD_PER_IMAGE = 2;

function isValidBucket(value: unknown): value is CalibrationBucket {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<CalibrationBucket>;
  return (
    typeof candidate.usdPerImage === "number" &&
    Number.isFinite(candidate.usdPerImage) &&
    candidate.usdPerImage >= 0 &&
    candidate.usdPerImage < MAX_SANE_USD_PER_IMAGE &&
    typeof candidate.samples === "number" &&
    Number.isFinite(candidate.samples) &&
    candidate.samples >= 0
  );
}

function sanitizeBuckets(raw: Record<string, unknown>): Record<string, CalibrationBucket> {
  const clean: Record<string, CalibrationBucket> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (isValidBucket(value)) clean[key] = { usdPerImage: value.usdPerImage, samples: value.samples };
  }
  return clean;
}

function loadCalibration(): CalibrationRecord {
  try {
    const raw = calibrationStorage.get(CALIBRATION_STORAGE_KEY);
    if (!raw) return emptyCalibration();
    const parsed = JSON.parse(raw) as Partial<CalibrationRecord>;
    // Schema mismatch (or a malformed/foreign record) -- reset rather than
    // trust a shape a future version might not agree with.
    if (parsed.schemaVersion !== CALIBRATION_SCHEMA_VERSION || typeof parsed.buckets !== "object" || parsed.buckets === null) {
      return emptyCalibration();
    }
    return { schemaVersion: CALIBRATION_SCHEMA_VERSION, buckets: sanitizeBuckets(parsed.buckets as Record<string, unknown>) };
  } catch {
    return emptyCalibration();
  }
}

function saveCalibration(record: CalibrationRecord): void {
  try {
    calibrationStorage.set(CALIBRATION_STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Best-effort: a full/blocked localStorage just means calibration resets
    // to the flat seed next load instead of persisting.
  }
}

// Records one run's actual input-image cost, updating that (size, quality)
// bucket's EMA. Called after every generation-shaped run that returned usage
// details; a run with no input images or no usage detail is a no-op (nothing
// to learn from). gpt-image-2 has no published input-vs-output token price
// split, so this reuses the output per-token rate -- the calibrated bucket
// value is what actually matters, not this constant.
export function recordImageTokenCalibration(size: string, quality: string, imageTokens: number | undefined, inputImages: number): void {
  if (!imageTokens || imageTokens <= 0 || inputImages <= 0) return;
  const usdPerImage = (imageTokens * OUTPUT_USD_PER_TOKEN) / inputImages;
  const record = loadCalibration();
  const key = bucketKey(size, quality);
  const existing = record.buckets[key];
  const nextUsd = existing ? existing.usdPerImage + CALIBRATION_EMA_ALPHA * (usdPerImage - existing.usdPerImage) : usdPerImage;
  record.buckets[key] = { usdPerImage: nextUsd, samples: (existing?.samples ?? 0) + 1 };
  saveCalibration(record);
}

// issue-6: extracts the actual per-run image-token usage from a
// /api/workbench/edit response and feeds recordImageTokenCalibration --
// shared by EVERY generation-shaped execute wrapper (imageGenerate/
// imageEdit/relight via shared.tsx's executeGeneration, plus Variations/
// Masked Edit/Upscaler/Collage Board/QA Correction, which each call the
// endpoint directly rather than through executeGeneration) so every paid
// image call contributes to calibration, not just the three that happened
// to share one core.
export function recordUsageCalibration(
  size: string,
  quality: string,
  usage: Record<string, unknown> | undefined,
  inputImages: number,
): void {
  const imageTokens = (usage as { input_tokens_details?: { image_tokens?: number } } | undefined)?.input_tokens_details?.image_tokens;
  recordImageTokenCalibration(size, quality, imageTokens, inputImages);
}

function calibratedInputUsdPerImage(size: string, quality: string): number {
  const bucket = loadCalibration().buckets[bucketKey(size, quality)];
  return bucket ? bucket.usdPerImage : ESTIMATED_INPUT_USD_PER_IMAGE;
}

// Exposed for the S31 registry-integrity/calibration unit test: resets the
// persisted record back to empty (simulating a fresh install / schema reset).
export function resetImageTokenCalibrationForTests(): void {
  saveCalibration(emptyCalibration());
}

export function estimateRunUsd(options: { size: string; quality: string; candidates: number; inputImages: number }): number | null {
  const tokens = outputTokensFor(options.size, options.quality);
  if (tokens === null) return null;
  const outputUsd = tokens * OUTPUT_USD_PER_TOKEN * Math.max(1, options.candidates);
  const inputUsd = options.inputImages * calibratedInputUsdPerImage(options.size, options.quality);
  return outputUsd + inputUsd;
}

export function formatUsd(value: number): string {
  // S-10 defense in depth: loadCalibration's sanitization is the root-cause
  // fix that keeps a corrupted bucket from ever reaching here, but a
  // non-finite input must still never render as the literal "$NaN".
  if (!Number.isFinite(value)) return "$0.00";
  if (value < 0.01) return "<$0.01";
  return `$${value.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// High-cost confirm guardrail (S27/AC21): a run whose estimate crosses this
// threshold (roughly a 4K-high single-candidate render) requires the user to
// confirm before it fires the paid call.
// ---------------------------------------------------------------------------

export const HIGH_COST_CONFIRM_THRESHOLD_USD = 0.4;

export function confirmHighCost(estimateUsd: number | null): boolean {
  if (estimateUsd === null || estimateUsd < HIGH_COST_CONFIRM_THRESHOLD_USD) return true;
  if (typeof window === "undefined" || typeof window.confirm !== "function") return true;
  return window.confirm(`This run is estimated to cost ~${formatUsd(estimateUsd)}. Continue?`);
}
