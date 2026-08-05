// ONE SSE subscription for the whole app (ADR-052, program plan §2).
//
// The runtime's bus is token+host+origin gated, but a browser EventSource cannot
// set `x-runtime-token`. So the flow is: POST /runtime/events/ticket (fully
// token-gated) → single-use 30s ticket → GET /runtime/events?ticket=… .
//
// RECONNECT: EventSource's own retry is structurally dead here — it replays the
// SAME url, the ticket is already consumed, the runtime answers 401, and the SSE
// spec then FAILS the connection (readyState CLOSED, no further retries). So this
// hook owns reconnection: on error it closes the stream itself, waits backoffMs(n),
// mints a FRESH ticket and opens a new EventSource, carrying the last seen event
// seq as `&lastEventId=` so the server replays what was missed (ADR-052 §3).
// On every (re)open it also fires `onResync` so the caller re-reads authoritative
// state — belt and braces, and the only correct behaviour if the events_log was
// pruned across a long disconnect.
//
// The 2s /api/state.json poll is NOT touched and NOT gated on this hook
// (program plan §2, decoupled-watcher principle).
//
// Everything above `useRuntimeEvents` is pure and DOM-free so `node --test` can
// import this module directly.
import { useEffect, useRef, useState } from "react";
import { mintEventTicket } from "./inboxClient.ts";
import { runtimeUrl } from "./runtimeBase.ts";

/**
 * The FULL v1 catalog, verbatim from program plan §2 / agent-runtime/events.mjs,
 * including the one documented amendment (`task.done`, 2026-07-30). This list must
 * stay identical to EVENT_NAMES server-side: a name missing here is a frame the
 * hook never subscribes to and `parseEvent` rejects.
 */
export const RUNTIME_EVENT_NAMES = [
  "delivery.created",
  "delivery.decided",
  "task.queued",
  "task.started",
  "task.retried",
  "task.failed",
  "task.done",
  "agent.state",
  "usage.tick",
  "policy.autoapplied",
  // P6 / ADR-053 — SLA escalation (documented amendment; see events.mjs). Neither
  // changes the pending badge: an SLA event escalates a delivery, it does not decide it.
  "delivery.sla_halflife",
  "delivery.expired",
  // B2 / ADR-052 §Amendment B2 — the Business-OS names, registered in ONE catalog
  // change so B4/B6/B7 never touch the closed wire contract again. `vault.written` is
  // LIVE from B2 (the Vault page and the deck's RECORDS READ react to it); the other
  // four are RESERVED — subscribed and parseable, emitted by nobody yet, rendered by
  // nobody yet. MUST stay byte-identical to agent-runtime/events.mjs EVENT_NAMES.
  "vault.written",
  "workflow.run",
  "lead.moved",
  "content.changed",
  "output.created",
  // CC-Primitives P2 — LIVE. Identity-only loop step of an engine turn; the drawer
  // re-fetches /runtime/engine/steps on frame. MUST stay byte-identical to events.mjs.
  "loop.step",
  // CC-Primitives P4 — LIVE. Station memory changed; vault/deck re-fetch the gated GET.
  // MUST stay byte-identical to agent-runtime/events.mjs EVENT_NAMES.
  "memory.changed",
  // CC-Primitives P1 — LIVE. A station's interactive permission-mode override changed;
  // the Agents deck reconciles the mode chip. MUST stay byte-identical to
  // agent-runtime/events.mjs EVENT_NAMES.
  "station.perm.changed",
  // CC-Primitives P3 — LIVE. Station skills list changed; deck re-fetches the gated GET.
  // MUST stay byte-identical to agent-runtime/events.mjs EVENT_NAMES.
  "skills.changed",
  // Story-Pipeline S1 — LIVE. A story was created or changed stage; the Stories board/detail
  // re-fetch the gated GET. Identity-only ({id, stage}). MUST stay byte-identical to
  // agent-runtime/events.mjs EVENT_NAMES.
  "story.changed",
] as const;

export type RuntimeEventName = (typeof RUNTIME_EVENT_NAMES)[number];

export interface RuntimeEvent {
  name: RuntimeEventName;
  data: Record<string, unknown>;
}

const CATALOG = new Set<string>(RUNTIME_EVENT_NAMES);

const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 30_000;

/** 1s → 2 → 4 → 8 → 16 → 30 (capped). Any bad attempt index floors at the base. */
export function backoffMs(attempt: number): number {
  const n = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  return Math.min(BACKOFF_BASE_MS * 2 ** n, BACKOFF_CAP_MS);
}

/**
 * Frame → typed event. Returns null for anything outside the closed catalog, so
 * a renamed or injected server event can never reach a UI reducer. Malformed or
 * non-object JSON degrades to `{}` rather than throwing on the stream callback.
 */
export function parseEvent(name: string, raw: string): RuntimeEvent | null {
  if (!CATALOG.has(name)) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    data = null;
  }
  const obj = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  return { name: name as RuntimeEventName, data: obj };
}

/**
 * P8 (ADR-030) — one `usage.tick` from the bus. Tokens + context% ONLY, NEVER a dollar
 * figure. `inputTokens`/`outputTokens`/`turns` are day-cumulative for this (agent,thread,
 * tier); `contextPct` is the latest window fill (0..1); `estimated` flags the chars/4
 * fallback (mock backend / no cli token JSON).
 */
export interface UsageTick {
  agentId: string;
  threadId: string;
  tier: string;
  day: string;
  inputTokens: number;
  outputTokens: number;
  turns: number;
  contextTokens: number;
  contextWindow: number;
  contextPct: number;
  estimated: boolean;
}

/** Live usage keyed by `${threadId}::${tier}` — one bucket per thread × tier. */
export type UsageByKey = Record<string, UsageTick>;

/**
 * Usage reducer for the bus-driven meter. Folds a `usage.tick` into the map keyed by
 * thread × tier (mirrors the server's per-thread×tier×day accumulation). Ignores every
 * other event and any tick missing an identity. Coerces every field so a malformed
 * payload can never poison the meter — and NEVER reads a cost/$ field (there is none).
 */
export function applyUsageTick(map: UsageByKey, e: RuntimeEvent): UsageByKey {
  if (e.name !== "usage.tick") return map;
  const d = e.data as Partial<UsageTick>;
  const threadId = typeof d.threadId === "string" && d.threadId ? d.threadId : (typeof d.agentId === "string" ? d.agentId : "");
  if (!threadId) return map;
  const tier = typeof d.tier === "string" && d.tier ? d.tier : "—";
  const tick: UsageTick = {
    agentId: typeof d.agentId === "string" && d.agentId ? d.agentId : threadId,
    threadId,
    tier,
    day: typeof d.day === "string" ? d.day : "",
    inputTokens: Number(d.inputTokens) || 0,
    outputTokens: Number(d.outputTokens) || 0,
    turns: Number(d.turns) || 0,
    contextTokens: Number(d.contextTokens) || 0,
    contextWindow: Number(d.contextWindow) || 0,
    contextPct: Math.min(1, Math.max(0, Number(d.contextPct) || 0)),
    estimated: !!d.estimated,
  };
  return { ...map, [`${threadId}::${tier}`]: tick };
}

/**
 * Pending-badge reducer. A Delivery enters the queue on `delivery.created` and
 * leaves it on any decision — human (`delivery.decided`) or policy
 * (`policy.autoapplied`, P6). Floors at zero: a replayed decision for a Delivery
 * we never counted must not drive the badge negative.
 */
export function applyBadge(current: number, e: RuntimeEvent): number {
  const n = Number.isFinite(current) ? current : 0;
  if (e.name === "delivery.created") return n + 1;
  if (e.name === "delivery.decided" || e.name === "policy.autoapplied") return Math.max(0, n - 1);
  return n;
}

/** Stream URL. The ticket is the only credential that ever rides a query string. */
export function streamPath(ticket: string, lastEventId?: string | null): string {
  const p = new URLSearchParams({ ticket });
  if (lastEventId != null && String(lastEventId).trim() !== "" && Number.isFinite(Number(lastEventId))) {
    p.set("lastEventId", String(lastEventId));
  }
  return `/runtime/events?${p.toString().replace(/\+/g, "%20")}`;
}

// ── the hook ────────────────────────────────────────────────────────────────
export interface UseRuntimeEventsOptions {
  /** Off ⇒ nothing is minted, nothing is opened. Used by the VITE_INBOX flag. */
  enabled?: boolean;
  /** Every catalog event, already parsed. */
  onEvent?: (e: RuntimeEvent) => void;
  /** Fired on every successful (re)open — re-read authoritative state here. */
  onResync?: () => void;
}

export interface RuntimeEventsState {
  /** True while the stream is open. */
  connected: boolean;
  /** Epoch ms of the next reconnect attempt, or null when connected/idle. */
  retryAt: number | null;
  /** Force an immediate reconnect (the banner's "Retry now"). */
  reconnectNow: () => void;
}

export function useRuntimeEvents(opts: UseRuntimeEventsOptions = {}): RuntimeEventsState {
  const { enabled = true, onEvent, onResync } = opts;
  const [connected, setConnected] = useState(false);
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [nudge, setNudge] = useState(0);

  // Callbacks live in refs so a re-rendered parent never tears the stream down.
  const onEventRef = useRef(onEvent);
  const onResyncRef = useRef(onResync);
  useEffect(() => { onEventRef.current = onEvent; }, [onEvent]);
  useEffect(() => { onResyncRef.current = onResync; }, [onResync]);

  const lastIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || typeof EventSource === "undefined") return;

    let disposed = false;
    let es: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const closeStream = () => {
      if (!es) return;
      try { es.close(); } catch { /* already closed */ }
      es = null;
    };

    const scheduleRetry = () => {
      if (disposed || timer) return;
      const wait = backoffMs(attempt);
      attempt += 1;
      setRetryAt(Date.now() + wait);
      timer = setTimeout(() => { timer = null; void connect(); }, wait);
    };

    const connect = async () => {
      if (disposed) return;
      closeStream();
      let ticket: string | undefined;
      try {
        ticket = (await mintEventTicket()).ticket;
      } catch {
        ticket = undefined;
      }
      if (disposed) return;
      if (!ticket) { setConnected(false); scheduleRetry(); return; }

      const source = new EventSource(runtimeUrl(streamPath(ticket, lastIdRef.current)));
      es = source;

      source.onopen = () => {
        if (disposed) return;
        attempt = 0;
        setRetryAt(null);
        setConnected(true);
        onResyncRef.current?.();
      };
      source.onerror = () => {
        if (disposed) return;
        // Our own retry owns this — the browser's would 401 on the spent ticket.
        closeStream();
        setConnected(false);
        scheduleRetry();
      };
      for (const name of RUNTIME_EVENT_NAMES) {
        source.addEventListener(name, (raw: Event) => {
          const m = raw as MessageEvent<string>;
          if (m.lastEventId) lastIdRef.current = m.lastEventId;
          const parsed = parseEvent(name, m.data);
          if (parsed) onEventRef.current?.(parsed);
        });
      }
    };

    void connect();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      closeStream();
      setConnected(false);
      setRetryAt(null);
    };
  }, [enabled, nudge]);

  return {
    connected,
    retryAt,
    reconnectNow: () => setNudge((n) => n + 1),
  };
}
