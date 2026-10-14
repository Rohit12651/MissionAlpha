// Side-effect fixture: import FIRST in any test that boots server.mjs.
//
// Found 2026-09-27: server-booting tests isolated the DB but left most durable roots at their
// defaults — INSIDE this repo. A test's seeded cadence planted a task in the live
// `agent-runtime/engine-store/`, and the real runtime then ran it as a real model turn; another test
// rewrote the tracked `.claude/agents/notifications-engineer.md` mid-suite.
//
// This points every root server.mjs / factory.mjs would otherwise default into the repo (or into a
// tmp dir the LIVE runtime shares) at a per-process temp dir. Live runtime STATE starts empty — a test
// must never see, reclaim or run the operator's tasks — while shipped CONFIG (roster, agent pool,
// factory files, cockpit state) is copied, so reads are unchanged and writes stay out of the repo.
// A test's own explicit env keys still win: the spawn env spreads process.env first.
// The root list is checked against the code by state-isolation.test.mjs (STATE-ISO-1/2).
import { mkdtempSync, mkdirSync, cpSync, existsSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const RUNTIME = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO = join(RUNTIME, "..");
const root = realpathSync(mkdtempSync(join(tmpdir(), "ma-state-")));
const at = (...p) => join(root, ...p);

/** Copy a shipped file/dir into the temp root when it exists; return the temp path either way. */
function seeded(src, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  if (existsSync(src)) cpSync(src, dest, { recursive: true });
  return dest;
}

const agentsCopy = seeded(join(REPO, ".claude", "agents"), at("claude-agents"));
const factoryCopy = seeded(join(REPO, "factory"), at("factory"));

export const ISOLATED_ROOTS = Object.freeze({
  // live runtime state — EMPTY
  RUNTIME_ENGINE_STORE: at("engine-store"),
  RUNTIME_MCP_DIR: at("engine-store", "mcp"),
  RUNTIME_MAIL_DIR: at("engine-store", "mail"),
  RUNTIME_THREADS_DIR: at("threads"),
  RUNTIME_DB_PATH: at("data", "mission.db"),
  RUNTIME_VAULT_DIR: at("data", "vault"),
  RUNTIME_TRUST_FILE: at("data", "trust.json"),
  RUNTIME_WORKER_CAP_FILE: at("data", "worker-caps.json"),
  RUNTIME_TOKEN_DIR: at("token"),
  RUNTIME_SANDBOX_ROOT: at("sandboxes"),
  RUNTIME_WORKTREE_ROOT: at("worktrees"),
  RUNTIME_UPLOADS_ROOT: at("uploads"),
  // shipped config — COPIED
  RUNTIME_ROSTER_FILE: seeded(join(RUNTIME, "roster.json"), at("roster.json")),
  RUNTIME_AGENTS_DIR: agentsCopy,
  RUNTIME_POOL_DIR: agentsCopy,
  RUNTIME_FACTORY_DIR: factoryCopy,
  FACTORY_REGISTRY_FILE: join(factoryCopy, "registry.json"),
  RUNTIME_POLICY_FILE: join(factoryCopy, "policy.json"),
  RUNTIME_ADAPTERS_FILE: join(factoryCopy, "adapters.json"),
  RUNTIME_DEPLOY_FILE: join(factoryCopy, "deploy.json"),
  RUNTIME_STATION_PERMS_FILE: join(factoryCopy, "station-perms.json"),
  RUNTIME_STATION_MEMORY_FILE: join(factoryCopy, "station-memory.json"),
  RUNTIME_STATION_SKILLS_FILE: join(factoryCopy, "station-skills.json"),
  WAAHYU_STATE_PATH: seeded(join(REPO, "agent-status", "state.json"), at("agent-status", "state.json")),
});

for (const [k, v] of Object.entries(ISOLATED_ROOTS)) if (!process.env[k]) process.env[k] = v;
process.once("exit", () => { try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });
