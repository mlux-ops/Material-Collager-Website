/**
 * WorkingField — pure decisions behind the generator's "working" state field
 * (app/components/WorkingField.tsx): whether the Velaris gradient runs at
 * all, whether its loop plays, which seed a render job gets, and the teal
 * palette it paints with.
 *
 * Import-free on purpose so node --test can load it directly
 * (tests/working-field.test.mjs).
 */

export type WorkingFieldMode = "off" | "static" | "live";
export type WorkingFieldVariant = "track" | "pill";

/**
 * The live colour tokens this field is drawn from. They mirror the LAST
 * `:root` block in app/globals.css (the "Compact studio workspace" one, which
 * overrides the first); tests/working-field.test.mjs re-reads that file and
 * fails if these drift.
 */
export const WORKING_FIELD_TOKENS = {
  accent: "#16796b", // --accent
  accentDark: "#0c574c", // --accent-dark
  paper: "#fafafa", // --mono-off-white
  ink: "#000000", // --mono-black
} as const;

export interface WorkingFieldPalette {
  bg: string;
  colors: [string, string, string, string];
}

/** Quantization levels per channel for the field's Bayer dither. Two levels
 *  (the wordmark menu's riso setting) snaps teal to RGB primaries; six keeps
 *  the hue and still prints a visible ordered-dot texture. */
export const WORKING_FIELD_DITHER_LEVELS = 6;

/**
 * Settings → mode. Potato machine skips the decorative GPU work entirely (the
 * flat CSS fill shows instead); reduced motion keeps the field but freezes it
 * on a single frame.
 */
export function workingFieldMode(input: { potato: boolean; reduced: boolean }): WorkingFieldMode {
  if (input.potato) return "off";
  if (input.reduced) return "static";
  return "live";
}

/**
 * The one play/pause decision: a live field animates only while its tab is
 * visible AND it is on screen. A static field never loops (it holds its one
 * frame), and an off field has nothing to play.
 */
export function workingFieldPlaying(
  mode: WorkingFieldMode,
  view: { documentHidden: boolean; onscreen: boolean },
): boolean {
  return mode === "live" && !view.documentHidden && view.onscreen;
}

/**
 * Spread any number (a job counter, Math.random()) into a seed whose
 * neighbours look unrelated: consecutive integers step by the golden ratio
 * mod 1, scaled into 1..11 so no job lands on seed 0 (the vendored
 * component's unseeded default pattern).
 */
export function workingFieldSeed(value: number): number {
  const safe = Number.isFinite(value) ? value : 0;
  const frac = (((safe * 0.618033988749895) % 1) + 1) % 1;
  return 1 + frac * 10;
}

// ---------------------------------------------------------------------------
// Colour helpers (sRGB hex in, hex out).

export function hexToRgb01(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

function channelHex(value: number): string {
  const byte = Math.round(Math.min(1, Math.max(0, value)) * 255);
  return byte.toString(16).padStart(2, "0");
}

export function rgb01ToHex(rgb: [number, number, number]): string {
  return `#${channelHex(rgb[0])}${channelHex(rgb[1])}${channelHex(rgb[2])}`;
}

/** Linear blend in sRGB space, like the shader's mix(): t=0 → a, t=1 → b. */
export function mixHex(a: string, b: string, t: number): string {
  const x = hexToRgb01(a);
  const y = hexToRgb01(b);
  return rgb01ToHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
}

/** WCAG 2 relative luminance of an sRGB colour given as 0..1 channels. */
export function relativeLuminance(rgb: [number, number, number]): number {
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
}

/** WCAG contrast ratio of white text over an sRGB colour. */
export function contrastWithWhite(rgb: [number, number, number]): number {
  return 1.05 / (relativeLuminance(rgb) + 0.05);
}

/**
 * The palettes. Both are teal state drawn from --accent / --accent-dark plus
 * two neutrals (an ink-teal shadow and a paper glint).
 *
 *  - track: the progress fill. Mid teal ground so the clipped edge of the
 *    determinate span stays a crisp teal-on-paper boundary, with an
 *    occasional paper glint (slot 3 only blooms where two noise octaves
 *    agree) reading as a sheet catching light.
 *  - pill: sits under the white "WORKING" label, so it is the same family
 *    pulled darker. Slot 1 also feeds the shader's additive centre glow, so
 *    it holds the darkest tone; slot 3's paper glint is mixed most of the
 *    way to the ink-teal so no blend can lift the label's ground past AA.
 */
export function workingFieldPalette(
  variant: WorkingFieldVariant,
  tokens: { accent: string; accentDark: string; paper: string; ink: string } = WORKING_FIELD_TOKENS,
): WorkingFieldPalette {
  const inkTeal = mixHex(tokens.accentDark, tokens.ink, 0.5);
  if (variant === "pill") {
    const deep = mixHex(tokens.accentDark, tokens.ink, 0.72);
    return {
      bg: inkTeal,
      colors: [
        mixHex(tokens.accent, tokens.accentDark, 0.55),
        deep,
        tokens.accentDark,
        mixHex(tokens.paper, inkTeal, 0.86),
      ],
    };
  }
  return {
    bg: tokens.accent,
    colors: [tokens.accentDark, tokens.accent, inkTeal, tokens.paper],
  };
}

/**
 * Brightest ground the shader can put under the label for a palette, before
 * the ordered dither: any slot (or bg) plus the additive centre glow
 * (colors[1] * 0.3) plus the film grain's maximum lift (grain * 0.05).
 * Mixes of two colours are never brighter than the brighter one, so the
 * per-slot maximum bounds every blend.
 */
export function worstCaseGround(palette: WorkingFieldPalette, grain: number): [number, number, number] {
  const glow = hexToRgb01(palette.colors[1]).map((c) => c * 0.3);
  const lift = grain * 0.05;
  let worst: [number, number, number] = [0, 0, 0];
  let worstLum = -1;
  for (const hex of [palette.bg, ...palette.colors]) {
    const rgb = hexToRgb01(hex);
    const lit: [number, number, number] = [
      Math.min(1, rgb[0] + glow[0] + lift),
      Math.min(1, rgb[1] + glow[1] + lift),
      Math.min(1, rgb[2] + glow[2] + lift),
    ];
    const lum = relativeLuminance(lit);
    if (lum > worstLum) {
      worstLum = lum;
      worst = lit;
    }
  }
  return worst;
}
