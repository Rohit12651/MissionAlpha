// ADR-037 — Execution Sandbox. The REAL OS-level boundary for the full tool loop.
//
// SECURITY LAW: a git worktree is NOT a security boundary (same uid/fs/network). An
// agent with Bash could read ~/.ssh, rm -rf the host, or exfiltrate over the network.
// Approval prompts stop ACCIDENTS, not malice/injection. So ALL execution is jailed in
// a locked Docker container; the worktree is bind-mounted as the ONLY host path. NO
// host exec, ever. Proven flags (Phase 3.5.0 spike): no host fs, no network by default,
// non-root, all caps dropped, read-only rootfs, resource-bounded, ephemeral.

import { spawn, execFile } from "node:child_process";
import { realpathSync, existsSync, statSync, readdirSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

// /work is the ONE writable host path and has NO size quota (the rootfs is --read-only,
// /tmp is a capped tmpfs). A runaway/malicious command (`dd if=/dev/zero of=/work/fill`)
// could fill the host disk = DoS. Loopback/overlay volumes, XFS project quotas, and
// `docker --storage-opt size=` are all driver/FS-dependent and NOT portable (notably
// they fail on Docker Desktop). The portable defense is a HOST-SIDE watchdog: poll the
// real worktree size and kill the container the instant it crosses the cap. Pure host
// code, no special privileges, works everywhere.
export const DEFAULT_DISK_CAP_BYTES = Number(process.env.RUNTIME_SANDBOX_DISK_BYTES) || 256 * 1024 * 1024;
const DISK_POLL_MS = Number(process.env.RUNTIME_SANDBOX_DISK_POLL_MS) || 750;

// Sum the apparent size of a directory tree, bailing out the moment we exceed `cap`
// (so a 100GB fill doesn't make us walk 100GB before reacting). lstat — never follow
// symlinks (a symlink's target is not charged to /work). Best-effort: unreadable/racing
// entries are skipped, not fatal.
export function dirSizeBytes(dir, cap = Infinity) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      const p = join(d, ent.name);
      let st;
      try { st = lstatSync(p); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) { stack.push(p); continue; }
      if (st.isFile()) {
        total += st.size;
        if (total > cap) return total; // early-out: already over the limit
      }
    }
  }
  return total;
}

const DOCKER = process.env.RUNTIME_DOCKER_BIN || "docker";
// Exec image (has node+npm+git for scaffolding). Escape-suite tests pass their own.
// Pin by digest in a hardened deploy (OQ-037.2); tag is acceptable for the dev milestone.
export const DEFAULT_EXEC_IMAGE = process.env.RUNTIME_SANDBOX_IMAGE || "node:20-alpine";

// Sanitize a callId for the container --name. When absent, mint a RANDOM id (never a
// fixed "anon") so concurrent/back-to-back runs can't collide on the --rm cleanup race.
const safeCallId = (s) => String(s || "").replace(/[^a-z0-9_-]/gi, "").slice(0, 48) || `r${randomBytes(5).toString("hex")}`;

// Build the docker argv — PURE + unit-testable. Every security flag is here. The
// command is the FINAL single argv token to `sh -c` (no host shell — spawn argv array).
export function buildDockerArgs({ worktreeDir, command, callId, network = false, image = DEFAULT_EXEC_IMAGE, limits = {} }) {
  const mem = limits.memory || "512m";
  const pids = String(limits.pids || 128);
  const cpus = String(limits.cpus || 1);
  const name = `ma-sbx-${safeCallId(callId)}`;
  const args = [
    "run", "--rm",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--user", "65534:65534",
    "--read-only",
    "--tmpfs", "/tmp:rw,size=64m,noexec,nosuid",
    "--pids-limit", pids,
    "--memory", mem, "--memory-swap", mem, // no swap escape
    "--cpus", cpus,
    "--label", "missionalpha.sandbox=1",
    "--name", name,
  ];
  // Network is an EXPLICIT capability — default OFF. Granted = a constrained bridge
  // (still no host fs, no caps, non-root); per-destination egress filtering is deferred.
  if (!network) args.push("--network", "none");
  args.push("-v", `${worktreeDir}:/work:rw`, "-w", "/work");
  args.push(image, "sh", "-c", command);
  return { args, name };
}

export function createSandbox(opts = {}) {
  const image = opts.image || DEFAULT_EXEC_IMAGE;

  // Is the docker daemon reachable? (fail-closed: no daemon → no exec).
  function dockerAvailable() {
    return new Promise((resolve) => {
      const c = execFile(DOCKER, ["info", "--format", "{{.ServerVersion}}"], { timeout: 8000 }, (err) => resolve(!err));
      c.on("error", () => resolve(false));
    });
  }

  // Validate the mount source BEFORE docker run (mount-injection guard): must be an
  // existing real directory; we mount its REALPATH so a symlinked worktree can't widen scope.
  function resolveMount(worktreeDir) {
    if (!worktreeDir || typeof worktreeDir !== "string") throw new Error("worktreeDir required");
    if (!existsSync(worktreeDir)) throw new Error("worktreeDir does not exist");
    const real = realpathSync(worktreeDir);
    if (!statSync(real).isDirectory()) throw new Error("worktreeDir is not a directory");
    return real;
  }

  // Run a command in a fresh locked container over the worktree. Kill-switch via
  // timeout + AbortSignal + docker kill by container name.
  function runInSandbox(worktreeDir, command, o = {}) {
    return new Promise((resolve) => {
      let real;
      try { real = resolveMount(worktreeDir); } catch (e) { return resolve({ stdout: "", stderr: e.message, exitCode: -1, error: e.message }); }
      const { args, name } = buildDockerArgs({ worktreeDir: real, command: String(command), callId: o.callId, network: !!o.network, image: o.image || image, limits: o.limits || {} });
      const child = spawn(DOCKER, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "", killed = false, timedOut = false, diskExceeded = false, done = false;
      const cap = 256 * 1024; // bound captured output
      child.stdout.on("data", (d) => { stdout = (stdout + d).slice(0, cap); o.onData?.("stdout", d.toString()); });
      child.stderr.on("data", (d) => { stderr = (stderr + d).slice(0, cap); o.onData?.("stderr", d.toString()); });
      const hardKill = () => {
        killed = true;
        try { execFile(DOCKER, ["kill", name], () => {}); } catch { /* */ }
        try { child.kill("SIGKILL"); } catch { /* */ }
      };
      const timer = setTimeout(() => { timedOut = true; hardKill(); }, o.timeoutMs || 120000);
      // Disk watchdog: poll the worktree size; the instant it crosses the cap, kill the
      // container so a fill-the-disk DoS is bounded to ~one poll interval of overrun.
      const diskCap = (o.limits && Number(o.limits.diskBytes)) || DEFAULT_DISK_CAP_BYTES;
      const diskTimer = setInterval(() => {
        if (done || dirSizeBytes(real, diskCap) <= diskCap) return;
        diskExceeded = true;
        stderr = (stderr + `\nsandbox: /work exceeded ${diskCap} bytes — container killed`).slice(0, cap);
        hardKill();
      }, DISK_POLL_MS);
      if (diskTimer.unref) diskTimer.unref();
      if (o.signal) {
        if (o.signal.aborted) hardKill();
        else o.signal.addEventListener("abort", hardKill, { once: true });
      }
      const finish = (exitCode) => {
        if (done) return; done = true;
        clearTimeout(timer);
        clearInterval(diskTimer);
        resolve({ stdout, stderr, exitCode, timedOut, killed, diskExceeded });
      };
      child.on("error", (e) => { stderr = (stderr + `\n${e.message}`).slice(0, cap); finish(-1); }); // set stderr BEFORE resolving
      child.on("close", (code) => finish(timedOut || killed || diskExceeded ? 124 : code));
    });
  }

  // Kill a running sandbox by callId (operator kill-switch).
  function kill(callId) {
    return new Promise((resolve) => execFile(DOCKER, ["kill", `ma-sbx-${safeCallId(callId)}`], () => resolve(true)));
  }

  // Preflight — daemon reachable + exec image pullable/present. Fail-closed.
  async function preflight() {
    if (!(await dockerAvailable())) return { ok: false, error: "docker daemon not reachable" };
    return { ok: true };
  }

  return { runInSandbox, kill, preflight, dockerAvailable, buildDockerArgs, image };
}
