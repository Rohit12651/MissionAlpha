// Phase 1 / R2b — worker cap + cadence gating tests.
// Load-bearing: LAW3-* (a worker cannot mint without limit) and SLOT-* (a deferred or
// capped run is POSTPONED, never LOST — the CAS must not advance).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkerCap, dayKey, normalizeCap, DEFAULT_DAILY_CAP, MAX_DAILY_CAP } from "../worker-cap.mjs";
import { CADENCE_SEED, isWorkerCadence, WORKER_PREFIX } from "../cadence.mjs";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 7, 18, 12, 0, 0);

test("dayKey is a UTC calendar day", () => {
  assert.equal(dayKey(Date.UTC(2026, 7, 18, 23, 59, 59)), "2026-08-18");
  assert.equal(dayKey(Date.UTC(2026, 7, 19, 0, 0, 1)), "2026-08-19");
  assert.equal(dayKey(NaN), "1970-01-01");
});

test("normalizeCap clamps into range and refuses junk", () => {
  assert.equal(normalizeCap(5), 5);
  assert.equal(normalizeCap(-3), 0);
  assert.equal(normalizeCap(9999), MAX_DAILY_CAP);
  assert.equal(normalizeCap("abc"), DEFAULT_DAILY_CAP);
  assert.equal(normalizeCap(undefined), DEFAULT_DAILY_CAP);
  assert.equal(normalizeCap(2.9), 2);
});

test("LAW3-1: a worker cannot exceed its daily cap", () => {
  const cap = createWorkerCap({ cap: 3 });
  for (let i = 0; i < 3; i++) assert.equal(cap.consume("worker-audit", T0).ok, true, `run ${i + 1}`);
  const over = cap.consume("worker-audit", T0);
  assert.equal(over.ok, false);
  assert.equal(over.used, 3);
  assert.equal(cap.allows("worker-audit", T0), false);
});

test("LAW3-2: caps are per-worker, not global", () => {
  const cap = createWorkerCap({ cap: 1 });
  assert.equal(cap.consume("worker-audit", T0).ok, true);
  assert.equal(cap.consume("worker-testgaps", T0).ok, true, "a different worker has its own budget");
  assert.equal(cap.consume("worker-audit", T0).ok, false);
});

test("LAW3-3: the budget rolls over at UTC midnight", () => {
  const cap = createWorkerCap({ cap: 1 });
  assert.equal(cap.consume("worker-audit", T0).ok, true);
  assert.equal(cap.consume("worker-audit", T0).ok, false);
  assert.equal(cap.consume("worker-audit", T0 + DAY).ok, true, "next UTC day re-opens the budget");
});

test("LAW3-4: a cap of 0 blocks everything", () => {
  const cap = createWorkerCap({ cap: 0 });
  assert.equal(cap.allows("worker-audit", T0), false);
  assert.equal(cap.consume("worker-audit", T0).ok, false);
});

test("LAW3-5: an operator cannot configure past the hard ceiling", () => {
  assert.equal(createWorkerCap({ cap: 10_000 }).cap, MAX_DAILY_CAP);
});

test("counts persist across process restarts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wcap-"));
  const file = join(dir, "caps.json");
  const a = createWorkerCap({ file, cap: 2 });
  assert.equal(a.consume("worker-audit", T0).ok, true);
  assert.equal(a.consume("worker-audit", T0).ok, true);

  const b = createWorkerCap({ file, cap: 2 }); // simulates a restart
  assert.equal(b.used("worker-audit", T0), 2, "a restart must not re-open the budget");
  assert.equal(b.consume("worker-audit", T0).ok, false);
});

test("a stale day in the persisted file rolls rather than blocking forever", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wcap-"));
  const file = join(dir, "caps.json");
  const a = createWorkerCap({ file, cap: 1 });
  a.consume("worker-audit", T0);
  const b = createWorkerCap({ file, cap: 1 });
  assert.equal(b.consume("worker-audit", T0 + DAY).ok, true);
});

test("a corrupt store degrades to an open budget rather than wedging the loop", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wcap-"));
  const file = join(dir, "caps.json");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(file, "{ not json");
  const cap = createWorkerCap({ file, cap: 2 });
  assert.equal(cap.consume("worker-audit", T0).ok, true, "unreadable state must not block autonomy");
});

test("an unwritable path never throws out of consume", () => {
  const cap = createWorkerCap({ file: "/proc/definitely/not/writable/caps.json", cap: 2 });
  assert.doesNotThrow(() => cap.consume("worker-audit", T0));
});

test("__proto__ is an ordinary key, not a prototype write", () => {
  const cap = createWorkerCap({ cap: 2 });
  cap.consume("__proto__", T0);
  assert.equal(({}).polluted, undefined);
  assert.equal(cap.used("__proto__", T0), 1);
});

test("snapshot reports the day, cap and per-worker counts", () => {
  const cap = createWorkerCap({ cap: 3 });
  cap.consume("worker-audit", T0);
  const s = cap.snapshot(T0);
  assert.equal(s.day, "2026-08-18");
  assert.equal(s.cap, 3);
  assert.equal(s.counts["worker-audit"], 1);
});

// ── the catalog itself ────────────────────────────────────────────────────────

test("the four workers exist in the seed", () => {
  const ids = CADENCE_SEED.map((r) => r.id);
  for (const id of ["worker-audit", "worker-testgaps", "worker-document", "worker-refactor"]) {
    assert.ok(ids.includes(id), `${id} missing from CADENCE_SEED`);
  }
});

test("SAFETY: every worker row lands DISABLED — no surprise spawns on an unproven install", () => {
  for (const row of CADENCE_SEED.filter((r) => isWorkerCadence(r.id))) {
    assert.equal(row.enabled, false, `${row.id} must ship disabled`);
  }
});

test("the pre-existing seed rows are untouched (no regression to shipped behaviour)", () => {
  const byId = Object.fromEntries(CADENCE_SEED.map((r) => [r.id, r]));
  assert.equal(byId["stuck-story-sweep"].enabled, true);
  assert.equal(byId["nightly-regression"].enabled, false);
  assert.equal(byId["monitor-tick"].enabled, true);
});

test("worker membership is by prefix so a new worker inherits Law 3 automatically", () => {
  assert.equal(isWorkerCadence("worker-anything-new"), true);
  assert.equal(isWorkerCadence("monitor-tick"), false);
  assert.equal(isWorkerCadence(null), false);
  assert.equal(WORKER_PREFIX, "worker-");
});

test("every worker row declares a real agent and skill", () => {
  for (const row of CADENCE_SEED.filter((r) => isWorkerCadence(r.id))) {
    assert.ok(row.agent && /^[a-z0-9-]+$/.test(row.agent), `${row.id} agent`);
    assert.ok(row.skill && /^[a-z0-9-]+$/.test(row.skill), `${row.id} skill`);
    assert.ok(["daily", "weekly", "2xdaily", "ondemand"].includes(row.expr), `${row.id} expr`);
  }
});
