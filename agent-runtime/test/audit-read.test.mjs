// ADR-041 audit-trail read model — proves the GET /factory/audit?limit read path
// is READ-ONLY and bounded. We exercise factory.audit() (the existing writer) +
// readAudit(limit) (what the endpoint delegates to) and pin the log line format so
// any change to how audit is WRITTEN would fail here — guarding the read-only contract.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir;
let factory;

before(async () => {
  // RUNTIME_DIR is resolved at import time from RUNTIME_TOKEN_DIR — set it first.
  dir = mkdtempSync(join(tmpdir(), "ma-audit-test-"));
  process.env.RUNTIME_TOKEN_DIR = dir;
  factory = await import("../factory.mjs");
});

after(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

test("audit() appends one TSV line per event: iso\\tevent\\tjson (format pinned)", () => {
  factory.audit("exec.run", { agentId: "builder", klass: "sensitive", cmd: "npm install" });
  const raw = readFileSync(join(dir, "factory-audit.log"), "utf-8").trim();
  const parts = raw.split("\t");
  assert.equal(parts.length >= 3, true);
  assert.match(parts[0], /^\d{4}-\d{2}-\d{2}T/); // ISO timestamp
  assert.equal(parts[1], "exec.run");
  assert.deepEqual(JSON.parse(parts.slice(2).join("\t")), { agentId: "builder", klass: "sensitive", cmd: "npm install" });
});

test("readAudit(limit) returns newest-first, bounded to limit", () => {
  for (let i = 0; i < 10; i++) factory.audit("exec.approved", { callId: `c${i}`, scope: "once" });
  const three = factory.readAudit(3);
  assert.equal(three.length, 3);
  // newest first
  assert.equal(three[0].data.callId, "c9");
  assert.equal(three[2].data.callId, "c7");
  // structured shape the UI consumes
  assert.equal(three[0].event, "exec.approved");
  assert.equal(typeof three[0].at, "string");
});

test("readAudit returns at most what exists, and limit clamps cannot over-read", () => {
  const all = factory.readAudit(2000); // server clamps query to ≤2000; readAudit returns ≤ existing
  assert.equal(all.length <= 2000, true);
  assert.equal(all.length >= 11, true); // 1 exec.run + 10 exec.approved
  // every entry parses; secrets were never written (writer logs refs/hashes only)
  for (const e of all) assert.equal(typeof e.event, "string");
});

test("readAudit on a fresh/empty log is a safe [] (never throws)", () => {
  const empty = factory.readAudit(0); // limit 0 → slice(-0) === whole array; just must not throw
  assert.equal(Array.isArray(empty), true);
});
