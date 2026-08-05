// B3 — CEO brief client: typed fetchers over the vite-proxied /runtime/captain/route
// and /runtime/brief/log, plus the PURE layer the brief UI is actually made of (the
// event→row mapper, the pill table, the dedupe/prepend reducer, the "last brief"
// label). The pure half has zero DOM and zero network so it is unit-testable under
// `node --experimental-strip-types`.
//
// Token pattern is cloned verbatim from vaultClient.ts / inboxClient.ts: same
// same-origin runtime token, same x-runtime-token header, same runtimeUrl() base so it
// works dev-proxied AND packaged.
//
// HONESTY RULES ENFORCED HERE:
//   • The routing is a DETERMINISTIC KEYWORD TABLE server-side (agent-runtime/captain.mjs).
//     Nothing in this file calls it a classification, and `matched` — the keyword that
//     decided it — is carried through to the UI so the BOSS can see the actual reason.
//   • A `vault.written` bus frame is IDENTITY ONLY by design (ADR-055): it carries no
//     title and no body. So the row this file builds from one says exactly that — it
//     never invents a headline the runtime did not send.
//   • Anything outside the closed brief catalog maps to `null` and is DROPPED, so a
//     future bus name cannot appear on the brief with a guessed pill.
import { runtimeToken, runtimeUrl } from "./runtimeBase.ts";

/** Client mirror of agent-runtime/server.mjs BRIEF_EVENT_NAMES. Pinned by a unit test. */
export const BRIEF_LOG_NAMES = [
  "vault.written",
  "task.queued",
  "task.done",
  "task.failed",
  "delivery.created",
  "delivery.decided",
] as const;
export type BriefLogName = (typeof BRIEF_LOG_NAMES)[number];

/** Client mirror of agent-runtime/captain.mjs MAX_CAPTAIN_TEXT. Pinned by a unit test. */
export const MAX_CAPTAIN_TEXT = 2000;
/** Client mirror of the server's brief-log ceiling + default window. */
export const MAX_BRIEF_HOURS = 168;
export const DEFAULT_BRIEF_HOURS = 24;
/** How many rows the log keeps in memory once live frames start prepending. */
export const BRIEF_ROW_CAP = 100;

/** The four states a brief row can be in. Closed set — no fallback pill. */
export type BriefPill = "logged" | "completed" | "needs-review" | "failed";

/** Which pill each catalog name carries. The SINGLE source for that mapping. */
export const PILL_BY_EVENT: Record<BriefLogName, BriefPill> = {
  "vault.written": "logged",
  "task.queued": "logged",
  "task.done": "completed",
  "task.failed": "failed",
  "delivery.created": "needs-review",
  "delivery.decided": "completed",
};

export const PILL_LABEL: Record<BriefPill, string> = {
  logged: "Logged",
  completed: "Completed",
  "needs-review": "Needs review",
  failed: "Failed",
};

/** helm-chip data-tone per pill. `logged` takes the default (muted) tone. */
export const PILL_TONE: Record<BriefPill, string | undefined> = {
  logged: undefined,
  completed: "green",
  "needs-review": "amber",
  failed: "red",
};

// ── wire types ──────────────────────────────────────────────────────────────
/** One row of GET /runtime/brief/log. */
export interface BriefEvent {
  seq: number;
  name: string;
  ts: string;
  data: Record<string, unknown>;
}

export interface BriefLog {
  hours: number;
  events: BriefEvent[];
}

/** POST /runtime/captain/route — the routing verdict. */
export interface CaptainRouted {
  agentId: string;
  /** The keyword that decided the route, or null when the Captain kept it. */
  matched: string | null;
  recordId: string;
  taskId: string;
  goalId?: string | null;
  error?: string;
}

/** A rendered line of the agent log. */
export interface LogRow {
  /** `${name}|${identity}` — stable across the fetched ⇄ live boundary, so the same
   *  event never appears twice however it arrived. */
  key: string;
  /** The monotonic events_log seq, or null for a client-side optimistic row. */
  seq: number | null;
  /** Brass tag: the agent, the author, or the decider — whoever the frame names. */
  agent: string;
  title: string;
  /** Meta line, left half: the node / task kind / delivery kind. */
  kind: string;
  /** Meta line, right half — only `vault.written` carries a venture. */
  venture: string | null;
  pill: BriefPill;
  ts: string;
  /** Set only for a `delivery.created` row — what the needs-review pill deep-links to. */
  deliveryId: string | null;
}

// ── pure helpers ────────────────────────────────────────────────────────────
const str = (v: unknown): string => (typeof v === "string" && v.trim() ? v.trim() : "");
const isBriefName = (n: string): n is BriefLogName => (BRIEF_LOG_NAMES as readonly string[]).includes(n);

/** The identity that dedupes a row: whatever stable id the frame carries. */
function identityOf(name: BriefLogName, d: Record<string, unknown>): string {
  if (name === "vault.written") return str(d.id);
  if (name === "delivery.created" || name === "delivery.decided") return str(d.id);
  return str(d.taskId);
}

/**
 * One bus frame (fetched OR live) → one renderable row, or null when the name is
 * outside the closed brief catalog.
 *
 * `ts` falls back to `nowMs` because a LIVE frame from the SSE hook carries no
 * timestamp (RuntimeEvent is `{name, data}` only) — the arrival instant is then the
 * honest stamp, and the authoritative one replaces it on the next read.
 */
export function logRow(
  evt: { name: string; data?: Record<string, unknown> | null; seq?: number | null; ts?: string | null },
  nowMs: number = Date.now(),
): LogRow | null {
  const name = typeof evt?.name === "string" ? evt.name : "";
  if (!isBriefName(name)) return null;
  const d = evt.data && typeof evt.data === "object" ? evt.data : {};
  const seq = typeof evt.seq === "number" && Number.isFinite(evt.seq) ? Math.floor(evt.seq) : null;
  const parsed = typeof evt.ts === "string" ? Date.parse(evt.ts) : NaN;
  const ts = Number.isNaN(parsed) ? new Date(nowMs).toISOString() : (evt.ts as string);

  // "—" rather than a guessed name: an agent the frame did not carry is unknown, and
  // saying so is cheaper than inventing an actor.
  const agent = str(d.agent) || str(d.agentId) || str(d.by) || "—";
  const identity = identityOf(name, d);
  const key = `${name}|${identity || (seq !== null ? `seq${seq}` : ts)}`;

  const base = { key, seq, agent, venture: null as string | null, pill: PILL_BY_EVENT[name], ts, deliveryId: null as string | null };

  switch (name) {
    case "vault.written":
      // Identity-only frame (ADR-055) — there is no title on the wire, so the row says
      // what actually happened instead of fabricating a headline.
      return { ...base, title: "Wrote to shared memory", kind: str(d.node) || "record", venture: str(d.venture) || null };
    case "task.queued":
      return { ...base, title: "Task queued", kind: str(d.priority) ? `${str(d.priority)} priority` : "task" };
    case "task.done":
      return { ...base, title: "Task finished", kind: "task" };
    case "task.failed":
      return { ...base, title: "Task failed", kind: str(d.kind) || "task" };
    case "delivery.created":
      return { ...base, title: str(d.title) || "Delivery awaiting your decision", kind: str(d.kind) || "delivery", deliveryId: str(d.id) || null };
    case "delivery.decided":
      return { ...base, title: `Delivery ${str(d.status) || "decided"}`, kind: "decision" };
  }
}

/** A whole fetched page → rows, newest-first order preserved, unknown names dropped. */
export function logRows(events: readonly BriefEvent[] | null | undefined, nowMs: number = Date.now()): LogRow[] {
  if (!Array.isArray(events)) return [];
  const out: LogRow[] = [];
  const seen = new Set<string>();
  for (const e of events) {
    const row = logRow(e, nowMs);
    if (!row || seen.has(row.key)) continue;
    seen.add(row.key);
    out.push(row);
  }
  return out;
}

/**
 * Prepend a live row. DEDUPE IS FIRST-WRITE-WINS on `key`: the log is append-only
 * history, so an identity already on it is not re-added — which is also what keeps an
 * optimistic row (which carries the operator's actual words) from being flattened by
 * the identity-only bus frame that follows it a few milliseconds later.
 */
export function prependRow(rows: readonly LogRow[], row: LogRow | null, cap: number = BRIEF_ROW_CAP): LogRow[] {
  if (!row) return rows as LogRow[];
  if (rows.some((r) => r.key === row.key)) return rows as LogRow[];
  return [row, ...rows].slice(0, Math.max(1, cap));
}

/**
 * The optimistic row for an order the Captain just routed. It is keyed on the
 * `vault.written` identity the runtime just minted, so the authoritative frame arriving
 * moments later is recognised as the SAME event rather than duplicating this line.
 */
export function routedRow(r: CaptainRouted, text: string, nowMs: number = Date.now()): LogRow {
  const matched = str(r.matched);
  return {
    key: `vault.written|${str(r.recordId)}`,
    seq: null,
    agent: str(r.agentId) || "—",
    title: str(text).slice(0, 80) || "Order routed",
    // The reason is the keyword, stated plainly — never dressed up as a classification.
    kind: matched ? `routed on “${matched}”` : "kept by the Captain",
    venture: null,
    pill: "logged",
    ts: new Date(nowMs).toISOString(),
    deliveryId: null,
  };
}

/** `3m ago` for the newest row, or an honest `—` when there is nothing to report. */
export function lastBriefLabel(rows: readonly LogRow[] | null | undefined, nowMs: number = Date.now()): string {
  if (!Array.isArray(rows) || rows.length === 0) return "—";
  let newest = -Infinity;
  for (const r of rows) {
    const t = Date.parse(r.ts);
    if (!Number.isNaN(t) && t > newest) newest = t;
  }
  if (newest === -Infinity) return "—";
  const sec = Math.max(0, Math.floor((nowMs - newest) / 1000));
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

/** Clamp a caller's window the same way the server does, so we never send a value it reshapes. */
export function briefLogQuery(hours: number = DEFAULT_BRIEF_HOURS): string {
  const n = Number(hours);
  const asked = Number.isFinite(n) ? Math.floor(n) : DEFAULT_BRIEF_HOURS;
  return `/runtime/brief/log?hours=${Math.min(Math.max(asked, 1), MAX_BRIEF_HOURS)}`;
}

// ── fetchers (vaultClient.ts token pattern) ─────────────────────────────────
async function authedJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await runtimeToken();
  const r = await fetch(runtimeUrl(path), {
    ...init,
    cache: "no-store",
    headers: { "Content-Type": "application/json", "x-runtime-token": token, ...(init.headers || {}) },
  });
  // 400 (empty / oversize order) and 403 (viewer) carry a JSON body the caller renders;
  // every other non-2xx is a transport-level failure.
  if (!r.ok && r.status !== 400 && r.status !== 403) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as T;
}

export const getBriefLog = (hours: number = DEFAULT_BRIEF_HOURS) => authedJson<BriefLog>(briefLogQuery(hours));

/**
 * POST /runtime/captain/route. Approver-gated server-side when auth is active — a
 * viewer gets 403 with a readable body, which the caller SURFACES rather than
 * pretending the order was given. The AUTHOR is set server-side from the session and is
 * deliberately not a parameter here.
 */
export const routeCaptain = (text: string) =>
  authedJson<CaptainRouted>("/runtime/captain/route", { method: "POST", body: JSON.stringify({ text }) });
