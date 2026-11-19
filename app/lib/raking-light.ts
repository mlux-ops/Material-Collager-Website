/** Photo-based PBR sets from Poly Haven. Local WebPs retain the source aspect ratio.
 * All three maps of a specimen come from the same 1K set.
 * Asset license: https://polyhaven.com/license (CC0). */
export const lightSamples = [
  { id: "white_oak_veneer", name: "White oak veneer" },
  { id: "marble_01", name: "Cream marble" },
  { id: "poly_wool_herringbone", name: "Wool-blend herringbone" },
] as const;

export type LightSample = typeof lightSamples[number];

export function sampleMap(sample: LightSample, map: "diffuse" | "nor_gl" | "rough") {
  return `/raking-light/${sample.id}-${map}.webp`;
}

/** Azimuth is clockwise from the top of the sample. Elevation is above its surface. */
export function lightVector(azimuth: number, elevation: number) {
  const bearing = azimuth * Math.PI / 180;
  const height = elevation * Math.PI / 180;
  return [
    Math.sin(bearing) * Math.cos(height),
    Math.cos(bearing) * Math.cos(height),
    Math.sin(height),
  ] as const;
}

export function pointToLight(x: number, y: number) {
  const radius = Math.min(1, Math.hypot(x, y));
  return {
    azimuth: (Math.round(Math.atan2(x, -y) * 180 / Math.PI) + 360) % 360,
    elevation: Math.round(80 - 70 * radius),
  };
}
