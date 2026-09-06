/**
 * Clamps a number to a range [min, max].
 * If min > max, swaps them. If n is NaN, returns min.
 */
export function clamp(n: number, min: number, max: number): number {
  if (min > max) {
    [min, max] = [max, min];
  }
  if (Number.isNaN(n)) {
    return min;
  }
  return Math.min(max, Math.max(min, n));
}
