// Phase 14 · task 14.2 — DOCTOR LEARNS THE MANAGER LOOP.
//
// Before this, `npm run doctor` could report a fully green runtime while the Manager had not
// ticked in an hour, the mailbox was silently backing up, roster.json was unparseable and HR
// was at its hiring cap. Every one of those stops the loop dead and none of them had a check,
// so the first symptom was a job that never moved and an operator with nothing to read.
//
// EACH CHECK IS TESTED BOTH WAYS — the failing state AND the recovered one. A check that has
// only ever been seen red is a check nobody has watched turn green, and it is the green that
// an operator acts on.
import { test } from "node:test";
import assert from "node:assert/strict";

import { createDoctor } from "../doctor.mjs";

const find = (report, id) => report.checks.find((c) => c.id === id);
const run = (deps) => createDoctor(deps).run();

test("DOC-MGR-1: an unwired manager probe WARNS — it never reports ok on no evidence", async () => {
  assert.equal(find(await run({}), "manager").status, "warn");
});

test("DOC-MGR-2: a Manager that has not ticked within 2 heartbeats FAILS", async () => {
  const r = await run({ managerTick: () => ({ lastTickMs: Date.now() - 60_000, heartbeatMs: 10_000, liveJobs: 3 }) });
  const c = find(r, "manager");
  assert.equal(c.status, "fail", "a stalled Manager loop is not a warning — no job can move");
  assert.match(c.detail, /60s|60 s|1m/i, "the operator must be told HOW stale, not merely that it is");
  assert.ok(c.fix, "a fail with no fix is an alarm with no action");
});

test("DOC-MGR-3: a recent tick is ok — the check turns green, not just red", async () => {
  const c = find(await run({ managerTick: () => ({ lastTickMs: Date.now() - 2_000, heartbeatMs: 10_000, liveJobs: 1 }) }), "manager");
  assert.equal(c.status, "ok");
});

test("DOC-MGR-4: NO live jobs and no tick is ok — an idle loop is not a broken one", async () => {
  const c = find(await run({ managerTick: () => ({ lastTickMs: 0, heartbeatMs: 10_000, liveJobs: 0 }) }), "manager");
  assert.equal(c.status, "ok", "an install with nothing queued must not read as a dead Manager");
});

test("DOC-MAIL-1: a backed-up mailbox WARNS with the count", async () => {
  const c = find(await run({ mailbox: () => ({ undelivered: 120 }) }), "mailbox");
  assert.equal(c.status, "warn");
  assert.match(c.detail, /120/);
});

test("DOC-MAIL-2: a quiet mailbox is ok", async () => {
  assert.equal(find(await run({ mailbox: () => ({ undelivered: 3 }) }), "mailbox").status, "ok");
});

test("DOC-ROSTER-1: an unparseable roster FAILS — it is what decides who may write where", async () => {
  const c = find(await run({ rosterHealth: () => ({ ok: false, error: "roster.json: unexpected token" }) }), "roster");
  assert.equal(c.status, "fail");
  assert.match(c.detail, /unexpected token/);
});

test("DOC-ROSTER-2: a valid roster reports its seat count", async () => {
  const c = find(await run({ rosterHealth: () => ({ ok: true, members: 12, workers: 9 }) }), "roster");
  assert.equal(c.status, "ok");
  assert.match(c.detail, /12/);
});

test("DOC-HR-1: HR at its cap FAILS — the next unmatched skill blocks a job forever", async () => {
  const c = find(await run({ hrHealth: () => ({ workers: 20, cap: 20 }) }), "hr");
  assert.equal(c.status, "fail");
  assert.match(c.detail, /20/);
  assert.ok(c.fix);
});

test("DOC-HR-2: HR near its cap WARNS; with headroom it is ok", async () => {
  assert.equal(find(await run({ hrHealth: () => ({ workers: 19, cap: 20 }) }), "hr").status, "warn");
  assert.equal(find(await run({ hrHealth: () => ({ workers: 8, cap: 20 }) }), "hr").status, "ok");
});

test("DOC-THRU-1: throughput reports jobs shipped in the window alongside tasks", async () => {
  const c = find(await run({ throughput: () => ({ done: 4, failed: 0, held: 1, windowDays: 7, jobsShipped7d: 6 }) }), "throughput");
  assert.equal(c.status, "ok");
  assert.match(c.detail, /6 job/i, `the jobs figure is the milestone's number and it is missing: ${c.detail}`);
});

test("DOC-THRU-2: a probe with no jobs figure still reports tasks — the check never throws", async () => {
  const c = find(await run({ throughput: () => ({ done: 2, failed: 0, held: 0, windowDays: 7 }) }), "throughput");
  assert.equal(c.status, "ok");
});

test("DOC-ALL: a throwing probe becomes a WARN, never an exception out of report()", async () => {
  const r = await run({
    managerTick: () => { throw new Error("boom"); },
    mailbox: () => { throw new Error("boom"); },
    rosterHealth: () => { throw new Error("boom"); },
    hrHealth: () => { throw new Error("boom"); },
  });
  for (const id of ["manager", "mailbox", "roster", "hr"]) {
    assert.equal(find(r, id).status, "warn", `${id} threw out of the report instead of degrading`);
  }
});

// ── the CLI actually WIRES them ──────────────────────────────────────────────
//
// The checks above are all injected, so every one of them can pass while `npm run doctor` —
// the command an operator actually runs — reports "probe not wired". That is exactly what
// happened: the HTTP route had the four probes and scripts/doctor.mjs did not, so 14.2's
// checks were invisible on the surface they were built for. Addendum #25.
//
// This runs the REAL CLI and reads its JSON. It is the only assertion here that proves a wire.
test("DOC-CLI-1: `npm run doctor --json` answers roster, hr and mailbox for real", async () => {
  const { execFile } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const { join, dirname } = await import("node:path");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

  const out = await new Promise((resolve) => {
    execFile(process.execPath, [join(root, "scripts", "doctor.mjs"), "--json"],
      { timeout: 60_000, shell: false, cwd: root },
      (_err, stdout) => resolve(String(stdout || "")));
  });
  const report = JSON.parse(out);
  const find = (id) => report.checks.find((c) => c.id === id);

  for (const id of ["roster", "hr", "mailbox"]) {
    const c = find(id);
    assert.ok(c, `the CLI report has no '${id}' check at all`);
    assert.ok(!/not wired/i.test(c.detail),
      `the CLI does not wire the '${id}' probe: ${c.detail}`);
  }
  // `manager` is NOT answerable from a CLI process — a tick age is runtime state. It must say
  // so in those words rather than reading like a broken check.
  const mgr = find("manager");
  assert.match(mgr.detail, /not measurable from the CLI|live job|last tick/i);
  assert.ok(!/not wired/i.test(mgr.detail));
});
