// SESSION 14 — a stage dispatch must be BOUNDED.
//
// Observed live (2026-08-23): after routing the pipeline to the operator's OpenRouter
// account, the `design` stage opened a TLS connection to the provider and never received
// a response. `lsof` showed the socket ESTABLISHED for eight minutes with zero bytes back.
// The story sat at stage `design`, status `active`, forever:
//   • openai-compat streamChat takes a `signal` but applies no timeout of its own
//   • the dispatch passed no signal
//   • anti-drift watches the ENGINE QUEUE, not pipeline stage dispatches
// So nothing anywhere could see it. Not a failure — a NON-EVENT, which is exactly how the
// three-day outage this program started with stayed invisible.
//
// A hung provider must become a bounded, VISIBLE failure: the story blocks, and one
// diff-less Delivery says the stage timed out.
import "./fixtures/isolate-state.mjs"; // FIRST — the booted server must not touch live runtime state (STATE-ISO-2)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { makeThrowawayRepo, isolatedRuntimeEnv } from "./fixtures/throwaway-repo.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dir, "..", "server.mjs");
const PORT = 3973, TOK = "pipetimeouttok", BASE = `http://127.0.0.1:${PORT}`;
const STAGE_TIMEOUT_MS = 2000;
let root, child;
const H = (x = {}) => ({ Host: `localhost:${PORT}`, "Content-Type": "application/json", ...x });
const auth = (x = {}) => H({ "x-runtime-token": TOK, ...x });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHealth(ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if ((await fetch(`${BASE}/runtime/health`, { headers: { Host: `localhost:${PORT}` } })).ok) return; } catch { /* */ }
    await sleep(120);
  }
  throw new Error("server not healthy");
}

before(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ma-pipetmo-")));
  const repo = makeThrowawayRepo(root);
  // A `claude` that connects and then says NOTHING — the provider-hang shape, reproduced
  // as a process. It never writes a frame and never exits on its own.
  const fakeJs = join(root, "fake-claude.mjs");
  writeFileSync(fakeJs, [
    "process.stdin.resume();",
    "setInterval(() => {}, 1 << 30);", // hold the event loop open forever
  ].join("\n"));
  const wrapper = join(root, "fake-claude");
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${fakeJs}" "$@"\n`);
  chmodSync(wrapper, 0o755);
  mkdirSync(join(root, "db"), { recursive: true });
  child = spawn(process.execPath, [SERVER], {
    cwd: join(__dir, ".."),
    env: {
      ...process.env,
      RUNTIME_PORT: String(PORT), RUNTIME_TOKEN: TOK, RUNTIME_BACKEND: "cli", RUNTIME_TOOLS: "write",
      CLAUDE_BIN: wrapper, ANTHROPIC_API_KEY: "",
      RUNTIME_STAGE_TIMEOUT_MS: String(STAGE_TIMEOUT_MS),
      ...isolatedRuntimeEnv(root, repo),
      RUNTIME_STATION_PERMS_FILE: join(root, "station-perms.json"),
      RUNTIME_TOKEN_DIR: join(root, "tok"), RUNTIME_THREADS_DIR: join(root, "threads"),
      RUNTIME_MCP_DIR: join(root, "mcp"), RUNTIME_ENGINE_STORE: join(root, "eng"),
      RUNTIME_DB_PATH: join(root, "db", "mission.db"), RUNTIME_VAULT_DIR: join(root, "vault"),
      FACTORY_REGISTRY_FILE: join(root, "factory", "registry.json"), RUNTIME_AGENTS_DIR: join(root, "agents"),
      RUNTIME_SEED_DEFAULTS: "0", RUNTIME_HOOK_POSTEDIT: "0",
    },
    stdio: "ignore",
  });
  await waitHealth();
  await fetch(`${BASE}/runtime/accounts`, {
    method: "POST", headers: auth(),
    body: JSON.stringify({ providerType: "claude", label: "pipeline", authMethod: "subscription" }),
  });
});

after(() => {
  try { child?.kill("SIGKILL"); } catch { /* */ }
  try { rmSync(root, { recursive: true, force: true }); } catch { /* */ }
});

// ── TMO-1 — a hung stage becomes a bounded, visible failure ──────────────────
test("TMO-1: a stage whose model never answers times out, blocks the story, and is not silent", async () => {
  const c = await fetch(`${BASE}/runtime/stories`, {
    method: "POST", headers: auth(), body: JSON.stringify({ title: "Hung provider", idea: "the model never replies" }),
  });
  assert.equal(c.status, 201);
  const id = (await c.json()).story.id;
  await fetch(`${BASE}/runtime/stories/${id}/advance`, {
    method: "POST", headers: auth(), body: JSON.stringify({ event: "start" }),
  });

  // Generously more than the deadline, but FINITE — the whole point is that it settles.
  const budget = STAGE_TIMEOUT_MS + 15000;
  const t0 = Date.now();
  let story;
  for (;;) {
    story = (await (await fetch(`${BASE}/runtime/stories/${id}`, { headers: auth() })).json()).story;
    if (story.status === "blocked") break;
    if (Date.now() - t0 > budget) break;
    await sleep(200);
  }

  assert.equal(story.status, "blocked", "a hung dispatch must not leave the story 'active' forever");
  assert.equal(story.stage, "requirements", "parked where it hung — never advanced on no answer");
  assert.equal(story.spec, null, "no artifact from a stage that produced nothing");

  const { deliveries } = await (await fetch(`${BASE}/inbox`, { headers: auth() })).json();
  const fails = deliveries.filter((d) => d.kind === "failure");
  assert.ok(fails.length >= 1, "the operator is told — a hung engine is never a non-event");
  const full = await (await fetch(`${BASE}/inbox/${fails[0].id}`, { headers: auth() })).json();
  assert.match(`${full.title || ""} ${full.summary || ""}`, /timed out|timeout/i, "the reason names the timeout");
});
