// Story-Pipeline S5 — the DEPLOY config loader/validator. This turns an operator-editable
// JSON file (`factory/deploy.json`) into the argv + settings the deploy executor will EXECUTE.
// Deploy command execution is the PROGRAM'S #1 SECURITY SURFACE, so every rule below exists to
// make sure a poisoned config can never smuggle an arbitrary command, an SSRF/exfil URL, or a
// path that widens the mount scope. It mirrors quality.mjs (the S4 test-gate config) exactly —
// argv-array, allow-listed binary, SAFE_ARG per element, timeout clamp, fail-closed on a bad
// file — with three deploy-specific additions:
//
//   • network  : a BOOLEAN, DEFAULT false. A deploy runs in the SAME `--network none` Docker
//                jail the test/QA gates use. network:true is an EXPLICIT operator opt-in for a
//                cloud deploy that needs egress; it is surfaced LOUDLY in the release-gate
//                payload so the human approving the release SEES the deploy will have network.
//   • healthUrl: a nullable post-deploy health-check URL. Validated LOOPBACK-ONLY (localhost /
//                127.0.0.1 / [::1]) so the health fetch can never be turned into an SSRF or an
//                exfil channel. A non-loopback host is REJECTED at load (documented residual:
//                a real cloud health URL would need a reviewed allow-list widening — deferred).
//   • cwd      : an optional RELATIVE subdir of the deploy root (no absolute, no `..`). The
//                executor realpath-guards it INSIDE the root before it becomes the mount source.
//
// SECURITY LAW (mirrors quality.mjs / worktree.mjs / pr.mjs):
//   • deployCmd is an ARGV ARRAY, never a shell string. It runs via the sandbox's `sh -c` over a
//     single joined string that — because every element passes SAFE_ARG — carries NO shell
//     metacharacter to interpret. There is NO host execFile on the deploy path.
//   • The FIRST element (the binary) must be one of a FIXED allow-list (ALLOWED_DEPLOY_BINS).
//     bash/sh are DELIBERATELY absent — a deploy is a node/npm script, never a shell. An
//     absolute path or a name with a path separator can never be allow-listed.
//   • EVERY element must match SAFE_ARG (a positive char allow-list) — every shell metachar,
//     newline, CR and NUL is rejected by construction.
//   • node-flag denylist (defense-in-depth): the allow-listed `node` binary may not be walked
//     into inline-eval or arbitrary-module preload from the worktree.
//   • A missing file falls back to a SAFE default (a local, network-free `npm run build`
//     preview deploy); a present-but-invalid file FAILS CLOSED ({ error }) — the caller treats
//     an unrunnable deploy config as a FAILED deploy, never a silent success.

import { readFileSync, existsSync } from "node:fs";

// The CLOSED allow-list of deploy binaries a deploy.json may name. Bare names only (resolved
// from PATH in the jail); a path-separated/absolute value can never match. Documented set —
// deploy-relevant runners ONLY; bash/sh are intentionally EXCLUDED (a deploy is a script run
// through a package/script runner, never a raw shell). Adding a binary here is a deliberate,
// reviewed code change — never a config-time decision:
//   node               — run a repo deploy script file (e.g. scripts/deploy-preview.mjs)
//   npm, npx, pnpm, yarn — run a package.json deploy/build script (e.g. `npm run build`)
export const ALLOWED_DEPLOY_BINS = Object.freeze(new Set([
  "node", "npm", "npx", "pnpm", "yarn",
]));

// Reject a `node` invocation that would eval inline code or preload an arbitrary module/config
// file from the (operator- but also possibly agent-adjacent) worktree — identical to quality.mjs.
const NODE_DANGEROUS_FLAG = /^(?:-e|--eval|-r|--require|--import|--input-type|--loader|--env-file)(?:=|$)|^--experimental-/;

// Positive character allow-list for EVERY argv element (same set as quality.mjs SAFE_ARG). Any
// char outside it — every shell metacharacter included — makes the element (and the config) invalid.
const SAFE_ARG = /^[A-Za-z0-9._\-/:=@,+ ]*$/;

const MAX_ARGV = 64;
const MAX_ELEM = 512;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 600_000;
export const DEFAULT_TIMEOUT_MS = 300_000; // a build/deploy step may legitimately run minutes

// The safe default when no deploy.json exists: a LOCAL, network-free preview deploy — the repo's
// own build (the local preview artifact), jailed with network:false and NO health URL (a pure
// build serves no surface, so there is nothing to poll). Every field satisfies the validator.
export const DEFAULT_DEPLOY = Object.freeze({
  deployCmd: Object.freeze(["npm", "run", "build"]),
  healthUrl: null,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  network: false,
  cwd: null,
});

/**
 * Validate one command (an argv array). Returns { cmd } or { error }. Identical discipline to
 * quality.mjs.validateCmd, but keyed to ALLOWED_DEPLOY_BINS (no bash/sh).
 */
export function validateDeployCmd(raw, { label = "deployCmd" } = {}) {
  if (raw === null || raw === undefined) return { error: `${label} is required` };
  if (!Array.isArray(raw)) return { error: `${label} must be an array of strings` };
  if (!raw.length) return { error: `${label} must be a non-empty array` };
  if (raw.length > MAX_ARGV) return { error: `${label} has too many elements (>${MAX_ARGV})` };
  for (const el of raw) {
    if (typeof el !== "string") return { error: `${label} elements must all be strings` };
    if (el.length > MAX_ELEM) return { error: `${label} element too long (>${MAX_ELEM})` };
    if (!SAFE_ARG.test(el)) return { error: `${label} element has a disallowed character: ${JSON.stringify(el).slice(0, 80)}` };
  }
  const bin = raw[0];
  if (!bin) return { error: `${label} binary is empty` };
  if (bin.includes("/") || bin.includes("\\")) return { error: `${label} binary must be a bare name, not a path: ${JSON.stringify(bin).slice(0, 80)}` };
  if (!ALLOWED_DEPLOY_BINS.has(bin)) return { error: `${label} binary '${bin}' is not in the allow-list` };
  if (bin === "node") {
    for (const arg of raw.slice(1)) {
      if (NODE_DANGEROUS_FLAG.test(arg)) return { error: `${label} uses a disallowed node flag: ${JSON.stringify(arg).slice(0, 80)}` };
    }
  }
  return { cmd: raw.slice() };
}

// A cwd override must be a RELATIVE subpath of the deploy root — no absolute, no `..` escape.
// Default (null/absent) = the deploy root itself. (The executor additionally realpath-guards it.)
export function validateCwd(raw) {
  if (raw === null || raw === undefined || raw === "") return { cwd: null };
  if (typeof raw !== "string") return { error: "cwd must be a string" };
  if (raw.length > MAX_ELEM) return { error: "cwd too long" };
  if (!SAFE_ARG.test(raw)) return { error: "cwd has a disallowed character" };
  if (raw.startsWith("/") || raw.startsWith("\\")) return { error: "cwd must be relative to the deploy root" };
  if (raw.split(/[/\\]/).some((seg) => seg === "..")) return { error: "cwd must not contain '..'" };
  return { cwd: raw };
}

// The health-check URL is fetched by the server AFTER a deploy. To make sure that fetch can
// never be turned into an SSRF probe or an exfil channel, it is validated LOOPBACK-ONLY: http/https
// scheme, a loopback host (localhost / 127.0.0.1 / [::1]), and NO embedded credentials. Any other
// host is rejected. (Residual, documented: a real cloud deploy's health URL would need a reviewed
// allow-list widening — deferred, exactly like per-destination egress filtering in ADR-056.)
const LOOPBACK_HOSTS = Object.freeze(new Set(["localhost", "127.0.0.1", "[::1]", "::1"]));
export function validateHealthUrl(raw) {
  if (raw === null || raw === undefined || raw === "") return { healthUrl: null };
  if (typeof raw !== "string") return { error: "healthUrl must be a string" };
  if (raw.length > MAX_ELEM) return { error: "healthUrl too long" };
  let u;
  try { u = new URL(raw); } catch { return { error: "healthUrl is not a valid URL" }; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { error: "healthUrl must be http(s)" };
  if (u.username || u.password) return { error: "healthUrl must not embed credentials" };
  const host = (u.hostname || "").toLowerCase();
  if (!LOOPBACK_HOSTS.has(host)) return { error: `healthUrl host must be loopback (localhost/127.0.0.1/[::1]), not '${host.slice(0, 40)}'` };
  return { healthUrl: u.toString() };
}

function validateTimeout(raw) {
  if (raw === null || raw === undefined) return DEFAULT_TIMEOUT_MS;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(n, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

/**
 * Validate a parsed deploy object into a normalized config. Returns { config } or { error }.
 * network is a strict boolean DEFAULT false — any non-true value (including absent) is false, so
 * a deploy is network-isolated unless the operator EXPLICITLY sets network:true.
 */
export function validateDeploy(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { error: "deploy config must be a JSON object" };
  const d = validateDeployCmd(obj.deployCmd, { label: "deployCmd" });
  if (d.error) return { error: d.error };
  const h = validateHealthUrl(obj.healthUrl);
  if (h.error) return { error: h.error };
  const c = validateCwd(obj.cwd);
  if (c.error) return { error: c.error };
  return {
    config: {
      deployCmd: d.cmd,
      healthUrl: h.healthUrl,
      timeoutMs: validateTimeout(obj.timeoutMs),
      network: obj.network === true, // strict: default false, only an explicit `true` opts in
      cwd: c.cwd,
    },
  };
}

// ── Phase 6 / 6.4 — SCOPING the deploy command to what actually changed ───────────────
//
// LIVE FAILURE 2026-09-02: every deploy ran the config's full command (`npm run build`).
// In the `--network none` jail the Vite build blew the /work disk cap
// (`/work exceeded 268435456 bytes — container killed`), the deploy failed, and the story
// went `deploy-watch`/`blocked`. No story has ever reached `shipped`.
//
// A story that only touched `agent-runtime/**` produces NO build artifact, so running the
// full bundler for it buys nothing and costs the whole disk budget. The narrow command
// TYPECHECKS instead — still a real gate, still jailed, still the same allow-list.
//
// THE RULE, stated once:
//   any changed path under `src/**` or `public/**`  → config.deployCmd  (the FULL command)
//   otherwise, with a KNOWN change set              → SCOPED_TYPECHECK_CMD
//   an EMPTY or UNKNOWN change set                  → config.deployCmd  (the FULL command)
//
// FAIL EXPENSIVE, NEVER FAIL NARROW — the same asymmetry router-tier.mjs uses. Narrowing on
// ignorance would silently skip the build that proves the ship works; "we do not know what
// changed" must cost minutes, never coverage.
//
// SECURITY: this function picks the argv the JAIL EXECUTES, so it is held to the loader's
// bar, not a lower one. It re-runs validateDeployCmd on whatever it chose and FAILS CLOSED
// ({error}) if that does not pass — a poisoned config can never be laundered into a command
// by taking the narrow branch. It is PURE: no fs, no env, no mutation of its arguments, and
// the argv it returns is a fresh copy.
export const SCOPED_TYPECHECK_CMD = Object.freeze(["npm", "run", "typecheck"]);

// Directories whose contents feed the BUILT artifact. Kept explicit and closed — widening it
// is a reviewed code change, exactly like ALLOWED_DEPLOY_BINS.
const BUILT_INPUT_DIRS = Object.freeze(["src", "public"]);

// Normalize ONE changed path for prefix matching. Returns null when the path cannot be
// reduced to a repo-relative form we are sure about (a traversal, a non-string, an empty
// string) — an unsure path makes the whole set UNKNOWN, which routes to the full command.
function normalizeChangedPath(raw) {
  if (typeof raw !== "string") return null;
  const p = raw.replace(/\\/g, "/").trim();
  if (!p) return null;
  if (p.split("/").some((seg) => seg === "..")) return null; // traversal — not ours to classify
  return p.replace(/^\.\//, "").replace(/^\/+/, "");
}

/**
 * deployCmdForChanges(changedPaths, config) → { cmd, scope } | { error }
 *
 *   scope: "full"      — the configured deploy command (a built input changed, or we do not know)
 *          "typecheck" — the narrow command (a known change set that touches no built input)
 *
 * Never throws. `config` defaults to DEFAULT_DEPLOY; a garbage config object degrades to that
 * default rather than to a guess. An INVALID deployCmd is refused on BOTH branches.
 */
export function deployCmdForChanges(changedPaths, config) {
  const cfg = config && typeof config === "object" && !Array.isArray(config) ? config : DEFAULT_DEPLOY;
  const full = validateDeployCmd(Array.isArray(cfg.deployCmd) ? cfg.deployCmd : DEFAULT_DEPLOY.deployCmd);
  if (full.error) return { error: full.error };

  if (!Array.isArray(changedPaths) || !changedPaths.length) return { cmd: full.cmd, scope: "full" };

  let touchesBuiltInput = false;
  for (const raw of changedPaths) {
    const p = normalizeChangedPath(raw);
    if (p === null) return { cmd: full.cmd, scope: "full" }; // unknown member ⇒ unknown set ⇒ full
    if (BUILT_INPUT_DIRS.some((d) => p.startsWith(`${d}/`))) { touchesBuiltInput = true; break; }
  }
  if (touchesBuiltInput) return { cmd: full.cmd, scope: "full" };

  // The narrow command is a module constant, but it is validated on the SAME path as the
  // configured one — nothing reaches a caller without having passed the allow-list.
  const narrow = validateDeployCmd([...SCOPED_TYPECHECK_CMD]);
  if (narrow.error) return { error: narrow.error };
  return { cmd: narrow.cmd, scope: "typecheck" };
}

/**
 * Load + validate factory/deploy.json.
 *   • file missing        → { config: DEFAULT_DEPLOY }  (a legitimate "not configured")
 *   • file present, bad   → { error }                   (FAIL CLOSED — never a command)
 *   • file present, valid → { config }
 * Never throws.
 */
export function loadDeploy(path) {
  if (!path || !existsSync(path)) return { config: { ...DEFAULT_DEPLOY, deployCmd: [...DEFAULT_DEPLOY.deployCmd] } };
  let text;
  try { text = readFileSync(path, "utf-8"); } catch (err) { return { error: `deploy.json unreadable: ${err.message}` }; }
  let obj;
  try { obj = JSON.parse(text); } catch (err) { return { error: `deploy.json parse error: ${err.message}` }; }
  return validateDeploy(obj);
}
