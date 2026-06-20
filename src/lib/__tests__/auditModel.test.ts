import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeFactory,
  normalizeOperator,
  normalizeHeartbeats,
  mergeAudit,
  filterAudit,
  factorySourceFor,
  agentsIn,
  type FactoryAuditEntry,
} from "../auditModel.ts";

const FX: FactoryAuditEntry[] = [
  { at: "2026-06-18T10:00:00.000Z", event: "exec.run", data: { agentId: "builder", klass: "sensitive", network: false, cmd: "npm install" } },
  { at: "2026-06-18T10:00:01.000Z", event: "exec.approved", data: { agentId: "builder", scope: "once", klass: "sensitive", callId: "c1" } },
  { at: "2026-06-18T10:00:02.000Z", event: "exec.forbidden", data: { agentId: "rogue", reason: "sudo" } },
  { at: "2026-06-18T10:00:03.000Z", event: "conn.create", data: { connId: "x", platform: "github", handle: "octo" } },
  { at: "2026-06-18T10:00:04.000Z", event: "agent.create", data: { id: "scout" } },
];

test("factorySourceFor buckets events correctly", () => {
  assert.equal(factorySourceFor("exec.run"), "exec");
  assert.equal(factorySourceFor("exec.approved"), "approval");
  assert.equal(factorySourceFor("exec.denied"), "approval");
  assert.equal(factorySourceFor("conn.create"), "connector");
  assert.equal(factorySourceFor("cred.delete"), "connector");
  assert.equal(factorySourceFor("agent.update"), "agent");
});

test("normalizeFactory maps events to records with agent + summary", () => {
  const r = normalizeFactory(FX);
  assert.equal(r.length, 5);
  const run = r.find((x) => x.kind === "exec.run")!;
  assert.equal(run.source, "exec");
  assert.equal(run.agent, "builder");
  assert.match(run.summary, /npm install/);
  const appr = r.find((x) => x.kind === "exec.approved")!;
  assert.equal(appr.source, "approval");
  assert.equal(agentsIn(r).includes("scout"), true);
});

test("normalizeOperator + normalizeHeartbeats produce correct sources", () => {
  const op = normalizeOperator([{ at: "2026-06-18T10:00:05.000Z", cmdId: "k", issuedBy: "USER", type: "ack", target: "senior-qa" }]);
  assert.equal(op[0].source, "operator");
  assert.equal(op[0].agent, "senior-qa");
  const hb = normalizeHeartbeats([{ ts: "2026-06-18T10:00:06.000Z", agent: "builder", state: "IN_PROGRESS" }]);
  assert.equal(hb[0].source, "heartbeat");
  assert.equal(hb[0].kind, "HEARTBEAT:IN_PROGRESS");
});

test("mergeAudit sorts newest-first and bounds", () => {
  const merged = mergeAudit([normalizeFactory(FX)], 3);
  assert.equal(merged.length, 3);
  // newest (agent.create @ :04) first
  assert.equal(merged[0].kind, "agent.create");
  assert.ok(merged[0].ts >= merged[1].ts);
});

test("filterAudit: search + source + agent + time facets", () => {
  const recs = normalizeFactory(FX);
  assert.equal(filterAudit(recs, { q: "npm" }).length, 1);
  assert.equal(filterAudit(recs, { source: "approval" }).length, 1);
  assert.equal(filterAudit(recs, { agent: "builder" }).length, 2);
  assert.equal(filterAudit(recs, { q: "FORBIDDEN" })[0].agent, "rogue");
  const since = Date.parse("2026-06-18T10:00:03.000Z");
  assert.equal(filterAudit(recs, { sinceMs: since }).length, 2); // conn.create + agent.create
});

test("NaN-guards bad timestamps to 0", () => {
  const r = normalizeFactory([{ at: "not-a-date", event: "exec.run", data: {} }]);
  assert.equal(r[0].ts, 0);
});
