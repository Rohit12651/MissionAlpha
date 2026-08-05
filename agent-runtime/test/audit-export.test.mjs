// P8 (ADR-055/030) — audit export bundle + bus `usage.tick`, end to end over a booted
// runtime (mock backend, throwaway dirs). Proves: 401 unauth · JSON has all sections ·
// CSV parses w/ section markers · date-range filters · a secret in an AUDIT.log line is
// REDACTED in the export · NO dollar/cost anywhere · usage.tick fires on the bus.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { makeThrowawayRepo, isolatedRuntimeEnv } from "./fixtures/throwaway-repo.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dir, "..", "server.mjs");
const PORT = 3986;
const TOKEN = "auditexporttok";
const BASE = `http://127.0.0.1:${PORT}`;
let root, threadsDir, tokDir;

const H = (extra = {}) => ({ Host: `localhost:${PORT}`, ...extra });
const AUTH = (extra = {}) => H({ "x-runtime-token": TOKEN, ...extra });

function boot() {
  return spawn(process.execPath, [SERVER], {
    cwd: join(__dir, ".."),
    env: {
      ...process.env, RUNTIME_PORT: String(PORT), RUNTIME_TOKEN: TOKEN, RUNTIME_BACKEND: "mock",
      RUNTIME_THREADS_DIR: threadsDir, RUNTIME_TOKEN_DIR: tokDir,
      RUNTIME_ENGINE_STORE: join(root, "eng"), RUNTIME_WORKTREE_ROOT: join(root, "wt"), ANTHROPIC_API_KEY: "",
      ...isolatedRuntimeEnv(root, makeThrowawayRepo(root)),
      RUNTIME_DB_PATH: join(root, "db", "mission.db"),
    },
    stdio: "ignore",
  });
}
async function waitHealth(ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if ((await fetch(`${BASE}/runtime/health`, { headers: H() })).ok) return; } catch { /* */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server not healthy");
}
// Drain a chat SSE to completion so the turn settles (⇒ usage recorded + emitted).
async function drainChat(agentId, message, model = "sonnet") {
  const res = await fetch(`${BASE}/runtime/${agentId}/chat`, {
    method: "POST", headers: H({ "Content-Type": "application/json" }),
    body: JSON.stringify({ message, model }),
  });
  await res.text();
}

let child;
before(async () => {
  root = mkdtempSync(join(tmpdir(), "ma-auditexport-"));
  threadsDir = join(root, "threads");
  tokDir = join(root, "tok");
  mkdirSync(threadsDir, { recursive: true });
  mkdirSync(tokDir, { recursive: true });
  // Plant an AUDIT.log line carrying a secret-shaped token — the export MUST redact it.
  // Format is the factory.audit TSV: <iso>\t<event>\t<json>. Timestamp = now (in range).
  const iso = new Date().toISOString();
  writeFileSync(
    join(tokDir, "factory-audit.log"),
    `${iso}\texec.run\t${JSON.stringify({ cmd: "deploy --token ghp_abcdef0123456789ABCDEFGHIJ", agentId: "u1" })}\n`,
    "utf-8",
  );
  child = boot();
  await waitHealth();
  // one chat turn → a usage row for today (mock ⇒ estimate path, est:true)
  await drainChat("expu1", "hello please build the thing", "haiku");
});
after(() => {
  try { child?.kill("SIGKILL"); } catch { /* */ }
  try { rmSync(root, { recursive: true, force: true }); } catch { /* */ }
});

test("export requires auth (401 without token)", async () => {
  const res = await fetch(`${BASE}/runtime/audit/export?format=json`, { headers: H() });
  assert.equal(res.status, 401);
});

test("JSON bundle has every section + usage rows, and NO dollar/cost field", async () => {
  const res = await fetch(`${BASE}/runtime/audit/export?format=json`, { headers: AUTH() });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /application\/json/);
  assert.match(res.headers.get("content-disposition") || "", /attachment; filename=/);
  const body = await res.text();
  const bundle = JSON.parse(body); // parses ⇒ streamed JSON is well-formed
  for (const k of ["meta", "deliveries", "decisions", "auditLog", "usage"]) assert.ok(k in bundle, `has ${k}`);
  assert.ok(Array.isArray(bundle.usage.rows), "usage.rows array");
  assert.ok(bundle.usage.rows.some((r) => r.agentId === "expu1"), "the chat turn's usage row is present");
  assert.ok("totals" in bundle.usage, "usage totals present");
  // BOSS hard rule — no dollars ANYWHERE in the bundle
  assert.ok(!/cost|usd|dollar|price|\$/i.test(body), "no dollar/cost token in the JSON bundle");
});

test("a secret in an AUDIT.log line is REDACTED in the export", async () => {
  const res = await fetch(`${BASE}/runtime/audit/export?format=json`, { headers: AUTH() });
  const body = await res.text();
  assert.ok(!/ghp_abcdef0123456789/.test(body), "planted secret is scrubbed out");
  assert.ok(/redacted-secret/.test(body), "redaction marker present");
  const bundle = JSON.parse(body);
  assert.ok(bundle.auditLog.some((a) => a.event === "exec.run"), "the audit line itself still exports (only the secret is stripped)");
});

test("CSV bundle carries section markers, parses, and has no dollars", async () => {
  const res = await fetch(`${BASE}/runtime/audit/export?format=csv`, { headers: AUTH() });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /text\/csv/);
  const body = await res.text();
  for (const marker of ["DELIVERIES", "AUDIT_LOG", "USAGE", "USAGE_TOTALS"]) assert.ok(body.includes(marker), `CSV has ${marker} section`);
  assert.ok(body.includes("inputTokens,outputTokens"), "usage header columns present");
  assert.ok(!/ghp_abcdef0123456789/.test(body), "secret scrubbed in CSV too");
  assert.ok(!/\$|cost|usd|dollar/i.test(body), "no dollars in CSV");
});

test("date range excludes out-of-window rows (a year-2000 window ⇒ no usage rows)", async () => {
  const res = await fetch(`${BASE}/runtime/audit/export?format=json&from=2000-01-01&to=2000-01-02`, { headers: AUTH() });
  const bundle = JSON.parse(await res.text());
  assert.equal(bundle.usage.rows.length, 0, "today's usage row is outside the y2k window");
  assert.equal(bundle.auditLog.length, 0, "today's audit line is outside the window");
});

test("bus emits usage.tick on a chat turn (emit-on-persist, no dollars)", async () => {
  const t = await (await fetch(`${BASE}/runtime/events/ticket`, { method: "POST", headers: AUTH() })).json();
  const ac = new AbortController();
  const esRes = await fetch(`${BASE}/runtime/events?ticket=${t.ticket}`, { headers: H(), signal: ac.signal });
  // subscribed now — fire a fresh chat turn, drain it so the turn settles + emits
  await drainChat("busu1", "another build please", "sonnet");
  const reader = esRes.body.getReader();
  const dec = new TextDecoder();
  let buf = "", tick = null;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !tick) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const frames = buf.split("\n\n");
    buf = frames.pop() || "";
    for (const f of frames) {
      if (/event: usage\.tick/.test(f)) {
        const d = /data: ([\s\S]*)/.exec(f)?.[1];
        try { tick = JSON.parse(d); } catch { /* keep looking */ }
      }
    }
  }
  ac.abort();
  assert.ok(tick, "usage.tick observed on the bus");
  assert.ok(tick.agentId === "busu1" || tick.threadId === "busu1", "tick carries the agent/thread id");
  assert.equal(typeof tick.contextPct, "number");
  assert.ok(!/cost|usd|dollar|price/i.test(JSON.stringify(tick)), "tick has no dollar field");
});
