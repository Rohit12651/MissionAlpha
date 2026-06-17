/**
 * Relative-time formatter for feed rows + scheduler tick age. Counts up against
 * a "now" epoch (pass useTick()) so ages tick smoothly between the 2s polls.
 * "just now" < 5s · "8s ago" · "3m ago" · "2h ago" · "4d ago". Returns "—" for
 * unparseable / missing timestamps (the live heartbeats array contains a junk
 * "#" sentinel row — this guards it).
 */
export function formatRelative(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const sec = Math.max(0, Math.floor((nowMs - t) / 1000));
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

/** Compact age (no "ago") for tight chips, e.g. the scheduler "ticked Ns ago". */
export function compactAge(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const sec = Math.max(0, Math.floor((nowMs - t) / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}
