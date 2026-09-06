// ADR-052 — Runtime event bus: closed catalog, emit-on-persist frames, scrub,
// Last-Event-ID replay, single-use tickets, prune, connection cap, heartbeat.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../db.mjs";
import { createEvents, EVENT_NAMES } from "../events.mjs";

const SECRET_RE = /sk-ant-[A-Za-z0-9_-]{6,}/g;
const scrub = (s) => (typeof s === "string" ? s.replace(SECRET_RE, "[redacted-secret]") : s);

// Minimal ServerResponse stand-in — no socket needed.
function fakeRes() {
  const r = {
    chunks: [], headers: null, code: 0, ended: false, handlers: {},
    writeHead(code, headers) { r.code = code; r.headers = headers; return r; },
    write(s) { if (r.ended) throw new Error("write after end"); r.chunks.push(s); return true; },
    end() { r.ended = true; },
    on(ev, fn) { (r.handlers[ev] ||= []).push(fn); return r; },
    fire(ev) { for (const fn of r.handlers[ev] || []) fn(); },
    text() { return r.chunks.join(""); },
  };
  return r;
}

function harness(over = {}) {
  const root = mkdtempSync(join(tmpdir(), "ma-ev-"));
  const h = openDb({ path: join(root, "mission.db") });
  const ev = createEvents({ db: h, scrub, pingMs: 25_000, maxClients: 3, ...over });
  return { root, h, ev, cleanup: () => { ev.closeAll(); h.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("EVENT_NAMES is EXACTLY the program-plan §2 catalog + the documented amendments", () => {
  assert.deepEqual([...EVENT_NAMES].sort(), [
    // RUFLO-ADOPTION amendment (2026-08-18): doctor.status (LIVE) + run.killed,
    // worker.deferred, retrieval.hit, selfgrade.changed, trust.changed (RESERVED),
    // registered in ONE catalog change. Sorted in, hence scattered above.
    // MUNDER-ADOPTION amendment (2026-08-20): breaker.state (LIVE) + usage.transcript,
    // vault.condensed, engine.roster, run.output (RESERVED), registered in ONE catalog
    // change. Sorted in, hence scattered below.
    // MISSIONALPHA PHASE 7.0b amendment (2026-09-04): roster.changed, job.changed and
    // mail, RESERVED and registered in ONE catalog change (declared before their
    // emitters land: 7.1 roster.add, 9 Job store, 8.1 mailbox route). Sorted in,
    // hence scattered below.
    "agent.state",
    "breaker.state",
    "content.changed",
    "delivery.created",
    "delivery.decided",
    "delivery.expired",
    "delivery.sla_halflife",
    "doctor.status",
    "engine.roster",
    "job.changed",
    "lead.moved",
    "loop.step",
    "mail",
    "memory.changed",
    "output.created",
    "policy.autoapplied",
    "retrieval.hit",
    "roster.changed",
    "run.killed",
    "run.output",
    "selfgrade.changed",
    "skills.changed",
    "station.perm.changed",
    "story.changed",
    "task.done",
    "task.failed",
    "task.queued",
    "task.retried",
    "task.started",
    "trust.changed",
    "usage.tick",
    "usage.transcript",
    "vault.condensed",
    "vault.written",
    "worker.deferred",
    "workflow.run",
  ]);
});

test("emit() accepts every B2 name and still refuses anything outside the catalog", () => {
  const t = harness();
  try {
    for (const name of ["vault.written", "workflow.run", "lead.moved", "content.changed", "output.created"]) {
      assert.ok(t.ev.emit(name, { id: "x" }) > 0, name);
    }
    assert.throws(() => t.ev.emit("vault.deleted", {}), /unknown event/);
    assert.throws(() => t.ev.emit("vault.written.extra", {}), /unknown event/);
  } finally { t.cleanup(); }
});

// Phase 7.0b — the three names are DECLARED here before anything emits them (7.1
// roster.add, 8.1 mailbox route, 9 Job store). Declaring first is only worth
// anything if the CLOSED catalog actually takes them, so prove the accept side:
// each one persists a real row AND reaches a subscribed client, while a near-miss
// spelling still throws. This is the assertion that would have caught a frame being
// silently dropped by emit().
test("emit() accepts the Phase 7.0b reserved names, frames them, and still refuses a near-miss", () => {
  const t = harness();
  try {
    const c = fakeRes();
    assert.equal(t.ev.subscribe(c, {}), true);
    for (const name of ["roster.changed", "job.changed", "mail"]) {
      const seq = t.ev.emit(name, { id: "x" });
      assert.ok(seq > 0, `${name} persisted`);
      assert.equal(t.h.db.prepare("SELECT event FROM events_log WHERE seq = ?").get(seq).event, name);
      assert.ok(c.text().includes(`\nevent: ${name}\ndata: `), `${name} framed to the client, not dropped`);
    }
    assert.throws(() => t.ev.emit("job.change", {}), /unknown event/);
    assert.throws(() => t.ev.emit("mail.changed", {}), /unknown event/);
    assert.throws(() => t.ev.emit("roster.change", {}), /unknown event/);
  } finally { t.cleanup(); }
});

test("emit persists to events_log and writes an id:/event:/data: frame to every client", () => {
  const t = harness();
  try {
    const a = fakeRes(), b = fakeRes();
    assert.equal(t.ev.subscribe(a, {}), true);
    assert.equal(t.ev.subscribe(b, {}), true);
    assert.equal(a.code, 200);
    assert.equal(a.headers["Content-Type"], "text/event-stream");
    t.ev.emit("delivery.created", { id: "01J", agentId: "bob" });
    const row = t.h.db.prepare("SELECT seq, event, data FROM events_log").get();
    assert.equal(row.event, "delivery.created");
    assert.deepEqual(JSON.parse(row.data), { id: "01J", agentId: "bob" });
    for (const c of [a, b]) {
      assert.match(c.text(), new RegExp(`id: ${row.seq}\\nevent: delivery\\.created\\ndata: `), "frame carries seq + event + data");
    }
  } finally { t.cleanup(); }
});

test("emit scrubs every payload string before persist AND before the frame", () => {
  const t = harness();
  try {
    const c = fakeRes();
    t.ev.subscribe(c, {});
    t.ev.emit("delivery.created", { summary: "key sk-ant-DEADBEEF01 here", nested: { deep: ["sk-ant-DEADBEEF01"] } });
    const stored = t.h.db.prepare("SELECT data FROM events_log").get().data;
    assert.ok(!stored.includes("sk-ant-"), "scrubbed AT REST in events_log");
    assert.ok(stored.includes("[redacted-secret]"));
    assert.ok(!c.text().includes("sk-ant-"), "scrubbed on the wire");
  } finally { t.cleanup(); }
});

test("emit refuses an event name outside the catalog and persists nothing", () => {
  const t = harness();
  try {
    assert.throws(() => t.ev.emit("delivery.exploded", {}), /unknown event/i);
    assert.equal(t.h.db.prepare("SELECT COUNT(*) n FROM events_log").get().n, 0);
  } finally { t.cleanup(); }
});

test("Last-Event-ID replays only newer rows, in seq order, before live tail", () => {
  const t = harness();
  try {
    t.ev.emit("task.queued", { n: 1 });
    t.ev.emit("task.started", { n: 2 });
    const watermark = t.h.db.prepare("SELECT MAX(seq) s FROM events_log").get().s;
    t.ev.emit("task.failed", { n: 3 });
    const c = fakeRes();
    t.ev.subscribe(c, { lastEventId: String(watermark) });
    const txt = c.text();
    assert.ok(!txt.includes('"n":1'), "already-seen events are not replayed");
    assert.ok(!txt.includes('"n":2'), "the watermark event itself is not replayed");
    assert.ok(txt.includes('"n":3'), "the missed event IS replayed");
    t.ev.emit("task.retried", { n: 4 });
    assert.ok(c.text().includes('"n":4'), "live tail continues on the same connection");
  } finally { t.cleanup(); }
});

test("a garbage Last-Event-ID replays nothing rather than throwing", () => {
  const t = harness();
  try {
    t.ev.emit("task.queued", { n: 1 });
    const c = fakeRes();
    t.ev.subscribe(c, { lastEventId: "'; DROP TABLE events_log; --" });
    assert.equal(t.h.db.prepare("SELECT COUNT(*) n FROM events_log").get().n, 1, "table intact — statement is parameterized");
    assert.ok(!c.text().includes('"n":1'));
  } finally { t.cleanup(); }
});

test("a client that throws on write is dropped, and never blocks the others", () => {
  const t = harness();
  try {
    const good = fakeRes(), bad = fakeRes();
    t.ev.subscribe(good, {});
    t.ev.subscribe(bad, {});
    bad.write = () => { throw new Error("EPIPE"); };
    t.ev.emit("usage.tick", { agentId: "a" });
    assert.equal(t.ev.clientCount(), 1, "broken client deregistered");
    assert.ok(good.text().includes("usage.tick"));
  } finally { t.cleanup(); }
});

test("close deregisters the client and clears its heartbeat", () => {
  const t = harness();
  try {
    const c = fakeRes();
    t.ev.subscribe(c, {});
    assert.equal(t.ev.clientCount(), 1);
    c.fire("close");
    assert.equal(t.ev.clientCount(), 0);
  } finally { t.cleanup(); }
});

test("the client cap refuses connection N+1 (SSE never touches MAX_INFLIGHT)", () => {
  const t = harness();
  try {
    assert.equal(t.ev.subscribe(fakeRes(), {}), true);
    assert.equal(t.ev.subscribe(fakeRes(), {}), true);
    assert.equal(t.ev.subscribe(fakeRes(), {}), true);
    const over = fakeRes();
    assert.equal(t.ev.subscribe(over, {}), false, "4th refused at maxClients=3");
    assert.equal(over.code, 0, "refused before any header was written");
  } finally { t.cleanup(); }
});

test("heartbeat writes a : ping comment frame on the interval", async () => {
  const t = harness({ pingMs: 15 });
  try {
    const c = fakeRes();
    t.ev.subscribe(c, {});
    await new Promise((r) => setTimeout(r, 60));
    assert.match(c.text(), /: ping\n\n/, "keepalive comment frame written");
  } finally { t.cleanup(); }
});

test("prune keeps the newest maxRows and drops rows older than maxAge", () => {
  const t = harness({ maxRows: 5, maxAgeMs: 7 * 24 * 3600 * 1000 });
  try {
    for (let i = 0; i < 12; i++) t.ev.emit("usage.tick", { i });
    t.ev.prune();
    const rows = t.h.db.prepare("SELECT data FROM events_log ORDER BY seq").all();
    assert.equal(rows.length, 5, "row cap enforced");
    assert.deepEqual(rows.map((r) => JSON.parse(r.data).i), [7, 8, 9, 10, 11], "newest kept");
    // an ancient row is dropped by the age rule even when under the row cap
    t.h.db.prepare("INSERT INTO events_log(event,data,createdAt) VALUES('usage.tick','{\"old\":1}',?)")
      .run(new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString());
    t.ev.prune();
    assert.equal(t.h.db.prepare("SELECT COUNT(*) n FROM events_log WHERE data LIKE '%old%'").get().n, 0);
  } finally { t.cleanup(); }
});

// ── tickets (ADR-052 §6 — the central auth decision) ─────────────────────────

test("ticket: 24 random bytes, single-use, and consumed before anything else", () => {
  const t = harness();
  try {
    const { ticket, expiresAt } = t.ev.mintTicket();
    assert.match(ticket, /^[0-9a-f]{48}$/, "24 bytes hex");
    assert.ok(expiresAt > Date.now(), "has a future expiry");
    assert.equal(t.ev.consumeTicket(ticket), true, "first use succeeds");
    assert.equal(t.ev.consumeTicket(ticket), false, "REPLAY refused");
  } finally { t.cleanup(); }
});

test("ticket: two mints are distinct, and one does not unlock the other", () => {
  const t = harness();
  try {
    const a = t.ev.mintTicket().ticket, b = t.ev.mintTicket().ticket;
    assert.notEqual(a, b);
    assert.equal(t.ev.consumeTicket(a), true);
    assert.equal(t.ev.consumeTicket(b), true);
  } finally { t.cleanup(); }
});

test("ticket: expired, unknown, wrong-length, and non-string all fail closed", () => {
  let clock = 1_000_000;
  const t = harness({ now: () => clock });
  try {
    const { ticket } = t.ev.mintTicket();
    clock += 30_001; // ADR-052 §6 — 30s TTL
    assert.equal(t.ev.consumeTicket(ticket), false, "expired ticket refused");
    assert.equal(t.ev.consumeTicket("f".repeat(48)), false, "unknown ticket refused");
    assert.equal(t.ev.consumeTicket("short"), false);
    assert.equal(t.ev.consumeTicket(null), false);
    assert.equal(t.ev.consumeTicket(undefined), false);
    assert.equal(t.ev.consumeTicket({}), false);
  } finally { t.cleanup(); }
});

test("subscribe flushes headers and sends an opening comment immediately", () => {
  const t = harness();
  try {
    const c = fakeRes();
    let flushed = false;
    c.flushHeaders = () => { flushed = true; };
    t.ev.subscribe(c, {});
    assert.equal(flushed, true, "headers flushed — no 25s phantom stall before onopen");
    assert.equal(c.text(), ": open\n\n", "an opening comment frame reaches the client at once");
  } finally { t.cleanup(); }
});

// ── sr-security P2 §8: the tickets Map is bounded ─────────────────────────────

test("mintTicket sweeps first, then refuses with 429 once the live set is at the cap", () => {
  let clock = 1_000_000;
  const t = harness({ maxTickets: 3, now: () => clock });
  try {
    const first = [];
    for (let i = 0; i < 3; i++) {
      const m = t.ev.mintTicket();
      assert.match(m.ticket, /^[0-9a-f]{48}$/, `mint ${i} inside the cap`);
      assert.equal(m.code, undefined);
      first.push(m.ticket);
    }
    // At the cap: the sweep finds nothing expired, so the mint is refused.
    const over = t.ev.mintTicket();
    assert.equal(over.code, 429);
    assert.equal(over.error, "too many tickets");
    assert.equal(over.ticket, undefined, "no ticket is handed out when refused");
    // A loop of authorised mints cannot grow the Map past the cap.
    for (let i = 0; i < 50; i++) assert.equal(t.ev.mintTicket().code, 429);
    // The tickets minted before the cap are still valid — refusal is not a purge.
    assert.equal(t.ev.consumeTicket(first[0]), true);
    // Consuming one freed a slot.
    const after = t.ev.mintTicket();
    assert.match(after.ticket, /^[0-9a-f]{48}$/, "a freed slot is immediately reusable");
  } finally { t.cleanup(); }
});

test("the cap sweeps expired tickets before refusing — TTL expiry alone reopens minting", () => {
  let clock = 2_000_000;
  const t = harness({ maxTickets: 2, now: () => clock });
  try {
    const a = t.ev.mintTicket().ticket;
    t.ev.mintTicket();
    assert.equal(t.ev.mintTicket().code, 429, "full");
    clock += 30_001; // past TICKET_TTL_MS — both entries are now dead weight
    const revived = t.ev.mintTicket();
    assert.match(revived.ticket, /^[0-9a-f]{48}$/, "the sweep reclaimed the expired entries");
    assert.equal(t.ev.consumeTicket(a), false, "the swept ticket is genuinely gone, not merely uncounted");
  } finally { t.cleanup(); }
});

// ── P4 hardening (sr-security LOW) — bounded replay + backpressure ───────────

test("HARDENING one reconnect replays AT MOST 500 frames, not the whole 5000-row log", () => {
  const t = harness();
  try {
    for (let i = 0; i < 620; i++) t.ev.emit("usage.tick", { n: i });
    const c = fakeRes();
    assert.equal(t.ev.subscribe(c, { lastEventId: "1" }), true);
    const frames = c.chunks.filter((s) => s.startsWith("id: "));
    assert.equal(frames.length, 500, "the replay cap bounds a single reconnect's burst");
    // Replay is oldest-first from the watermark: seq 2 in, the newest ones out.
    assert.ok(frames[0].includes('"n":1'), "replay starts just after the watermark");
    assert.ok(!c.text().includes('"n":619'), "the tail beyond the cap is left to onResync");
  } finally { t.cleanup(); }
});

test("HARDENING a replay whose write() returns false PAUSES instead of buffering the rest", () => {
  const t = harness();
  try {
    for (let i = 0; i < 10; i++) t.ev.emit("usage.tick", { n: i });
    const c = fakeRes();
    const drains = [];
    c.once = (ev, fn) => { if (ev === "drain") drains.push(fn); return c; };
    let allowed = 3; // ": open" + 2 frames, then the socket buffer is "full"
    c.write = (s) => { c.chunks.push(s); return allowed-- > 0; };

    assert.doesNotThrow(() => t.ev.subscribe(c, { lastEventId: "1" }), "the write-false path must not throw");
    const framesBefore = c.chunks.filter((s) => s.startsWith("id: ")).length;
    assert.ok(framesBefore < 9, `paused mid-backlog (wrote ${framesBefore})`);
    assert.equal(drains.length, 1, "and registered exactly one drain handler");

    allowed = Infinity;
    drains[0](); // the socket drained
    const framesAfter = c.chunks.filter((s) => s.startsWith("id: ")).length;
    assert.equal(framesAfter, 9, "the remainder is delivered on drain — no frames lost");
  } finally { t.cleanup(); }
});

test("HARDENING a response stand-in with no once/on still replays without throwing", () => {
  const t = harness();
  try {
    for (let i = 0; i < 5; i++) t.ev.emit("usage.tick", { n: i });
    const c = fakeRes();
    c.on = undefined;
    c.write = (s) => { c.chunks.push(s); return false; }; // always congested
    assert.doesNotThrow(() => t.ev.subscribe(c, { lastEventId: "1" }));
  } finally { t.cleanup(); }
});

test("HARDENING a client that disconnects mid-replay stops the pump", () => {
  const t = harness();
  try {
    for (let i = 0; i < 10; i++) t.ev.emit("usage.tick", { n: i });
    const c = fakeRes();
    const drains = [];
    c.once = (ev, fn) => { if (ev === "drain") drains.push(fn); return c; };
    let allowed = 2;
    c.write = (s) => { c.chunks.push(s); return allowed-- > 0; };
    t.ev.subscribe(c, { lastEventId: "1" });
    const framesWhilePaused = c.chunks.filter((s) => s.startsWith("id: ")).length;

    t.ev.closeAll();   // the tab went away
    allowed = Infinity;
    assert.doesNotThrow(() => drains[0]());
    assert.equal(
      c.chunks.filter((s) => s.startsWith("id: ")).length, framesWhilePaused,
      "a deregistered client is written to no further",
    );
  } finally { t.cleanup(); }
});

test("HARDENING task.done is emittable and framed like any other catalog event", () => {
  const t = harness();
  try {
    const c = fakeRes();
    t.ev.subscribe(c, {});
    const seq = t.ev.emit("task.done", { taskId: "task_a", agentId: "web-1", status: "done" });
    assert.match(c.text(), new RegExp(`id: ${seq}\\nevent: task\\.done\\ndata: `));
    assert.equal(t.h.db.prepare("SELECT event FROM events_log WHERE seq = ?").get(seq).event, "task.done");
  } finally { t.cleanup(); }
});
