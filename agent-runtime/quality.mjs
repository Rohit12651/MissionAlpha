// Story-Pipeline S4 — the QUALITY-GATE config + its command loader/validator + the
// hardened, env-stripped, worktree-cwd-locked test-runner. This is the SECURITY CORE of
// the phase: it turns an operator-editable JSON file (`factory/quality.json`) into a
// command the engine will actually EXECUTE, so every rule below exists to make sure a
// poisoned config can never smuggle an arbitrary command or leak a secret.
//
// SECURITY LAW (sr-security, BLOCKING phase — mirrors worktree.mjs / pr.mjs):
//   • testCmd / e2eCmd are ARGV ARRAYS, never a shell string. They run through execFile
//     with shell:false — no shell exists to interpret metacharacters, ever.
//   • The FIRST element (the binary) must be one of a FIXED allow-list of test-runner
//     binaries (ALLOWED_BINS). Anything else — including an absolute path like /bin/bash
//     or a relative ./x — is REJECTED at load. The binary is resolved from PATH by name;
//     a name containing a path separator can never be allow-listed (the set is bare names).
//   • EVERY element (binary + every arg) must match SAFE_ARG — a positive character
//     allow-list. That rejects shell metacharacters (; | & $ ` ( ) { } < > newline CR NUL
//     * ? ~ ! # ' " backslash …) by construction: a char not on the allow-list fails.
//   • The child env is MINIMAL (minimalEnv) — a small fixed allow-list of harmless vars
//     (PATH/HOME/LANG/…). process.env is NEVER forwarded, so ANTHROPIC_API_KEY, every
//     *_TOKEN / *_SECRET / *_KEY and every operator secret are absent from the child.
//   • The runner's cwd is LOCKED to the worktree (or a validated relative subdir of it);
//     shell:false means the command cannot `cd` out of it.
//   • A timeout KILLS the child (SIGKILL) so a hung/looping test can never wedge the loop.
//   • A missing config file falls back to a SAFE default (`node --test`); a config file
//     that is present-but-invalid FAILS CLOSED (returns { error }) — the caller treats an
//     unrunnable gate as a FAILED gate, never a silent pass, so a broken/poisoned file can
//     neither run a command nor green-light a build.

import { execFile } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

// The CLOSED allow-list of test-runner binaries a quality.json may name. Bare names only
// (resolved from PATH); a path-separated or absolute value can never match. Documented set:
//   node, npm, npx, pnpm, yarn — JS/TS runners & wrappers
//   python, python3, pytest    — Python
//   go, cargo                  — Go, Rust
//   jest, vitest, playwright   — JS test frameworks / e2e
// Adding a binary here is a deliberate, reviewed change — never a config-time decision.
export const ALLOWED_BINS = Object.freeze(new Set([
  "node", "npm", "npx", "pnpm", "yarn",
  "python", "python3", "pytest",
  "go", "cargo",
  "jest", "vitest", "playwright",
]));

// Defense-in-depth (sr-security INFO): even the allow-listed `node` binary must not be
// walkable into arbitrary code / arbitrary-module-file loading. These flags make `node`
// execute inline code or PRELOAD a module file from the (agent-controlled) worktree, which
// side-steps the "test runner only" intent of the allow-list — `node -r ./evil.js --test`
// would pass SAFE_ARG yet run attacker code. Reject them for the node binary. (npm/npx/pnpm/
// yarn do NOT interpret these directly — they forward args to a script — so the denylist is
// scoped to `node`.) Matches -e/--eval, -r/--require, --import, --input-type (with or without
// =value), --loader/--env-file (ESM loader hook / dotenv both load worktree code/config),
// and every --experimental-* flag.
const NODE_DANGEROUS_FLAG = /^(?:-e|--eval|-r|--require|--import|--input-type|--loader|--env-file)(?:=|$)|^--experimental-/;

// Positive character allow-list for EVERY argv element. Letters, digits, and a small set
// of punctuation that appears in real test invocations (paths, flags, key=value, globs are
// NOT allowed — shell:false would pass them literally anyway). Any char outside this set —
// every shell metacharacter included — makes the element (and the whole config) invalid.
const SAFE_ARG = /^[A-Za-z0-9._\-/:=@,+ ]*$/;

const MAX_ARGV = 64;        // a bounded argv — never an unbounded flood
const MAX_ELEM = 512;       // a bounded element — never an unbounded paste
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 600_000;
export const DEFAULT_TIMEOUT_MS = 120_000;

// The safe default when no quality.json exists: run the repo's own `node --test`. Every
// field here itself satisfies the validator (asserted in the tests).
export const DEFAULT_QUALITY = Object.freeze({
  testCmd: Object.freeze(["node", "--test"]),
  e2eCmd: null,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  workdir: null,
});

/**
 * Validate one command (an argv array). Returns { cmd } on success or { error } on any
 * violation. `null`/absent is allowed ONLY when `allowNull` (e2eCmd may be unset).
 */
export function validateCmd(raw, { allowNull = false, label = "cmd" } = {}) {
  if (raw === null || raw === undefined) {
    if (allowNull) return { cmd: null };
    return { error: `${label} is required` };
  }
  if (!Array.isArray(raw)) return { error: `${label} must be an array of strings` };
  if (!raw.length) return { error: `${label} must be a non-empty array` };
  if (raw.length > MAX_ARGV) return { error: `${label} has too many elements (>${MAX_ARGV})` };
  for (const el of raw) {
    if (typeof el !== "string") return { error: `${label} elements must all be strings` };
    if (el.length > MAX_ELEM) return { error: `${label} element too long (>${MAX_ELEM})` };
    if (!SAFE_ARG.test(el)) return { error: `${label} element has a disallowed character: ${JSON.stringify(el).slice(0, 80)}` };
  }
  const bin = raw[0];
  // An empty binary, or one carrying a path separator, can never be allow-listed. Check the
  // separators explicitly so the error is precise (SAFE_ARG permits '/', which is fine for
  // ARGS but never for the binary — the binary is a bare PATH-resolved name).
  if (!bin) return { error: `${label} binary is empty` };
  if (bin.includes("/") || bin.includes("\\")) return { error: `${label} binary must be a bare name, not a path: ${JSON.stringify(bin).slice(0, 80)}` };
  if (!ALLOWED_BINS.has(bin)) return { error: `${label} binary '${bin}' is not in the allow-list` };
  // node-family dangerous-flag denylist (defense-in-depth): reject a node invocation that
  // would eval inline code or preload an arbitrary module file from the worktree.
  if (bin === "node") {
    for (const arg of raw.slice(1)) {
      if (NODE_DANGEROUS_FLAG.test(arg)) return { error: `${label} uses a disallowed node flag: ${JSON.stringify(arg).slice(0, 80)}` };
    }
  }
  return { cmd: raw.slice() };
}

// A workdir override must be a RELATIVE subpath of the worktree — no absolute path, no
// `..` escape. Default (null/absent) = the worktree root itself.
function validateWorkdir(raw) {
  if (raw === null || raw === undefined || raw === "") return { workdir: null };
  if (typeof raw !== "string") return { error: "workdir must be a string" };
  if (raw.length > MAX_ELEM) return { error: "workdir too long" };
  if (!SAFE_ARG.test(raw)) return { error: "workdir has a disallowed character" };
  if (raw.startsWith("/") || raw.startsWith("\\")) return { error: "workdir must be relative to the worktree" };
  if (raw.split(/[/\\]/).some((seg) => seg === "..")) return { error: "workdir must not contain '..'" };
  return { workdir: raw };
}

function validateTimeout(raw) {
  if (raw === null || raw === undefined) return DEFAULT_TIMEOUT_MS;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(n, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

/**
 * Validate a parsed quality object into a normalized config. Returns { config } or { error }.
 */
export function validateQuality(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { error: "quality config must be a JSON object" };
  const t = validateCmd(obj.testCmd, { label: "testCmd" });
  if (t.error) return { error: t.error };
  const e = validateCmd(obj.e2eCmd, { allowNull: true, label: "e2eCmd" });
  if (e.error) return { error: e.error };
  const w = validateWorkdir(obj.workdir);
  if (w.error) return { error: w.error };
  return {
    config: {
      testCmd: t.cmd,
      e2eCmd: e.cmd,
      timeoutMs: validateTimeout(obj.timeoutMs),
      workdir: w.workdir,
    },
  };
}

/**
 * Load + validate factory/quality.json.
 *   • file missing        → { config: DEFAULT_QUALITY }  (a legitimate "not configured")
 *   • file present, bad   → { error }                    (FAIL CLOSED — never a command)
 *   • file present, valid → { config }
 * Never throws.
 */
export function loadQuality(path) {
  if (!path || !existsSync(path)) return { config: { ...DEFAULT_QUALITY } };
  let text;
  try { text = readFileSync(path, "utf-8"); } catch (err) { return { error: `quality.json unreadable: ${err.message}` }; }
  let obj;
  try { obj = JSON.parse(text); } catch (err) { return { error: `quality.json parse error: ${err.message}` }; }
  return validateQuality(obj);
}

// The MINIMAL child env: a small fixed allow-list of harmless variables. process.env is
// NEVER spread in, so ANTHROPIC_API_KEY, every *_TOKEN / *_SECRET / *_KEY / PASSWORD and
// any operator secret are structurally absent from the test child. CI=1 is added so a
// runner that branches on it behaves in non-interactive mode.
const ENV_KEEP = Object.freeze(["PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TZ", "TERM", "USER", "LOGNAME", "SHLVL"]);
export function minimalEnv(env = process.env) {
  const out = {};
  for (const k of ENV_KEEP) if (env[k] !== undefined && env[k] !== null) out[k] = env[k];
  out.CI = "1";
  return out;
}

/**
 * A hardened host-exec runner. argv array + shell:false + cwd-locked + minimal env + timeout
 * that SIGKILLs the child. `exec` is injectable so a test can capture the spawn options and
 * assert the security posture (shell:false, cwd, stripped env) without a real subprocess.
 * Never throws — a spawn error (e.g. ENOENT) resolves as { ok:false }.
 *
 * NOTE (ADR-056 remediation): this runner is NO LONGER on the story quality-gate path. The
 * unit-test gate (test-gate.mjs) and the QA/e2e gate (story-reviewqa.mjs) now execute agent-
 * authored test code INSIDE the Docker jail (sandbox.mjs, `--network none`, no host fs, no
 * HOME/secrets) — matching the tool-loop posture. `docker kill` nukes the whole container
 * tree on timeout, which also MOOTS the earlier process-group-orphan finding (#7): there is
 * no host child process group to leak. This function is retained only as a validated
 * reference for hardened host exec and for any future NON-agent, trusted-command path; it is
 * covered by quality.test.mjs. It must not be reintroduced as a story-gate fallback.
 */
export function createExecFileRunner({ exec = execFile } = {}) {
  return function run({ argv, cwd, timeoutMs = DEFAULT_TIMEOUT_MS, env = minimalEnv() }) {
    return new Promise((resolve) => {
      const list = Array.isArray(argv) ? argv : [];
      const [bin, ...args] = list;
      if (!bin) return resolve({ ok: false, exitCode: -1, stdout: "", stderr: "empty command", timedOut: false });
      let done = false;
      const finish = (v) => { if (done) return; done = true; resolve(v); };
      try {
        const child = exec(bin, args, {
          cwd,                    // LOCKED to the worktree; shell:false ⇒ cannot cd out
          env,                    // minimal, secret-free
          timeout: Math.floor(timeoutMs) || DEFAULT_TIMEOUT_MS,
          killSignal: "SIGKILL",  // the timeout HARD-kills the child (no zombie/hang)
          maxBuffer: 1024 * 1024, // bound captured output
          encoding: "utf-8",
          shell: false,           // NEVER a shell
          windowsHide: true,
        }, (err, stdout, stderr) => {
          const timedOut = !!(err && (err.killed || err.signal === "SIGKILL") && err.code === null);
          finish({
            ok: !err,
            exitCode: err && typeof err.code === "number" ? err.code : (err ? -1 : 0),
            stdout: String(stdout || ""),
            stderr: String(stderr || (err ? err.message : "")),
            timedOut,
          });
        });
        if (child && typeof child.on === "function") child.on("error", () => { /* surfaced via callback err */ });
      } catch (err) {
        finish({ ok: false, exitCode: -1, stdout: "", stderr: String(err?.message || err), timedOut: false });
      }
    });
  };
}
