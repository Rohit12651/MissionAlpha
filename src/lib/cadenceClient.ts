// B4 — Cadence client: typed fetchers over the vite-proxied /runtime/cadence routes,
// plus the PURE layer the Workflows table, the Schedule timeline and the drawer are made
// of (label, status pill, relative-time, schedule bucketer, row view-model). The pure half
// has zero DOM and zero network so it is unit-testable under `node --experimental-strip-types`.
//
// Token pattern is cloned verbatim from vaultClient.ts: same same-origin runtime token,
// same x-runtime-token header, same runtimeUrl() base so it works dev-proxied AND packaged.
//
// TIME IS UTC. The stored `hour` and `next_run` are absolute UTC (the server schedules in
// UTC, drift-free); the labels here format in UTC so the display never disagrees with the
// schedule that produced it. The Schedule page notes this.

import { runtimeToken, runtimeUrl } from "./runtimeBase.ts";
import { STATIONS } from "./stationMeta.ts";

// ── the closed enum mirror (server: agent-runtime/cadence.mjs CADENCE_EXPRS) ─
export const CADENCE_EXPRS = ["daily", "weekly", "2xdaily", "ondemand"] as const;
export type CadenceExpr = (typeof CADENCE_EXPRS)[number];

/** One cadence row — mirrors agent-runtime/cadence.mjs hydrate() exactly. */
export interface Cadence {
  id: string;
  skill: string;
  agent: string;
  venture: string;
  /** The closed schedule enum; a server that ever widened it degrades to the raw string. */
  expr: CadenceExpr | string;
  /** UTC hour-of-day (0..23) the slot aligns to, or null. */
  hour: number | null;
  enabled: boolean;
  /** Absolute-UTC ms of the next scheduled fire, or null for an on-demand row. */
  next_run: number | null;
  last_run: number | null;
  last_status: string | null;
  last_fired_slot?: number | null;
}

export interface CadenceList {
  cadences: Cadence[];
}

export type PillTone = "green" | "muted" | "red" | "brass";
export interface CadenceStatus {
  label: string;
  tone: PillTone;
}

// ── station / skill labels (reuse the pinned client mirror — no drift) ──────
const SKILL_LABEL = new Map<string, string>();
const STATION_NAME = new Map<string, string>();
for (const s of STATIONS) {
  STATION_NAME.set(s.id, s.name);
  for (const sk of s.skills) SKILL_LABEL.set(sk.id, sk.label);
}

/** Title-case a `kebab-skill-id` when the catalog has no label (a new server skill). */
function titleCase(id: string): string {
  const spaced = String(id).replace(/[-_]+/g, " ").trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : id;
}

export const skillLabel = (skill: string): string => SKILL_LABEL.get(skill) ?? titleCase(skill);
export const stationName = (agent: string): string => STATION_NAME.get(agent) ?? agent;

// ── labels ───────────────────────────────────────────────────────────────────
const pad2 = (n: number): string => String(n).padStart(2, "0");
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** `07:00` for a UTC hour, or "" for a null hour. */
const hourLabel = (hour: number | null): string =>
  hour === null || hour === undefined || !Number.isFinite(hour) ? "" : `${pad2(Math.floor(hour))}:00`;

/**
 * The mono cadence label — a closed-enum rendering, NEVER a cron string:
 *   DAILY · 07:00 · WEEKLY · 2×DAILY · ON DEMAND
 */
export function cadenceLabel(c: Cadence): string {
  const h = hourLabel(c.hour);
  switch (c.expr) {
    case "daily": return h ? `DAILY · ${h}` : "DAILY";
    case "weekly": return h ? `WEEKLY · ${h}` : "WEEKLY";
    case "2xdaily": return h ? `2×DAILY · ${h}` : "2×DAILY";
    case "ondemand": return "ON DEMAND";
    default: return String(c.expr).toUpperCase();
  }
}

/** The status pill: enabled state wins, then a failed last run, then dispatched vs idle. */
export function cadenceStatus(c: Cadence): CadenceStatus {
  if (!c.enabled) return { label: "Paused", tone: "muted" };
  if (c.last_status === "error") return { label: "Failed", tone: "red" };
  if (c.last_status === "dispatched") return { label: "Active", tone: "green" };
  return { label: "Idle", tone: "brass" };
}

/** Relative future label for a next-run stamp. Null = an on-demand cadence. */
export function nextRunLabel(nextRun: number | null, now: number): string {
  if (nextRun === null || nextRun === undefined) return "on demand";
  const d = nextRun - now;
  if (d <= 0) return "due now";
  if (d < 60_000) return "under a minute";
  if (d < HOUR_MS) return `in ${Math.round(d / 60_000)}m`;
  if (d < DAY_MS) return `in ${Math.round(d / HOUR_MS)}h`;
  return `in ${Math.round(d / DAY_MS)}d`;
}

/** Relative past label for a last-run stamp. Null = it has never run. */
export function lastRunLabel(lastRun: number | null, now: number): string {
  if (lastRun === null || lastRun === undefined) return "never";
  const d = now - lastRun;
  if (d < 60_000) return "just now";
  if (d < HOUR_MS) return `${Math.round(d / 60_000)}m ago`;
  if (d < DAY_MS) return `${Math.round(d / HOUR_MS)}h ago`;
  return `${Math.round(d / DAY_MS)}d ago`;
}

// ── schedule bucketer (the Schedule timeline) ───────────────────────────────
export interface ScheduleItem {
  cadence: Cadence;
  /** absolute-UTC ms of the fire. */
  at: number;
}
export interface ScheduleBucket {
  /** UTC hour-of-day (0..23) of the fires in this bucket. */
  hour: number;
  /** `HH:00` label. */
  label: string;
  items: ScheduleItem[];
}

/**
 * The next `windowMs` (default 24h) of scheduled fires, grouped by UTC hour and kept in
 * chronological order. On-demand rows (next_run null) and fires beyond the window are
 * dropped — the Schedule page shows what the swarm will actually do, not a fabricated grid.
 */
export function scheduleBuckets(rows: Cadence[], now: number, windowMs: number = DAY_MS): ScheduleBucket[] {
  const items: ScheduleItem[] = rows
    .filter((c) => c.next_run !== null && c.next_run !== undefined && c.next_run <= now + windowMs)
    .map((c) => ({ cadence: c, at: c.next_run as number }))
    .sort((a, b) => a.at - b.at);

  const buckets: ScheduleBucket[] = [];
  for (const it of items) {
    const hour = new Date(it.at).getUTCHours();
    const last = buckets[buckets.length - 1];
    if (last && last.hour === hour) last.items.push(it);
    else buckets.push({ hour, label: `${pad2(hour)}:00`, items: [it] });
  }
  return buckets;
}

// ── row view-model (the Workflows table) ────────────────────────────────────
export interface CadenceRow {
  id: string;
  name: string;
  station: string;
  cadence: string;
  nextRun: string;
  lastRun: string;
  status: CadenceStatus;
}

export function cadenceRow(c: Cadence, now: number): CadenceRow {
  return {
    id: c.id,
    name: skillLabel(c.skill),
    station: stationName(c.agent),
    cadence: cadenceLabel(c),
    nextRun: nextRunLabel(c.next_run, now),
    lastRun: lastRunLabel(c.last_run, now),
    status: cadenceStatus(c),
  };
}

// ── fetchers (vaultClient.ts token pattern) ─────────────────────────────────
async function authedJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await runtimeToken();
  const r = await fetch(runtimeUrl(path), {
    ...init,
    cache: "no-store",
    headers: { "Content-Type": "application/json", "x-runtime-token": token, ...(init.headers || {}) },
  });
  // 400 (bad input) and 403 (viewer) / 404 (unknown id) carry a JSON body the caller
  // renders; every other non-2xx is a transport-level failure.
  if (!r.ok && r.status !== 400 && r.status !== 403 && r.status !== 404) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as T;
}

/** GET /runtime/cadence — the full cadence list (viewer-readable). */
export const listCadences = () => authedJson<CadenceList>("/runtime/cadence");

/**
 * POST /runtime/cadence/run — approver-gated Run-now. A viewer gets 403 with a readable
 * body, which the caller surfaces rather than pretending the run happened. The dispatch
 * identity (agent/skill) is set server-side from the seeded row — never a parameter here.
 */
export const runCadence = (id: string) =>
  authedJson<{ taskId?: string; deduped?: boolean; error?: string }>("/runtime/cadence/run", {
    method: "POST",
    body: JSON.stringify({ id }),
  });

/** POST /runtime/cadence/toggle — approver-gated pause/resume. */
export const toggleCadence = (id: string, enabled: boolean) =>
  authedJson<{ cadence?: Cadence; error?: string }>("/runtime/cadence/toggle", {
    method: "POST",
    body: JSON.stringify({ id, enabled }),
  });
