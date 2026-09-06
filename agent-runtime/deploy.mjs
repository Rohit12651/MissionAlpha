// Story-Pipeline S5 — the DEPLOY EXECUTOR. The program's #1 security surface: it takes the
// validated deploy config (deploy-config.mjs) and actually RUNS the deploy command, then polls
// the health URL. Every containment property mirrors the S4 quality gates (ADR-056) because the
// threat is identical — an executed command over a repo tree must be jailed, not host-run.
//
// SECURITY (mirrors test-gate.mjs / story-reviewqa.mjs, ADR-056 — sr-security BLOCKING re-review):
//   • deployCmd is executed ONLY through the sandbox Docker jail (sandbox.runInSandbox), never a
//     host execFile/spawn. The container is `--network none` by DEFAULT (cfg.network=false),
//     `--read-only` rootfs, non-root, `--cap-drop ALL`, with the deploy root the ONLY writable/
//     visible host path (no ~/.aws, ~/.ssh, HOME, or process env / secrets). `docker kill` on
//     timeout nukes the whole container tree — no host process-group orphan.
//   • network is an EXPLICIT capability: default false. cfg.network=true (a cloud deploy that
//     needs egress) is surfaced LOUDLY in the release-gate payload upstream so the approving
//     human SEES it. The executor passes cfg.network straight through to the jail; it never
//     forces network on.
//   • FAIL CLOSED when Docker is unavailable: no daemon ⇒ the deploy FAILS (reason
//     `sandbox-unavailable`) — the story blocks with a clear alert. There is NO un-jailed host
//     fallback (an un-jailed deploy is exactly the risk this closes).
//   • cwd is realpath-guarded INSIDE the deploy root (a poisoned symlink cannot widen the mount
//     scope), exactly like the test-gate. The config comes from server-controlled factory/, not
//     the worktree.
//   • The health URL is re-validated LOOPBACK-ONLY before the fetch (belt-and-braces on top of
//     the load-time check) so the health probe can never be turned into an SSRF/exfil channel.
//   • Captured output is SCRUBBED before it leaves this module (into the story log).
//   • This is APPROVER-GATED at the seam: run() is only ever called from the release-gate APPROVE
//     path (story-deploy.mjs), never from a viewer-reachable route.

import { join, sep } from "node:path";
import { realpathSync } from "node:fs";
import { validateHealthUrl, deployCmdForChanges } from "./deploy-config.mjs";

const TAIL_MAX = 2_000;
const FEEDBACK_MAX = 1_500;
const DEFAULT_HEALTH_RETRIES = 5;
const DEFAULT_HEALTH_RETRY_MS = 1_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 5_000;

function tailOf(s, max = TAIL_MAX) {
  const t = String(s ?? "");
  return t.length > max ? t.slice(t.length - max) : t;
}

export function createDeployExecutor(deps = {}) {
  const sandbox = deps.sandbox;
  if (!sandbox || typeof sandbox.runInSandbox !== "function" || typeof sandbox.dockerAvailable !== "function") {
    throw new Error("createDeployExecutor: sandbox { runInSandbox, dockerAvailable } required");
  }
  const loadConfig = typeof deps.loadConfig === "function" ? deps.loadConfig : () => ({ error: "no deploy config loader" });
  const scrub = typeof deps.scrub === "function" ? deps.scrub : (s) => s;
  const realpath = typeof deps.realpath === "function" ? deps.realpath : realpathSync;
  // Injected so tests are hermetic; production passes the platform fetch. It is ONLY ever called
  // with a loopback URL (re-validated below) and a bounded per-attempt AbortSignal timeout.
  const fetchFn = typeof deps.fetchFn === "function" ? deps.fetchFn : (typeof fetch === "function" ? fetch : null);
  const sleep = typeof deps.sleep === "function" ? deps.sleep : (ms) => new Promise((r) => setTimeout(r, ms));
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const healthRetries = Number.isFinite(Number(deps.healthRetries)) && Number(deps.healthRetries) > 0 ? Math.floor(Number(deps.healthRetries)) : DEFAULT_HEALTH_RETRIES;
  const healthRetryMs = Number.isFinite(Number(deps.healthRetryMs)) && Number(deps.healthRetryMs) >= 0 ? Math.floor(Number(deps.healthRetryMs)) : DEFAULT_HEALTH_RETRY_MS;
  const healthTimeoutMs = Number.isFinite(Number(deps.healthTimeoutMs)) && Number(deps.healthTimeoutMs) > 0 ? Math.floor(Number(deps.healthTimeoutMs)) : DEFAULT_HEALTH_TIMEOUT_MS;

  // Resolve + PROVE the run cwd stays inside the deploy root (mirrors test-gate guardCwd). The
  // resolved real path is what we hand the sandbox as the mount source.
  function guardCwd(root, sub) {
    const joined = sub ? join(root, sub) : root;
    let realRoot, realCwd;
    try { realRoot = realpath(root); realCwd = realpath(joined); }
    catch (e) { return { error: `deploy cwd realpath failed: ${e?.message || e}` }; }
    const withSep = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
    if (realCwd !== realRoot && !realCwd.startsWith(withSep)) return { error: "deploy cwd escapes the deploy root" };
    return { cwd: realCwd };
  }

  /**
   * Poll a health URL for a healthy response. LOOPBACK-ONLY (re-validated), bounded retries, a
   * per-attempt timeout. Never throws — an unreachable/failed probe returns { healthy:false }.
   * @returns {Promise<{healthy:boolean, status:number|null, attempts:number, reason?:string}>}
   */
  async function checkHealth(url) {
    const v = validateHealthUrl(url);
    if (v.error || !v.healthUrl) return { healthy: false, status: null, attempts: 0, reason: v.error || "no health url" };
    if (!fetchFn) return { healthy: false, status: null, attempts: 0, reason: "no fetch available" };
    let lastStatus = null;
    for (let i = 1; i <= healthRetries; i++) {
      let ac = null, timer = null;
      try {
        ac = typeof AbortController === "function" ? new AbortController() : null;
        if (ac) timer = setTimeout(() => { try { ac.abort(); } catch { /* */ } }, healthTimeoutMs);
        const resp = await fetchFn(v.healthUrl, { method: "GET", redirect: "manual", signal: ac ? ac.signal : undefined });
        lastStatus = typeof resp?.status === "number" ? resp.status : null;
        if (lastStatus !== null && lastStatus >= 200 && lastStatus < 400) return { healthy: true, status: lastStatus, attempts: i };
      } catch (e) {
        lastStatus = null;
        log(`[deploy] health probe attempt ${i} failed: ${e?.message || e}`);
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (i < healthRetries) await sleep(healthRetryMs);
    }
    return { healthy: false, status: lastStatus, attempts: healthRetries, reason: "health check did not go healthy" };
  }

  /**
   * Run the deploy for a story in the given deploy root. NEVER throws — a config error, an
   * out-of-root cwd, a missing Docker daemon, or a sandbox fault is a FAILED deploy (fail-closed),
   * which the caller turns into a blocked story + alert. NEVER a silent success, NEVER an un-jailed
   * host fallback.
   * @returns {Promise<{deployed:boolean, healthy:boolean|null, network:boolean, tail:string,
   *                    exitCode:number, timedOut:boolean, reason?:string, health?:object}>}
   */
  async function run({ storyId, deployRoot, changedPaths } = {}) {
    const sid = String(storyId || "");
    const loaded = loadConfig();
    if (!loaded || loaded.error || !loaded.config) {
      const reason = loaded?.error || "deploy config unavailable";
      log(`[deploy] config unavailable for ${sid}: ${reason}`);
      return { deployed: false, healthy: null, network: false, tail: scrub(String(reason)).slice(0, FEEDBACK_MAX), exitCode: -1, timedOut: false, reason: "config" };
    }
    const cfg = loaded.config;
    if (!deployRoot) {
      return { deployed: false, healthy: null, network: cfg.network, tail: "no deploy root", exitCode: -1, timedOut: false, reason: "no-root" };
    }
    const guarded = guardCwd(deployRoot, cfg.cwd);
    if (guarded.error) {
      log(`[deploy] cwd guard failed for ${sid}: ${guarded.error}`);
      return { deployed: false, healthy: null, network: cfg.network, tail: guarded.error, exitCode: -1, timedOut: false, reason: "cwd-escape" };
    }
    // FAIL CLOSED when the jail is unavailable — never fall back to an un-jailed host run.
    if (!(await sandbox.dockerAvailable())) {
      const reason = "sandbox unavailable — Docker daemon not reachable; deploy cannot run in the jail";
      log(`[deploy] sandbox unavailable for ${sid}`);
      return { deployed: false, healthy: null, network: cfg.network, tail: reason, exitCode: -1, timedOut: false, reason: "sandbox-unavailable" };
    }
    // The validated argv (allow-listed binary + SAFE_ARG per element + node-flag denylist) has no
    // shell metachars, so joining is a clean single string for the container's `sh -c`.
    // Phase 6.4 — pick the command from WHAT CHANGED (src/public → the configured build;
    // anything else → the scoped typecheck; unknown/empty → the full command, never narrow
    // blindly). Both branches are re-validated inside deployCmdForChanges; it fails closed.
    const sel = deployCmdForChanges(Array.isArray(changedPaths) ? changedPaths : [], cfg);
    if (sel.error) {
      log(`[deploy] command selection refused for ${sid}: ${sel.error}`);
      return { deployed: false, healthy: null, network: cfg.network, tail: sel.error, exitCode: -1, timedOut: false, reason: "config" };
    }
    const command = sel.cmd.join(" ");
    let res;
    try {
      res = await sandbox.runInSandbox(guarded.cwd, command, { network: cfg.network, timeoutMs: cfg.timeoutMs, callId: `deploy-${sid}`.slice(0, 48) });
    } catch (e) {
      const msg = `sandbox run error: ${e?.message || e}`;
      return { deployed: false, healthy: null, network: cfg.network, tail: scrub(msg).slice(0, FEEDBACK_MAX), exitCode: -1, timedOut: false, reason: "sandbox-error" };
    }
    const exitCode = typeof res.exitCode === "number" ? res.exitCode : -1;
    const timedOut = !!res.timedOut;
    const rawTail = tailOf(`${res.stdout || ""}\n${res.stderr || ""}${res.error ? `\n${res.error}` : ""}`);
    const deployed = exitCode === 0 && !timedOut && !res.killed && !res.diskExceeded;
    const tail = scrub(rawTail).slice(0, FEEDBACK_MAX);
    if (!deployed) {
      return { deployed: false, healthy: null, network: cfg.network, tail, exitCode, timedOut, reason: timedOut ? "deploy-timeout" : "deploy-failed" };
    }
    // Deploy command succeeded. Health check ONLY when a (loopback) health URL is configured.
    if (!cfg.healthUrl) return { deployed: true, healthy: null, network: cfg.network, tail, exitCode, timedOut: false };
    const health = await checkHealth(cfg.healthUrl);
    return { deployed: true, healthy: health.healthy, network: cfg.network, tail, exitCode, timedOut: false, health, reason: health.healthy ? undefined : "health-failed" };
  }

  return { run, checkHealth, guardCwd };
}
