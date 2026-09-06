/** Returns part/whole as a percentage rounded to one decimal place, or 0 if whole is 0 or non-finite. */
export function pct(part: number, whole: number): number {
  if (!whole || !isFinite(whole)) return 0;
  return Math.round((part / whole) * 1000) / 10;
}
