// D1 — TEST SCOPING FOR THE QUALITY GATE. PURE: no I/O, no git, no globbing.
//
// THE DEFECT THIS CLOSES, measured on the live install: `factory/quality.json` said
// `["node","--test"]` with a 120s deadline, and the post-edit hook ran it on EVERY task.
// On this repo that is ~2,500 tests; the container reached test 328 and was killed. The
// gate could therefore never pass, so no autonomous task ever produced a Delivery —
// 42 failed / 0 done — and each failure threw away a real (paid) model turn before the
// broker had even computed a diff.
//
// The gate's job is "does the agent's diff break its own tests", not "is the whole repo
// green". So: run the test files that RELATE to the paths the agent touched. That is the
// same idea as `jest --findRelatedTests`, expressed as a pure function so every rule is
// provable without a repo.
//
// THREE VERDICTS, and the difference between them is load-bearing:
//   • targets found          → run exactly those
//   • `scope-empty`          → the change has no related tests (a docs edit). Honest pass,
//                              RECORDED. Vetoing it is the defect, not the fix.
//   • `scope-unknown`        → we could not learn what changed (git said nothing). NEVER
//                              scope on a blind list: the caller falls back to the full
//                              configured command rather than silently testing nothing.
//
// SECURITY: every target ends up in an argv. Nothing here trusts a filename — a target
// must be a repo-relative path with no `..`, no leading `/`, must look like a test file,
// and must sit either under an operator-configured `testDir` or in the same directory as
// a file the agent changed. The caller additionally re-validates the FINAL argv
// through quality.mjs `validateCmd` (allow-listed binary + SAFE_ARG per element), so an
// agent-authored filename cannot smuggle a flag or a metacharacter into the runner.

/** Both layouts this repo uses, plus the common `.spec.` convention. */
const TEST_FILE_RE = /(\.test\.[cm]?[jt]sx?|\.spec\.[cm]?[jt]sx?)$/;
const TESTS_DIR_RE = /(^|\/)__tests__\//;

const MAX_TARGETS_CEIL = 64;   // hard ceiling regardless of config — argv stays bounded
const DIR_RE = /^[A-Za-z0-9._\-/]+$/;

export const DEFAULT_SCOPE = Object.freeze({
  enabled: true,
  testDirs: Object.freeze(["test", "tests", "__tests__"]),
  maxTargets: 12,
});

/** True when `p` looks like a test file by either convention. Never throws. */
export function isTestPath(p) {
  const s = String(p ?? "");
  return TEST_FILE_RE.test(s) || TESTS_DIR_RE.test(s);
}

/**
 * Validate an operator-supplied `scope` block. Absent ⇒ the safe default. Malformed ⇒
 * `{ error }` — quality.mjs FAILS CLOSED on it, exactly like a malformed testCmd, so a
 * broken block can never quietly widen or narrow what the gate runs.
 */
export function validateScope(raw) {
  if (raw === null || raw === undefined) return { scope: { ...DEFAULT_SCOPE, testDirs: [...DEFAULT_SCOPE.testDirs] } };
  if (typeof raw !== "object" || Array.isArray(raw)) return { error: "scope must be a JSON object" };
  const enabled = raw.enabled === undefined ? true : Boolean(raw.enabled);
  let testDirs = DEFAULT_SCOPE.testDirs;
  if (raw.testDirs !== undefined) {
    if (!Array.isArray(raw.testDirs)) return { error: "scope.testDirs must be an array of strings" };
    if (!raw.testDirs.length) return { error: "scope.testDirs must not be empty" };
    for (const d of raw.testDirs) {
      if (typeof d !== "string" || !d) return { error: "scope.testDirs elements must be non-empty strings" };
      if (!DIR_RE.test(d)) return { error: `scope.testDirs has a disallowed character: ${JSON.stringify(d).slice(0, 80)}` };
      if (d.startsWith("/") || d.split("/").includes("..")) return { error: `scope.testDirs must be a relative subpath: ${JSON.stringify(d).slice(0, 80)}` };
    }
    testDirs = raw.testDirs.slice();
  }
  let maxTargets = DEFAULT_SCOPE.maxTargets;
  if (raw.maxTargets !== undefined) {
    const n = Math.floor(Number(raw.maxTargets));
    if (!Number.isFinite(n) || n < 1) return { error: "scope.maxTargets must be a positive integer" };
    maxTargets = Math.min(n, MAX_TARGETS_CEIL);
  }
  return { scope: { enabled, testDirs: [...testDirs], maxTargets } };
}

/** Repo-relative, no traversal, no absolute. Anything else can never become an argv element. */
function safeRelPath(p) {
  const s = String(p ?? "").replace(/\\/g, "/");
  if (!s || s.startsWith("/") || s.startsWith("~")) return null;
  if (s.split("/").includes("..")) return null;
  return s;
}

/** `testDirs` are path SEGMENTS or prefixes: "test" matches `a/test/x`, "a/test" matches `a/test/x`. */
function underTestDir(p, testDirs) {
  const segs = p.split("/");
  return testDirs.some((d) => (d.includes("/") ? p.startsWith(`${d}/`) : segs.slice(0, -1).includes(d)));
}

/** The directory part of a repo-relative path ("" for a root-level file). */
function dirOf(p) {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

/** `agent-runtime/pipeline.mjs` → `pipeline`; `src/lib/__tests__/x.test.ts` → `x`. */
function stemOf(p) {
  const base = p.slice(p.lastIndexOf("/") + 1);
  return base.replace(TEST_FILE_RE, "").replace(/\.[cm]?[jt]sx?$/, "").replace(/\.[A-Za-z0-9]+$/, "");
}

/**
 * Which test files should run for this change set.
 *
 * @param changed   repo-relative paths the agent added/modified (from git, in the worktree)
 * @param repoFiles every repo-relative file present in the worktree (bounded by the caller)
 * @param scope     a validated scope block
 * @returns {{targets:string[], reason:(string|null), truncated:boolean}}
 */
export function relatedTests({ changed = [], repoFiles = [], scope = DEFAULT_SCOPE } = {}) {
  const dirs = scope.testDirs?.length ? scope.testDirs : DEFAULT_SCOPE.testDirs;
  const changedSafe = (changed || []).map(safeRelPath).filter(Boolean);
  // An empty change list is NOT "nothing to test" — it is "we do not know". Scoping on it
  // would run zero tests and call that a pass, which is the silent-pass this gate exists
  // to prevent. The caller falls back to the full command.
  if (!changedSafe.length) return { targets: [], reason: "scope-unknown", truncated: false };

  // The universe a target may come from: real test files that are either under a
  // configured test dir OR co-located with a changed file. The second clause matters —
  // plenty of repos keep `foo.ts` beside `foo.test.ts` and never declare a test dir, and
  // a scoper that ignored them would find nothing and skip the gate on every change.
  const changedDirs = new Set(changedSafe.map(dirOf));
  const eligible = (p) => isTestPath(p) && (underTestDir(p, dirs) || changedDirs.has(dirOf(p)));
  const candidates = (repoFiles || []).map(safeRelPath).filter(Boolean).filter(eligible);

  const picked = new Set();
  for (const c of changedSafe) {
    if (eligible(c)) { picked.add(c); continue; }
    const stem = stemOf(c);
    if (!stem) continue;
    for (const cand of candidates) {
      const cbase = cand.slice(cand.lastIndexOf("/") + 1);
      if (!cbase.startsWith(stem)) continue;
      // Whole-stem match only: `queue` must not drag in `queueModel`. What follows the
      // stem has to be a separator, so `queue.test.mjs` and `queue-http.test.mjs` match
      // and `queueModel.test.ts` does not.
      const rest = cbase.slice(stem.length);
      if (rest.startsWith(".") || rest.startsWith("-")) picked.add(cand);
    }
  }

  const all = [...picked].sort();
  const max = Math.min(scope.maxTargets || DEFAULT_SCOPE.maxTargets, MAX_TARGETS_CEIL);
  const targets = all.slice(0, max);
  return {
    targets,
    reason: targets.length ? null : "scope-empty",
    truncated: all.length > targets.length,
  };
}
