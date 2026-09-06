// Phase 10 · task 10.1 — HR: THE ONLY THING THAT CREATES AN AGENT WITHOUT THE BOSS.
//
// The whole surface, stated once: HR reads its own mailbox, and the ONLY message it acts on
// is a `hire-request` from the Manager. It creates at most one worker per request, adds it to
// the roster, and answers `hire-done` or `hire-failed`. It talks to nobody else, it initiates
// nothing, and every refusal is REPORTED — a job waiting on a hire that silently failed is
// the failure mode this phase exists inside (Phase 9's #29/#30 were exactly that shape).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHr, WORKER_CAP } from "../hr.mjs";
import { createRoster } from "../roster.mjs";
import { createMailbox } from "../mailbox.mjs";
import { SKILL_CATALOG } from "../factory.mjs";
import { SEED_DIRS } from "../guards.mjs";

const SKILLS = new Set(SKILL_CATALOG.map((c) => c.id));
const ROLES = { "tech-lead": "manager", hr: "hr", qa: "worker", "sr-backend": "worker", ceo: "ceo" };

function harness({ seed = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "hr-"));
  const file = join(dir, "roster.json");
  writeFileSync(file, JSON.stringify({ version: 1, members: seed }), "utf-8");
  process.env.RUNTIME_AGENTS_DIR = dir;
  const events = [];
  const roster = createRoster({
    file, validSkills: SKILLS, seedDirs: SEED_DIRS,
    emit: (n, d) => events.push({ n, d }),
  });
  const mailbox = createMailbox({ root: join(dir, "mail"), roleOf: (id) => ROLES[id] ?? null });
  const logs = [];
  const hr = createHr({ roster, mailbox, log: (r) => logs.push(r) });
  const ask = (over = {}) => {
    const r = mailbox.send({
      from: "tech-lead", to: "hr", kind: "hire-request", jobId: "job_1",
      body: JSON.stringify({ skills: ["notifications"], writeScope: ["src/lib/notifications/**"], reason: "nobody holds it", ...over }),
    });
    assert.ok(!r?.error, r?.error);
    mailbox.route();
  };
  const managerInbox = () => mailbox.read("tech-lead");
  return { dir, roster, mailbox, hr, events, logs, ask, managerInbox };
}

const worker = (id, skills) => ({
  id, name: id, seat: id, role: "worker", skills, writeScope: ["src/**"],
  tools: ["Read", "Write"], createdBy: "seed", createdAt: "2026-01-01T00:00:00.000Z",
});

// ── the happy path ───────────────────────────────────────────────────────────
test("HR-1: a Manager hire-request creates ONE worker with exactly those skills", async () => {
  const h = harness();
  h.ask();
  const out = await h.hr.tick();
  assert.equal(out.hired?.length, 1, JSON.stringify(out));
  const [m] = h.roster.all();
  assert.equal(m.role, "worker");
  assert.deepEqual(m.skills, ["notifications"]);
  assert.equal(m.createdBy, "hr");
});

test("HR-2: it answers the MANAGER with hire-done naming the agent", async () => {
  const h = harness();
  h.ask();
  await h.hr.tick();
  h.mailbox.route();
  const inbox = h.managerInbox();
  const done = inbox.find((m) => m.kind === "hire-done");
  assert.ok(done, `no hire-done: ${JSON.stringify(inbox)}`);
  assert.equal(done.from, "hr");
  assert.equal(done.jobId, "job_1");
  assert.match(done.body, /notifications-engineer/);
});

test("HR-3: the new member is on the roster and roster.changed fired", async () => {
  const h = harness();
  h.ask();
  await h.hr.tick();
  assert.equal(h.roster.all().length, 1);
  assert.ok(h.events.some((e) => e.n === "roster.changed"), "the board learns about a hire from this event");
});

test("HR-4: the Manager's roster.match now finds it — the point of the whole phase", async () => {
  const h = harness();
  h.ask();
  await h.hr.tick();
  assert.deepEqual(h.roster.match(["notifications"]).map((m) => m.id), ["notifications-engineer"]);
});

// ── HR initiates nothing ─────────────────────────────────────────────────────
test("HR-5: an empty inbox creates NOTHING — HR never hires on its own initiative", async () => {
  const h = harness();
  const out = await h.hr.tick();
  assert.equal(out.hired?.length ?? 0, 0);
  assert.equal(h.roster.all().length, 0);
});

test("HR-6: a non-hire-request from the Manager is ignored, not acted on", async () => {
  const h = harness();
  h.mailbox.send({ from: "tech-lead", to: "hr", kind: "status", jobId: "job_1", body: "fyi" });
  h.mailbox.route();
  await h.hr.tick();
  assert.equal(h.roster.all().length, 0);
});

test("HR-7: a hire-request from a NON-manager is refused and creates nothing", async () => {
  const h = harness();
  // The transport already refuses worker → hr (routeAllowed), which is the real control.
  const sent = h.mailbox.send({ from: "qa", to: "hr", kind: "hire-request", jobId: "job_1", body: "{}" });
  assert.ok(sent?.error, "a worker must not be able to mail HR at all");
  // Defense in depth: even if a role changed between send and route, HR checks the sender.
  const out = await h.hr.tick({ inject: [{ from: "qa", to: "hr", kind: "hire-request", jobId: "job_1", body: "{}" }] });
  assert.equal(h.roster.all().length, 0, "HR acted on a request that did not come from the Manager");
  assert.ok((out.refused || []).length >= 1, "a refused request must be reported, never silently dropped");
});

// ── refusals are REPORTED ────────────────────────────────────────────────────
test("HR-8: an unknown skill is hire-failed with a readable reason, and nothing is created", async () => {
  const h = harness();
  h.ask({ skills: ["telepathy"] });
  await h.hr.tick();
  h.mailbox.route();
  const failed = h.managerInbox().find((m) => m.kind === "hire-failed");
  assert.ok(failed, "an unknown skill must come back as hire-failed");
  assert.match(failed.body, /unknown skill/i);
  assert.equal(h.roster.all().length, 0);
});

test("HR-9: a CORE_GUARD writeScope is hire-failed — the privilege never lands", async () => {
  const h = harness();
  h.ask({ writeScope: ["agent-runtime/guards.mjs"] });
  await h.hr.tick();
  h.mailbox.route();
  const failed = h.managerInbox().find((m) => m.kind === "hire-failed");
  assert.ok(failed, "a CORE_GUARD scope must be refused OUT LOUD");
  assert.equal(h.roster.all().length, 0);
});

test("HR-10: a malformed body is hire-failed, never a crash and never a guess", async () => {
  const h = harness();
  h.mailbox.send({ from: "tech-lead", to: "hr", kind: "hire-request", jobId: "job_1", body: "not json at all" });
  h.mailbox.route();
  await h.hr.tick();
  h.mailbox.route();
  assert.ok(h.managerInbox().some((m) => m.kind === "hire-failed"));
  assert.equal(h.roster.all().length, 0);
});

// ── idempotency + the cap ────────────────────────────────────────────────────
test("HR-11: a duplicate request returns the SAME agent — one skill, one specialist", async () => {
  const h = harness();
  h.ask(); await h.hr.tick();
  h.ask(); await h.hr.tick();
  assert.equal(h.roster.all().length, 1, "a repeated request must not mint a second worker");
  h.mailbox.route();
  const dones = h.managerInbox().filter((m) => m.kind === "hire-done");
  assert.equal(dones.length, 2, "both requests are ANSWERED, even though only one agent exists");
});

test("HR-12: an existing member that already covers the skills is REUSED, not duplicated", async () => {
  const h = harness({ seed: [worker("sr-notifier", ["notifications"])] });
  h.ask();
  await h.hr.tick();
  assert.equal(h.roster.all().length, 1, "HR created a duplicate of a seat that already exists");
  h.mailbox.route();
  assert.match(h.managerInbox().find((m) => m.kind === "hire-done").body, /sr-notifier/);
});

test("HR-13: beyond the worker cap it is hire-failed, not an unbounded payroll", async () => {
  const seed = Array.from({ length: WORKER_CAP }, (_, i) => worker(`w${i}`, ["ui"]));
  const h = harness({ seed });
  h.ask();
  await h.hr.tick();
  h.mailbox.route();
  const failed = h.managerInbox().find((m) => m.kind === "hire-failed");
  assert.ok(failed, "the cap must be reported, not silently ignored");
  assert.match(failed.body, /cap/i);
  assert.equal(h.roster.all().length, WORKER_CAP);
});

test("HR-14: the cap counts WORKERS, not stations — hiring is not blocked by the org chart", async () => {
  const stations = Array.from({ length: WORKER_CAP }, (_, i) => ({
    ...worker(`s${i}`, ["repo-read"]), role: "station", writeScope: [],
  }));
  const h = harness({ seed: stations });
  h.ask();
  await h.hr.tick();
  assert.equal(h.roster.all().length, WORKER_CAP + 1, "stations must not consume the worker budget");
});

test("HR-15: the hire's identity file is written where the runtime looks for it", async () => {
  const h = harness();
  h.ask();
  await h.hr.tick();
  assert.ok(existsSync(join(h.dir, "notifications-engineer.md")), "no identity document for the new seat");
});
