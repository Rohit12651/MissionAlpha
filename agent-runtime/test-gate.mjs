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

import { join, sep } from "node:path";
import { realpathSync } from "node:fs";

const TAIL_MAX = 2_000;   // how much captured output to keep as feedback
const FEEDBACK_MAX = 1_500;

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
    // The validated argv (allow-listed binary + SAFE_ARG per element + node-flag denylist) has
    // no shell metachars, so joining is a clean single string for the container's `sh -c`.
    const command = cfg.testCmd.join(" ");
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
    return { pass, tail: scrub(rawTail).slice(0, FEEDBACK_MAX), exitCode, timedOut };
  }

  return { run };
}
