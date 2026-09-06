// Phase 0-FIX — unit tests for the visual harness DATA-PLANE fixture layer.
//
// WHY THIS EXISTS: Phase 0 shipped a screenshot harness whose captures depended on a LIVE
// runtime, a live SQLite file and a live auth token. Fable's review was right about the
// failure mode: when that environment broke, the harness silently baked a 401 error page
// into the baselines instead of failing loudly. These tests pin the pure parts of the fix —
// which requests are data-plane, how they are keyed, and what must never be recorded.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isDataPlanePath,
  fixtureKey,
  redactFixture,
  redactAbsolutePaths,
  FIXTURE_TOKEN,
  FIXTURE_TICKET,
  VOLATILE_PARAMS,
} from "./fixtures.mjs";

test("data-plane classification covers every proxied API prefix", () => {
  for (const p of [
    "/api/state.json",
    "/api/runtime-token",
    "/api/audit",
    "/api/commands/status",
    "/api/sessions",
    "/runtime/accounts",
    "/runtime/engine/runs",
    "/inbox",
    "/inbox/01J1/approve",
    "/factory/agents",
  ]) {
    assert.equal(isDataPlanePath(p), true, `${p} must be fixtured`);
  }
});

test("static assets are NOT data-plane and must reach the dev server", () => {
  for (const p of ["/", "/index.html", "/src/main.tsx", "/assets/index-abc.js", "/favicon.ico"]) {
    assert.equal(isDataPlanePath(p), false, `${p} must not be intercepted`);
  }
});

test("the SSE stream is excluded — it is a long-lived body, not a fixture", () => {
  // route.fetch() on an event-stream never resolves; the harness stubs EventSource in
  // page context instead, so this path must never enter the fixture layer at all.
  assert.equal(isDataPlanePath("/runtime/events"), false);
  // …but the ticket mint that precedes it IS a normal JSON POST and must be fixtured.
  assert.equal(isDataPlanePath("/runtime/events/ticket"), true);
});

test("fixtureKey is stable across volatile query params", () => {
  const a = fixtureKey("GET", "http://localhost:3004/inbox?status=pending&_=1786500000000");
  const b = fixtureKey("GET", "http://localhost:3004/inbox?_=1786500999999&status=pending");
  assert.equal(a, b, "cache-busters must not fragment the fixture key");
  assert.equal(a, "GET /inbox?status=pending");
});

test("fixtureKey keeps meaningful query params and normalises their order", () => {
  const k = fixtureKey("GET", "http://localhost:3004/runtime/agent-ledger?window=7d&sort=rate");
  assert.equal(k, "GET /runtime/agent-ledger?sort=rate&window=7d");
});

test("fixtureKey distinguishes methods on the same path", () => {
  assert.notEqual(
    fixtureKey("GET", "http://localhost:3004/runtime/accounts"),
    fixtureKey("POST", "http://localhost:3004/runtime/accounts"),
  );
});

test("every volatile param is genuinely dropped", () => {
  for (const p of VOLATILE_PARAMS) {
    const k = fixtureKey("GET", `http://localhost:3004/inbox?${p}=xyz`);
    assert.equal(k, "GET /inbox", `${p} leaked into the key`);
  }
});

test("SECURITY: a recorded runtime token is replaced with a constant, never stored", () => {
  const real = JSON.stringify({ token: "d34db33f-real-runtime-token" });
  const out = redactFixture("GET /api/runtime-token", real);
  assert.ok(!out.includes("d34db33f-real-runtime-token"), "real token must never hit disk");
  assert.equal(JSON.parse(out).token, FIXTURE_TOKEN);
});

test("redaction leaves ordinary payloads byte-identical", () => {
  const body = JSON.stringify({ agents: [{ id: "tech-lead", state: "idle" }] });
  assert.equal(redactFixture("GET /api/state.json", body), body);
});

// ── found in adversarial review of the first recording ─────────────────────────

test("SECURITY: the SSE ticket is a credential too, and is replaced", () => {
  // The first version of redactFixture only looked at the token endpoint, so a real
  // single-use SSE ticket was written into the committed fixture file.
  const real = JSON.stringify({ ticket: "11bec265deadbeefcafe", expiresAt: 1786415092588 });
  const out = redactFixture("POST /runtime/events/ticket", real);
  assert.ok(!out.includes("11bec265deadbeefcafe"), "a real ticket reached disk");
  assert.equal(JSON.parse(out).ticket, FIXTURE_TICKET);
  assert.equal(JSON.parse(out).expiresAt, 1786415092588, "the response shape must survive redaction");
});

test("the operator's home directory never reaches the fixture file", () => {
  const body = JSON.stringify({ cwd: "/Users/someone/Downloads/proj", err: "git failed in /Users/someone/x" });
  const out = redactAbsolutePaths(body, "/Users/someone");
  assert.ok(!out.includes("/Users/someone"), "home path committed");
  assert.match(out, /\/fixture-home\/Downloads\/proj/);
});

test("path redaction is a no-op when HOME is unset or root", () => {
  const body = JSON.stringify({ cwd: "/Users/someone" });
  assert.equal(redactAbsolutePaths(body, ""), body);
  assert.equal(redactAbsolutePaths(body, "/"), body);
});

test("fixtureKey does not collide on encoded separators", () => {
  // `?a=1&b=2` and `?a=1%26b%3D2` are DIFFERENT requests. Joining decoded values with
  // raw &/= made them the same key — one fixture answering two distinct requests.
  const two = fixtureKey("GET", "http://localhost:3004/api/q?a=1&b=2");
  const one = fixtureKey("GET", "http://localhost:3004/api/q?a=1%26b%3D2");
  assert.notEqual(two, one);
});

test("fixtureKey is stable for repeated params in any order", () => {
  const a = fixtureKey("GET", "http://localhost:3004/api/q?id=1&id=2");
  const b = fixtureKey("GET", "http://localhost:3004/api/q?id=2&id=1");
  assert.equal(a, b, "repeated params fragmented the key");
});
