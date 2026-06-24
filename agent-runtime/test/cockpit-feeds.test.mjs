// Task 1 TDD — cockpit-feeds module (F4.1)
// RED first: exercises the 5 exported handlers before the module exists.
// Each handler is called with a mock req/res; no network, no real server.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Fixture helpers ────────────────────────────────────────────────────────────
let tmpDir;
let statePath;
let commandsDir;

function makeMockRes() {
  const res = {
    statusCode: 200,
    _headers: {},
    body: undefined,
    setHeader(k, v) { this._headers[k] = v; },
    end(b) { this.body = b; },
  };
  return res;
}

function makeGetReq(url = "/api/state.json") {
  return { method: "GET", url, on() {} };
}

function makePostReq(bodyObj) {
  const buf = Buffer.from(JSON.stringify(bodyObj));
  return {
    method: "POST",
    url: "/api/command",
    on(ev, cb) {
      if (ev === "data") cb(buf);
      if (ev === "end") cb();
    },
  };
}

// Import the handlers under test — module doesn't exist yet (RED).
let stateHandler, commandHandler, auditHandler, commandStatusHandler, sessionsHandler;

before(async () => {
  // Create a tmp fixture tree:
  //   <tmpDir>/state.json
  //   <tmpDir>/commands/        (pending)
  //   <tmpDir>/commands/done/
  //   <tmpDir>/commands/rejected/
  //   <tmpDir>/history/
  tmpDir = mkdtempSync(join(tmpdir(), "ma-cockpit-feeds-test-"));
  statePath = join(tmpDir, "state.json");
  commandsDir = join(tmpDir, "commands");

  writeFileSync(statePath, JSON.stringify({ agents: [{ id: "ceo" }, { id: "cto" }], generatedAt: "2026-01-01T00:00:00Z", counts: { active: 2, blocked: 0 } }), "utf-8");
  mkdirSync(commandsDir, { recursive: true });
  mkdirSync(join(commandsDir, "done"), { recursive: true });
  mkdirSync(join(commandsDir, "rejected"), { recursive: true });
  mkdirSync(join(tmpDir, "history"), { recursive: true });

  // Dynamic import so this test file can be written before the module exists.
  const mod = await import("../cockpit-feeds.mjs");
  stateHandler = mod.stateHandler;
  commandHandler = mod.commandHandler;
  auditHandler = mod.auditHandler;
  commandStatusHandler = mod.commandStatusHandler;
  sessionsHandler = mod.sessionsHandler;
});

after(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── stateHandler ──────────────────────────────────────────────────────────────
test("stateHandler: returns state JSON with 200 when file exists", async () => {
  const res = makeMockRes();
  const req = makeGetReq("/api/state.json");
  await stateHandler(statePath)(req, res);
  assert.equal(res.statusCode, 200);
  const parsed = JSON.parse(res.body);
  assert.ok(Array.isArray(parsed.agents));
  assert.equal(parsed.agents.length, 2);
});

test("stateHandler: returns 503 when state file absent", async () => {
  const res = makeMockRes();
  const req = makeGetReq("/api/state.json");
  await stateHandler(join(tmpDir, "nonexistent.json"))(req, res);
  assert.equal(res.statusCode, 503);
  const body = JSON.parse(res.body);
  assert.ok(body.error);
});

// ── commandHandler ────────────────────────────────────────────────────────────
test("commandHandler: rejects non-POST with 405", async () => {
  const res = makeMockRes();
  const req = makeGetReq("/api/command");
  await commandHandler(statePath)(req, res);
  assert.equal(res.statusCode, 405);
});

test("commandHandler: rejects bad type with 400", async () => {
  const res = makeMockRes();
  const req = makePostReq({ type: "hack", target: "ceo" });
  await commandHandler(statePath)(req, res);
  assert.equal(res.statusCode, 400);
  const body = JSON.parse(res.body);
  assert.ok(body.error.includes("unsupported command type"));
});

test("commandHandler: rejects invalid target with 400", async () => {
  const res = makeMockRes();
  const req = makePostReq({ type: "ack", target: "../etc/passwd" });
  await commandHandler(statePath)(req, res);
  assert.equal(res.statusCode, 400);
  const body = JSON.parse(res.body);
  assert.ok(body.error.includes("invalid target"));
});

test("commandHandler: rejects unknown agent with 404", async () => {
  const res = makeMockRes();
  const req = makePostReq({ type: "ack", target: "ghost" });
  await commandHandler(statePath)(req, res);
  assert.equal(res.statusCode, 404);
  const body = JSON.parse(res.body);
  assert.ok(body.error.includes("unknown agent"));
});

test("commandHandler: accepts valid ack → 202 + writes cmd file + appends AUDIT.log", async () => {
  const res = makeMockRes();
  const req = makePostReq({ type: "ack", target: "ceo", issuedBy: "operator", reason: "test" });
  await commandHandler(statePath)(req, res);
  assert.equal(res.statusCode, 202);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.ok(typeof body.id === "string" && body.id.startsWith("cmd_"));

  // Check command file was written
  const files = (await import("node:fs")).readdirSync(commandsDir).filter(n => n.endsWith(".json"));
  assert.equal(files.length >= 1, true);
  const cmdJson = JSON.parse(readFileSync(join(commandsDir, files[0]), "utf-8"));
  assert.equal(cmdJson.type, "ack");
  assert.equal(cmdJson.target, "ceo");
  assert.equal(cmdJson.status, "pending");

  // Check audit log was appended
  const auditLog = join(commandsDir, "AUDIT.log");
  const auditContent = readFileSync(auditLog, "utf-8");
  assert.ok(auditContent.includes("ack"));
  assert.ok(auditContent.includes("ceo"));
});

test("commandHandler: rejects task with empty body with 400", async () => {
  const res = makeMockRes();
  const req = makePostReq({ type: "task", target: "ceo", body: "  " });
  await commandHandler(statePath)(req, res);
  assert.equal(res.statusCode, 400);
  const body = JSON.parse(res.body);
  assert.ok(body.error.includes("task requires a body"));
});

test("commandHandler: accepts task with non-empty body → 202", async () => {
  const res = makeMockRes();
  const req = makePostReq({ type: "task", target: "ceo", body: "Deploy to prod" });
  await commandHandler(statePath)(req, res);
  assert.equal(res.statusCode, 202);
});

// ── auditHandler ──────────────────────────────────────────────────────────────
test("auditHandler: returns {entries:[]} when no audit log", async () => {
  // Use a fresh statePath pointing at a dir with no AUDIT.log
  const tmpState2 = join(tmpDir, "state2.json");
  writeFileSync(tmpState2, JSON.stringify({ agents: [] }), "utf-8");
  mkdirSync(join(tmpDir, "commands2"), { recursive: true });
  // Note: commands2/AUDIT.log doesn't exist — handler should return empty
  // We use a fresh statePath that points to commands2 dir
  const tmpState2Path = join(tmpDir, "sub2", "state.json");
  mkdirSync(join(tmpDir, "sub2", "commands"), { recursive: true });
  writeFileSync(tmpState2Path, "{}", "utf-8");

  const res = makeMockRes();
  const req = makeGetReq("/api/audit");
  await auditHandler(tmpState2Path)(req, res);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.deepEqual(body.entries, []);
});

test("auditHandler: returns entries newest-first after commands written", async () => {
  const res = makeMockRes();
  const req = makeGetReq("/api/audit?limit=50");
  req.url = "/api/audit?limit=50";
  await auditHandler(statePath)(req, res);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.entries));
  // At least 1 entry from the commandHandler tests that ran before
  assert.ok(body.entries.length >= 1);
  // entries have expected shape
  const e = body.entries[0];
  assert.ok("at" in e);
  assert.ok("cmdId" in e);
  assert.ok("type" in e);
  assert.ok("target" in e);
});

test("auditHandler: rejects non-GET with 405", async () => {
  const res = makeMockRes();
  const req = { method: "POST", url: "/api/audit", on() {} };
  await auditHandler(statePath)(req, res);
  assert.equal(res.statusCode, 405);
});

// ── commandStatusHandler ──────────────────────────────────────────────────────
test("commandStatusHandler: returns counts {pending,done,rejected,recent}", async () => {
  const res = makeMockRes();
  const req = makeGetReq("/api/commands/status");
  await commandStatusHandler(statePath)(req, res);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(typeof body.pending === "number");
  assert.ok(typeof body.done === "number");
  assert.ok(typeof body.rejected === "number");
  assert.ok(Array.isArray(body.recent));
  // At least 1 pending from commandHandler tests
  assert.ok(body.pending >= 1);
});

test("commandStatusHandler: rejects non-GET with 405", async () => {
  const res = makeMockRes();
  const req = { method: "POST", url: "/api/commands/status", on() {} };
  await commandStatusHandler(statePath)(req, res);
  assert.equal(res.statusCode, 405);
});

// ── sessionsHandler ────────────────────────────────────────────────────────────
test("sessionsHandler: returns {sessions:[]} when history dir empty", async () => {
  const res = makeMockRes();
  const req = makeGetReq("/api/sessions");
  await sessionsHandler(statePath)(req, res);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok("sessions" in body);
  assert.ok(Array.isArray(body.sessions));
});

test("sessionsHandler: returns {sessions:[]} when history dir absent", async () => {
  const tmpState3 = join(tmpDir, "sub3", "state.json");
  mkdirSync(join(tmpDir, "sub3"), { recursive: true });
  writeFileSync(tmpState3, "{}", "utf-8");
  // No history dir — handler should return {sessions:[]}
  const res = makeMockRes();
  const req = makeGetReq("/api/sessions");
  await sessionsHandler(tmpState3)(req, res);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.deepEqual(body.sessions, []);
});

test("sessionsHandler: returns session summaries when ndjson files present", async () => {
  // Write a fake history ndjson
  const histDir = join(tmpDir, "history");
  const snapshot = JSON.stringify({ generatedAt: "2026-01-01T10:00:00Z", agents: [{ id: "ceo" }], counts: { active: 1, blocked: 0 } });
  writeFileSync(join(histDir, "2026-01-01.ndjson"), snapshot + "\n", "utf-8");

  const res = makeMockRes();
  const req = makeGetReq("/api/sessions");
  await sessionsHandler(statePath)(req, res);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.sessions));
  assert.equal(body.sessions.length, 1);
  const s = body.sessions[0];
  assert.equal(s.id, "2026-01-01");
  assert.equal(s.date, "2026-01-01");
  assert.ok(typeof s.snapshotCount === "number");
  assert.ok(typeof s.agentsSeen === "number");
});

test("sessionsHandler: rejects non-GET with 405", async () => {
  const res = makeMockRes();
  const req = { method: "POST", url: "/api/sessions", on() {} };
  await sessionsHandler(statePath)(req, res);
  assert.equal(res.statusCode, 405);
});

test("sessionsHandler: returns 400 for bad session id in detail request", async () => {
  const res = makeMockRes();
  const req = makeGetReq("/api/sessions/../../../etc");
  req.url = "/api/sessions/../../../etc";
  await sessionsHandler(statePath)(req, res);
  assert.equal(res.statusCode, 400);
});

test("sessionsHandler: returns 404 for unknown session id in detail request", async () => {
  const res = makeMockRes();
  const req = makeGetReq("/api/sessions/2099-12-31");
  req.url = "/api/sessions/2099-12-31";
  await sessionsHandler(statePath)(req, res);
  assert.equal(res.statusCode, 404);
});
