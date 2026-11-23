/** A leftward or upward pull opens the booklet around its lower-right pivot. */
export function fanPull(x: number, y: number) {
  return -x - y * 0.45;
}

export function fanOpening(initial: number, distance: number, travel: number) {
  return Math.max(0, Math.min(1, initial + distance / travel));
}

export function isFanFlick(distance: number, elapsed: number) {
  return distance >= 8 && elapsed > 0 && distance / elapsed >= 0.65;
}
