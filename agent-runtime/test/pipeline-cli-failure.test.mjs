// SESSION 14 — the WIRE proof that a dead engine cannot walk a story.
//
// This is the test that would have caught the live 2026-08-23 defect. On that install the
// Claude CLI's OAuth had expired, and `claude -p --output-format stream-json` responds:
//
//   {"type":"result","subtype":"success","is_error":true,"api_error_status":401,
//    "result":"Failed to authenticate. API Error: 401 OAuth access token has expired…",
//    "usage":{"input_tokens":0,"output_tokens":0,…}}
//
// …and EXITS 0. Note `subtype:"success"` — the subtype LIES; `is_error` is the truth.
// The runtime read `result` as the reply, so the auth error became the requirement spec
// in the Vault, was stamped on story.spec, auto-advanced the story into design, ran design
// against the same dead engine, and minted a design-approval GATE asking a human to
// approve a 99-character auth error as an engineering design.
//
// The stub below reproduces that frame BYTE-FOR-BYTE from the real observed output. What
// is pinned: the pipeline REFUSES. No spec, no advance, no gate — and one visible,
// diff-less failure Delivery that names the cause.
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
const PORT = 3971, TOK = "pipefailtok", BASE = `http://127.0.0.1:${PORT}`;
// The exact operator-visible string the live CLI produced.
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
  root = realpathSync(mkdtempSync(join(tmpdir(), "ma-pipecli-")));
  const repo = makeThrowawayRepo(root);
  // A `claude` that is authenticated with nobody — the real expired-OAuth wire frame.
  const fakeJs = join(root, "fake-claude.mjs");
  writeFileSync(fakeJs, [
    'const w = (o) => process.stdout.write(JSON.stringify(o) + "\\n");',
    `w({ type: "assistant", message: { model: "<synthetic>", content: [{ type: "text", text: ${JSON.stringify(OAUTH_ERR)} }] }, error: "authentication_failed" });`,
    `w({ type: "result", subtype: "success", is_error: true, api_error_status: 401, num_turns: 1, result: ${JSON.stringify(OAUTH_ERR)}, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } });`,
    // The CLI exits ZERO on an auth failure. That is a load-bearing part of the bug:
    // every exit-code-based check on this path reports success.
    'process.exit(0);',
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
      ...isolatedRuntimeEnv(root, repo),
      RUNTIME_STATION_PERMS_FILE: join(root, "station-perms.json"),
      RUNTIME_TOKEN_DIR: join(root, "tok"), RUNTIME_THREADS_DIR: join(root, "threads"),
      RUNTIME_MCP_DIR: join(root, "mcp"), RUNTIME_ENGINE_STORE: join(root, "eng"),
      RUNTIME_DB_PATH: join(root, "db", "mission.db"), RUNTIME_VAULT_DIR: join(root, "vault"),
      FACTORY_REGISTRY_FILE: join(root, "factory", "registry.json"), RUNTIME_AGENTS_DIR: join(root, "agents"),
      RUNTIME_SEED_DEFAULTS: "0",
      // No post-edit Docker gate — this file is about the DISPATCH leg, not the quality gate.
      RUNTIME_HOOK_POSTEDIT: "0",
    },
    stdio: "ignore",
  });
  await waitHealth();
  // The pipeline's CLI leg only runs with a swarm-capable active account.
  await fetch(`${BASE}/runtime/accounts`, {
    method: "POST", headers: auth(),
    body: JSON.stringify({ providerType: "claude", label: "pipeline", authMethod: "subscription" }),
  });
});

after(() => {
  try { child?.kill("SIGKILL"); } catch { /* */ }
  try { rmSync(root, { recursive: true, force: true }); } catch { /* */ }
});

// Walk a fresh story to `requirements`, which is where the pm-analyst dispatch fires.
async function storyIntoRequirements(title) {
  const c = await fetch(`${BASE}/runtime/stories`, {
    method: "POST", headers: auth(), body: JSON.stringify({ title, idea: `${title} — idea body` }),
  });
  assert.equal(c.status, 201, "story created");
  const id = (await c.json()).story.id;
  const a = await fetch(`${BASE}/runtime/stories/${id}/advance`, {
    method: "POST", headers: auth(), body: JSON.stringify({ event: "start" }),
  });
  assert.equal(a.status, 200, "advanced idea → requirements");
  return id;
}

async function readStory(id) {
  const r = await fetch(`${BASE}/runtime/stories/${id}`, { headers: auth() });
  assert.equal(r.status, 200);
  return await r.json();
}

// Poll until the fire-and-forget stage dispatch has settled (the advance route kicks it
// asynchronously and returns immediately). Condition-based, never a fixed sleep.
async function settled(id, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const { story } = await readStory(id);
    if (story.status === "blocked" || story.stage !== "requirements") return story;
    await sleep(150);
  }
  return (await readStory(id)).story;
}

// ── CLI-1 — the whole point: an unauthenticated engine cannot produce an artifact ──
test("CLI-1: an expired-OAuth CLI turn fails the stage — no spec, no advance, no gate", async () => {
  const id = await storyIntoRequirements("Dark mode toggle");
  const story = await settled(id);

  assert.equal(story.stage, "requirements", "the story did NOT advance into design");
  assert.equal(story.status, "blocked", "it is parked blocked, not silently active");
  assert.equal(story.spec, null, "the auth error was NOT stamped as the requirement spec");
  assert.equal(story.designRef, null, "design never ran");
});

// ── CLI-2 — the auth error never reaches a human decision surface as a document ──
test("CLI-2: no design-approval gate is minted carrying the auth error", async () => {
  const id = await storyIntoRequirements("CSV export");
  await settled(id);
  const r = await fetch(`${BASE}/inbox`, { headers: auth() });
  const { deliveries } = await r.json();
  const gates = deliveries.filter((d) => d.storyId === id && (d.kind === "design-approval" || d.kind === "question"));
  assert.equal(gates.length, 0, "a human is never asked to approve an authentication failure");
  for (const d of deliveries) {
    assert.ok(
      !String(d.title || "").includes("OAuth access token has expired"),
      "no Delivery presents the auth error as its TITLE (i.e. as an artifact)",
    );
  }
});

// ── CLI-3 — the failure is SURFACED, diff-less, and names the cause ──────────
test("CLI-3: a visible diff-less failure Delivery names the authentication cause", async () => {
  const id = await storyIntoRequirements("Push notifications");
  await settled(id);
  const r = await fetch(`${BASE}/inbox`, { headers: auth() });
  const { deliveries } = await r.json();
  const fails = deliveries.filter((d) => d.kind === "failure");
  assert.ok(fails.length >= 1, "the operator gets a row — a dead engine is never silent");
  const one = fails[0];
  assert.equal(one.diffstat.files, 0, "diff-less (Law 3)");
  const full = await (await fetch(`${BASE}/inbox/${one.id}`, { headers: auth() })).json();
  const hay = `${full.title || ""} ${full.summary || ""}`;
  assert.match(hay, /OAuth access token has expired|authenticat/i, "the reason travels to the operator");
});

// ── CLI-4 — the Vault holds no forged engineering artifact ───────────────────
test("CLI-4: no vault record was written containing the auth error", async () => {
  const r = await fetch(`${BASE}/runtime/vault?venture=waahyu`, { headers: auth() });
  // A vault read shape differs across nodes; assert on the raw body, which is enough:
  // the error string must appear NOWHERE in the knowledge base.
  const body = await r.text();
  assert.ok(
    !body.includes("OAuth access token has expired"),
    "an authentication failure never becomes institutional knowledge",
  );
});
