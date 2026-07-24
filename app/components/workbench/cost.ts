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

function emptyCalibration(): CalibrationRecord {
  return { schemaVersion: CALIBRATION_SCHEMA_VERSION, buckets: {} };
}

function bucketKey(size: string, quality: string): string {
  return `${size}|${quality}`;
}

function loadCalibration(): CalibrationRecord {
  if (typeof window === "undefined") return emptyCalibration();
  try {
    const raw = window.localStorage.getItem(CALIBRATION_STORAGE_KEY);
    if (!raw) return emptyCalibration();
    const parsed = JSON.parse(raw) as Partial<CalibrationRecord>;
    // Schema mismatch (or a malformed/foreign record) -- reset rather than
    // trust a shape a future version might not agree with.
    if (parsed.schemaVersion !== CALIBRATION_SCHEMA_VERSION || typeof parsed.buckets !== "object" || parsed.buckets === null) {
      return emptyCalibration();
    }
    return { schemaVersion: CALIBRATION_SCHEMA_VERSION, buckets: parsed.buckets };
  } catch {
    return emptyCalibration();
  }
}

function saveCalibration(record: CalibrationRecord): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CALIBRATION_STORAGE_KEY, JSON.stringify(record));
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
