// F2b apply-broker GUARDS — extracted verbatim from server.mjs so the engine
// (ADR-024) and policy (ADR-029) can reuse the EXACT same predicates without
// booting the HTTP server. LOGIC IS UNCHANGED — this is a move, not a rewrite.
// server.mjs imports these back, so its behavior is byte-for-byte identical.
//
// F5 — RUNTIME_REPO_ROOT (absolute path) makes the target repo configurable.
// Default (env unset) = MissionAlpha, byte-identical to before. Validation is
// fail-closed and GATED on the env var being set (so the 287 existing tests,
// which import with env unset, are byte-for-byte unaffected). Also reads
// RUNTIME_SEED_DIRS (csv) to generalise the appliable scope for an arbitrary
// repo. Uses node:fs for fail-closed validation.
//
// sr-security: applyAllowed / configGuardViolation / APPLY_DENY / CONFIG_GUARD /
// SEED_DIRS / SEED_FILES are the security boundary. Any change here changes the
// broker. Diff against the original server.mjs definitions to confirm equivalence.

import { dirname, resolve, relative, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, statSync } from "node:fs";
// P5 — the persisted workspace (POST /runtime/workspace). Validation + perms live
// in workspace.mjs; this module only consumes the already-validated result.
import { readWorkspace } from "./workspace.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
// F5 — configurable target repo. resolve(env) takes an absolute path verbatim.
// Fail CLOSED if set-but-invalid.
//
// P5 inserts the PERSISTED workspace between the env var and the built-in default,
// so the UI's choice survives a restart without the operator managing an env var.
// Precedence, highest first:
//   1. RUNTIME_REPO_ROOT — explicit env (CI, tests, Electron's hot-swap)
//   2. the persisted workspace config (POST /runtime/workspace)
//   3. MissionAlpha itself — byte-identical to pre-P5 behavior
// The value resolves ONCE at module load and is IMMUTABLE for the process lifetime.
// That immutability is what makes applyAllowed's containment check trustworthy: a
// mutable root would open a validate-then-apply TOCTOU window. Changing the
// workspace therefore requires a runtime restart, which POST /runtime/workspace
// reports back as `restartRequired`.
export const REPO_ROOT = process.env.RUNTIME_REPO_ROOT
  ? resolve(process.env.RUNTIME_REPO_ROOT)
  : (readWorkspace() || resolve(__dir, ".."));
if (process.env.RUNTIME_REPO_ROOT) {
  if (!existsSync(REPO_ROOT) || !statSync(REPO_ROOT).isDirectory()) {
    throw new Error(`RUNTIME_REPO_ROOT does not exist or is not a directory: ${REPO_ROOT}`);
  }
}

// Seeded + appliable scope. src/ + public/ + README + package.json. Still EXCLUDES
// *.config.ts + scripts/ + infrastructure/ + .github/ (pure exec / CI). package.json
// IS appliable BUT its exec/supply-chain keys are hard-guarded server-side
// (CONFIG_GUARD) — sr-security F2b.
//
// public/ is the static-deliverable surface: a /run "build" (e.g. an agent producing
// billsplit.html) writes its output here so it surfaces via /changes and is operator-
// appliable. It carries no exec semantics (Vite serves it verbatim), and apply stays
// gated by APPLY_DENY + containment + symlink/realpath checks. SEED_DIRS is the SINGLE
// source of truth for both the copy-sandbox broker AND the engine worktree broker.
//
// F5 — RUNTIME_SEED_DIRS (csv) generalizes the appliable scope for an arbitrary
// repo. Default unchanged = ["src","public"]. APPLY_DENY/PUBLIC_DENY/CONFIG_GUARD
// are root-relative matchers and need NO change — applyAllowed recomputes relNorm
// against the new root, so the same deny rules apply.
// C28 (2026-09-18) — ROOT-LEVEL FILES A PLAN MAY SCOPE A SEAT TO.
//
// applyAllowed("README.md") is TRUE: the broker lands root-level files. But every scope rule
// keyed on SEED_DIRS refused them, so a seat could never be SCOPED to a file the runtime would
// happily apply. Live run 2 hired `repo-edit-engineer` with ["src/lib/**"] for a README task and
// every attempt died `empty-diff … README.md (out-of-scope)`.
//
// DOCUMENTATION ONLY, deliberately. A sentence in a model-authored plan must not be able to
// grant a freshly-hired specialist write access to package.json, tsconfig.json or a Makefile —
// that is privilege escalation by prose. Directories still go through SEED_DIRS unchanged.
export const ROOT_DOC_FILE = /^[A-Za-z0-9][A-Za-z0-9_-]*\.(?:md|markdown|txt|rst|adoc)$/i;

/** Is `entry` a bare root-level documentation file (no directory part)? */
export function isRootDocFile(entry) {
  const e = String(entry ?? "");
  return !e.includes("/") && ROOT_DOC_FILE.test(e);
}

export const SEED_DIRS = process.env.RUNTIME_SEED_DIRS
  ? process.env.RUNTIME_SEED_DIRS.split(",").map((s) => s.trim()).filter(Boolean)
  : ["src", "public", "agent-runtime", "docs"];
export const SEED_FILES = ["README.md", "package.json"];
// apply() refuses any path matching these (defense beyond the .claude denylist).
// #9 — `\.env` now covers its SUFFIXED siblings. The old pattern required `.env` to be
// followed by a slash or end-of-string, so `.env.local` / `.env.backup` / `.env.production`
// all sailed past it. That was survivable while the appliable scope was `src` + `public`
// (no dotfile lives there); widening it to `agent-runtime` made `agent-runtime/.env.local`
// appliable, which CG-6 caught. Same fix, same reasoning as `snapshotAllowed` in
// worktree.mjs — a deny that matches one exact spelling of a secret file is not a deny.
// Lockfiles (GUARD-7, 2026-09-24): a dependency change is already refused via CONFIG_GUARD, so an
// agent-authored lockfile edit has no legitimate source — and `resolved`/`integrity` steer `npm ci`.
export const APPLY_DENY = /(^|\/)(\.env(\.[^/]*)?|\.git|\.claude|node_modules|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|\.npmrc|\.yarnrc(\.yml)?|\.pnpmfile\.cjs|.*\.(pem|key|p12))(\/|$)/iu; // `u`: Unicode case folding (GUARD-4)

// ── #9 — CORE_GUARD: the floor under every scope ────────────────────────────────
//
// SEED_DIRS now includes `agent-runtime`, because on a repo whose product IS the runtime
// the old `["src","public"]` scope made most self-directed work unappliable — observed
// live, a build seat wrote a correct file under `agent-runtime/providers/` four times and
// every one was dropped as "no appliable diff".
//
// That widening is only safe with a floor. These are the files that DEFINE what an agent
// may do: applyAllowed itself, the sole write path, the jail, the containment helpers, the
// egress scrub, the PR ladder, the route table and its auth gates, and the two JSON files
// that name commands the runtime EXECUTES. An agent able to edit `guards.mjs` can delete
// the check that stopped it; one able to edit `quality.json` chooses what runs in the jail.
//
// The human approval gate is not a sufficient answer on its own — a diff that quietly
// relaxes a predicate is exactly the kind a tired reviewer waves through — so this is
// enforced in code and is NOT configurable. It is checked BEFORE the seed comparison, so
// no value of RUNTIME_SEED_DIRS can reach these paths. The broker must never be the tool
// that edits the broker. An operator who genuinely needs to change one of these edits it
// by hand, deliberately, outside the swarm.
//
// Deliberately EXACT names, never prefixes: `guardsHelper.mjs` is ordinary work, and a
// guard that swallowed its neighbours would quietly re-create the too-narrow scope this
// change exists to open up. There are TWO directory clauses: `agent-runtime/providers/`
// (Phase E · 16, see below) and `agent-runtime/data/` — the
// SQLite Delivery store, the patch bodies and the vault. Widening the scope made those
// appliable, which would have let an agent hand the operator a diff that REPLACES the
// record of every decision ever made, including the approvals. Caught by CG-6.
export const CORE_GUARD = new RegExp(
  // Re-review 2026-09-24 (HIGH): every runtime STATE location inside agent-runtime/, not just data/ —
  // engine-store/ (mcp-connectors.json names commands launched on the host), threads/ (the BOSS and
  // CEO conversation history), sandboxes/, and the auth token file.
  "(^|/)(agent-runtime/data/.*|agent-runtime/engine-store/.*|agent-runtime/threads/.*|agent-runtime/sandboxes/.*|agent-runtime/\\.runtime-token|" + [
    "agent-runtime/guards\\.mjs",
    "agent-runtime/broker\\.mjs",
    "agent-runtime/workspace\\.mjs",
    "agent-runtime/worktree\\.mjs",
    "agent-runtime/sandbox\\.mjs",
    "agent-runtime/quality\\.mjs",
    "agent-runtime/quality-hook\\.mjs",
    "agent-runtime/hooks\\.mjs",
    "agent-runtime/policy\\.mjs",
    "agent-runtime/test-gate\\.mjs",
    "agent-runtime/test-scope\\.mjs",
    "agent-runtime/secret-scrub\\.mjs",
    "agent-runtime/pr\\.mjs",
    "agent-runtime/server\\.mjs",
    // Phase 7 (BOSS-approved 2026-09-04). roster.json decides what every seat may write,
    // and roster.mjs holds load()/match() that produce those seats. An agent able to edit
    // either grants itself scope — the same argument that puts guards.mjs here.
    // HONEST BOUND: neither could ever exceed this floor anyway, because writeScope is the
    // LAST gate and only subtracts. These rows are defence in depth, not a hole closed.
    "agent-runtime/roster\\.json",
    "agent-runtime/roster\\.mjs",
    // Phase E · 16 (BOSS-approved plan, 2026-09-17). The files that ROUTE, DISPATCH and HIRE:
    // factory.mjs validates what a new seat may write; mailbox.mjs is who may mail whom;
    // manager.mjs decides scope disjointness and ships; seat-settings-guard.mjs writes a
    // seat's CLI permissions. providers/ is the second directory clause: it holds the
    // credential store, its crypto, the child-process env scrub, the SSRF guard and the
    // tool jail for non-CLI providers. A seat able to edit any of these edits its own leash.
    "agent-runtime/factory\\.mjs",
    "agent-runtime/mailbox\\.mjs",
    "agent-runtime/manager\\.mjs",
    "agent-runtime/seat-settings-guard\\.mjs",
    // Security pass 2026-09-24: assertCanonicalInside, the one containment check broker and pr share.
    "agent-runtime/workdir-guard\\.mjs",
    "agent-runtime/providers/.*",
    // Phase E · 17 — the gate on running the TARGET repo's scripts on the host.
    "agent-runtime/repo-scripts\\.mjs",
    // Phase E · 18 — the worker jail's definition.
    "agent-runtime/worker-jail\\.mjs",
    // Phase E security pass, open MEDIUM closed 2026-09-24: the auto-apply loop, the non-CLI tool
    // executor, and the mail tool + its address book — each decides what a seat can DO. Plus the
    // three Phase E/F control files whose whole job is to refuse: the approved prompts (and the
    // flag that enforces their approval), the dispatcher that checks it, and decide() itself.
    "agent-runtime/engine\\.mjs",
    "agent-runtime/tool-broker\\.mjs",
    "agent-runtime/mcp/mail-tools\\.mjs",
    "agent-runtime/mail-env\\.mjs",
    "agent-runtime/manager-prompts\\.mjs",
    "agent-runtime/manager-dispatch\\.mjs",
    "agent-runtime/deliveries\\.mjs",
    // Security review 2026-09-24 (HIGH) — the rest of the control plane, found by probing
    // applyAllowed over agent-runtime/: who may act (users, trust, perms, caps), what is reviewed
    // or auto-approved (task-diff, risk), what runs (deploy, engine-spawner), and the records
    // that decide all of it (jobs, pipeline, db, hr, ash-tools, inject-detect, patch-edit, github).
    "agent-runtime/users\\.mjs",
    "agent-runtime/risk\\.mjs",
    "agent-runtime/patch-edit\\.mjs",
    "agent-runtime/task-diff\\.mjs",
    "agent-runtime/jobs\\.mjs",
    "agent-runtime/deploy\\.mjs",
    "agent-runtime/story-deploy\\.mjs",
    "agent-runtime/adapters/github\\.mjs",
    "agent-runtime/station-perms\\.mjs",
    "agent-runtime/perm-mode\\.mjs",
    "agent-runtime/worker-cap\\.mjs",
    "agent-runtime/trust\\.mjs",
    "agent-runtime/inject-detect\\.mjs",
    "agent-runtime/mcp/ash-tools\\.mjs",
    "agent-runtime/engine-spawner\\.mjs",
    "agent-runtime/pipeline\\.mjs",
    "agent-runtime/db\\.mjs",
    "agent-runtime/hr\\.mjs",
    "factory/quality\\.json",
    "factory/deploy\\.json",
  ].join("|") + ")$",
  "iu", // `u` — fold Unicode case too: `guardſ.mjs` is guards.mjs on case-insensitive APFS (GUARD-4)
);
// ── BOSS decision #1 (2026-09-27) — agent-runtime/ is DENY-BY-DEFAULT ────────────────
//
// CORE_GUARD above is an allowlist of control files, and every security pass found more that
// were missing: the last census still left 66 runtime modules appliable. That list cannot be
// finished, because every module server.mjs imports runs INSIDE the runtime process with its fs,
// env and token — any of them can patch what the others enforce. So the question is inverted:
// under agent-runtime/, only the two test directories the suite runs are appliable (BOSS
// decision #2 pending). Code, JSON, a new file, a new directory: refused, for every seat.
// Safe only while the runtime never imports from those dirs (RTF-4) and a symlink cannot
// redirect a write out of them (RTF-7, assertCanonicalInside).
export const RUNTIME_FLOOR = /^agent-runtime\/(?!(?:test|__tests__)\/)/iu; // `u` folds `teſt` → test, as APFS does

// public/ is appliable for STATIC deliverables only. An agent's /run "build" must NOT
// land: (a) public/index.html — Vite serves it at / AHEAD of the SPA shell on every
// dashboard load, so an applied one could swap the UI + exfiltrate the runtime token
// (fetched same-origin from localhost); or (b) any script/executable type — served
// verbatim by Vite = browser RCE/XSS surface. Non-index .html / css / images / fonts /
// json stay appliable (e.g. billsplit.html). sr-security: PUBLIC_GUARD.
export const PUBLIC_DENY = /^public\/(index\.html$|.*\.(sh|bash|zsh|py|rb|pl|ps1|bat|cmd|exe|dll|so|dylib|wasm|mjs|cjs|jsx?|tsx?)$)/iu; // `u` (GUARD-4)
// Files whose exec-relevant keys must NEVER change via the broker. If any protected
// key differs between repo + sandbox, the whole file apply is refused.
export const CONFIG_GUARD = {
  "package.json": ["scripts", "dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "bin", "main", "module", "exports",
    // Re-review 2026-09-24: each of these redirects what `npm install` fetches or what an import resolves to.
    "overrides", "resolutions", "pnpm", "workspaces", "imports"],
};

// ── glob → RegExp ────────────────────────────────────────────────────────────
// Deliberately tiny and dependency-free: prefix segments, `**` (any number of path
// segments), `*` and `?` (never crossing a `/`), everything else literal. A path
// separator is the only structural character, so `*` cannot swallow one — that is the
// property that stops `src/*.tsx` from reaching `src/deep/a.tsx`.
const RE_CACHE = new Map();

function segmentToSource(seg) {
  let out = "";
  for (const ch of seg) {
    if (ch === "*") out += "[^/]*";
    else if (ch === "?") out += "[^/]";
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return out;
}

export function globToRegExp(glob) {
  const hit = RE_CACHE.get(glob);
  if (hit) return hit;
  const segs = String(glob).split("/");
  let src = "^";
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const last = i === segs.length - 1;
    if (seg === "**") {
      // Trailing `**` = everything BELOW this point (at least one character), so a bare
      // directory path never matches. A middle `**` = zero or more whole segments.
      src += last ? ".+" : "(?:[^/]+/)*";
      continue;
    }
    src += segmentToSource(seg);
    if (!last) src += "/";
  }
  src += "$";
  const re = new RegExp(src);
  RE_CACHE.set(glob, re);
  return re;
}

/**
 * True if `relPath` falls inside `writeScope`.
 * An absent or empty scope matches NOTHING — a seat with no declared scope writes nothing.
 *
 * GLOB RULE (stated once): a `**`-rooted glob is accepted by load() and is INTERSECTED
 * with SEED_DIRS *at match time*. That intersection is not re-implemented here — it IS
 * the order of the checks in applyAllowed, which tests SEED_DIRS before writeScope. So
 * `src/x/__tests__/a.test.ts` is in scope for the test seat and
 * `node_modules/x/__tests__/a.test.ts` is not, because it never reaches this function.
 */
export function matchesWriteScope(relPath, writeScope) {
  if (!Array.isArray(writeScope) || writeScope.length === 0) return false;
  if (typeof relPath !== "string" || relPath === "") return false;
  // NO backslash rewriting here. `applyAllowed` hands this a path already normalised from
  // `sep`, so on POSIX the old `split("\\").join("/")` was a no-op for real paths and a
  // CORRUPTION for legitimate filenames that contain a backslash: `src/lib\evil.ts` became
  // `src/lib/evil.ts` and satisfied a `src/lib/**` scope it was never granted, landing a file
  // directly in `src/`. A backslash is refused one gate earlier instead (applyAllowed).
  return writeScope.some((g) => globToRegExp(g).test(relPath));
}

// True if a relPath is safe to apply — validated on the RESOLVED path, not the raw
// string (sr-security F2b: re-derive scope from the normalized path).
// Phase 7 (BOSS-approved 2026-09-04) — `opts.seat` is a roster member, or absent.
//
// ORDER, and the order IS the security argument:
//   containment → APPLY_DENY → CORE_GUARD → RUNTIME_FLOOR → PUBLIC_DENY → SEED_DIRS → writeScope(seat)
// writeScope is appended LAST and can only ever SUBTRACT. There is no path by which a
// seat makes an appliable path out of a refused one; pinned by WS-SUBSET.
//
// LEGACY RULE, stated once: with no `opts`, no `opts.seat`, or a seat whose role is not
// "worker", this returns EXACTLY what it returned before Phase 7 — UNLESS `opts.strict`.
// The single-argument callers are enumerated and pinned by GUARD-2 (patch-edit, policy ×2,
// factory, broker's diagnostic), which is what keeps policy.mjs's stated invariant
// `isAutoSafe(p) ⟹ applyAllowed(p)` true by construction.
//
// STRICT (Phase E · 16): the engine broker and the ship ladder land an AGENT's work. There,
// "no seat" means the task's seat could not be resolved, so the narrowing below never ran —
// and unknown must mean no. Strict refuses ONLY the unresolved case; a resolved seat's
// answer is unchanged.
export function applyAllowed(relPath, opts) {
  if (!relPath || typeof relPath !== "string") return false;
  if (isAbsolute(relPath)) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(relPath)) return false; // control chars / NUL
  if (/["'`|$=]/.test(relPath)) return false; // bus-format metachars — no legit use in src/
  // A backslash is a path separator on one platform and an ordinary filename character on
  // another. Rather than guess, refuse it: `writeScope` entries already refuse it
  // (fatalScopeProblem), so a path containing one can never be inside any seat's scope, and
  // treating it as a separator is how `src/lib\evil.ts` slipped a `src/lib/**` grant.
  if (relPath.includes("\\")) return false;
  const dest = resolve(REPO_ROOT, relPath);
  const rootPrefix = resolve(REPO_ROOT) + sep;
  if (!dest.startsWith(rootPrefix)) return false; // containment (kills ../ escape)
  const relNorm = relative(REPO_ROOT, dest); // canonical
  if (APPLY_DENY.test(relNorm)) return false;
  // #9 — the floor. Checked BEFORE the seed comparison so no RUNTIME_SEED_DIRS value can
  // reach the files that decide what an agent may write.
  const relSlash = relNorm.split(sep).join("/"); // platform-stable for the public/ guard
  if (CORE_GUARD.test(relSlash)) return false;
  if (RUNTIME_FLOOR.test(relSlash)) return false; // decision #1 — deny-by-default under agent-runtime/
  if (PUBLIC_DENY.test(relSlash)) return false;
  const top = relNorm.split(sep)[0];
  if (!(SEED_DIRS.includes(top) || SEED_FILES.includes(relNorm))) return false;

  // THE LAST GATE. Everything above has already had its say; this can only narrow.
  const seat = opts?.seat;
  if (!seat) return !opts?.strict; // STRICT: an unresolved seat on an agent write path is a no
  if (seat.role !== "worker") return true; // LEGACY RULE — byte-for-byte as before
  return matchesWriteScope(relSlash, seat.writeScope);
}

/**
 * The CONFIG_GUARD keys for a path, or null. Matched by BASENAME, case-insensitively: every
 * package.json in the tree runs its scripts on install/test, not only the root one, and on
 * case-insensitive APFS `Package.json` IS package.json (CFG-NEST-1).
 */
export function configGuardKeys(relPath) {
  // NFKC before lower-casing: `package.j\u017fon` (long s) and `pac\u212Age.json` (Kelvin) open
  // package.json on APFS, and toLowerCase() alone leaves \u017f untouched (CFG-NEST-1b).
  const base = String(relPath ?? "").split(/[\\/]/).pop().normalize("NFKC").toLowerCase();
  return Object.prototype.hasOwnProperty.call(CONFIG_GUARD, base) ? CONFIG_GUARD[base] : null;
}

// Config guard — for a CONFIG_GUARD file, return the first protected key that
// differs between repo (before) and sandbox (after), or null if safe. Blocks
// supply-chain / exec-on-apply key changes (e.g. package.json scripts/deps).
export function configGuardViolation(relNorm, before, after) {
  const keys = configGuardKeys(relNorm);
  if (!keys) return null;
  let a, b;
  try {
    b = JSON.parse(before ?? "{}");
    a = JSON.parse(after);
  } catch {
    return "unparseable JSON"; // refuse if we can't verify
  }
  const norm = (v) => JSON.stringify(v ?? null);
  for (const k of keys) {
    if (norm(b[k]) !== norm(a[k])) return k;
  }
  return null;
}
