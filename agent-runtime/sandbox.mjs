// ADR-037 — Execution Sandbox. The REAL OS-level boundary for the full tool loop.
//
// SECURITY LAW: a git worktree is NOT a security boundary (same uid/fs/network). An
// agent with Bash could read ~/.ssh, rm -rf the host, or exfiltrate over the network.
// Approval prompts stop ACCIDENTS, not malice/injection. So ALL execution is jailed in
// a locked Docker container; the worktree is bind-mounted as the ONLY host path. NO
// host exec, ever. Proven flags (Phase 3.5.0 spike): no host fs, no network by default,
// non-root, all caps dropped, read-only rootfs, resource-bounded, ephemeral.

import { spawn, execFile } from "node:child_process";
import { realpathSync, existsSync, statSync, readdirSync, lstatSync, chmodSync } from "node:fs";
import { readdir, lstat } from "node:fs/promises";
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

// ── Phase 7 / task 7.6 (BOSS-approved 2026-09-04) ───────────────────────────
// Default memory is UNCHANGED at 512m; this adds the knob that was missing, nothing more.
// `tsc && vite build` OOMs at 512m on this repo (V8: "Mark-Compact … 254 MB"), which made
// the ship rung unreachable with defaults and gave the operator no way to raise it.
/** The jail's memory bound when nobody overrides it. Unchanged by 7.6 — that task added the
 *  knob, it did not retune the default. */
export const FALLBACK_SANDBOX_MEMORY = "512m";

/**
 * Docker memory values are `<positive int>[b|k|m|g]`, or a bare byte count. `0` means
 * UNLIMITED to Docker — and `"0"` is a truthy string, so it sailed through the `||` default
 * and switched the jail's memory bound (and, since --memory-swap tracks it, the swap bound)
 * off entirely. Anything not matching is refused and the default is used.
 * A single argv element either way, so no flag injection is possible via spawn's array form.
 */
export function normalizeMemory(v) {
  if (typeof v !== "string" || v === "") return FALLBACK_SANDBOX_MEMORY;
  if (!/^[1-9]\d*[bkmg]?$/i.test(v)) return FALLBACK_SANDBOX_MEMORY;
  return v;
}

export const DEFAULT_SANDBOX_MEMORY = normalizeMemory(process.env.RUNTIME_SANDBOX_MEMORY);

/**
 * ASYNC sibling of dirSizeBytes, for the disk watchdog ONLY.
 *
 * WHY IT EXISTS, measured rather than assumed. `dirSizeBytes` is fully synchronous, and the
 * cost is the TRAVERSAL (readdir + lstat over 38,859 entries here ≈ 560 ms), not the
 * addition — so neither charging by mtime nor raising the early-exit ceiling makes it cheap:
 *
 *     walk uncapped ................ 1229 ms
 *     walk, ceiling = cap .......... 3 ms    (pre-7.6: cheap, and always wrong)
 *     walk, ceiling = base + cap ... 557 ms  (a first 7.6 attempt: still a full walk)
 *     walk, mtime-charged .......... 619 ms  (a second attempt: still a full walk)
 *
 * At DISK_POLL_MS = 750 that is ~75% of the single-threaded runtime blocked for the whole of
 * every jailed run — SSE frames, the scheduler tick and every /runtime read queue behind it.
 * This version does the same work but yields to the event loop every YIELD_EVERY entries, so
 * no single turn blocks for more than a few milliseconds.
 */
const YIELD_EVERY = 2000;

export async function dirSizeBytesAsync(dir, cap = Infinity, sinceMs = undefined) {
  let total = 0, seen = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = await readdir(d, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      if (++seen % YIELD_EVERY === 0) await new Promise((r) => setImmediate(r));
      const p2 = join(d, ent.name);
      let st;
      try { st = await lstat(p2); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) { stack.push(p2); continue; }
      if (st.isFile()) {
        if (sinceMs !== undefined && st.mtimeMs < sinceMs) continue;
        total += st.size;
        if (total > cap) return total; // early-exit: the caller only needs "over or not"
      }
    }
  }
  return total;
}

/**
 * PES addendum #16 — "a cap that measures the mount measures the repo, not the work."
 * Bounds what the RUN WROTE, never the absolute size of the bind-mounted worktree: on this
 * repo the old check compared 3.79 GiB against the budget and killed every deploy before it
 * had written a byte.
 *
 * The live caller now passes GROWTH directly (`dirSizeBytes(dir, cap, startedAtMs)` sums only
 * files modified since the container started), so `baselineBytes` is 0 there. The two-argument
 * form is kept because it is the honest predicate for any caller that measures a total.
 *
 * FAILS CLOSED on every non-finite input — a NaN cap must never read as "unbounded". A
 * shrinking tree clamps at 0 rather than underflowing into false headroom.
 */
export function exceedsDiskBudget(currentBytes, baselineBytes, capBytes) {
  // FAIL CLOSED on every non-finite input, not just the baseline. This is a security
  // predicate and `capBytes` is caller-supplied: a NaN cap previously returned false
  // (unbounded), which is the opposite of what the docstring promised.
  const cur = Number(currentBytes);
  const cap = Number(capBytes);
  if (!Number.isFinite(cur) || !Number.isFinite(cap) || cap < 0) return true;
  const base = Number.isFinite(baselineBytes) ? Math.max(0, baselineBytes) : 0;
  return Math.max(0, cur - base) > cap;
}

// Sum the apparent size of a directory tree, bailing out the moment we exceed `cap`
// (so a 100GB fill doesn't make us walk 100GB before reacting). lstat — never follow
// symlinks (a symlink's target is not charged to /work). Best-effort: unreadable/racing
// entries are skipped, not fatal.
export function dirSizeBytes(dir, cap = Infinity, sinceMs = undefined) {
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
        // 7.6 — `sinceMs` charges only what THIS RUN wrote. Without it the walk sums the
        // whole bind-mounted repo (3.70 GiB here) and the `total > cap` early-out is never
        // reached, so every poll is a full 557 ms synchronous traversal on the single
        // threaded server loop. With it the sum IS the growth, so the early-out fires
        // after ~cap bytes and a healthy poll costs a few milliseconds.
        if (sinceMs !== undefined && st.mtimeMs < sinceMs) continue;
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
  const mem = limits.memory ? normalizeMemory(limits.memory) : DEFAULT_SANDBOX_MEMORY;
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
  //
  // THE EXIT CODE ALONE IS NOT PROOF. Measured on Docker CLI 27.3.1 with the daemon
  // stopped:
  //     docker info                               -> exit 1
  //     docker info --format '{{.ServerVersion}}' -> exit 0, stdout EMPTY
  // The templated form is the one used here, so testing `!err` answered TRUE with no
  // daemon running. That silently un-skipped the LIVE escape suite below (10 tests FAILED
  // instead of skipping, which is how this was found during a gate run) and — far worse —
  // made `preflight()` report ok on a host with no sandbox at all, even though its own
  // comment promises fail-closed. A security predicate must not report "available" on the
  // strength of a command that printed nothing.
  //
  // Regression: agent-runtime/test/sandbox-probe.test.mjs drives all three daemon states
  // through a stub binary, so it reproduces with or without Docker installed.
  function dockerAvailable() {
    return new Promise((resolve) => {
      const c = execFile(
        DOCKER,
        ["info", "--format", "{{.ServerVersion}}"],
        { timeout: 8000 },
        (err, stdout) => resolve(!err && String(stdout ?? "").trim().length > 0),
      );
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
      // The container runs as non-root nobody (uid 65534). On Linux, bind-mount perms
      // are ENFORCED: a worktree created with mkdtemp (mode 0700) is owned by the host
      // user and not even traversable by nobody → every /work write fails. macOS Docker
      // ignores this, which is why it only surfaces on Linux/CI. Make the mount point
      // writable by the sandbox uid. Safe: the worktree is an ephemeral, per-task scratch
      // dir; container isolation is unchanged (rootfs --read-only, --cap-drop ALL,
      // --network none, non-root all still hold — /work is the ONLY writable host path).
      // Mode 0o777 (not 0o711): nobody is "other", and CREATING files in /work needs dir
      // w+x for other — 0o711 grants only traverse (x), so writes would still fail. Mode
      // bits can't grant-write-to-nobody while denying-read-to-others (both are "other");
      // the residual host-side exposure is accepted for the single-operator/CI target.
      try { chmodSync(real, 0o777); } catch (e) { console.warn(`sandbox: chmod 0777 on /work mount failed (${e.code || e.message}); container writes may EACCES`); }
      const { args, name } = buildDockerArgs({ worktreeDir: real, command: String(command), callId: o.callId, network: !!o.network, image: o.image || image, limits: o.limits || {} });
      const diskCap = (o.limits && Number.isFinite(Number(o.limits.diskBytes)) && Number(o.limits.diskBytes) >= 0)
        ? Number(o.limits.diskBytes)
        : DEFAULT_DISK_CAP_BYTES;
      // 7.6 — NO baseline walk. An earlier revision measured the whole tree before spawn and
      // compared `current − baseline`; that cost a 557 ms synchronous walk on every poll and
      // raced the container (bytes written during the walk counted as pre-existing, silently
      // raising the cap). Charging by mtime removes both: the sum IS the growth.
      // The 2 s slack absorbs normal host/container clock skew.
      const startedAtMs = Date.now() - 2000;
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
      let diskWalking = false; // a walk slower than the interval must not stack
      const diskTimer = setInterval(() => {
        if (done || diskWalking) return;
        diskWalking = true;
        // Only bytes written since the container started, walked ASYNCHRONOUSLY so the
        // runtime's event loop keeps serving while the jail runs.
        dirSizeBytesAsync(real, diskCap, startedAtMs).then((grew) => {
          diskWalking = false;
          if (done || !exceedsDiskBudget(grew, 0, diskCap)) return;
          diskExceeded = true;
          stderr = (stderr + `\nsandbox: /work GREW by more than ${diskCap} bytes during this run — container killed`).slice(0, cap);
          hardKill();
        }).catch(() => { diskWalking = false; /* a walk fault must not kill the run */ });
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
