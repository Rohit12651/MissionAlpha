// Quota guard — unit tests (node --test, serialized like the suite).
// Covers: window counting, pre-gate (runaway brake), 429 backoff+retry
// (the REAL-limit reaction), and on-write prune. File-based, no DB.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  QuotaExceeded,
  logCall,
  countInWindow,
  quotaStatus,
  guardedSpawn,
  is429,
} from "../quota-guard.mjs";

let dir, logFile;
const WINDOW = 5 * 60 * 60 * 1000; // 5h

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ma-quota-"));
  logFile = join(dir, "quota-log.jsonl");
  process.env.MA_QUOTA_LOG = logFile;
});
afterEach(() => {
  delete process.env.MA_QUOTA_LOG;
  rmSync(dir, { recursive: true, force: true });
});

test("countInWindow counts only calls inside the window", () => {
  // two recent calls + one stale (10h old) for the same agent
  logCall("ceo", true, WINDOW);
  logCall("ceo", true, WINDOW);
  const old = { ts: Date.now() - 10 * 60 * 60 * 1000, agentId: "ceo", ok: true };
  appendFileSync(logFile, JSON.stringify(old) + "\n");
  // a different agent's recent call must not bleed in
  logCall("architect", true, WINDOW);
  assert.equal(countInWindow("ceo", WINDOW), 2, "stale + other-agent excluded");
  assert.equal(countInWindow("architect", WINDOW), 1);
});

test("pre-gate: at max → QuotaExceeded and fn is NOT called", async () => {
  for (let i = 0; i < 3; i++) logCall("ceo", true, WINDOW);
  let called = false;
  await assert.rejects(
    () => guardedSpawn(
      { agentId: "ceo", max: 3, windowMs: WINDOW, baseDelayMs: 1, maxRetries: 2 },
      async () => { called = true; return "x"; },
    ),
    QuotaExceeded,
  );
  assert.equal(called, false, "fn must not run when gated");
});

test("429: fn throws 429 once then succeeds → retried, result returned, one ok:false logged", async () => {
  let attempts = 0;
  const res = await guardedSpawn(
    { agentId: "ceo", max: 100, windowMs: WINDOW, baseDelayMs: 1, maxRetries: 3 },
    async () => {
      attempts++;
      if (attempts === 1) { const e = new Error("rate limit"); e.status = 429; throw e; }
      return "done";
    },
  );
  assert.equal(res, "done");
  assert.equal(attempts, 2, "retried exactly once");
  const lines = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const fails = lines.filter((l) => l.ok === false);
  const oks = lines.filter((l) => l.ok === true);
  assert.equal(fails.length, 1, "one ok:false for the 429");
  assert.equal(oks.length, 1, "one ok:true for the success");
});

test("non-429 error rethrows without retry and without a log line", async () => {
  let attempts = 0;
  await assert.rejects(
    () => guardedSpawn(
      { agentId: "ceo", max: 100, windowMs: WINDOW, baseDelayMs: 1, maxRetries: 3 },
      async () => { attempts++; throw new Error("boom"); },
    ),
    /boom/,
  );
  assert.equal(attempts, 1, "no retry on non-429");
  assert.equal(existsSync(logFile), false, "nothing logged for a non-429 failure");
});

test("prune: lines older than 2× window removed on write", () => {
  const veryOld = { ts: Date.now() - 11 * 60 * 60 * 1000, agentId: "ceo", ok: true }; // > 2×5h
  writeFileSync(logFile, JSON.stringify(veryOld) + "\n");
  logCall("ceo", true, WINDOW); // triggers prune on write
  const lines = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 1, "stale line pruned, only the new one remains");
  assert.equal(lines[0].agentId, "ceo");
  assert.ok(lines[0].ts > Date.now() - WINDOW);
});

test("quotaStatus reports aggregate count + paused when any agent at/over max", () => {
  for (let i = 0; i < 5; i++) logCall("ceo", true, WINDOW);
  logCall("architect", true, WINDOW);
  const s = quotaStatus({ max: 5, windowMs: WINDOW });
  assert.equal(s.count, 6, "total across agents");
  assert.equal(s.max, 5);
  assert.equal(s.windowMs, WINDOW);
  assert.equal(s.paused, true, "ceo hit max → paused");
  assert.equal(quotaStatus({ max: 50, windowMs: WINDOW }).paused, false);
});

test("is429 recognizes status, statusCode, and rate-limit text", () => {
  assert.equal(is429({ status: 429 }), true);
  assert.equal(is429({ statusCode: 429 }), true);
  assert.equal(is429(new Error("Anthropic rate limit exceeded")), true);
  assert.equal(is429(new Error("overloaded_error")), true);
  assert.equal(is429(new Error("boom")), false);
});
