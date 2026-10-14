// Observed 2026-09-27: `kill <server pid>` exited the runtime, but the `claude -p` seat it had just
// dispatched (a cadence tick at boot) survived as an orphan with PPID 1, still running and still
// spending, and had to be killed by hand. The server had no SIGTERM/SIGINT handler at all, and its
// CLI children share its process group, so nothing ever told them the parent was gone.
//
// Now every claude/engine child is spawned through `seatChildren.spawnSeat` — DETACHED, so it leads
// its own process group — and a shutdown signal terminates every live group (SIGTERM, a short
// grace, then SIGKILL) and exits SYNCHRONOUSLY. Synchronous matters: no child `close` handler gets an
// event-loop turn, so an in-flight task is left claimed/EDITING — exactly the state the P4 boot
// reconcile re-queues — instead of being marked a failed attempt.
import "./fixtures/isolate-state.mjs"; // FIRST — the booted server must not touch live runtime state (STATE-ISO-2)
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, chmodSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { parse } from "acorn";
import { makeThrowawayRepo, isolatedRuntimeEnv } from "./fixtures/throwaway-repo.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const RUNTIME = join(__dir, "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
async function waitGone(pid, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (!alive(pid)) return true; await sleep(100); }
  return !alive(pid);
}
async function waitFile(p, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (existsSync(p) && readFileSync(p, "utf8").trim()) return Number(readFileSync(p, "utf8").trim()); await sleep(100); }
  throw new Error(`timed out waiting for ${p}`);
}

const leftovers = [];
after(() => { for (const pid of leftovers) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } } });

test("SHUT-1 (E2E): SIGTERM to the real server kills the claude child it spawned AND that child's own child", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ma-shut-")));
  const repo = makeThrowawayRepo(root);
  const cliPid = join(root, "cli.pid"), kidPid = join(root, "kid.pid");
  // A CLI that never answers and has a subprocess of its own — the shape of a real seat turn
  // (an MCP server, a Bash tool command).
  const fakeJs = join(root, "fake-claude.mjs");
  writeFileSync(fakeJs, [
    'import { spawn } from "node:child_process";',
    'import { writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(cliPid)}, String(process.pid));`,
    'const k = spawn("sleep", ["300"], { stdio: "ignore" });',
    `writeFileSync(${JSON.stringify(kidPid)}, String(k.pid));`,
    "setInterval(() => {}, 1000);",
  ].join("\n"));
  const wrapper = join(root, "fake-claude");
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${fakeJs}" "$@"\n`);
  chmodSync(wrapper, 0o755);
  mkdirSync(join(root, "db"), { recursive: true });
  const PORT = 3977, TOK = "shuttok", BASE = `http://127.0.0.1:${PORT}`;
  const H = { Host: `localhost:${PORT}`, "Content-Type": "application/json" };
  const server = spawn(process.execPath, [join(RUNTIME, "server.mjs")], {
    cwd: RUNTIME,
    env: {
      ...process.env, RUNTIME_PORT: String(PORT), RUNTIME_TOKEN: TOK, RUNTIME_BACKEND: "cli", RUNTIME_TOOLS: "none",
      CLAUDE_BIN: wrapper, ANTHROPIC_API_KEY: "", ...isolatedRuntimeEnv(root, repo),
      RUNTIME_STATION_PERMS_FILE: join(root, "station-perms.json"),
      RUNTIME_TOKEN_DIR: join(root, "tok"), RUNTIME_THREADS_DIR: join(root, "threads"),
      RUNTIME_MCP_DIR: join(root, "mcp"), RUNTIME_ENGINE_STORE: join(root, "eng"),
      RUNTIME_DB_PATH: join(root, "db", "mission.db"), RUNTIME_VAULT_DIR: join(root, "vault"),
      FACTORY_REGISTRY_FILE: join(root, "factory", "registry.json"), RUNTIME_AGENTS_DIR: join(root, "agents"),
      RUNTIME_SEED_DEFAULTS: "0", RUNTIME_HOOK_POSTEDIT: "0",
    },
    stdio: "ignore",
  });
  leftovers.push(server.pid);
  const exited = new Promise((r) => server.once("exit", (code, signal) => r({ code, signal })));
  try {
    const t0 = Date.now();
    for (;;) {
      try { if ((await fetch(`${BASE}/runtime/health`, { headers: { Host: H.Host } })).ok) break; } catch { /* booting */ }
      if (Date.now() - t0 > 20000) throw new Error("server not healthy");
      await sleep(150);
    }
    const ac = new AbortController();
    fetch(`${BASE}/runtime/tech-lead/chat`, { method: "POST", signal: ac.signal, headers: { ...H, "x-runtime-token": TOK },
      body: JSON.stringify({ message: "hello" }) }).catch(() => {});
    const cli = await waitFile(cliPid, 20000);
    const kid = await waitFile(kidPid, 10000);
    leftovers.push(cli, kid);
    assert.ok(alive(cli) && alive(kid), "premise: the seat and its subprocess are running");

    server.kill("SIGTERM");
    const how = await Promise.race([exited, sleep(10000).then(() => null)]);
    ac.abort();
    assert.ok(how, "the server exits on SIGTERM");
    assert.equal(await waitGone(cli, 5000), true, `the claude child ${cli} outlived the server`);
    assert.equal(await waitGone(kid, 5000), true, `the child's own subprocess ${kid} outlived the server`);
  } finally {
    try { server.kill("SIGKILL"); } catch { /* gone */ }
    try { rmSync(root, { recursive: true, force: true }); } catch { /* */ }
  }
});

test("SHUT-2: the shutdown handler kills every live group, then exits BEFORE any child handler can run", async () => {
  const { createSeatChildren, installShutdown } = await import("../seat-children.mjs");
  const children = createSeatChildren();
  const root = mkdtempSync(join(tmpdir(), "ma-shut2-"));
  const kidPid = join(root, "kid.pid");
  const c = children.spawnSeat("sh", ["-c", `sleep 300 & echo $! > '${kidPid}'; wait`], { stdio: "ignore" });
  leftovers.push(c.pid);
  const kid = await waitFile(kidPid, 5000);
  leftovers.push(kid);
  let closedBeforeExit = false, exitCode = null;
  c.once("exit", () => { if (exitCode === null) closedBeforeExit = true; });
  const proc = new EventEmitter();
  installShutdown(children, { proc, exit: (code) => { exitCode = code; }, graceMs: 200 });
  proc.emit("SIGTERM");
  assert.equal(exitCode, 143, "exit is called synchronously, with 128 + SIGTERM");
  assert.equal(closedBeforeExit, false, "no child handler ran before exit — the task row is left for the boot reconcile");
  assert.equal(await waitGone(c.pid, 3000), true, "the group leader is gone");
  assert.equal(await waitGone(kid, 3000), true, "the leader's child is gone — the whole group was signalled");
  rmSync(root, { recursive: true, force: true });
});

test("SHUT-2b: SIGINT exits 130; a second signal does not run the handler twice", async () => {
  const { createSeatChildren, installShutdown } = await import("../seat-children.mjs");
  const proc = new EventEmitter();
  const codes = [];
  installShutdown(createSeatChildren(), { proc, exit: (code) => codes.push(code), graceMs: 0 });
  proc.emit("SIGINT");
  proc.emit("SIGTERM");
  assert.deepEqual(codes, [130]);
});

test("SHUT-5: a per-task kill (kill-switch, timeout, STOP) reaches the seat's own subprocesses, not just the CLI", async () => {
  // Detaching put a seat's subprocesses (MCP server, Bash commands) in the SEAT's group. A kill that
  // signals only the leader orphans them — and once the leader is gone, shutdown no longer tracks it.
  const { createSeatChildren } = await import("../seat-children.mjs");
  const children = createSeatChildren();
  const root = mkdtempSync(join(tmpdir(), "ma-shut5-"));
  const kidPid = join(root, "kid.pid");
  const c = children.spawnSeat("sh", ["-c", `sleep 300 & echo $! > '${kidPid}'; wait`], { stdio: "ignore" });
  leftovers.push(c.pid);
  const kid = await waitFile(kidPid, 5000);
  leftovers.push(kid);
  children.killGroup(c, "SIGTERM");
  assert.equal(await waitGone(c.pid, 3000), true, "the seat is gone");
  assert.equal(await waitGone(kid, 3000), true, "the seat's subprocess is gone too");
  assert.doesNotThrow(() => children.killGroup(c, "SIGKILL"), "killing an already-dead group is a no-op");
  rmSync(root, { recursive: true, force: true });
});

test("SHUT-6: server.mjs never signals a seat child's leader alone — every kill goes through killGroup", () => {
  const bare = [];
  walk(astOf("server.mjs"), (n) => {
    if (n.type === "CallExpression" && n.callee?.type === "MemberExpression" && n.callee.property?.name === "kill"
      && n.callee.object?.type === "Identifier" && ["child", "spawned"].includes(n.callee.object.name)) bare.push(n.start);
  });
  assert.deepEqual(bare, [], "child.kill(sig) reaches the CLI only; its subprocesses orphan");
  let group = 0;
  walk(astOf("server.mjs"), (n) => { if (n.type === "CallExpression" && n.callee?.property?.name === "killGroup") group++; });
  assert.ok(group >= 4, `anti-vacuity: STOP, Manager timeout, engine kill-switch and stage timeout (found ${group})`);
});

// ── the wiring: SHUT-2 passes against a server that never uses the helper ──
function walk(n, visit) {
  if (!n || typeof n.type !== "string") return;
  visit(n);
  for (const k of Object.keys(n)) { const v = n[k]; if (Array.isArray(v)) v.forEach((c) => walk(c, visit)); else if (v && typeof v.type === "string") walk(v, visit); }
}
const astOf = (f) => parse(readFileSync(join(RUNTIME, f), "utf8"), { ecmaVersion: "latest", sourceType: "module" });

test("SHUT-3: no module spawns the claude/engine CLI directly — every one goes through seatChildren.spawnSeat", () => {
  const direct = [], tracked = [];
  for (const f of ["server.mjs", "factory.mjs"]) {
    walk(astOf(f), (n) => {
      if (n.type !== "CallExpression") return;
      const first = n.arguments[0];
      const cliBin = first?.type === "Identifier" && ["CLAUDE_BIN", "ENGINE_BIN"].includes(first.name);
      if (!cliBin) return;
      if (n.callee?.type === "Identifier" && n.callee.name === "spawn") direct.push(`${f}:${n.start}`);
      if (n.callee?.type === "MemberExpression" && n.callee.property?.name === "spawnSeat") tracked.push(`${f}:${n.start}`);
    });
  }
  assert.deepEqual(direct, [], "a direct spawn is invisible to shutdown and orphans on SIGTERM");
  assert.ok(tracked.length >= 4, `anti-vacuity: chat, manager, engine seat and factory spawns are tracked (found ${tracked.length})`);
});

test("SHUT-4: server.mjs installs the shutdown handler on the shared registry", () => {
  let installed = false;
  walk(astOf("server.mjs"), (n) => {
    if (n.type === "CallExpression" && n.callee?.name === "installShutdown" && n.arguments[0]?.name === "seatChildren") installed = true;
  });
  assert.ok(installed, "installShutdown(seatChildren, …) must be called at boot");
});
