// ADR-052 — Runtime Event Bus. A READ-ONLY fan-out transport: SSE clients, a
// 25s keepalive, Last-Event-ID replay out of events_log, and the short-lived
// single-use ticket that closes the gap `EventSource` leaves (it cannot send the
// x-runtime-token header).
//
// This module creates NO capability to mutate anything. Every event is a
// notification of a write that some OTHER gated route already made.
//
// SECURITY (ADR-052 security table):
//   • Ticket = 24 random bytes, 30s TTL, single-use, timingSafeEqual compare, and
//     marked consumed BEFORE any SSE header is written so a race cannot
//     double-spend it. The master token NEVER appears in a URL.
//   • Every payload runs through the SHARED scrub (injected) once, covering every
//     nested string, before it is persisted AND before it is framed.
//   • The event-name catalog is CLOSED — emit() throws on anything else, so a
//     future caller cannot quietly widen the wire contract.
//   • RUNTIME_MAX_SSE_CLIENTS caps connections; SSE never consumes MAX_INFLIGHT
//     (it spawns no child).
//   • events_log is bounded: newest 5000 rows / 7 days, swept at boot and on an
//     insert-count modulo (no second timer).

import { randomBytes, timingSafeEqual } from "node:crypto";

// The FULL v1 catalog, verbatim from program plan §2. No additions, no renames —
// except ONE documented amendment: `task.done` (see below and program plan §2).
export const EVENT_NAMES = Object.freeze(new Set([
  "delivery.created",
  "delivery.decided",
  "task.queued",
  "task.started",
  "task.retried",
  "task.failed",
  // PLAN AMENDMENT 2026-07-30 — the v1 catalog had no SUCCESS-terminal name, so the
  // only way the UI learned a task had left the queue was the QueueStrip's 400ms
  // debounced re-truth fetch. Emitted from queue.update() on the done transition
  // under the same emit-on-persist rule and the same 7-scalar wire() allow-list.
  "task.done",
  "agent.state",
  "usage.tick",
  "policy.autoapplied",
  // PLAN AMENDMENT 2026-07-30 (P6 / ADR-053) — SLA escalation. Program plan §2 named
  // `delivery.expired`; `delivery.sla_halflife` is its half-life sibling (re-notify
  // once). Added to EVENT_NAMES, the client RUNTIME_EVENT_NAMES and both
  // catalog-equality tests together, under the SAME emit-on-persist rule. The
  // delivery stays pending on both — these are escalation signals, not decisions.
  "delivery.sla_halflife",
  "delivery.expired",
  // PLAN AMENDMENT 2026-07-30 (B2 / ADR-052 §Amendment B2, ADR-055) — the Business-OS
  // names. Registered in ONE catalog change on purpose: the catalog is CLOSED, and
  // widening it once per phase would mean four more wire-contract edits (each one a
  // chance to desync this Set from the client's RUNTIME_EVENT_NAMES and from the two
  // equality tests that pin them together).
  //   vault.written   — B2, LIVE. Emitted by vault.mjs write() under the same
  //                     emit-on-persist rule as every other name. Identity only
  //                     ({id,node,venture,agent}) — never a title or a body, because a
  //                     bus frame reaches every connected seat while the record itself
  //                     stays behind the auth-gated GET.
  //   workflow.run    — B4 (cadence), RESERVED.
  //   lead.moved      — B6 (pipeline), RESERVED.
  //   content.changed — B6 (content), RESERVED.
  //   output.created  — B7 (outputs), RESERVED.
  // A RESERVED name is a name emit() will accept and no caller emits yet. That is a
  // deliberate, disclosed gap — not a stub: nothing renders off these four, so nothing
  // shows a fabricated number until the phase that fills them lands.
  "vault.written",
  "workflow.run",
  "lead.moved",
  "content.changed",
  "output.created",
  // CC-Primitives P2 — LIVE. One frame per persisted loop step of an engine turn
  // (loop-steps.mjs). IDENTITY ONLY ({agentId,taskId,seq,kind,tool}) — the scrubbed
  // summary stays behind the auth-gated GET /runtime/engine/steps, same rationale as
  // vault.written. Volume is bounded structurally: deltas never become steps.
  "loop.step",
  // CC-Primitives P4 — LIVE. A station's memory (its CLAUDE.md) changed. Identity+size
  // only ({agentId,size}); the text stays behind the gated GET. Next wake carries it.
  "memory.changed",
  // CC-Primitives P1 — LIVE. Emitted when a station's INTERACTIVE permission mode override
  // changes (PUT /runtime/:agentId/perm-mode). Identity + mode only ({agentId,permMode});
  // the Agents deck reacts so the mode chip reconciles live. Kept byte-identical to the
  // client RUNTIME_EVENT_NAMES and both catalog-equality tests.
  "station.perm.changed",
  // CC-Primitives P3 — LIVE. A station's skills list changed (PUT /runtime/:id/skills).
  // Identity + count only ({agentId, count}); the list itself sits behind the gated GET.
  "skills.changed",
  // Story-Pipeline S1 — LIVE. A story was created or changed stage (stories.mjs
  // create/advance/reject). IDENTITY ONLY ({id, stage}); the title/idea/spec stay behind
  // the auth-gated GET /runtime/stories/:id, same rationale as vault.written / loop.step.
  // MUST stay byte-identical to the client RUNTIME_EVENT_NAMES and both catalog-equality tests.
  "story.changed",
]));

const TICKET_BYTES = 24;
const TICKET_TTL_MS = 30_000;   // ADR-052 §6
const MAX_TICKETS = 512;        // hard cap — an unbounded Map is a memory-growth DoS
const PING_MS = 25_000;         // ADR-052 §4 — under the common 30s proxy idle timeout
const MAX_ROWS = 5000;          // ADR-052 §3
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const PRUNE_EVERY = 200;        // insert-count modulo sweep (no second timer)
// One reconnect must not be able to shove the entire 5000-row log into a socket in a
// single synchronous burst. 500 is far more than any real disconnect produces, and
// the client re-syncs authoritatively on every (re)open anyway (useRuntimeEvents
// onResync), so a replay that is short is a latency detail, never a correctness one.
const REPLAY_CAP = 500;

export function createEvents(deps = {}) {
  const store = deps.db;
  if (!store || !store.db) throw new Error("createEvents: db handle required");
  const db = store.db;
  const scrub = deps.scrub || ((s) => s);
  const now = deps.now || (() => Date.now());
  const maxClients = Number(deps.maxClients) > 0 ? Number(deps.maxClients) : 16;
  const pingMs = Number(deps.pingMs) > 0 ? Number(deps.pingMs) : PING_MS;
  const maxRows = Number(deps.maxRows) > 0 ? Number(deps.maxRows) : MAX_ROWS;
  const maxAgeMs = Number(deps.maxAgeMs) > 0 ? Number(deps.maxAgeMs) : MAX_AGE_MS;
  const maxTickets = Number(deps.maxTickets) > 0 ? Number(deps.maxTickets) : MAX_TICKETS;

  const clients = new Map();   // connId → { res, timer }
  const tickets = new Map();   // ticket → { expiresAt }
  let connSeq = 0;
  let inserts = 0;

  const insertStmt = db.prepare("INSERT INTO events_log(event, data, createdAt) VALUES(?, ?, ?)");
  const replayStmt = db.prepare("SELECT seq, event, data FROM events_log WHERE seq > ? ORDER BY seq LIMIT ?");

  const frame = (seq, event, json) => `id: ${seq}\nevent: ${event}\ndata: ${json}\n\n`;

  function drop(connId) {
    const c = clients.get(connId);
    if (!c) return;
    try { clearInterval(c.timer); } catch { /* */ }
    clients.delete(connId);
  }

  function writeTo(connId, text) {
    const c = clients.get(connId);
    if (!c) return;
    try { c.res.write(text); } catch { drop(connId); } // half-open socket → deregister
  }

  // ── replay with backpressure ────────────────────────────────────────────────
  // The backlog is the one place this module writes many frames back-to-back. A slow
  // or stalled client returns `false` from write() once the kernel buffer is full;
  // ignoring that buffers the remainder in node's heap — unbounded memory growth for
  // exactly the client least able to drain it. So: stop on false, resume on 'drain'.
  // A response stand-in with no once/on simply stops replaying — never throws.
  function replayBacklog(connId, rows) {
    let i = 0;
    const pump = () => {
      while (i < rows.length) {
        const c = clients.get(connId);
        if (!c) return; // client disconnected mid-replay
        const row = rows[i++];
        let ok;
        try { ok = c.res.write(frame(row.seq, row.event, row.data)); }
        catch { drop(connId); return; } // half-open socket → deregister
        if (ok === false) { // buffer full — hand the socket back until it drains
          try { (c.res.once || c.res.on)?.call(c.res, "drain", pump); } catch { /* stand-in without once/on */ }
          return;
        }
      }
    };
    pump();
  }

  // ── emit-on-persist (ADR-052 §2) ───────────────────────────────────────────
  // The SAME call writes the row and pushes the frame. No watcher, no dual path.
  function emit(event, data) {
    if (!EVENT_NAMES.has(event)) throw new Error(`events.emit: unknown event '${event}'`);
    // One scrub pass over the serialized payload covers every nested string
    // (ADR-052 §7) using the server's shared scrub — no second implementation.
    let json;
    try { json = scrub(JSON.stringify(data ?? {})); } catch { json = "{}"; }
    if (typeof json !== "string") json = "{}";
    const seq = Number(insertStmt.run(event, json, new Date(now()).toISOString()).lastInsertRowid);
    const text = frame(seq, event, json);
    for (const connId of [...clients.keys()]) writeTo(connId, text);
    if (++inserts % PRUNE_EVERY === 0) { try { prune(); } catch { /* best-effort */ } }
    return seq;
  }

  // ── subscribe (ADR-052 §3/§4/§5) ───────────────────────────────────────────
  // Returns false (nothing written) when the cap is hit, so the caller can answer
  // 503 with its own body.
  function subscribe(res, opts = {}) {
    if (clients.size >= maxClients) return false;
    const connId = ++connSeq;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    // node buffers headers until the first body write, so WITHOUT this an idle
    // stream would not reach the client (EventSource `onopen`, and any awaiting
    // fetch) until the first real event or the 25s ping — a 25s phantom stall.
    // Flush, then send one comment frame so the connection is provably open.
    try { res.flushHeaders?.(); } catch { /* stand-in without flushHeaders */ }

    // Replay first, then live tail — a reconnecting EventSource sees no gap.
    const raw = opts.lastEventId;
    const since = Number.isFinite(Number(raw)) && String(raw).trim() !== "" ? Math.max(0, Math.floor(Number(raw))) : 0;
    let backlog = [];
    if (since > 0) { try { backlog = replayStmt.all(since, REPLAY_CAP); } catch { backlog = []; } }

    const timer = setInterval(() => writeTo(connId, ": ping\n\n"), pingMs);
    if (typeof timer.unref === "function") timer.unref();
    clients.set(connId, { res, timer });
    writeTo(connId, ": open\n\n"); // opening comment — proves the stream to the client now

    replayBacklog(connId, backlog);
    // Mirror the existing inflight-cleanup posture (server.mjs res.on("close")).
    try {
      res.on("close", () => drop(connId));
      res.on("error", () => drop(connId));
    } catch { /* stand-in without .on — tests drive drop() directly */ }
    return true;
  }

  // ── prune (ADR-052 §3) ─────────────────────────────────────────────────────
  function prune() {
    const max = db.prepare("SELECT MAX(seq) s FROM events_log").get()?.s;
    if (!max) return 0;
    const cutoffIso = new Date(now() - maxAgeMs).toISOString();
    return db.prepare("DELETE FROM events_log WHERE seq <= ? OR createdAt < ?").run(max - maxRows, cutoffIso).changes;
  }

  // ── tickets (ADR-052 §6) ───────────────────────────────────────────────────
  function sweepTickets() {
    const t = now();
    for (const [k, v] of tickets) if (v.expiresAt <= t) tickets.delete(k);
  }

  // Tickets are token-gated but unbounded until they expire, so a loop of authorised
  // mints grows the Map without limit. Sweep first (the cheap path), and only refuse
  // when the live, unexpired set is genuinely at the cap.
  function mintTicket() {
    sweepTickets();
    if (tickets.size >= maxTickets) return { error: "too many tickets", code: 429 };
    const ticket = randomBytes(TICKET_BYTES).toString("hex");
    const expiresAt = now() + TICKET_TTL_MS;
    tickets.set(ticket, { expiresAt });
    return { ticket, expiresAt, ttlMs: TICKET_TTL_MS };
  }

  // Validate + CONSUME atomically: the entry is deleted before this returns true,
  // so a concurrent second connect with the same ticket loses the race.
  function consumeTicket(candidate) {
    if (typeof candidate !== "string" || candidate.length !== TICKET_BYTES * 2) return false;
    sweepTickets();
    const buf = Buffer.from(candidate);
    for (const [known, v] of tickets) {
      if (known.length !== candidate.length) continue;
      let same = false;
      try { same = timingSafeEqual(Buffer.from(known), buf); } catch { same = false; }
      if (!same) continue;
      tickets.delete(known);              // consumed BEFORE the caller writes headers
      return v.expiresAt > now();
    }
    return false;
  }

  function clientCount() { return clients.size; }

  function closeAll() {
    for (const connId of [...clients.keys()]) {
      const c = clients.get(connId);
      drop(connId);
      try { c.res.end(); } catch { /* */ }
    }
    tickets.clear();
  }

  return { emit, subscribe, prune, mintTicket, consumeTicket, clientCount, closeAll, EVENT_NAMES };
}
