// Phase 8 / 8.1 — the mail HTTP surface, and its AUTH GATE.
//
// The gate is asserted first and hardest because `needsAuth` in server.mjs is an ALLOW-LIST:
// a route left off it is served to anything that can reach the loopback port. Phase 7 shipped
// `GET /runtime/roster` exactly that way (addendum #20). Mail names who is talking to whom and
// carries agent-authored bodies, so it is gated like the roster.
import "./fixtures/isolate-state.mjs"; // FIRST — the booted server must not touch live runtime state (STATE-ISO-2)
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 3995;
const TOK = "mailtok";
const HOSTH = { Host: `localhost:${PORT}`, "Content-Type": "application/json" };

let proc;
test.before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "mail-http-"));
  proc = spawn(process.execPath, [join(ROOT, "agent-runtime", "server.mjs")], {
    env: { ...process.env, RUNTIME_BACKEND: "mock", RUNTIME_PORT: String(PORT),
      RUNTIME_TOKEN: TOK, RUNTIME_TOKEN_DIR: dir, RUNTIME_DB_PATH: join(dir, "mission.db"),
      RUNTIME_MAIL_DIR: join(dir, "mail") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("server did not start")), 30_000);
    proc.stdout.on("data", (b) => { if (String(b).includes(`listening :${PORT}`)) { clearTimeout(t); resolve(); } });
    proc.on("exit", (c) => { clearTimeout(t); reject(new Error(`server exited ${c}`)); });
  });
});
test.after(() => { try { proc?.kill(); } catch { /* gone */ } });

function req(method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: PORT, path, method, headers }, (res) => {
      let out = ""; res.on("data", (c) => { out += c; });
      res.on("end", () => { let j = null; try { j = JSON.parse(out); } catch { /* */ } resolve({ status: res.statusCode, body: out, json: j }); });
    });
    r.on("error", reject); r.end(body);
  });
}
const auth = { ...HOSTH, "x-runtime-token": TOK };

test("MAILHTTP-1: the mail routes are GATED — no token is 401", async () => {
  assert.equal((await req("GET", "/runtime/mail/sr-backend", HOSTH)).status, 401);
  assert.equal((await req("POST", "/runtime/mail", HOSTH, "{}")).status, 401);
});

test("MAILHTTP-2: a wrong token is 401, and no mail content leaks in the refusal", async () => {
  const r = await req("GET", "/runtime/mail/sr-backend", { ...HOSTH, "x-runtime-token": "nope" });
  assert.equal(r.status, 401);
  assert.equal(r.body.includes("messages"), false);
});

test("MAILHTTP-3: a real worker→worker send is accepted, routed, and readable", async () => {
  const sent = await req("POST", "/runtime/mail", auth, JSON.stringify({
    from: "sr-frontend", to: "sr-backend", kind: "question", body: "what is the endpoint name?",
  }));
  assert.equal(sent.status, 201, sent.body);
  assert.equal(sent.json.routed, 1, "the operator's send is delivered at once, not on the next heartbeat");

  const inbox = await req("GET", "/runtime/mail/sr-backend", auth);
  assert.equal(inbox.status, 200);
  assert.equal(inbox.json.messages.length, 1);
  assert.equal(inbox.json.messages[0].from, "sr-frontend");
  assert.equal(inbox.json.messages[0].body, "what is the endpoint name?");
});

test("MAILHTTP-4: the operator read is a GLANCE — a second read returns the same message (Phase B · Task 3 reversed the old drain)", async () => {
  const again = await req("GET", "/runtime/mail/sr-backend", auth);
  assert.equal(again.json.messages.length, 1, "GET must not archive; mailbox.read() (the Manager's drain) is not on the HTTP surface");
  assert.equal(again.json.messages[0].body, "what is the endpoint name?");
});

test("MAILHTTP-5: a disallowed pair is a 400, not a silent drop", async () => {
  const r = await req("POST", "/runtime/mail", auth, JSON.stringify({
    from: "sr-frontend", to: "ceo", kind: "status", body: "hi",
  }));
  assert.equal(r.status, 400);
  assert.match(r.json.error, /may not mail/i);
});

test("MAILHTTP-6: an id that is not on the roster has no role and cannot mail", async () => {
  const r = await req("POST", "/runtime/mail", auth, JSON.stringify({
    from: "not-a-real-agent", to: "sr-backend", kind: "status", body: "hi",
  }));
  assert.equal(r.status, 400);
});

test("MAILHTTP-7: status is COPIED to the Manager as well as the addressee", async () => {
  await req("POST", "/runtime/mail", auth, JSON.stringify({
    from: "sr-frontend", to: "sr-backend", kind: "status", body: "halfway",
  }));
  const mgr = await req("GET", "/runtime/mail/tech-lead", auth);
  // UPDATED 2026-09-23 (Phase D · task 13): this counted EVERY message in the Manager's inbox
  // and expected exactly one. MAILHTTP-3, earlier in this file and on the same server, sends a
  // `question`, which is now copied to the Manager too — so the inbox holds two. The claim this
  // test makes is about STATUS, so it now counts status messages rather than the whole inbox.
  const statuses = mgr.json.messages.filter((m) => m.kind === "status");
  assert.equal(statuses.length, 1, "the Manager is kept informed without being addressed");
  assert.equal(statuses[0].body, "halfway");
});

test("MAILHTTP-8: a rebound Host is 403 and DELETE is 405", async () => {
  assert.equal((await req("GET", "/runtime/mail/sr-backend", { Host: "evil.example.com", "x-runtime-token": TOK })).status, 403);
  assert.equal((await req("DELETE", "/runtime/mail", auth)).status, 405);
});
