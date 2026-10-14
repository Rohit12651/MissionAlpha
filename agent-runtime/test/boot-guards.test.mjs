// sr-security P5 re-review — the BOOT assertions in server.mjs (#1 containment,
// #4b RUNTIME_CONFIG_DIR).
//
// server.mjs refuses to start when a runtime state dir sits INSIDE REPO_ROOT: a
// read-mode agent runs with cwd=REPO_ROOT, so an in-root TOKEN_FILE is self-readable
// and the agent can self-authorize /apply. The assertion used to be a raw
// `resolve(p).startsWith(root + sep)`, which on APFS is bypassed by re-spelling the
// ancestor in a different case. It now runs through workspace.mjs's isInside.
//
// Every case boots the server against a THROWAWAY git repo in $TMPDIR with fully
// isolated RUNTIME_* dirs — the live MissionAlpha checkout is never the target and
// no worktree/branch is ever registered against it.
import "./fixtures/isolate-state.mjs"; // FIRST — the booted server must not touch live runtime state (STATE-ISO-2)
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { isCaseInsensitiveFs } from "../workspace.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dir, "..", "server.mjs");
let port = 3997;

function throwawayRepo(prefix) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const repo = join(root, "Repo"); // deliberately mixed case — the #1 probe needs it
  mkdirSync(join(repo, "src"), { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  return { root, repo };
}

// Boot the server with the given extra env and report how it exited. A boot-time
// assertion throws before listen(), so this resolves fast on the refusal path.
function bootOnce(extraEnv, timeoutMs = 15_000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER], {
      cwd: join(__dir, ".."),
      env: {
        ...process.env,
        RUNTIME_PORT: String(port++),
        RUNTIME_TOKEN: "boot-guard-token",
        RUNTIME_BACKEND: "mock",
        ANTHROPIC_API_KEY: "",
        RUNTIME_SEED_DEFAULTS: "0",
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += String(d); });
    child.stdout.on("data", () => {});
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* */ } }, timeoutMs);
    child.on("exit", (code) => { clearTimeout(timer); resolve({ code, stderr }); });
  });
}

test("#4b RUNTIME_CONFIG_DIR inside REPO_ROOT REFUSES to boot", async () => {
  const { root, repo } = throwawayRepo("ma-boot-cfg-");
  try {
    const r = await bootOnce({
      RUNTIME_REPO_ROOT: repo,
      RUNTIME_CONFIG_DIR: join(repo, "cfg"), // the file that PINS the next boot's root
      RUNTIME_TOKEN_DIR: join(root, "tok"),
      RUNTIME_SANDBOX_ROOT: join(root, "sb"),
      RUNTIME_WORKTREE_ROOT: join(root, "wt"),
      RUNTIME_DB_PATH: join(root, "db", "mission.db"),
      RUNTIME_ENGINE_STORE: join(root, "eng"),
      RUNTIME_THREADS_DIR: join(root, "threads"),
    });
    assert.notEqual(r.code, 0, "boot must fail closed");
    assert.match(r.stderr, /RUNTIME_CONFIG_DIR must be OUTSIDE RUNTIME_REPO_ROOT/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#1 a MIXED-CASE ancestor no longer hides a state dir from the boot assertion", async () => {
  const { root, repo } = throwawayRepo("ma-boot-case-");
  try {
    // The SAME directory, re-spelled. Pre-fix, startsWith() compared "…/REPO/" with
    // "…/Repo/tok", missed the containment, and the runtime booted with TOKEN_FILE
    // inside REPO_ROOT — i.e. readable by a read-mode agent.
    const shouted = join(dirname(repo), "REPO");
    const r = await bootOnce({
      RUNTIME_REPO_ROOT: shouted,
      RUNTIME_TOKEN_DIR: join(repo, "tok"),
      RUNTIME_SANDBOX_ROOT: join(root, "sb"),
      RUNTIME_WORKTREE_ROOT: join(root, "wt"),
      RUNTIME_CONFIG_DIR: join(root, "cfg"),
      RUNTIME_DB_PATH: join(root, "db", "mission.db"),
      RUNTIME_ENGINE_STORE: join(root, "eng"),
      RUNTIME_THREADS_DIR: join(root, "threads"),
    });
    assert.notEqual(r.code, 0, "boot must fail closed on the re-spelled ancestor");
    if (isCaseInsensitiveFs()) assert.match(r.stderr, /RUNTIME_TOKEN_DIR must be OUTSIDE RUNTIME_REPO_ROOT/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("control: the SAME layout with every state dir outside REPO_ROOT boots fine", async () => {
  const { root, repo } = throwawayRepo("ma-boot-ok-");
  const p = port;
  try {
    const child = spawn(process.execPath, [SERVER], {
      cwd: join(__dir, ".."),
      env: {
        ...process.env,
        RUNTIME_PORT: String(port++), RUNTIME_TOKEN: "boot-ok-token", RUNTIME_BACKEND: "mock",
        ANTHROPIC_API_KEY: "", RUNTIME_SEED_DEFAULTS: "0",
        RUNTIME_REPO_ROOT: repo,
        RUNTIME_TOKEN_DIR: join(root, "tok"), RUNTIME_SANDBOX_ROOT: join(root, "sb"),
        RUNTIME_WORKTREE_ROOT: join(root, "wt"), RUNTIME_CONFIG_DIR: join(root, "cfg"),
        RUNTIME_DB_PATH: join(root, "db", "mission.db"), RUNTIME_ENGINE_STORE: join(root, "eng"),
        RUNTIME_THREADS_DIR: join(root, "threads"), RUNTIME_MCP_DIR: join(root, "mcp"),
        FACTORY_REGISTRY_FILE: join(root, "factory", "registry.json"), RUNTIME_AGENTS_DIR: join(root, "agents"),
      },
      stdio: "ignore",
    });
    try {
      const t0 = Date.now();
      let healthy = false;
      while (Date.now() - t0 < 15_000 && !healthy) {
        try { healthy = (await fetch(`http://127.0.0.1:${p}/runtime/health`, { headers: { Host: `localhost:${p}` } })).ok; }
        catch { /* not up yet */ }
        if (!healthy) await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal(healthy, true, "the guard is a guard, not a blanket refusal");
    } finally { try { child.kill("SIGKILL"); } catch { /* */ } }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
