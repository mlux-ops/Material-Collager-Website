// Deterministic client-side cost estimate for gpt-image-2 output tokens,
// validated against OpenAI's own calculator (see
// docs/workbench-node-editor-design.md §4). Input-image tokens have no
// published formula; we show a conservative per-input estimate and let the
// node display actuals from `usage` after each run.

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

export function estimateRunUsd(options: { size: string; quality: string; candidates: number; inputImages: number }): number | null {
  const tokens = outputTokensFor(options.size, options.quality);
  if (tokens === null) return null;
  const outputUsd = tokens * OUTPUT_USD_PER_TOKEN * Math.max(1, options.candidates);
  const inputUsd = options.inputImages * ESTIMATED_INPUT_USD_PER_IMAGE;
  return outputUsd + inputUsd;
}

export function formatUsd(value: number): string {
  if (value < 0.01) return "<$0.01";
  return `$${value.toFixed(2)}`;
}
