// PHASE 5 — the activity stream model. Pure, DOM-free, unit-tested.
//
// WHAT THIS IS: a CONSUMER of the SSE bus ADR-052 already fans out. No new endpoint, no
// new polling, no server change. The runtime emits `task.*`, `agent.state`, `usage.tick`,
// `delivery.created` and `delivery.decided` today; this turns them into a readable feed.
//
// THREE RULES IT ENFORCES, all learned the hard way in this codebase:
//
// 1. NO FABRICATED DATA. Every field comes from the event. A missing `agentId` is `null`
//    and renders as "unattributed" — never a guess, never the string "undefined". An
//    event outside this feed's vocabulary produces NOTHING rather than a row of blanks.
//
// 2. HONEST TIME. The SSE frame carries `id`, `event` and `data` — and NO server
//    timestamp (agent-runtime/events.mjs writes one to SQLite but does not put it on the
//    wire). So the only real time available is when the browser received the frame. The
//    field is therefore called `receivedAt`, not `at`: the name has to carry the
//    semantics, or someone will eventually read it as server truth.
//
// 3. BOUNDED. A cockpit runs for days. The buffer is a fixed-size ring — 500 rows, newest
//    first — so a long session cannot leak memory. Everything is immutable, and an
//    ignored event returns the SAME array reference so React does not re-render for a
//    frame the feed does not show.

import type { RuntimeEvent, RuntimeEventName } from "./useRuntimeEvents.ts";

/** Newest 500. Roughly a full working day of a busy swarm, at a bounded cost. */
export const ACTIVITY_CAP = 500;

export type ActivityTone = "neutral" | "good" | "bad" | "warn";

export interface ActivityRow {
  /** Unique per row; the React key. Built from the bus sequence, which is monotonic. */
  id: string;
  /** The bus sequence number this row came from. */
  seq: number;
  /** CLIENT receipt time (epoch ms). Not server time — the wire does not carry one. */
  receivedAt: number;
  name: RuntimeEventName;
  /** The agent this concerns, or null when the event is not agent-scoped. */
  agentId: string | null;
  /** Human verb, always a fixed string from the table below — never interpolated data. */
  verb: string;
  /** What the verb acted on, already coerced to a safe display string, or null. */
  target: string | null;
  tone: ActivityTone;
}

/**
 * The feed's VOCABULARY — deliberately narrower than the SSE catalog.
 *
 * The catalog includes reserved names emitted by nobody (`workflow.run`, `lead.moved`,
 * `content.changed`, `output.created`) and identity-only plumbing events
 * (`loop.step`, `memory.changed`, `skills.changed`, `station.perm.changed`,
 * `story.changed`, `vault.written`). Rendering those would fill the feed with rows a
 * human cannot act on. If one of them becomes meaningful later, it gets an entry here
 * with a real verb — not a fallback that prints its raw name.
 */
const VOCAB: Partial<Record<RuntimeEventName, { verb: string; tone: ActivityTone }>> = {
  "task.queued": { verb: "queued", tone: "neutral" },
  "task.started": { verb: "started", tone: "neutral" },
  "task.retried": { verb: "retried", tone: "warn" },
  "task.failed": { verb: "failed", tone: "bad" },
  "task.done": { verb: "finished", tone: "good" },
  "agent.state": { verb: "is now", tone: "neutral" },
  "usage.tick": { verb: "used", tone: "neutral" },
  "delivery.created": { verb: "delivered", tone: "neutral" },
  "delivery.decided": { verb: "decision", tone: "good" },
  "policy.autoapplied": { verb: "auto-applied", tone: "good" },
  "delivery.sla_halflife": { verb: "is half past its SLA", tone: "warn" },
  "delivery.expired": { verb: "missed its SLA", tone: "bad" },
  // Phase 1 / R1 — a hook VETO. This is the ONLY place the reason a run was stopped is
  // ever shown: the run never mints a Delivery, so without this row a killed run reads as
  // an ordinary failure with no cause. `bad` because work was destroyed, not postponed.
  "run.killed": { verb: "run killed", tone: "bad" },
  // Phase 1 / R2b — a cadence tick chose NOT to dispatch. `warn`, not `bad`: the slot is
  // postponed and survives (queue.mjs writes nothing on a deferral), so this is pressure,
  // not loss. It is here because a non-event that leaves no trace is precisely how "the
  // workers are quiet" becomes indistinguishable from "the workers are broken".
  "worker.deferred": { verb: "workers deferred", tone: "warn" },
};

/** Known agent lifecycle states. Anything else is not echoed into the UI. */
const AGENT_STATES = new Set(["idle", "working", "blocked", "offline", "stale", "error", "starting"]);

/** A short, printable string, or null. Never "undefined", never an object. */
function str(v: unknown, max = 64): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t) return null;
  // Control characters would corrupt the row; agent-authored ids are not trusted shapes.
  // Filtered by codepoint rather than a control-char regex: a literal control byte in
  // source is invisible in review and trips no-control-regex, and this reads clearer.
  const clean = [...t].filter((c) => (c.codePointAt(0) ?? 0) >= 0x20).join("");
  return clean.slice(0, max) || null;
}

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Per-event target text. Each branch reads only fields that event actually carries. */
function targetFor(name: RuntimeEventName, d: Record<string, unknown>): string | null {
  switch (name) {
    case "task.queued":
    case "task.started":
    case "task.retried":
    case "task.failed":
    case "task.done":
      return str(d.taskId) ?? str(d.title, 80);
    case "agent.state": {
      const s = str(d.state, 24);
      return s && AGENT_STATES.has(s) ? s : null;
    }
    case "usage.tick": {
      // Tokens ONLY. agent-runtime/usage.mjs is explicit that no cost/USD field exists
      // on a subscription run, and inventing one here would be exactly the fabrication
      // the whole program forbids.
      const i = num(d.inputTokens) ?? 0;
      const o = num(d.outputTokens) ?? 0;
      const total = Math.max(0, Math.round(i + o));
      return total > 0 ? `${total.toLocaleString("en-US")} tokens` : null;
    }
    case "delivery.created":
      return str(d.title, 80) ?? str(d.id);
    case "delivery.decided":
      return str(d.status, 24) ?? str(d.id);
    case "policy.autoapplied":
      return str(d.title, 80) ?? str(d.id);
    case "delivery.sla_halflife":
    case "delivery.expired":
      return str(d.title, 80) ?? str(d.id);
    // The REASON is the payload here, not decoration. A veto message carries the failing
    // gate's own output, so it is capped well above the usual 80 — enough to read the
    // failure, bounded so one row cannot flood the feed.
    case "run.killed":
      return str(d.reason, 200) ?? str(d.event, 32);
    case "worker.deferred":
      return str(d.reason, 64);
    default:
      return null;
  }
}

/** A decided delivery's tone follows the decision — a rejection is not "good". */
function toneFor(name: RuntimeEventName, d: Record<string, unknown>, base: ActivityTone): ActivityTone {
  if (name !== "delivery.decided") return base;
  const status = str(d.status, 24);
  if (status === "rejected") return "bad";
  if (status === "changes_requested") return "warn";
  return base;
}

/**
 * One event → one row, or null when the feed does not speak that event.
 * `seq` is the bus sequence; `receivedAt` is the caller's clock at receipt.
 */
export function activityRow(e: RuntimeEvent, seq: number, receivedAt: number): ActivityRow | null {
  const spec = VOCAB[e.name];
  if (!spec) return null;
  const d = e.data ?? {};
  return {
    id: `${seq}:${e.name}`,
    seq,
    receivedAt,
    name: e.name,
    agentId: str(d.agentId, 48),
    verb: spec.verb,
    target: targetFor(e.name, d),
    tone: toneFor(e.name, d, spec.tone),
  };
}

/**
 * Fold an event into the buffer. Newest first, capped, immutable.
 * Returns the SAME reference when the event is not part of the feed's vocabulary, so an
 * ignored frame costs zero renders.
 */
export function applyActivity(
  rows: ActivityRow[],
  e: RuntimeEvent,
  seq: number,
  receivedAt: number,
): ActivityRow[] {
  const row = activityRow(e, seq, receivedAt);
  if (!row) return rows;
  // DEDUPE. On reconnect the runtime replays from `lastEventId` (ADR-052 §3). The
  // watermark should make that exact, but an off-by-one there would duplicate rows in
  // the feed — visible, confusing, and the kind of thing that only shows up in
  // production. The bus sequence is unique, so identity is the honest guard.
  if (rows.some((r) => r.id === row.id)) return rows;
  const next = [row, ...rows];
  return next.length > ACTIVITY_CAP ? next.slice(0, ACTIVITY_CAP) : next;
}

/** Distinct named agents present in the buffer, sorted. Unattributed rows contribute none. */
export function agentsIn(rows: ActivityRow[]): string[] {
  const set = new Set<string>();
  for (const r of rows) if (r.agentId) set.add(r.agentId);
  return [...set].sort();
}

/** Narrow to one agent. `null` means "no filter" and returns the same reference. */
export function filterActivity(rows: ActivityRow[], agentId: string | null): ActivityRow[] {
  if (!agentId) return rows;
  return rows.filter((r) => r.agentId === agentId);
}

/**
 * A DETERMINISTIC stand-in sequence for a frame that arrived without one.
 *
 * CODE-REVIEW MEDIUM. The caller used to hand out a freshly decremented counter here, so
 * the SAME frame redelivered after a reconnect got a DIFFERENT id the second time and the
 * identity guard in `applyActivity` never matched — the row was rendered twice. That is
 * precisely the duplicate-on-replay failure the dedupe exists to prevent, arriving from
 * the client side instead of a server off-by-one.
 *
 * Derived from the frame's own content, so a replay of the same frame collapses. Negative,
 * so it can never collide with a real bus sequence (which is a positive rowid).
 *
 * THE TRADE-OFF, STATED. Two genuinely distinct frames with byte-identical content and no
 * sequence would collapse into one row. That is acceptable ONLY because the server writes
 * `id: <seq>` on every frame it emits (agent-runtime/events.mjs), so this path is
 * anomaly handling, not the normal case — and showing one row twice is a lie about what
 * happened, while collapsing two identical anomalous frames is a lossy but honest one.
 */
export function fallbackSeq(event: unknown): number {
  let json = "";
  try {
    json = JSON.stringify(event, (k, v) => (k === "seq" ? undefined : v)) ?? "";
  } catch {
    json = String(event); // a cyclic payload cannot reach here from JSON.parse, but be safe
  }
  // djb2 — small, fast, and adequate: a collision costs one dropped anomalous row.
  let h = 5381;
  for (let i = 0; i < json.length; i += 1) h = ((h * 33) ^ json.charCodeAt(i)) >>> 0;
  return -(h + 1); // +1 so a zero hash cannot produce -0
}
