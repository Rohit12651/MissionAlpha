// Story-Pipeline S4 — the UNIT-TEST GATE. The autonomy teeth: after a build task writes its
// diff into the worktree, the engine runs the repo's configured test command INSIDE that same
// worktree, POST-diff and BEFORE the delivery is minted/applied. A pass lets the diff proceed;
// a fail becomes structured feedback that drives the engine's red→green retry loop.
//
// This module is PURE orchestration over injected seams (a sandbox, a config loader, the loop-
// step store) so it is deterministically testable AND wires to the real Docker jail in
// production. It NEVER runs a command on the host and NEVER decides retries — it returns a
// verdict; the engine owns the loop.
//
// SECURITY (ADR-056 remediation — sr-security BLOCK cleared):
//   • The test command is AGENT-AUTHORED CODE (a build agent can plant *.test.js). It is NOT
//     run on the host — it executes INSIDE the sandbox Docker jail (sandbox.mjs): `--network
//     none` (no exfil), `--read-only` rootfs, non-root, `--cap-drop ALL`, the worktree the ONLY
//     writable/visible host path (no ~/.aws, no ~/.ssh, no HOME, no process env / secrets). This
//     is the SAME jail the tool-loop uses. `docker kill` on timeout nukes the whole container
//     tree, so there is no host process-group orphan to leak.
//   • FAIL CLOSED when Docker is unavailable: no daemon ⇒ the gate FAILS with reason
//     `sandbox-unavailable` (the story blocks with a clear alert). There is NO un-jailed host
//     execFile fallback — an un-jailed run of agent code is exactly the risk this closes.
//   • Defense-in-depth BEFORE the sandbox: the command still comes ONLY from the validated
//     quality config (quality.mjs — allow-listed binary, SAFE_ARG per element, node-flag
//     denylist), so `testCmd.join(" ")` is a clean single string for `sh -c`; and the cwd
//     subdir join is realpath-guarded to stay inside the worktree so a planted symlink cannot
//     widen the mount scope. Containment holds regardless: the container has no host fs / no
//     network / no secrets.
//   • Captured output is fed through the loop-step store, which SCRUBS every summary before it
//     lands at rest; the tail returned to the engine (for the fix prompt) is scrubbed here too.

import { join, sep, relative } from "node:path";
import { realpathSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { relatedTests, DEFAULT_SCOPE } from "./test-scope.mjs";
import { validateCmd } from "./quality.mjs";
import { GIT_SAFE_ARGS } from "./workspace.mjs";

const TAIL_MAX = 2_000;   // how much captured output to keep as feedback
const FEEDBACK_MAX = 1_500;
const WALK_MAX_FILES = 20_000;  // bounded discovery — a hostile tree cannot make this unbounded
const WALK_MAX_DEPTH = 12;
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", "out"]);

/**
 * What the AGENT changed inside its worktree, relative to the base the worktree was cut
 * from. Read-only, argv-array, hardened git flags — the same posture worktree.mjs uses.
 * Returns [] on ANY failure, which the caller reads as "unknown" and therefore falls back
 * to the full command rather than scoping on a blind list.
 */
export function gitChangedPaths(cwd) {
  let raw;
  try {
    raw = execFileSync("git", [...GIT_SAFE_ARGS, "-C", cwd, "status", "--porcelain=v1", "-z", "-uall"], {
      encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000,
    });
  } catch { return []; }
  const out = [];
  for (const rec of raw.split("\0")) {
    if (rec.length < 4 || rec[2] !== " ") continue;
    if (rec[0] === "D" || rec[1] === "D") continue; // a deleted file has no tests to run
    out.push(rec.slice(3));
  }
  return out;
}

/** Every repo-relative file under `root`, bounded in depth and count. Never follows links. */
export function listWorktreeFiles(root) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > WALK_MAX_DEPTH || out.length >= WALK_MAX_FILES) return;
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= WALK_MAX_FILES) return;
      if (e.isSymbolicLink()) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(full, depth + 1); }
      else if (e.isFile()) out.push(relative(root, full).split(sep).join("/"));
    }
  };
  walk(root, 0);
  return out;
}

// Keep the LAST `max` chars of combined output — a test failure's signal is at the end.
function tailOf(s, max = TAIL_MAX) {
  const t = String(s ?? "");
  return t.length > max ? t.slice(t.length - max) : t;
}

export function createTestGate(deps = {}) {
  const sandbox = deps.sandbox;
  if (!sandbox || typeof sandbox.runInSandbox !== "function" || typeof sandbox.dockerAvailable !== "function") {
    throw new Error("createTestGate: sandbox { runInSandbox, dockerAvailable } required");
  }
  const loadConfig = typeof deps.loadConfig === "function" ? deps.loadConfig : () => ({ error: "no config loader" });
  const scrub = typeof deps.scrub === "function" ? deps.scrub : (s) => s;
  const loopSteps = deps.loopSteps && typeof deps.loopSteps.record === "function" ? deps.loopSteps : null;
  const realpath = typeof deps.realpath === "function" ? deps.realpath : realpathSync; // injectable for hermetic tests
  const log = typeof deps.log === "function" ? deps.log : () => {};
  // D1 seams — injected so scoping is provable without a repo on disk.
  const changedPathsFn = typeof deps.changedPathsFn === "function" ? deps.changedPathsFn : gitChangedPaths;
  const listFilesFn = typeof deps.listFilesFn === "function" ? deps.listFilesFn : listWorktreeFiles;

  /**
   * D1 — decide WHAT to run. Returns the final argv plus the two facts the caller and the
   * post-edit hook need: whether the run was scoped, and (when nothing needs running) why.
   *
   * FALL BACK, NEVER NARROW BLINDLY. Any uncertainty — git said nothing, the resolved argv
   * fails the quality validator — returns the operator's configured command unchanged. The
   * only way to run FEWER tests than configured is a positive, validated match.
   */
  function resolveCommand(cfg, cwd, workdir, { agentId, taskId }) {
    const scope = cfg.scope || DEFAULT_SCOPE;
    if (!scope.enabled) return { argv: cfg.testCmd, scoped: false, skip: null };
    let changed = [];
    try { changed = changedPathsFn(cwd) || []; } catch (e) { log(`[test-gate] changed-path probe failed for ${taskId}: ${e?.message || e}`); }
    let repoFiles = [];
    try { repoFiles = listFilesFn(workdir) || []; } catch (e) { log(`[test-gate] file discovery failed for ${taskId}: ${e?.message || e}`); }
    const r = relatedTests({ changed, repoFiles, scope });
    if (r.reason === "scope-unknown") return { argv: cfg.testCmd, scoped: false, skip: null };
    if (r.reason === "scope-empty") {
      return { argv: null, scoped: true, skip: `no related tests for the changed paths (${changed.length} changed) — unit-test gate skipped` };
    }
    const argv = [...cfg.testCmd, ...r.targets];
    // Re-validate the WHOLE argv through the same validator the config went through: the
    // targets are agent-influenced filenames, and this is the last point before they become
    // a command. A rejection is a fall-back, never a veto.
    const checked = validateCmd(argv, { label: "scoped testCmd" });
    if (checked.error) {
      log(`[test-gate] scoped argv rejected for ${taskId} (${checked.error}) — running the configured command instead`);
      return { argv: cfg.testCmd, scoped: false, skip: null };
    }
    if (r.truncated) {
      recordSteps(agentId, taskId, {
        cmd: null,
        tail: `scope truncated to ${r.targets.length} test target(s) — more matched than scope.maxTargets allows`,
        pass: true, exitCode: 0,
      });
    }
    return { argv: checked.cmd, scoped: true, skip: null };
  }

  // Feed the gate's activity into the per-task loop-step store as synthetic stream-json
  // objects — reusing loop-steps' own scrub+cap path (no second scrubber). A store fault is
  // observational: it must never break the gate verdict.
  function recordSteps(agentId, taskId, { cmd, tail, pass, timedOut, exitCode }) {
    if (!loopSteps || !taskId) return;
    try {
      if (cmd) loopSteps.record(agentId, taskId, { type: "assistant", message: { content: [{ type: "tool_use", name: "unit-test-gate", input: { cmd } }] } });
      loopSteps.record(agentId, taskId, { type: "user", message: { content: [{ type: "tool_result", content: tail || "(no output)" }] } });
      const verdict = pass ? "unit tests passed" : timedOut ? "unit tests TIMED OUT — killed" : `unit tests FAILED (exit ${exitCode})`;
      loopSteps.record(agentId, taskId, { type: "result", result: verdict });
    } catch { /* observational */ }
  }

  // Resolve the run cwd and PROVE it stays inside the worktree root (fix #3). A quality.json
  // `workdir` subdir is validated relative/no-`..` by quality.mjs, but a planted symlink could
  // still resolve OUT of the worktree; realpath both and assert containment before use. The
  // resolved real path is what we hand the sandbox as the mount source.
  function guardCwd(workdir, sub) {
    const joined = sub ? join(workdir, sub) : workdir;
    let realRoot, realCwd;
    try { realRoot = realpath(workdir); realCwd = realpath(joined); }
    catch (e) { return { error: `cwd realpath failed: ${e?.message || e}` }; }
    const withSep = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
    if (realCwd !== realRoot && !realCwd.startsWith(withSep)) return { error: "workdir escapes the worktree root" };
    return { cwd: realCwd };
  }

  /**
   * Run the unit-test gate for a build task in its worktree.
   * @returns {Promise<{pass:boolean, tail:string, exitCode:number, timedOut:boolean, reason?:string}>}
   * Never throws — a config error, an out-of-tree workdir, a missing Docker daemon, or a
   * sandbox fault is a FAILED gate (fail-closed), which the engine turns into a red→green fix
   * attempt (and, once the budget is spent, a blocked story). NEVER a silent pass, NEVER an
   * un-jailed host fallback.
   */
  async function run({ task, workdir } = {}) {
    const taskId = task?.taskId;
    const agentId = task?.agentId || "";
    const loaded = loadConfig();
    if (!loaded || loaded.error || !loaded.config) {
      const reason = loaded?.error || "quality config unavailable";
      recordSteps(agentId, taskId, { cmd: null, tail: reason, pass: false, exitCode: -1 });
      log(`[test-gate] config unavailable for ${taskId}: ${reason}`);
      return { pass: false, tail: scrub(String(reason)).slice(0, FEEDBACK_MAX), exitCode: -1, timedOut: false, reason: "config" };
    }
    const cfg = loaded.config;
    if (!workdir) {
      // No worktree ⇒ nothing to test in isolation. Fail closed rather than pass blind.
      recordSteps(agentId, taskId, { cmd: cfg.testCmd.join(" "), tail: "no worktree to run tests in", pass: false, exitCode: -1 });
      return { pass: false, tail: "no worktree to run tests in", exitCode: -1, timedOut: false, reason: "no-worktree" };
    }
    // Fix #3 — realpath-guard the (possibly subdir) cwd so it cannot escape the worktree.
    const guarded = guardCwd(workdir, cfg.workdir);
    if (guarded.error) {
      recordSteps(agentId, taskId, { cmd: cfg.testCmd.join(" "), tail: guarded.error, pass: false, exitCode: -1 });
      log(`[test-gate] cwd guard failed for ${taskId}: ${guarded.error}`);
      return { pass: false, tail: guarded.error, exitCode: -1, timedOut: false, reason: "workdir-escape" };
    }
    // FAIL CLOSED when the jail is unavailable — never fall back to an un-jailed host run.
    if (!(await sandbox.dockerAvailable())) {
      const reason = "sandbox unavailable — Docker daemon not reachable; unit-test gate cannot run in the jail";
      recordSteps(agentId, taskId, { cmd: cfg.testCmd.join(" "), tail: reason, pass: false, exitCode: -1 });
      log(`[test-gate] sandbox unavailable for ${taskId}`);
      return { pass: false, tail: reason, exitCode: -1, timedOut: false, reason: "sandbox-unavailable" };
    }
    // D1 — narrow the command to the tests that relate to this diff. `scoped` rides on the
    // verdict because the post-edit hook reads it: a timeout on a THREE-file run says
    // something about the diff; a timeout on the whole repo says something about the config.
    const plan = resolveCommand(cfg, guarded.cwd, workdir, { agentId, taskId });
    if (plan.skip) {
      // The receipt names the GATE even when it ran nothing. A skip with no `unit-test-gate`
      // step is indistinguishable from a gate that never fired, and "my gate has not run in
      // a week" has to stay answerable from the loop-step replay alone.
      recordSteps(agentId, taskId, { cmd: "unit-test-gate: skipped (no related tests)", tail: `scope-empty — ${plan.skip}`, pass: true, exitCode: 0 });
      log(`[test-gate] ${taskId}: ${plan.skip}`);
      return { pass: true, tail: plan.skip.slice(0, FEEDBACK_MAX), exitCode: 0, timedOut: false, scoped: true, reason: "scope-empty" };
    }
    // The validated argv (allow-listed binary + SAFE_ARG per element + node-flag denylist) has
    // no shell metachars, so joining is a clean single string for the container's `sh -c`.
    const command = plan.argv.join(" ");
    let res;
    try {
      res = await sandbox.runInSandbox(guarded.cwd, command, { network: false, timeoutMs: cfg.timeoutMs, callId: taskId });
    } catch (e) {
      const msg = `sandbox run error: ${e?.message || e}`;
      recordSteps(agentId, taskId, { cmd: command, tail: msg, pass: false, exitCode: -1 });
      return { pass: false, tail: scrub(msg).slice(0, FEEDBACK_MAX), exitCode: -1, timedOut: false, reason: "sandbox-error" };
    }
    const exitCode = typeof res.exitCode === "number" ? res.exitCode : -1;
    const timedOut = !!res.timedOut;
    const rawTail = tailOf(`${res.stdout || ""}\n${res.stderr || ""}${res.error ? `\n${res.error}` : ""}`);
    const pass = exitCode === 0 && !timedOut && !res.killed && !res.diskExceeded;
    recordSteps(agentId, taskId, { cmd: command, tail: rawTail, pass, timedOut, exitCode });
    const verdict = { pass, tail: scrub(rawTail).slice(0, FEEDBACK_MAX), exitCode, timedOut, scoped: plan.scoped };
    // A timeout on a command we did NOT narrow is a statement about the command, not about
    // the diff — the exact confusion that let a 2,500-test suite veto every autonomous run
    // for weeks. Naming it as infra lets the hook proceed-unverified instead of condemning
    // work it never actually tested. A timeout on a SCOPED run keeps its normal meaning.
    if (timedOut && !plan.scoped) verdict.reason = "gate-timeout-unscoped";
    return verdict;
  }

  return { run };
}
