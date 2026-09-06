// Phase 1 / R4 — doctor tests.
//
// The load-bearing test is OUTAGE-1: the exact live condition that blocked this install
// for three days must produce a FAIL with an actionable fix naming the Accounts page.

import test from "node:test";
import assert from "node:assert/strict";
import { createDoctor, renderDoctor, MIN_NODE_MAJOR } from "../doctor.mjs";

const healthy = {
  nodeVersion: () => "v22.1.0",
  which: async (b) => (b === "gh" ? "/opt/homebrew/bin/gh" : null),
  run: async () => ({ ok: true, stdout: "Logged in" }),
  readiness: async () => ({ standing: "runs", accountId: "acct-1" }),
  guard: { status: async () => ({ ok: true, reason: "clear", availPct: 20, loadPerCore: 0.5, minAvailPct: 10 }) },
  db: { open: true, path: "/tmp/mission.db", wal: true },
  ports: async () => ({ 3004: "listening", 3005: "listening" }),
  repoRoot: async () => ({ path: "/repo", isGit: true }),
  cadenceConfig: async () => ({ ok: true, workers: 3 }),
  embedModel: async () => ({ present: true }),
  encryption: async () => ({ enabled: true, keyPresent: true }),
  selfGrade: async () => ({ score: 100, grade: "A", findings: [], checked: ["policy", "quality"], worst: null }),
  hooks: async () => [
    { event: "pre-task", enabled: true, canVeto: true, handlers: ["guard"] },
    { event: "post-task", enabled: true, canVeto: false, handlers: [] },
  ],
  // D8 — a healthy install is one whose loop has actually FINISHED something. Adding the
  // seam here is the point of the check: "healthy" that never completed a task is the
  // exact report this install produced while 42 runs died at the quality gate.
  throughput: () => ({ done: 9, failed: 1, held: 0, windowDays: 7 }),
  // #8 — a healthy install is also one whose endpoint is answering.
  providerCooldown: () => [],
  // Phase 14 / 14.2 — a healthy install is also one whose MANAGER LOOP is alive. The fixture
  // grows with the check set on purpose: leaving these unwired would make "healthy" mean
  // "healthy apart from the four things that stop every job", which is what this check set
  // exists to stop being possible.
  managerTick: () => ({ lastTickMs: Date.now() - 1_000, heartbeatMs: 60_000, liveJobs: 2 }),
  mailbox: () => ({ undelivered: 0 }),
  rosterHealth: () => ({ ok: true, members: 12, workers: 9 }),
  hrHealth: () => ({ workers: 9, cap: 20 }),
};

const find = (r, id) => r.checks.find((c) => c.id === id);

test("a healthy install reports ok across the board", async () => {
  const r = await createDoctor(healthy).run();
  assert.equal(r.status, "ok");
  assert.equal(r.summary.fail, 0);
  assert.equal(r.summary.warn, 0);
});

test("OUTAGE-1: no active account is a FAIL naming the Accounts page", async () => {
  const r = await createDoctor({ ...healthy, readiness: async () => ({ standing: "none" }) }).run();
  const acct = find(r, "account");
  assert.equal(acct.status, "fail");
  assert.match(acct.detail, /NO ACTIVE ACCOUNT/);
  assert.match(acct.detail, /spawn/i, "must connect to the observed failure mode");
  assert.match(acct.fix, /Accounts/);
  assert.equal(r.status, "fail", "whole report must be fail — this blocks all useful work");
  // and the fix must be surfaced in the fixes list the CLI prints
  assert.ok(r.fixes.some((f) => f.id === "account"));
});

test("OUTAGE-1b: the rendered CLI output states the problem and the fix", async () => {
  const r = await createDoctor({ ...healthy, readiness: async () => ({ standing: "none" }) }).run();
  const out = renderDoctor(r);
  assert.match(out, /✗ Active account/);
  assert.match(out, /Fixes:/);
  assert.match(out, /Accounts/);
});

test("backend mismatch fails with a transport-specific fix", async () => {
  const r = await createDoctor({ ...healthy, readiness: async () => ({ standing: "backend", accountId: "a2" }) }).run();
  assert.equal(find(r, "account").status, "fail");
  assert.match(find(r, "account").fix, /RUNTIME_BACKEND/);
});

test("unmeasured / cannot / deterministic are warns, not fails", async () => {
  for (const standing of ["unmeasured", "cannot", "deterministic"]) {
    const r = await createDoctor({ ...healthy, readiness: async () => ({ standing, accountId: "a" }) }).run();
    assert.equal(find(r, "account").status, "warn", `${standing} should warn`);
  }
});

test("missing gh warns and explains the local-branch fallback", async () => {
  const r = await createDoctor({ ...healthy, which: async () => null }).run();
  const gh = find(r, "gh");
  assert.equal(gh.status, "warn");
  assert.match(gh.detail, /LOCAL BRANCH/);
  assert.match(gh.fix, /gh auth login/);
});

test("gh present but unauthenticated warns", async () => {
  const r = await createDoctor({ ...healthy, run: async () => ({ ok: false, stdout: "" }) }).run();
  assert.match(find(r, "gh").detail, /not authenticated/);
});

test("old node fails", async () => {
  const r = await createDoctor({ ...healthy, nodeVersion: () => "v18.4.0" }).run();
  assert.equal(find(r, "node").status, "fail");
  assert.match(find(r, "node").detail, new RegExp(String(MIN_NODE_MAJOR)));
});

test("unopenable db fails", async () => {
  const r = await createDoctor({ ...healthy, db: { open: false, path: "/nope/x.db" } }).run();
  assert.equal(find(r, "db").status, "fail");
});

test("R2 wiring: invalid cadence config FAILS — silent no-workers is the outage class", async () => {
  const r = await createDoctor({ ...healthy, cadenceConfig: async () => ({ ok: false, error: "bad JSON at line 3" }) }).run();
  const c = find(r, "cadence");
  assert.equal(c.status, "fail");
  assert.match(c.detail, /NO background workers/);
  assert.match(c.detail, /bad JSON/);
});

test("R2 wiring: zero enabled cadences warns that the Inbox will not fill itself", async () => {
  const r = await createDoctor({ ...healthy, cadenceConfig: async () => ({ ok: true, workers: 0 }) }).run();
  assert.equal(find(r, "cadence").status, "warn");
  assert.match(find(r, "cadence").detail, /will not fill itself/);
});

test("R6 wiring: absent embedding model warns about silent retrieval degradation", async () => {
  const r = await createDoctor({ ...healthy, embedModel: async () => ({ present: false }) }).run();
  const e = find(r, "embeddings");
  assert.equal(e.status, "warn");
  assert.match(e.detail, /degrades/);
});

test("R13 wiring: encryption enabled with a missing key is FAIL, never silent plaintext", async () => {
  const r = await createDoctor({ ...healthy, encryption: async () => ({ enabled: true, keyPresent: false }) }).run();
  const e = find(r, "encryption");
  assert.equal(e.status, "fail");
  assert.match(e.detail, /fail-closed, never plaintext/);
});

test("guard deferral surfaces as a warn with the measured numbers", async () => {
  const r = await createDoctor({
    ...healthy,
    guard: { status: async () => ({ ok: false, reason: "memory", availPct: 4, minAvailPct: 10, loadPerCore: 0.3 }) },
  }).run();
  assert.equal(find(r, "guard").status, "warn");
  assert.match(find(r, "guard").detail, /4%/);
});

test("a throwing probe becomes a warn, never a crash — doctor runs on broken systems", async () => {
  const r = await createDoctor({
    ...healthy,
    readiness: async () => { throw new Error("credentials store corrupt"); },
  }).run();
  assert.equal(find(r, "account").status, "warn");
  assert.match(find(r, "account").detail, /credentials store corrupt/);
  assert.ok(r.status === "warn" || r.status === "fail");
});

test("unwired probes degrade to warn rather than pretending ok", async () => {
  const r = await createDoctor({ nodeVersion: () => "v22.0.0" }).run();
  assert.equal(find(r, "account").status, "warn");
  assert.equal(find(r, "db").status, "warn");
  assert.equal(find(r, "node").status, "ok");
});

test("R1 wiring: all-disabled hooks warn — nothing guards a run", async () => {
  const r = await createDoctor({ ...healthy, hooks: async () => [
    { event: "pre-task", enabled: false, canVeto: true, handlers: ["guard"] },
    { event: "post-task", enabled: false, canVeto: false, handlers: [] },
  ] }).run();
  const h = find(r, "hooks");
  assert.equal(h.status, "warn");
  assert.match(h.detail, /DISABLED/);
});

test("R1 wiring: enabled events with NO handler is a WARN, not a clean bill", async () => {
  // The gap this closes: for the whole of R1 the dispatcher was wired and enabled while
  // NOTHING was registered on it. Doctor said "5/5 events enabled" and graded that ok — a
  // veto path with no user reads, from outside, exactly like a guarded install. An event
  // that is enabled and empty guards nothing, and the report must say so.
  const r = await createDoctor({ ...healthy, hooks: async () => [
    { event: "pre-task", enabled: true, canVeto: true, handlers: [] },
    { event: "post-edit", enabled: true, canVeto: true, handlers: [] },
  ] }).run();
  const h = find(r, "hooks");
  assert.equal(h.status, "warn");
  assert.match(h.detail, /no handler/i);
  assert.ok(h.fix, "a warn must carry an actionable fix");
});

test("R1 wiring: enabled hooks report their counts", async () => {
  const r = await createDoctor(healthy).run();
  const h = find(r, "hooks");
  assert.equal(h.status, "ok");
  assert.match(h.detail, /2\/2 events enabled/);
});

test("no check ever leaks a secret value", async () => {
  const r = await createDoctor({
    ...healthy,
    readiness: async () => ({ standing: "runs", accountId: "acct-1", secret: "sk-ant-SHOULD-NEVER-APPEAR" }),
  }).run();
  assert.ok(!JSON.stringify(r).includes("sk-ant-"), "doctor output must never carry a credential");
});

// ── D8 — THE CHECK THAT WOULD HAVE CAUGHT ALL OF THIS ────────────────────────────
// On 2026-08-24 the doctor reported `status: warn` with `account: ok — 'active' ready
// (runs)` on an install whose engine had completed ZERO tasks and failed 42. Every check
// asked about a PRECONDITION; none asked the only outcome question that matters — has the
// loop ever actually finished anything? A precondition report that is green while the
// product does nothing is the exact failure mode doctor was built to end.
test("THROUGHPUT-1: failures with no completions is a FAIL, not a silent pass", async () => {
  const d = createDoctor({ throughput: () => ({ done: 0, failed: 42, held: 13, windowDays: 7 }) });
  const r = await d.run();
  const c = r.checks.find((x) => x.id === "throughput");
  assert.ok(c, "the report must carry a throughput check");
  assert.equal(c.status, "fail", "0 done + 42 failed is the loop being dead");
  assert.match(c.detail, /0 completed/i);
  assert.ok(c.fix, "a failing check must tell the operator what to do");
  assert.equal(r.status, "fail", "and it must dominate the overall verdict");
});

test("THROUGHPUT-2: completions make it ok", async () => {
  const d = createDoctor({ throughput: () => ({ done: 6, failed: 2, held: 1, windowDays: 7 }) });
  const c = (await d.run()).checks.find((x) => x.id === "throughput");
  assert.equal(c.status, "ok");
  assert.match(c.detail, /6 completed/i);
});

test("THROUGHPUT-3: an idle install is a warn, never a fail — nothing was asked of it", async () => {
  const d = createDoctor({ throughput: () => ({ done: 0, failed: 0, held: 0, windowDays: 7 }) });
  const c = (await d.run()).checks.find((x) => x.id === "throughput");
  assert.equal(c.status, "warn");
  assert.match(c.detail, /no engine task/i);
});

test("THROUGHPUT-4: held-only work is a warn that names the operator as the blocker", async () => {
  const d = createDoctor({ throughput: () => ({ done: 0, failed: 0, held: 5, windowDays: 7 }) });
  const c = (await d.run()).checks.find((x) => x.id === "throughput");
  assert.equal(c.status, "warn");
  assert.match(c.detail, /awaiting/i);
});

test("THROUGHPUT-5: an unwired probe warns rather than crashing the report", async () => {
  const c = (await createDoctor({}).run()).checks.find((x) => x.id === "throughput");
  assert.equal(c.status, "warn");
  assert.match(c.detail, /not wired/i);
});

// ── #8 — "why is nothing happening" now includes "the endpoint is refusing everyone" ──
// Live on 2026-08-24 the honest answer to that question was a rate-limited provider, and
// the report had no way to say so: every check was green while every call 429'd.
test("PROVIDER-1: an endpoint in cooldown is a WARN that names the wait and the reason", async () => {
  const d = createDoctor({
    ...healthy,
    providerCooldown: () => ([{ key: "acct-1", label: "OX Alpha", consecutive: 3, remainingMs: 90_000, reason: "HTTP 429 rate-limited upstream" }]),
  });
  const r = await d.run();
  const c = r.checks.find((x) => x.id === "provider");
  assert.equal(c.status, "warn", "the loop still works; the provider is busy — not a fail");
  assert.match(c.detail, /OX Alpha/);
  assert.match(c.detail, /90s|9\ds/, "the operator is told how long");
  assert.match(c.detail, /429|rate/i, "and why");
  assert.ok(c.fix);
});

test("PROVIDER-2: an endpoint that is answering is ok and says nothing alarming", async () => {
  const c = (await createDoctor({ ...healthy, providerCooldown: () => [] }).run()).checks.find((x) => x.id === "provider");
  assert.equal(c.status, "ok");
  assert.match(c.detail, /answering|no provider/i);
});

test("PROVIDER-3: an unwired probe warns rather than crashing the report", async () => {
  const c = (await createDoctor({}).run()).checks.find((x) => x.id === "provider");
  assert.equal(c.status, "warn");
  assert.match(c.detail, /not wired/i);
});
