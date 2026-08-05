// Story-Pipeline S7 — the DETERMINISTIC engine spawner (TEST-HARNESS INFRA, not a prod path).
// Proves: when ON it writes a small PLAIN-SAFE canned diff into the task worktree (so the engine's
// real broker.applyChanges + Docker-jailed test gate run over it and the goal reaches DONE); the
// fail-first mode writes STATUS=FAIL on the designated seat's FIRST attempt and STATUS=PASS on the
// retry (proving the real red→green loop end to end, not just a unit); and it writes ONLY inside the
// worktree under src/ (auto-apply eligible), never touching anything else — the containment the
// senior-security-engineer spot-checks. It is env-gated OFF in the server (proven by the full suite
// running unchanged with the spawner un-constructed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeterministicSpawner } from "../engine-spawner.mjs";

function tmpWorkdir() {
  return mkdtempSync(join(tmpdir(), "ma-spawner-"));
}
function fakeLoopSteps() {
  const rows = [];
  return { rows, record: (agentId, taskId, obj) => { rows.push({ agentId, taskId, obj }); return 1; } };
}

test("ON → writes a PLAIN-SAFE canned diff (src/build-<seat>.txt STATUS=PASS) and returns {acc}", async () => {
  const wd = tmpWorkdir();
  try {
    const ls = fakeLoopSteps();
    const sp = createDeterministicSpawner({ loopSteps: ls });
    const out = await sp.dispatch({ taskId: "task_aaa111", agentId: "sr-backend", task: "Implement the backend core logic.", workdir: wd });
    assert.ok(out.acc && !out.error, "returns success {acc}, never {error}");
    const rel = sp.fileFor("sr-backend");
    assert.equal(rel, "src/build-sr-backend.txt", "namespaced plain-safe file under src/");
    const abs = join(wd, rel);
    assert.ok(existsSync(abs), "canned diff written into the worktree");
    const body = readFileSync(abs, "utf8");
    assert.match(body, /STATUS=PASS/, "healthy status by default");
    assert.ok(ls.rows.length >= 1, "activity recorded to the loop-step store");
  } finally { rmSync(wd, { recursive: true, force: true }); }
});

test("S8 → emits a factory audit record when it writes a canned diff (observable in the trail)", async () => {
  const wd = tmpWorkdir();
  try {
    const audits = [];
    const sp = createDeterministicSpawner({ audit: (event, data) => audits.push({ event, data }) });
    await sp.dispatch({ taskId: "task_audit1", agentId: "sr-backend", task: "Implement it.", workdir: wd });
    const rec = audits.find((a) => a.event === "spawner.canned-diff");
    assert.ok(rec, "a spawner.canned-diff audit record was emitted");
    assert.equal(rec.data.seat, "sr-backend");
    assert.equal(rec.data.taskId, "task_audit1");
    assert.equal(rec.data.status, "PASS");
    assert.equal(rec.data.file, "src/build-sr-backend.txt");
  } finally { rmSync(wd, { recursive: true, force: true }); }
});

test("writes ONLY inside the given worktree under src/ (containment — no host escape)", async () => {
  const wd = tmpWorkdir();
  try {
    const sp = createDeterministicSpawner({});
    const rel = sp.fileFor("../../etc/evil");
    // seat id is sanitized to [a-z0-9-] so a hostile seat can never traverse out of src/
    assert.equal(rel, "src/build-etcevil.txt");
    await sp.dispatch({ taskId: "task_bbb222", agentId: "sr-frontend", task: "Build the UI.", workdir: wd });
    assert.ok(existsSync(join(wd, "src/build-sr-frontend.txt")), "written under the worktree src/");
  } finally { rmSync(wd, { recursive: true, force: true }); }
});

test("FAIL-FIRST → designated seat's first attempt writes STATUS=FAIL; the retry writes STATUS=PASS", async () => {
  const wd1 = tmpWorkdir();
  const wd2 = tmpWorkdir();
  try {
    const sp = createDeterministicSpawner({ failFirstSeat: "sr-backend" });
    // First attempt (no retry marker in the task) → FAIL, so the REAL test gate goes red.
    await sp.dispatch({ taskId: "task_c1", agentId: "sr-backend", task: "Implement the backend core logic.", workdir: wd1 });
    assert.match(readFileSync(join(wd1, "src/build-sr-backend.txt"), "utf8"), /STATUS=FAIL/);
    // Retry: the engine enriches the task text with its red→green marker → PASS, gate goes green.
    const retryTask = "Implement the backend core logic.\n\n(The unit-test gate FAILED on the prior attempt. Change the code so the tests pass.)";
    await sp.dispatch({ taskId: "task_c2", agentId: "sr-backend", task: retryTask, workdir: wd2 });
    assert.match(readFileSync(join(wd2, "src/build-sr-backend.txt"), "utf8"), /STATUS=PASS/);
  } finally { rmSync(wd1, { recursive: true, force: true }); rmSync(wd2, { recursive: true, force: true }); }
});

test("FAIL-FIRST is scoped to the designated seat — other seats always PASS on the first attempt", async () => {
  const wd = tmpWorkdir();
  try {
    const sp = createDeterministicSpawner({ failFirstSeat: "sr-backend" });
    await sp.dispatch({ taskId: "task_d1", agentId: "sr-frontend", task: "Build the UI.", workdir: wd });
    assert.match(readFileSync(join(wd, "src/build-sr-frontend.txt"), "utf8"), /STATUS=PASS/, "non-designated seat is never failed");
  } finally { rmSync(wd, { recursive: true, force: true }); }
});

test("no worktree and no seedSandbox → returns a plain {error}, never throws", async () => {
  const sp = createDeterministicSpawner({});
  const out = await sp.dispatch({ taskId: "task_e1", agentId: "sr-backend", task: "x", workdir: null });
  assert.ok(out.error, "surfaces a contract-shaped error");
});

test("no workdir but a seedSandbox fallback → seeds a copy-sandbox and writes there", async () => {
  const wd = tmpWorkdir();
  try {
    let seededFor = null;
    const sp = createDeterministicSpawner({ seedSandbox: async (agentId) => { seededFor = agentId; return wd; } });
    const out = await sp.dispatch({ taskId: "task_f1", agentId: "sr-backend", task: "x", workdir: null });
    assert.ok(out.acc);
    assert.equal(seededFor, "sr-backend", "used the injected copy-sandbox seam (same as the model path)");
    assert.ok(existsSync(join(wd, "src/build-sr-backend.txt")));
  } finally { rmSync(wd, { recursive: true, force: true }); }
});
