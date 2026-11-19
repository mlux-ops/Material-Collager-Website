export const SAMPLES_PER_SPREAD = 4;

export function sampleSpread<T>(items: readonly T[], selectedIndex: number): T[] {
  const first = Math.floor(selectedIndex / SAMPLES_PER_SPREAD) * SAMPLES_PER_SPREAD;
  return items.slice(first, first + SAMPLES_PER_SPREAD);
}

/** Fit a four-up contact print and an axonometric stack into the same square. */
export function samplePose(index: number, count: number, unpack: number) {
  const t = Math.max(0, Math.min(1, unpack));
  const columns = Math.min(count, 2);
  const rows = Math.ceil(count / columns);
  const row = Math.floor(index / columns);
  const rowLength = Math.min(columns, count - row * columns);
  const flatX = (index % columns - (rowLength - 1) / 2) * 2.1;
  const flatY = ((rows - 1) / 2 - row) * 1.52;
  const level = (count - 1) / 2 - index;
  return {
    x: flatX * (1 - t) - level * 0.23 * t,
    y: flatY * (1 - t) + level * 0.93 * t,
    z: level * 0.08,
    scale: 1 + 0.12 * t,
    tilt: 0.86 * t,
    turn: -0.36 * t,
  };
}
