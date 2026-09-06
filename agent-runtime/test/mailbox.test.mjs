// Phase 8 · task 8.1 — the MAILBOX. Workers talk to each other without the human.
//
// SECURITY POSTURE, stated once. A mail body is AGENT-AUTHORED text that ends up inside
// ANOTHER agent's prompt, so it is treated exactly like the SKILL bodies in 7.3: capped,
// scrubbed, and fenced as DATA. `from` is bound by the CALLER (the runtime knows which seat
// it spawned); a `from` supplied in the payload is ignored, never trusted.
//
// SINGLE WRITER: send() writes only into the SENDER's outbox, route() only moves outbox →
// inbox. No two writers ever touch one file, so there is no lock and no lost update.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMailbox, MAIL_KINDS, MAX_BODY_BYTES, MAX_THREAD, routeAllowed } from "../mailbox.mjs";

const ROLES = {
  "tech-lead": "manager", ceo: "ceo", hr: "hr",
  "sr-frontend": "worker", "sr-backend": "worker", qa: "worker",
  reviewer: "station",
};
const mk = (over = {}) => createMailbox({
  root: mkdtempSync(join(tmpdir(), "ma-mail-")),
  roleOf: (id) => ROLES[id] ?? null,
  scrub: (t) => t,
  ...over,
});

// ── the rules table ──────────────────────────────────────────────────────────
test("MAIL-RULE-1: worker ↔ worker is allowed", () => {
  assert.equal(routeAllowed("worker", "worker"), true);
});

test("MAIL-RULE-2: worker → manager is allowed; manager → worker is allowed", () => {
  assert.equal(routeAllowed("worker", "manager"), true);
  assert.equal(routeAllowed("manager", "worker"), true);
});

test("MAIL-RULE-3: manager ↔ hr is allowed", () => {
  assert.equal(routeAllowed("manager", "hr"), true);
  assert.equal(routeAllowed("hr", "manager"), true);
});

test("MAIL-RULE-4: NOBODY writes to the ceo — BOSS hears from the Manager via Job state", () => {
  for (const from of ["worker", "manager", "hr", "station", "ceo"]) {
    assert.equal(routeAllowed(from, "ceo"), false, `${from} → ceo must be refused`);
  }
});

test("MAIL-RULE-4b: the ALLOWED table itself never names the ceo, in either direction", () => {
  // MAIL-RULE-4 alone passes whether the ceo is refused by an explicit guard or merely by
  // falling off the end of the allow-list. This pins the stronger property: across the whole
  // role cross-product there is NO pair involving a ceo that is allowed. A future edit that
  // adds one — the realistic mistake — fails here even if the explicit guard is still present.
  const ROLE_SET = ["worker", "manager", "hr", "station", "ceo"];
  const allowedPairs = [];
  for (const a of ROLE_SET) for (const b of ROLE_SET) if (routeAllowed(a, b)) allowedPairs.push(`${a}->${b}`);
  assert.deepEqual(allowedPairs.filter((p) => p.includes("ceo")), [],
    `no allowed pair may involve the ceo; got ${JSON.stringify(allowedPairs)}`);
  // Non-vacuity: the table must actually allow something, or this asserts nothing.
  assert.deepEqual(allowedPairs.sort(),
    ["hr->manager", "manager->hr", "manager->worker", "worker->manager", "worker->worker"]);
});

test("MAIL-RULE-5: a worker cannot reach hr directly — hiring goes through the Manager", () => {
  assert.equal(routeAllowed("worker", "hr"), false);
  assert.equal(routeAllowed("hr", "worker"), false);
});

test("MAIL-RULE-6: an unknown role is refused, never defaulted", () => {
  assert.equal(routeAllowed(null, "worker"), false);
  assert.equal(routeAllowed("worker", null), false);
  assert.equal(routeAllowed("wizard", "worker"), false);
});

// ── send ─────────────────────────────────────────────────────────────────────
test("MAIL-SEND-1: send writes into the SENDER's outbox only", () => {
  const mb = mk();
  const r = mb.send({ from: "sr-frontend", to: "sr-backend", kind: "question", body: "endpoint name?", jobId: "job_1" });
  assert.equal(r.error, undefined, `send refused: ${r.error}`);
  assert.equal(mb.outboxCount("sr-frontend"), 1);
  assert.equal(mb.inboxCount("sr-backend"), 0, "route() moves it, not send()");
  assert.equal(mb.inboxCount("sr-frontend"), 0);
});

test("MAIL-SEND-2: `from` is bound by the caller — a forged from in the payload is ignored", () => {
  const mb = mk();
  // The runtime passes the identity it spawned; anything the model puts in the body is data.
  const r = mb.send({ from: "sr-frontend", to: "sr-backend", kind: "question", body: "x",
    jobId: "job_1", extra: { from: "tech-lead" } });
  assert.equal(r.from, "sr-frontend", "the bound identity wins over anything in the payload");
});

test("MAIL-SEND-3: an unknown kind is refused", () => {
  const mb = mk();
  assert.ok(mb.send({ from: "sr-frontend", to: "sr-backend", kind: "exfiltrate", body: "x", jobId: "j" }).error);
  for (const k of MAIL_KINDS) {
    assert.equal(mb.send({ from: "sr-frontend", to: "sr-backend", kind: k, body: "x", jobId: "j" }).error, undefined, k);
  }
});

test("MAIL-SEND-4: a body over the cap is TRUNCATED and says so, never silently cut", () => {
  const mb = mk();
  const r = mb.send({ from: "sr-frontend", to: "sr-backend", kind: "status", body: "x".repeat(MAX_BODY_BYTES * 3), jobId: "j" });
  assert.ok(Buffer.byteLength(r.body, "utf8") <= MAX_BODY_BYTES + 80);
  assert.match(r.body, /truncated/i);
});

test("MAIL-SEND-5: the injected scrub runs on every body", () => {
  const mb = mk({ scrub: (t) => t.replace(/sk-live-\S+/g, "[REDACTED]") });
  const r = mb.send({ from: "sr-frontend", to: "sr-backend", kind: "status", body: "key sk-live-DEADBEEF here", jobId: "j" });
  assert.equal(r.body.includes("sk-live-DEADBEEF"), false, "a mail body reaches another agent's prompt");
  assert.match(r.body, /\[REDACTED\]/);
});

test("MAIL-SEND-6: a disallowed pair is refused at send time and writes nothing", () => {
  const mb = mk();
  const r = mb.send({ from: "sr-frontend", to: "ceo", kind: "status", body: "hi", jobId: "j" });
  assert.ok(r.error, "worker → ceo must be refused");
  assert.equal(mb.outboxCount("sr-frontend"), 0, "a refused send must not touch the store");
});

test("MAIL-SEND-7b: a traversing id creates NOTHING outside the mailbox root", () => {
  // The charset check is what makes an id safe as a PATH SEGMENT. Refusal alone is not the
  // property — roleOf() also refuses an unknown id — so this asserts the filesystem instead.
  //
  // The escape target lives inside a DEDICATED parent, not the shared tmpdir: a first version
  // aimed at `join(root, "..", "ESCAPED")`, so the directory a mutation run created survived
  // into the next run and failed the restored code. A test must not leave state that changes
  // the next run's verdict.
  const parent = mkdtempSync(join(tmpdir(), "ma-mail-jail-"));
  const root = join(parent, "root");
  mkdirSync(root, { recursive: true });
  const mb = createMailbox({ root, roleOf: () => "worker", scrub: (t) => t });
  mb.send({ from: "../ESCAPED", to: "sr-backend", kind: "status", body: "x", jobId: "j" });
  mb.send({ from: "sr-frontend", to: "../ESCAPED", kind: "status", body: "x", jobId: "j" });
  mb.route();
  assert.deepEqual(readdirSync(parent), ["root"], "no id may become a path segment outside the root");
  assert.deepEqual(readdirSync(root), [], "and nothing at all should have been written");
});

test("MAIL-SEND-7: an agentId that is not a path segment is refused", () => {
  const mb = mk();
  for (const bad of ["../../etc", "a/b", ".", "..", ""]) {
    assert.ok(mb.send({ from: bad, to: "sr-backend", kind: "status", body: "x", jobId: "j" }).error, bad);
    assert.ok(mb.send({ from: "sr-frontend", to: bad, kind: "status", body: "x", jobId: "j" }).error, bad);
  }
});

// ── route ────────────────────────────────────────────────────────────────────
test("MAIL-ROUTE-1: route moves outbox → recipient inbox and logs one row", () => {
  const rows = [];
  const mb = mk({ log: (r) => rows.push(r) });
  mb.send({ from: "sr-frontend", to: "sr-backend", kind: "handoff", body: "yours now", jobId: "job_1" });
  const moved = mb.route();
  assert.equal(moved, 1);
  assert.equal(mb.outboxCount("sr-frontend"), 0);
  assert.equal(mb.inboxCount("sr-backend"), 1);
  assert.equal(rows.length, 1);
  assert.deepEqual(
    { event: rows[0].event, byAgent: rows[0].byAgent, toAgent: rows[0].toAgent, ref: rows[0].ref },
    { event: "mail", byAgent: "sr-frontend", toAgent: "sr-backend", ref: "handoff" });
});

test("MAIL-ROUTE-2: route emits the `mail` SSE name declared in 7.0b", () => {
  const seen = [];
  const mb = mk({ emit: (n, p) => seen.push([n, p]) });
  mb.send({ from: "sr-frontend", to: "sr-backend", kind: "handoff", body: "b", jobId: "j" });
  mb.route();
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], "mail");
  assert.equal(seen[0][1].body, undefined, "identity only on the bus — the body stays behind the gated read");
});

test("MAIL-ROUTE-3: route is IDEMPOTENT — a second call moves nothing", () => {
  const mb = mk();
  mb.send({ from: "sr-frontend", to: "sr-backend", kind: "status", body: "b", jobId: "j" });
  assert.equal(mb.route(), 1);
  assert.equal(mb.route(), 0, "a heartbeat runs this constantly; re-delivery would duplicate work");
  assert.equal(mb.inboxCount("sr-backend"), 1);
});

test("MAIL-ROUTE-4: status/blocked/done are COPIED to the manager as well", () => {
  const mb = mk();
  mb.send({ from: "sr-frontend", to: "sr-backend", kind: "blocked", body: "stuck", jobId: "j" });
  mb.route();
  assert.equal(mb.inboxCount("sr-backend"), 1, "the addressee still gets it");
  assert.equal(mb.inboxCount("tech-lead"), 1, "and the Manager is kept informed");
});

test("MAIL-ROUTE-5: a question is NOT copied to the manager (only status|blocked|done are)", () => {
  const mb = mk();
  mb.send({ from: "sr-frontend", to: "sr-backend", kind: "question", body: "?", jobId: "j" });
  mb.route();
  assert.equal(mb.inboxCount("tech-lead"), 0);
});

test("MAIL-ROUTE-6: a message that became disallowed since send is DROPPED with a log row", () => {
  const rows = [];
  const roles = { ...ROLES };
  const mb = mk({ roleOf: (id) => roles[id] ?? null, log: (r) => rows.push(r) });
  mb.send({ from: "sr-frontend", to: "sr-backend", kind: "handoff", body: "b", jobId: "j" });
  roles["sr-backend"] = "ceo"; // the pair is no longer allowed
  assert.equal(mb.route(), 0);
  assert.equal(mb.inboxCount("sr-backend"), 0);
  assert.equal(rows.at(-1).event, "mail-refused");
});

// ── read ─────────────────────────────────────────────────────────────────────
test("MAIL-READ-1: read returns newest-last and ARCHIVES, so a seat never re-reads", () => {
  const mb = mk();
  mb.send({ from: "sr-frontend", to: "sr-backend", kind: "status", body: "one", jobId: "j" });
  mb.route();
  const got = mb.read("sr-backend");
  assert.equal(got.length, 1);
  assert.equal(got[0].body, "one");
  assert.deepEqual(mb.read("sr-backend"), [], "a second read is empty — messages are archived");
  assert.equal(mb.inboxCount("sr-backend"), 0);
});

test("MAIL-READ-2: reading an empty / unknown inbox is [] and never throws", () => {
  const mb = mk();
  assert.deepEqual(mb.read("sr-backend"), []);
  assert.deepEqual(mb.read("nobody"), []);
});

test("MAIL-READ-3: a message carries its full envelope", () => {
  const mb = mk();
  mb.send({ from: "sr-frontend", to: "sr-backend", kind: "handoff", body: "b", jobId: "job_9", taskId: "task_9" });
  mb.route();
  const [m] = mb.read("sr-backend");
  assert.match(m.id, /^[0-9A-HJKMNP-TV-Z]{26}$/, "ulid");
  assert.deepEqual(
    { from: m.from, to: m.to, kind: m.kind, jobId: m.jobId, taskId: m.taskId },
    { from: "sr-frontend", to: "sr-backend", kind: "handoff", jobId: "job_9", taskId: "task_9" });
  assert.ok(Number.isFinite(m.at));
});

test("MAIL-SINGLE-WRITER: two senders to the same recipient never collide", () => {
  const mb = mk();
  for (let i = 0; i < 25; i++) {
    mb.send({ from: "sr-frontend", to: "qa", kind: "status", body: `fe${i}`, jobId: "j" });
    mb.send({ from: "sr-backend", to: "qa", kind: "status", body: `be${i}`, jobId: "j" });
  }
  mb.route();
  const got = mb.read("qa");
  assert.equal(got.length, 50, "every message survives — no lost update");
  assert.equal(new Set(got.map((m) => m.id)).size, 50, "and every id is unique");
});

// ── the runtime's own signal (Phase 9) ───────────────────────────────────────
test("MAIL-RULE-7: `system` may mail the Manager, and NOTHING else", () => {
  // The runtime reports a terminal task outcome so a job never waits on news a crashed seat
  // cannot send. It is the narrowest rule in the table and no seat can hold the role.
  assert.equal(routeAllowed("system", "manager"), true);
  for (const to of ["worker", "hr", "ceo", "station", "system"]) {
    assert.equal(routeAllowed("system", to), false, `system → ${to} must be refused`);
  }
  for (const from of ["worker", "manager", "hr", "station"]) {
    assert.equal(routeAllowed(from, "system"), false, `${from} → system must be refused`);
  }
});

test("MAIL-RULE-7b: adding `system` did not widen anything else", () => {
  const ROLE_SET = ["worker", "manager", "hr", "station", "ceo", "system"];
  const allowed = [];
  for (const a of ROLE_SET) for (const b of ROLE_SET) if (routeAllowed(a, b)) allowed.push(`${a}->${b}`);
  assert.deepEqual(allowed.sort(),
    ["hr->manager", "manager->hr", "manager->worker", "system->manager", "worker->manager", "worker->worker"]);
});

test("MB-GOAL-1: goalId survives send -> route -> read", () => {
  // The transport is the third end of this fix. server.mjs put goalId on the signal and
  // manager.mjs read it, but `send()` destructured a fixed field list and dropped it on the
  // floor — so the live scenario-2 blocked signal arrived with taskId only, could not be
  // joined to its job task (the engine had re-minted the id on retry), and was archived
  // unhandled. Both other ends looked correct in review (addendum #4).
  const dir = mkdtempSync(join(tmpdir(), "mb-goal-"));
  const mb = createMailbox({ root: dir, roleOf: (id) => (id === "engine" ? "system" : "manager") });
  const r = mb.send({ from: "engine", to: "tech-lead", kind: "blocked",
    jobId: "job_1", taskId: "task_attempt3", goalId: "goal_stable", body: "terminal failure" });
  assert.ok(!r?.error, r?.error);
  mb.route();
  const [msg] = mb.read("tech-lead");
  assert.equal(msg.goalId, "goal_stable", "goalId must survive the transport, not just the sender");
  assert.equal(msg.taskId, "task_attempt3");
});

test("MB-PATHS-1: changedPaths and deliveryId survive send -> route -> read", () => {
  // Same shape as MB-GOAL-1, same lesson (addendum #30): a field is only carried if the
  // TRANSPORT carries it. `send()` destructures a fixed list, so the engine's `done` signal
  // arrived without the files it named — the review turn then reported "0 files changed" and
  // `manager.ship` would have committed nothing while still reporting the job shipped.
  const dir = mkdtempSync(join(tmpdir(), "mb-paths-"));
  const mb = createMailbox({ root: dir, roleOf: (id) => (id === "engine" ? "system" : "manager") });
  const r = mb.send({ from: "engine", to: "tech-lead", kind: "done", jobId: "job_1", taskId: "task_1",
    changedPaths: ["src/lib/x.ts"], deliveryId: "01DELIV", body: "held" });
  assert.ok(!r?.error, r?.error);
  mb.route();
  const [msg] = mb.read("tech-lead");
  assert.deepEqual(msg.changedPaths, ["src/lib/x.ts"], "the files the task changed did not survive the transport");
  assert.equal(msg.deliveryId, "01DELIV");
});

// ── Phase 12 · task 12.2 — the JOB THREAD ────────────────────────────────────
//
// The board's drawer shows the conversation that produced a job. It could not: the server's
// `log` sink calls `stories.appendMailLog(row.jobId, …)`, which begins
// `if (!getStory(storyId)) return null` — and a JOB IS NOT A STORY. Every mail row belonging to
// a Job has been dropped on the floor since Phase 8, silently, because the sink is wrapped in
// `catch { /* logging must never fail a delivery */ }`. Addendum #1: the write site looked
// correct and there was no reader to notice.
//
// The fix reads mail from the place mail already lives, rather than a second store that could
// disagree with the first. `read()` ARCHIVES what it returns, so the thread must scan BOTH the
// inbox and the archive — and must not archive anything itself, or opening the drawer would
// consume the Manager's unread mail.

test("MB-THREAD-1: the thread carries a job's messages from BOTH inbox and archive", () => {
  const mb = mk();
  mb.send({ from: "sr-backend", to: "tech-lead", kind: "done", body: "first", jobId: "job_x" });
  mb.route();
  mb.read("tech-lead");                       // archives the first message
  mb.send({ from: "sr-backend", to: "tech-lead", kind: "status", body: "second", jobId: "job_x" });
  mb.route();                                 // the second is still in the inbox
  const t = mb.thread("job_x");
  assert.deepEqual(t.map((m) => m.body), ["first", "second"],
    "a thread that only reads the inbox loses every message the Manager already read");
});

test("MB-THREAD-2: reading the thread is NON-DESTRUCTIVE — it never eats unread mail", () => {
  const mb = mk();
  mb.send({ from: "sr-backend", to: "tech-lead", kind: "done", body: "unread", jobId: "job_y" });
  mb.route();
  mb.thread("job_y");
  mb.thread("job_y");
  assert.equal(mb.inboxCount("tech-lead"), 1, "opening the drawer archived the Manager's mail");
  assert.equal(mb.read("tech-lead").length, 1, "the Manager lost a message to a board refresh");
});

test("MB-THREAD-3: another job's messages are not in this job's thread", () => {
  const mb = mk();
  mb.send({ from: "sr-backend", to: "tech-lead", kind: "done", body: "mine", jobId: "job_a" });
  mb.send({ from: "sr-backend", to: "tech-lead", kind: "done", body: "theirs", jobId: "job_b" });
  mb.route();
  assert.deepEqual(mb.thread("job_a").map((m) => m.body), ["mine"]);
  assert.deepEqual(mb.thread("job_b").map((m) => m.body), ["theirs"]);
});

test("MB-THREAD-4: a thread with no jobId, or an unknown job, is EMPTY — never everything", () => {
  const mb = mk();
  mb.send({ from: "sr-backend", to: "tech-lead", kind: "done", body: "x", jobId: "job_a" });
  mb.route();
  assert.deepEqual(mb.thread(""), [], "an empty id must not match every message ever sent");
  assert.deepEqual(mb.thread("job_nope"), []);
});

test("MB-THREAD-5: the thread is BOUNDED and oldest-first", () => {
  const mb = mk();
  for (let i = 0; i < 260; i += 1) {
    mb.send({ from: "sr-backend", to: "tech-lead", kind: "status", body: `m${i}`, jobId: "job_big" });
  }
  mb.route();
  const t = mb.thread("job_big");
  assert.ok(t.length <= MAX_THREAD, `the thread returned ${t.length} rows — a drawer is not a log file`);
  // Oldest-first: a conversation reads forward. The CAP keeps the MOST RECENT, because the
  // newest exchange is what the operator opened the drawer for.
  const idx = t.map((m) => Number(String(m.body).slice(1)));
  assert.deepEqual([...idx].sort((a, b) => a - b), idx, "the thread is out of order");
  assert.equal(idx[idx.length - 1], 259, "the cap dropped the NEWEST messages instead of the oldest");
});
