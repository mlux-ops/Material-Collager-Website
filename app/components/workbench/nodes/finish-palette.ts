type Channels = readonly [number, number, number];

export interface FinishTone {
  hex: string;
  lab: Channels;
}

export function finishTone(red: number, green: number, blue: number): FinishTone {
  const rgb = [red, green, blue].map(Math.round);
  const [r, g, b] = rgb.map((channel) => {
    const s = channel / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  // Linear sRGB → Oklab, following CSS Color 4's D65 conversion.
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    hex: "#" + rgb.map((c) => c.toString(16).padStart(2, "0")).join("").toUpperCase(),
    lab: [
      0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    ],
  };
}

function distance(a: FinishTone, b: FinishTone) {
  return Math.hypot(a.lab[0] - b.lab[0], a.lab[1] - b.lab[1], a.lab[2] - b.lab[2]);
}

/** Sample the interior of the photo, skipping its matte/frame and transparent pixels. */
export function extractFinishPalette(pixels: Uint8ClampedArray, width: number, height: number): FinishTone[] {
  const bins = new Map<number, { count: number; red: number; green: number; blue: number }>();
  const insetX = Math.floor(width / 8);
  const insetY = Math.floor(height / 8);
  for (let y = insetY; y < height - insetY; y++) {
    for (let x = insetX; x < width - insetX; x++) {
      const i = 4 * (y * width + x);
      if (pixels[i + 3] < 192) continue;
      const [r, g, b] = [pixels[i], pixels[i + 1], pixels[i + 2]];
      const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
      const bin = bins.get(key) ?? { count: 0, red: 0, green: 0, blue: 0 };
      bin.count++;
      bin.red += r;
      bin.green += g;
      bin.blue += b;
      bins.set(key, bin);
    }
  }
  const tones: FinishTone[] = [];
  for (const bin of [...bins.values()].sort((a, b) => b.count - a.count)) {
    const color = finishTone(bin.red / bin.count, bin.green / bin.count, bin.blue / bin.count);
    if (tones.every((tone) => distance(tone, color) > 0.055)) tones.push(color);
    if (tones.length === 6) break;
  }
  return tones;
}

export function paletteDistance(tones: FinishTone[], pins: FinishTone[]) {
  if (!pins.length) return 0;
  if (!tones.length) return Infinity;
  return pins.reduce((sum, pin) => sum + Math.min(...tones.map((tone) => distance(pin, tone))), 0);
}

export function toggleFinishPin(pins: FinishTone[], tone: FinishTone) {
  if (pins.some((pin) => pin.hex === tone.hex)) return pins.filter((pin) => pin.hex !== tone.hex);
  return [...pins.slice(0, 1), tone];
}
