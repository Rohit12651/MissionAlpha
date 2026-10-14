// D9 — THE SAME LIE, IN THE SURFACE SESSION 14 DID NOT TOUCH.
//
// Session 14 taught the STORY PIPELINE that `claude -p` reports an expired token as
// `is_error:true` inside a frame whose `subtype` still says `"success"`, then exits 0 —
// and that `result` therefore carries an ERROR, not a reply. `cliReply` was given a
// fourth `onDone` argument (`{isError, apiErrorStatus}`) so callers could tell the
// difference. `handleChat` never read it.
//
// Read off the LIVE install on 2026-08-24, `GET /runtime/tech-lead/thread`:
//
//   user      | Say hello in 3 words.
//   assistant | Failed to authenticate. API Error: 401 OAuth access token has expired.
//
// The provider's error is sitting in the thread as the agent's own words — persisted at
// rest, replayed on every reload, and indistinguishable from something the model said. A
// human reading that thread cannot tell a broken engine from a rude one.
//
// What this pins: an is_error turn is streamed as an ERROR, streams no assistant tokens,
// and leaves history holding a MARKED failure notice instead of the provider's prose —
// the turn happened and failed, and the thread says exactly that.
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
const PORT = 3974, TOK = "chatfailtok", BASE = `http://127.0.0.1:${PORT}`;
const OAUTH_ERR = "Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.";
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
  root = realpathSync(mkdtempSync(join(tmpdir(), "ma-chatcli-")));
  const repo = makeThrowawayRepo(root);
  const fakeJs = join(root, "fake-claude.mjs");
  // The real expired-OAuth wire frame, byte for byte: subtype "success", is_error true,
  // exit 0. Every exit-code check on this path reports a healthy turn.
  writeFileSync(fakeJs, [
    'const w = (o) => process.stdout.write(JSON.stringify(o) + "\\n");',
    `w({ type: "result", subtype: "success", is_error: true, api_error_status: 401, num_turns: 1, result: ${JSON.stringify(OAUTH_ERR)}, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } });`,
    "process.exit(0);",
  ].join("\n"));
  const wrapper = join(root, "fake-claude");
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${fakeJs}" "$@"\n`);
  chmodSync(wrapper, 0o755);
  mkdirSync(join(root, "db"), { recursive: true });
  child = spawn(process.execPath, [SERVER], {
    cwd: join(__dir, ".."),
    env: {
      ...process.env,
      RUNTIME_PORT: String(PORT), RUNTIME_TOKEN: TOK, RUNTIME_BACKEND: "cli", RUNTIME_TOOLS: "none",
      CLAUDE_BIN: wrapper, ANTHROPIC_API_KEY: "",
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
});

after(() => {
  try { child?.kill("SIGKILL"); } catch { /* */ }
  try { rmSync(root, { recursive: true, force: true }); } catch { /* */ }
});

/** Drive one chat turn and collect the SSE frames the browser would receive. */
async function chatTurn(agentId, message) {
  const r = await fetch(`${BASE}/runtime/${agentId}/chat`, {
    method: "POST", headers: auth(), body: JSON.stringify({ message }),
  });
  assert.equal(r.status, 200);
  const text = await r.text();
  const frames = [];
  let event = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) {
      let data = null;
      try { data = JSON.parse(line.slice(5).trim()); } catch { data = line.slice(5).trim(); }
      frames.push({ event, data });
    }
  }
  return { text, frames };
}

const threadOf = async (agentId) =>
  (await (await fetch(`${BASE}/runtime/${agentId}/thread`, { headers: auth() })).json()).messages || [];

test("CHAT-ERR-1: an is_error CLI turn is streamed as an ERROR, not as the agent's reply", async () => {
  const { text, frames } = await chatTurn("tech-lead", "Say hello in 3 words.");
  const errored = frames.some((f) => f.event === "error");
  assert.ok(errored, `the turn must surface as an error frame; got events ${JSON.stringify(frames.map((f) => f.event))}`);
  // Whatever the operator sees must NAME the failure. The provider's own sentence is the
  // most useful thing we have, so it may appear — but never as an assistant token.
  assert.match(text, /authenticate|401/i, "the operator is told what actually happened");
  const tokens = frames.filter((f) => f.event === "token");
  assert.equal(tokens.length, 0, "a failed turn produces no assistant tokens");
});

test("CHAT-ERR-2: history records a MARKED failure, never the provider's prose", async () => {
  const msgs = await threadOf("tech-lead");
  const body = (m) => String(m.text ?? m.content ?? "");
  const assistants = msgs.filter((m) => m.role === "assistant");
  for (const m of assistants) {
    // The whole defect: at rest, a provider error is indistinguishable from the agent
    // speaking. It goes to the operator LIVE on the error frame instead.
    assert.doesNotMatch(body(m), /Failed to authenticate|OAuth access token/i,
      "a provider error must never sit in the thread as something the agent said");
  }
  // The turn still HAPPENED, so the thread must not pretend otherwise: the question stays,
  // and the assistant side carries an unmistakable failure notice.
  assert.ok(msgs.some((m) => m.role === "user" && /Say hello in 3 words/.test(body(m))),
    "the question the operator asked is still history");
  assert.ok(assistants.some((m) => /did not run/.test(body(m)) && /401/.test(body(m))),
    "and the failure is stated as a failure, with its status");
});

test("CHAT-ERR-3: a HEALTHY turn is unaffected — the reply is saved and streamed", async () => {
  // Swap the stub for one that answers normally, then drive another turn.
  const okJs = join(root, "ok-claude.mjs");
  writeFileSync(okJs, [
    'const w = (o) => process.stdout.write(JSON.stringify(o) + "\\n");',
    'w({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: "hello there friend", usage: { input_tokens: 1, output_tokens: 3 } });',
    "process.exit(0);",
  ].join("\n"));
  writeFileSync(join(root, "fake-claude"), `#!/bin/sh\nexec "${process.execPath}" "${okJs}" "$@"\n`);
  chmodSync(join(root, "fake-claude"), 0o755);

  const { frames } = await chatTurn("docs-writer", "say hi");
  assert.ok(frames.some((f) => f.event === "token"), "a good turn still streams tokens");
  assert.ok(!frames.some((f) => f.event === "error"), "and raises no error frame");
  const msgs = await threadOf("docs-writer");
  assert.ok(
    msgs.some((m) => m.role === "assistant" && /hello there friend/.test(String(m.text ?? m.content ?? ""))),
    "the reply is persisted",
  );
});
