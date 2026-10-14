// MUNDER-ADOPTION A5 — the skills-budget field at the wire, through a REAL booted
// runtime. Pins: GET /runtime/:id/skills carries {budget:{used,raw,max,trimmed}},
// budget.used never exceeds budget.max, and an empty station reports used 0 with the
// index note's length only when RUNTIME_SKILL_INDEX is on (off here → 0).
import "./fixtures/isolate-state.mjs"; // FIRST — the booted server must not touch live runtime state (STATE-ISO-2)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dir = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dir, "..", "server.mjs");
const PORT = 3982, TOK = "skillstok", BASE = `http://127.0.0.1:${PORT}`;

let root, repo, child;
const H = (x = {}) => ({ Host: `localhost:${PORT}`, "Content-Type": "application/json", ...x });
const auth = (x = {}) => H({ "x-runtime-token": TOK, ...x });
const get = (path) => fetch(`${BASE}${path}`, { headers: auth() });
const put = (path, body) => fetch(`${BASE}${path}`, { method: "PUT", headers: auth(), body: JSON.stringify(body) });

async function waitHealth() {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`${BASE}/runtime/health`, { headers: H() }); if (r.status) return; } catch { /* boot race */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("runtime never came up");
}

before(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ma-skillsb-")));
  repo = join(root, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "seed.ts"), "export const seed = 1;\n");
  child = spawn(process.execPath, [SERVER], {
    cwd: join(__dir, ".."),
    env: {
      ...process.env,
      RUNTIME_PORT: String(PORT), RUNTIME_TOKEN: TOK, RUNTIME_BACKEND: "mock", RUNTIME_TOOLS: "write",
      RUNTIME_REPO_ROOT: repo, RUNTIME_SEED_DIRS: "src",
      RUNTIME_DB_PATH: join(root, "x", "db", "mission.db"),
      RUNTIME_SANDBOX_ROOT: join(root, "x", "sb"),
      RUNTIME_TOKEN_DIR: join(root, "x", "tok"), RUNTIME_THREADS_DIR: join(root, "x", "threads"),
      RUNTIME_MCP_DIR: join(root, "x", "mcp"), RUNTIME_ENGINE_STORE: join(root, "x", "eng"),
      RUNTIME_WORKTREE_ROOT: join(root, "x", "wt"), RUNTIME_EXEC_WT_ROOT: join(root, "x", "exwt"),
      RUNTIME_SEED_DEFAULTS: "0", ANTHROPIC_API_KEY: "",
      RUNTIME_POLICY_FILE: join(root, "x", "policy.json"),
      RUNTIME_ADAPTERS_FILE: join(root, "x", "adapters.json"),
      RUNTIME_STATION_SKILLS_FILE: join(root, "x", "station-skills.json"),
      RUNTIME_WORKER_CAP_FILE: join(root, "x", "worker-caps.json"),
      FACTORY_REGISTRY_FILE: join(root, "x", "factory", "registry.json"), RUNTIME_AGENTS_DIR: join(root, "x", "agents"),
    },
    stdio: "ignore",
  });
  await waitHealth();
});
after(async () => {
  await new Promise((r) => { if (!child) return r(); child.once("exit", r); try { child.kill("SIGKILL"); } catch { r(); } });
  try { rmSync(root, { recursive: true, force: true }); } catch { /* */ }
});

test("empty station: budget present, used 0 (index off), trimmed false", async () => {
  const r = await get("/runtime/sre/skills");
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(body.budget, "budget field present");
  assert.equal(body.budget.used, 0);
  assert.equal(body.budget.trimmed, false);
  assert.ok(body.budget.max > 0);
});

test("attached skills: used > 0, used <= max, raw >= used", async () => {
  const cat = (await (await get("/runtime/sre/skills")).json()).catalog;
  assert.ok(Array.isArray(cat) && cat.length > 0, "catalog non-empty");
  const pick = cat.slice(0, Math.min(3, cat.length)).map((s) => s.id);
  const w = await put("/runtime/sre/skills", { skills: pick });
  assert.equal(w.status, 200);
  const body = await (await get("/runtime/sre/skills")).json();
  assert.ok(body.budget.used > 0, "note has length");
  assert.ok(body.budget.used <= body.budget.max, "boundary cut respected");
  assert.ok(body.budget.raw >= body.budget.used, "raw >= used");
});
