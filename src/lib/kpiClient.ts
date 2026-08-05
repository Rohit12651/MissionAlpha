// B5 — Command Center client: the typed fetcher over the vite-proxied
// /runtime/bos/kpis route, plus the PURE layer the Command Center UI is actually made
// of (the tile formatter, the trend guard, the ventures empty-state selector, the query
// builder). The pure half has zero DOM and zero network so it is unit-testable under
// `node --experimental-strip-types`.
//
// Token pattern is cloned verbatim from vaultClient.ts / inboxClient.ts.
//
// HONESTY RULES ENFORCED HERE (hallmark gate 56):
//   • `tile()` renders "—" for a PENDING metric (a metric with no real store behind it)
//     and for any non-finite/impossible value — never a fabricated 0.
//   • `hasTrend()` gates deltas: a delta is shown ONLY when a real prior-window number
//     exists. v1 computes no prior window, so no delta is ever rendered — and NEVER a
//     fabricated +0%.
//   • The endpoint's decision metrics are CROSS-VENTURE (deliveries have no venture
//     column, v1). The types carry `crossVenture` so the UI can label them, not fake
//     per-venture decisions.
import { runtimeToken, runtimeUrl } from "./runtimeBase.ts";
import { normalizeVenture } from "./vaultClient.ts";

// ── wire types — mirror agent-runtime/kpis.mjs exactly ───────────────────────
export interface VentureKpi {
  id: string;
  name: string;
  /** The venture's live vault size (all-time), matching the sidebar switcher. */
  records: number;
  /** Cross-venture pending-delivery count (v1 — deliveries have no venture column). */
  pending: number;
}

/**
 * A metric value. `pending` is the signal a metric raises while it has no real store yet
 * ({value:0, pending:true} → the tile shows "—"); an absent flag means the value is
 * authoritative. No shipped metric currently raises it — the type stays because `tile()`
 * is the honesty gate every future metric goes through.
 */
export interface PendingMetric {
  value: number;
  pending?: boolean;
}

export interface Kpis {
  windowMs: number;
  since: string;
  decisionsToday: number;
  recordsWritten: number;
  deliveriesApproved: number;
  /** True in v1: decisions/approvals span every venture (no venture column). */
  crossVenture: boolean;
  pendingDeliveries: number;
  ventures: VentureKpi[];
}

// ── pure helpers ──────────────────────────────────────────────────────────────
/**
 * Format a tile value. Renders "—" when the metric is pending (no real source yet) or
 * the value is non-finite / impossible (negative) — a fabricated 0 would read as truth.
 * A real 0 renders as "0".
 */
export function tile(value: number, opts: { pending?: boolean } = {}): string {
  if (opts.pending) return "—";
  if (!Number.isFinite(value) || value < 0) return "—";
  return String(Math.floor(value));
}

/**
 * Should a delta be shown? Only when a real prior-window number exists. v1 has no prior
 * window, so this is always false and StatTiles render bare numbers — never a fake +0%.
 */
export function hasTrend(prior?: number | null): boolean {
  return typeof prior === "number" && Number.isFinite(prior);
}

/**
 * The ventures-panel empty state, or null when there is a real multi-venture list.
 *   0 ventures → an honest "seeds on first write" line (the store always seeds waahyu,
 *                so this is a belt-and-braces path, not the normal one).
 *   1 venture  → "One venture so far — <NAME>." naming the single scope.
 *   >1         → null (render the list).
 */
export function venturesEmptyState(ventures: readonly VentureKpi[]): string | null {
  if (!Array.isArray(ventures) || ventures.length === 0) return "No ventures yet — one seeds on first write.";
  if (ventures.length === 1) {
    const only = ventures[0];
    return `One venture so far — ${only.name || only.id}.`;
  }
  return null;
}

// ── query builder ─────────────────────────────────────────────────────────────
/**
 * Build the KPI request. `venture` is normalised to a slug or dropped (all-ventures);
 * `window` is validated against the server's own `<n>h|<n>d` grammar and falls back to
 * "1d" when malformed, so the client never sends a value the server would 400.
 */
export function kpiQuery(venture: string | null | undefined, window: string = "1d"): string {
  const p = new URLSearchParams();
  const v = normalizeVenture(venture);
  if (v) p.set("venture", v);
  const w = /^(\d{1,4})(h|d)$/.test(String(window).trim()) ? String(window).trim() : "1d";
  p.set("window", w);
  return `/runtime/bos/kpis?${p.toString()}`;
}

// ── fetcher (vaultClient.ts token pattern) ───────────────────────────────────
async function authedJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await runtimeToken();
  const r = await fetch(runtimeUrl(path), {
    ...init,
    cache: "no-store",
    headers: { "Content-Type": "application/json", "x-runtime-token": token, ...(init.headers || {}) },
  });
  // 400 (bad window) carries a JSON body the caller renders as an error state; every
  // other non-2xx is a transport-level failure.
  if (!r.ok && r.status !== 400) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as T;
}

/** GET /runtime/bos/kpis — the cross-venture Command Center snapshot. */
export const getKpis = (venture: string | null = null, window = "1d") =>
  authedJson<Kpis & { error?: string }>(kpiQuery(venture, window));
