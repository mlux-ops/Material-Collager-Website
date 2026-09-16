export const QUALITY_OPTIONS = ["auto", "low", "medium", "high", "xhigh", "max"] as const;
export type Quality = (typeof QUALITY_OPTIONS)[number];

export const BACKGROUND_OPTIONS = ["auto", "opaque", "transparent"] as const;
export type Background = (typeof BACKGROUND_OPTIONS)[number];

export const MODEL_FLARE = "gpt-image-2.5-flare" as const;
export const MODEL_SUNBURST = "gpt-image-2.5-sunburst" as const;

export type ModelId = typeof MODEL_FLARE | typeof MODEL_SUNBURST;

export interface SizeClassification {
  size: string;
  width: number;
  height: number;
  pixels: number;
  legal: boolean;
  experimental: boolean;
  reasons: string[];
}

export function classifySize(size: string): SizeClassification {
  const reasons: string[] = [];
  let width = 0;
  let height = 0;
  let pixels = 0;

  const parts = size.split("x");
  if (parts.length !== 2) {
    reasons.push("invalid format, must be WIDTHxHEIGHT");
    return {
      size,
      width: 0,
      height: 0,
      pixels: 0,
      legal: false,
      experimental: false,
      reasons,
    };
  }

  const w = parseInt(parts[0], 10);
  const h = parseInt(parts[1], 10);

  if (isNaN(w) || isNaN(h) || w <= 0 || h <= 0) {
    reasons.push("width and height must be positive integers");
    return {
      size,
      width: 0,
      height: 0,
      pixels: 0,
      legal: false,
      experimental: false,
      reasons,
    };
  }

  width = w;
  height = h;
  pixels = width * height;

  // Rule 1: each edge <= 3840
  if (width > 3840 || height > 3840) {
    reasons.push("edges must be <= 3840");
  }

  // Rule 2: both edges multiples of 16
  if (width % 16 !== 0 || height % 16 !== 0) {
    reasons.push("edges must be multiples of 16");
  }

  // Rule 3: longer:shorter ratio <= 3:1
  const longer = Math.max(width, height);
  const shorter = Math.min(width, height);
  if (longer / shorter > 3) {
    reasons.push("aspect ratio must not exceed 3:1");
  }

  // Rule 4: total pixels 655360 - 8294400 inclusive
  if (pixels < 655360 || pixels > 8294400) {
    reasons.push("pixels must be between 655360 and 8294400 inclusive");
  }

  const legal = reasons.length === 0;

  // Experimental: pixels > 3686400 (strictly greater)
  const experimental = pixels > 3686400;
  if (experimental) {
    reasons.push("above 3,686,400 px");
  }

  return {
    size,
    width,
    height,
    pixels,
    legal,
    experimental,
    reasons,
  };
}
