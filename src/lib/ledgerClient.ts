// PHASE 6 — the agent-ledger client, plus the PURE display layer the table is made of.
//
// The pure half has zero DOM and zero network so it is unit-testable under
// `node --experimental-strip-types`. Token pattern cloned verbatim from kpiClient.ts.
//
// THE HONESTY RULE LIVES ON BOTH SIDES. The runtime already refuses to compute a rate
// below 5 decisions (`approvalRate: null`, `rated: false`). `rateLabel()` refuses a second
// time on the client, so a future payload that regressed — or a hand-rolled response —
// still cannot put a fabricated percentage on screen. Follows the RiskChip / ADR-053
// `unrated` precedent: "insufficient data" is a DISPLAY state, never a stored value.
import { runtimeToken, runtimeUrl } from "./runtimeBase.ts";

/** Mirrors agent-runtime/agent-ledger.mjs exactly. */
export interface AgentLedgerRow {
  agentId: string;
  delivered: number;
  approved: number;
  autoApproved: number;
  rejected: number;
  changesRequested: number;
  expired: number;
  pending: number;
  failures: number;
  /** Terminal rows that judged the WORK. Excludes pending, expired and failure rows. */
  decisions: number;
  /** 0..1, or null when `decisions < minDecisionsForRate`. NEVER 0 as a stand-in. */
  approvalRate: number | null;
  rated: boolean;
  /** Median createdAt→decidedAt in ms, or null when nothing was decided. */
  medianDecisionMs: number | null;
}

export interface AgentLedger {
  windowMs: number;
  since: string;
  minDecisionsForRate: number;
  agents: AgentLedgerRow[];
  error?: string;
}

/** The windows the UI offers. Anything else is a client bug and the route 400s. */
export const LEDGER_WINDOWS = ["24h", "7d", "30d"] as const;
export type LedgerWindow = (typeof LEDGER_WINDOWS)[number];

export const INSUFFICIENT_DATA = "insufficient data";

/**
 * The approval rate as text. Returns the honest label — never a percentage — whenever the
 * runtime declined to rate the agent, and also whenever the number itself is not a real
 * finite value in 0..1. Belt and braces on purpose: this is the one string in the feature
 * that a reader will act on.
 */
export function rateLabel(row: Pick<AgentLedgerRow, "approvalRate" | "rated">): string {
  if (!row.rated) return INSUFFICIENT_DATA;
  const r = row.approvalRate;
  if (typeof r !== "number" || !Number.isFinite(r) || r < 0 || r > 1) return INSUFFICIENT_DATA;
  return `${Math.round(r * 100)}%`;
}

/** Coarse tone for the rate cell. Unrated is neutral — it is an absence, not a warning. */
export function rateTone(row: Pick<AgentLedgerRow, "approvalRate" | "rated">): "good" | "warn" | "bad" | "muted" {
  if (!row.rated || typeof row.approvalRate !== "number") return "muted";
  if (row.approvalRate >= 0.8) return "good";
  if (row.approvalRate >= 0.5) return "warn";
  return "bad";
}

/** A duration a human reads at a glance. Null in, "—" out — never "0ms". */
export function durationLabel(ms: number | null): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return "<1s";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = ms / 3_600_000;
  if (h < 24) return `${h < 10 ? h.toFixed(1).replace(/\.0$/, "") : Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

export type LedgerSort = "delivered" | "approvalRate" | "failures" | "medianDecisionMs";

/**
 * Sort for the table. Immutable (returns a new array).
 *
 * UNRATED ROWS ALWAYS SINK when sorting by rate, in BOTH directions. Treating a null as
 * 0 would rank an agent with no data alongside an agent that genuinely fails, which is
 * the same fabrication the label refuses — just expressed as position instead of text.
 */
export function sortLedger(rows: AgentLedgerRow[], key: LedgerSort, dir: "asc" | "desc" = "desc"): AgentLedgerRow[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    const aNull = typeof av !== "number";
    const bNull = typeof bv !== "number";
    if (aNull && bNull) return a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0;
    if (aNull) return 1;
    if (bNull) return -1;
    if (av === bv) return a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0;
    return (av as number) < (bv as number) ? -sign : sign;
  });
}

async function authedJson<T>(path: string): Promise<T> {
  const token = await runtimeToken();
  const r = await fetch(runtimeUrl(path), {
    cache: "no-store",
    headers: { "Content-Type": "application/json", "x-runtime-token": token },
  });
  if (!r.ok && r.status !== 400) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as T;
}

export const getAgentLedger = (window: LedgerWindow = "7d") =>
  authedJson<AgentLedger>(`/runtime/agent-ledger?window=${encodeURIComponent(window)}`);

// ── PHASE 7 — metered spend ───────────────────────────────────────────────────
//
// Mirrors agent-runtime/spend.mjs. The rule the types themselves carry: `usd` is
// `number | null`, and null means "no price" — NOT zero. A subscription account never
// produces a row, so it can never contribute to a total.

export interface AgentSpend {
  agentId: string;
  meteredTurns: number;
  unpricedTurns: number;
  usd: number | null;
}

export interface SpendSummary {
  since: string;
  windowMs: number;
  usd: number | null;
  meteredTurns: number;
  unpricedTurns: number;
  /** True when metered turns arrived with no figure — the UI MUST caveat the total. */
  mixed: boolean;
  /** Whether the ACTIVE account bills per token. Drives the empty state's wording. */
  activeMetered: boolean;
  agents: AgentSpend[];
  error?: string;
}

/** What an unmetered account shows instead of a number. Mirrors spend.mjs. */
export const SUBSCRIPTION_LABEL = "included";

/**
 * The spend cell for one agent.
 *
 * `metered` is a fact about the account active RIGHT NOW — not about the window being
 * displayed. It decides the EMPTY-STATE wording and nothing else.
 *
 * CODE-REVIEW HIGH, and the correction matters. This used to return "included" whenever
 * `metered` was false, before even looking at the row. But spend.mjs aggregates real
 * historical rows, and every one of them is by construction from an api_key account (the
 * table's CHECK makes an unmetered row impossible to write). So an operator who spent
 * $12.34 on an API account this week and then switched to a subscription saw the whole
 * week relabelled "included" — a false statement about the period, which is the very
 * thing this phase exists to prevent, merely inverted. Real metered turns always show
 * their real figure; only a row with NO metered turns takes its wording from the account.
 */
export function spendCell(row: AgentSpend | undefined, metered: boolean): string {
  if (!row || row.meteredTurns === 0) return metered ? "—" : SUBSCRIPTION_LABEL;
  const usd = row.usd;
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0) return "not reported";
  if (usd > 0 && usd < 1) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export const getSpend = (window: LedgerWindow = "7d") =>
  authedJson<SpendSummary>(`/runtime/spend?window=${encodeURIComponent(window)}`);
