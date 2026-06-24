# F5 — Configurable target repo (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Code steps RED→GREEN→commit. Boundary change → security-reviewer BLOCKING before commit.

**Goal:** Make the swarm's target repo configurable via `RUNTIME_REPO_ROOT` (default unchanged = MissionAlpha) so it can read + build any project (e.g. `/Users/.../WaahyuPython`), with containment + APPLY_DENY + token invariant intact for any root and a graceful copy-sandbox fallback on a non-git target.

**Architecture (architect blueprint):** The whole system funnels through TWO module consts in `guards.mjs` — `REPO_ROOT` (:14) and `SEED_DIRS` (:26). `applyAllowed` reads both directly; `broker.mjs`/`policy.mjs`/`server.mjs` bind them at import. So env-drive the consts ONCE in guards.mjs → every consumer inherits, zero threading. Validation fails closed at module load, GATED on the env var being set (so the 287 existing tests, which import with env unset, are byte-for-byte unaffected). Non-git fallback is a single boot probe at the engine wiring (the manual path already uses copy-sandbox).

**Tech Stack:** Node ESM, `node --test`.

## Verified anchors
- `guards.mjs:14` `export const REPO_ROOT = resolve(__dir, "..")`; `:26` `export const SEED_DIRS = ["src","public"]`; `applyAllowed` :45-59 (uses REPO_ROOT+SEED_DIRS); APPLY_DENY :29 / PUBLIC_DENY :36 / CONFIG_GUARD :39 are root-relative pattern matchers (no change). guards.mjs is currently PURE (only node:path).
- Consumers inherit: `broker.mjs:14,42`, `policy.mjs:14,24`, `server.mjs:70`.
- tmp roots (all outside any repo): `SANDBOX_ROOT` server.mjs:127, `TOKEN_DIR` :140, `execWorktrees` worktreeRoot :345, `engine-store` :856 (under `__dir`), `worktree.mjs:29` worktreeRoot.
- Engine worktree wiring: `engineWorktrees` server.mjs:859, `engineBroker workdirFor: (id)=>engineWorktrees.pathFor(id)` :861; dispatch uses `ctx.workdir` :887/:895. Manual path already copy-sandbox: `createBroker({workdirFor: sandboxDir})` :461.
- `worktree.mjs createWorktreeMgr.create()` runs `git rev-parse HEAD` → throws on non-git (:57-61).
- heartbeat/sync scripts: `join(REPO_ROOT,"scripts",...)` server.mjs:467-468, :955-956.

---

## File Structure
- **Modify:** `agent-runtime/guards.mjs` (env REPO_ROOT + fail-closed validation + SEED_DIRS env + fs import + header).
- **Modify:** `agent-runtime/worktree.mjs` (+ exported `isGitRepo()`; `create()` untouched).
- **Modify:** `agent-runtime/server.mjs` (tmp-root-outside-root boot assertion; non-git engine broker fallback; `existsSync` guard on heartbeat/sync; boot warning if zero SEED_DIRS exist under root).
- **Create:** `agent-runtime/test/repo-root.test.mjs`.

---

## Task 1: guards.mjs — env-driven REPO_ROOT + SEED_DIRS, fail-closed (TDD)

**Files:** Modify `agent-runtime/guards.mjs`; Test `agent-runtime/test/repo-root.test.mjs` (new).

> ⚠️ R1 env-timing: `RUNTIME_REPO_ROOT`/`RUNTIME_SEED_DIRS` are read at MODULE LOAD. Tests MUST set `process.env` BEFORE a dynamic `import()` of guards.mjs (use a fresh import per case via `import(\`../guards.mjs?x=\${n}\`)` cache-buster, or a child process). Static top-of-file import = stale.

- [ ] **Step 1: Failing test**

```javascript
// agent-runtime/test/repo-root.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Fresh guards module with a given env (R1: env read at load → cache-bust the import).
let _n = 0;
async function loadGuards(env) {
  for (const k of ["RUNTIME_REPO_ROOT", "RUNTIME_SEED_DIRS"]) delete process.env[k];
  Object.assign(process.env, env);
  return import(`../guards.mjs?case=${_n++}`);
}

test("unset env → REPO_ROOT defaults to MissionAlpha repo (zero change)", async () => {
  const g = await loadGuards({});
  assert.ok(g.REPO_ROOT.endsWith("/MissonAlpha") || g.REPO_ROOT.includes("MissonAlpha"));
  assert.deepEqual(g.SEED_DIRS, ["src", "public"]);
});

test("RUNTIME_REPO_ROOT points the root at another existing dir", async () => {
  const dir = mkdtempSync(join(tmpdir(), "f5-root-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  const g = await loadGuards({ RUNTIME_REPO_ROOT: dir });
  assert.equal(g.REPO_ROOT, dir);
  // applyAllowed re-derives against the NEW root
  assert.equal(g.applyAllowed("src/app.ts"), true);
  assert.equal(g.applyAllowed("../escape.ts"), false);     // containment vs new root
  assert.equal(g.applyAllowed(".env"), false);             // APPLY_DENY vs new root
});

test("invalid RUNTIME_REPO_ROOT fails closed (throws at load)", async () => {
  await assert.rejects(loadGuards({ RUNTIME_REPO_ROOT: "/no/such/dir/xyz123" }), /does not exist|not a directory/i);
});

test("RUNTIME_SEED_DIRS csv overrides the appliable scope", async () => {
  const dir = mkdtempSync(join(tmpdir(), "f5-seed-"));
  mkdirSync(join(dir, "app"), { recursive: true });
  const g = await loadGuards({ RUNTIME_REPO_ROOT: dir, RUNTIME_SEED_DIRS: "app, lib" });
  assert.equal(g.applyAllowed("app/x.ts"), true);
  assert.equal(g.applyAllowed("lib/y.ts"), true);
  assert.equal(g.applyAllowed("src/z.ts"), false); // src no longer seeded
});
```

- [ ] **Step 2: Run → FAIL** (`cd agent-runtime && node --test test/repo-root.test.mjs`) — invalid-path test won't throw yet; seed override won't apply.

- [ ] **Step 3: Implement guards.mjs**

Add fs import (after :11): `import { existsSync, statSync } from "node:fs";`
Replace `:14`:
```javascript
// F5 — configurable target repo. Default (env unset) = MissionAlpha, byte-identical
// to before. resolve(env) takes an absolute path verbatim. Fail CLOSED if set-but-invalid.
export const REPO_ROOT = process.env.RUNTIME_REPO_ROOT
  ? resolve(process.env.RUNTIME_REPO_ROOT)
  : resolve(__dir, "..");
if (process.env.RUNTIME_REPO_ROOT) {
  if (!existsSync(REPO_ROOT) || !statSync(REPO_ROOT).isDirectory()) {
    throw new Error(`RUNTIME_REPO_ROOT does not exist or is not a directory: ${REPO_ROOT}`);
  }
}
```
Replace `:26`:
```javascript
// F5 — RUNTIME_SEED_DIRS (csv) generalizes the appliable scope for an arbitrary
// repo. Default unchanged = ["src","public"]. APPLY_DENY/PUBLIC_DENY/CONFIG_GUARD
// are root-relative matchers and need NO change — applyAllowed recomputes relNorm
// against the new root, so the same deny rules apply.
export const SEED_DIRS = process.env.RUNTIME_SEED_DIRS
  ? process.env.RUNTIME_SEED_DIRS.split(",").map((s) => s.trim()).filter(Boolean)
  : ["src", "public"];
```
Update the header comment block (:1-8) to note guards.mjs now reads two env vars + uses fs for fail-closed validation.

- [ ] **Step 4: Run → PASS** (4 tests).
- [ ] **Step 5: Commit** `feat(runtime): RUNTIME_REPO_ROOT + RUNTIME_SEED_DIRS — configurable target repo, fail-closed (F5)`.

---

## Task 2: worktree.mjs — `isGitRepo()` probe (create() untouched)

**Files:** Modify `agent-runtime/worktree.mjs`; extend `test/repo-root.test.mjs`.

- [ ] **Step 1: Failing test (append)**

```javascript
import { isGitRepo } from "../worktree.mjs";
test("isGitRepo: true for a git repo, false for a plain dir", async () => {
  const plain = mkdtempSync(join(tmpdir(), "f5-nogit-"));
  assert.equal(isGitRepo(plain), false);
  assert.equal(isGitRepo(process.cwd()), true); // agent-runtime is inside a git repo
});
```

- [ ] **Step 2: Run → FAIL** (`isGitRepo` not exported).

- [ ] **Step 3: Implement** — add to worktree.mjs (export, same hardened git shape as the internal `git()`):
```javascript
// F5 — cheap probe: is `dir` inside a git work tree? Used at boot to decide whether
// the engine uses worktree isolation or falls back to the copy-sandbox (non-git target).
export function isGitRepo(dir) {
  try {
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", dir, "rev-parse", "--is-inside-work-tree"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(runtime): worktree.isGitRepo() probe for non-git target detection (F5)`.

---

## Task 3: server.mjs — boot assertion, non-git engine fallback, heartbeat guard

**Files:** Modify `agent-runtime/server.mjs`.

- [ ] **Step 1: Import** `isGitRepo` alongside the existing worktree import; ensure `existsSync` is imported (it is, :62).

- [ ] **Step 2: Tmp-root-outside-REPO_ROOT boot assertion** (R2 — fail closed). Add near the SANDBOX_ROOT/TOKEN_DIR definitions (after :140), at module top level:
```javascript
// F5 — the sandbox/token/worktree roots MUST stay OUTSIDE REPO_ROOT (a read-mode
// agent runs with cwd=REPO_ROOT; an in-root token/sandbox would be self-readable →
// self-authorize /apply). Default tmpdir roots already satisfy this; assert it for
// ANY configured root + any operator-set RUNTIME_*_ROOT. Fail closed.
{
  const rootPfx = resolve(REPO_ROOT) + sep;
  const outside = (p, name) => {
    if (resolve(p).startsWith(rootPfx)) throw new Error(`${name} must be OUTSIDE RUNTIME_REPO_ROOT: ${p}`);
  };
  outside(SANDBOX_ROOT, "RUNTIME_SANDBOX_ROOT");
  outside(TOKEN_DIR, "RUNTIME_TOKEN_DIR");
  outside(process.env.RUNTIME_WORKTREE_ROOT || join(tmpdir(), "missionalpha-worktrees"), "RUNTIME_WORKTREE_ROOT");
  if (process.env.RUNTIME_EXEC_WT_ROOT) outside(process.env.RUNTIME_EXEC_WT_ROOT, "RUNTIME_EXEC_WT_ROOT");
}
```
(`sep` + `resolve` are already imported via node:path at the top of server.mjs.)

- [ ] **Step 3: Boot warning if zero SEED_DIRS exist under the root** (R3). After the seed/broker setup (~:461):
```javascript
// F5 — warn loudly if NOTHING is seedable under the configured root (foreign repo
// with a different layout) so an empty sandbox fails loud, not silent.
if (!SEED_DIRS.some((d) => existsSync(join(REPO_ROOT, d)))) {
  console.warn(`[runtime] WARNING: none of SEED_DIRS [${SEED_DIRS.join(", ")}] exist under REPO_ROOT (${REPO_ROOT}). Set RUNTIME_SEED_DIRS to this repo's source dirs, or the agent sandbox will be empty.`);
}
```

- [ ] **Step 4: Non-git engine fallback** (R5). At the engine broker wiring (:859-861), probe once and switch `workdirFor` to the copy-sandbox when the target isn't git:
```javascript
const engineWorktrees = createWorktreeMgr({ repoRoot: REPO_ROOT });
const targetIsGit = isGitRepo(REPO_ROOT);
if (!targetIsGit) console.warn(`[runtime] REPO_ROOT is not a git repo — engine uses copy-sandbox isolation (worktrees disabled).`);
const engineBroker = createBroker({
  repoRoot: REPO_ROOT,
  workdirFor: targetIsGit ? (id) => engineWorktrees.pathFor(id) : sandboxDir,
  scrub,
});
```
And where the engine dispatch creates the per-task workdir (the `engineWorktrees.create(...)` call feeding `ctx.workdir`): when `!targetIsGit`, source the workdir from `seedSandbox(agentId)` (the manual path's copy-sandbox) instead. Locate the create site (grep `engineWorktrees.create` / where `ctx.workdir` is assigned in the engine dispatch) and branch on `targetIsGit`. The apply broker stays identical — only the workdir SOURCE changes.

- [ ] **Step 5: Heartbeat/sync existsSync guard** (R4 / Q4). At reportBack (:467) and the request-handler heartbeat (:955), guard each spawn:
```javascript
if (existsSync(HB)) { try { spawn("bash", [HB, ...], { stdio: "ignore", cwd: REPO_ROOT }); } catch {} }
if (existsSync(SYNC)) { try { spawn("bash", [SYNC, ...], { stdio: "ignore", cwd: REPO_ROOT }); } catch {} }
```
(A foreign repo has no `scripts/agent-*.sh` → skip cleanly instead of spawning doomed bash.)

- [ ] **Step 6: Full suite green + tsc**

Run: `cd agent-runtime && npm test` → 287 + repo-root tests, 0 fail. Confirm NO existing test broke (env unset → guards.mjs identical, assertion uses default tmp roots which are outside → no throw).
Run: `cd /Users/RohitAnandeshi/Downloads/WaahyuFOLDER/MissonAlpha && npm run typecheck` → exit 0.

- [ ] **Step 7: Commit** `feat(runtime): F5 wiring — tmp-root boot assertion, non-git engine fallback, heartbeat guard`.

---

## Task 4: Live check — point at another repo

- [ ] **Step 1:** Boot against WaahyuPython:
```bash
cd agent-runtime
RUNTIME_REPO_ROOT=/Users/RohitAnandeshi/Downloads/WaahyuFOLDER/WaahyuPython \
RUNTIME_PORT=3077 RUNTIME_TOKEN=f5live000000000000000000 RUNTIME_BACKEND=none node server.mjs > /tmp/ma-f5.log 2>&1 &
sleep 2
curl -s -H "x-runtime-token: f5live000000000000000000" http://127.0.0.1:3077/runtime/health | head -c 120
grep -i "SEED_DIRS\|not a git\|WARNING\|OUTSIDE" /tmp/ma-f5.log || echo "(no warnings — git repo with src/)"
```
Expected: health ok; no fatal; if WaahyuPython has `src/` it seeds, else the SEED_DIRS warning fires.
- [ ] **Step 2:** Fail-closed check: `RUNTIME_REPO_ROOT=/no/such/dir node server.mjs` → exits with the clear error (does NOT serve).
- [ ] **Step 3:** Default check: `node server.mjs` (no env) → REPO_ROOT = MissionAlpha, unchanged.
- [ ] **Step 4:** Tear down: `pkill -f "RUNTIME_PORT=3077"`.

---

## Security review (MANDATORY — BLOCKING; boundary change = bigger blast radius)
Dispatch `security-reviewer`. Confirm for ANY root:
1. Containment: `applyAllowed` still blocks `../` escape relative to the NEW root (guards.mjs:51-52 recomputed) — proven by the repo-root test.
2. APPLY_DENY/PUBLIC_DENY/CONFIG_GUARD + symlink/realpath in broker.mjs all re-derive against the new root (they're root-relative) — no widening.
3. Token/sandbox/worktree roots provably OUTSIDE REPO_ROOT (the new boot assertion) — fail closed if an operator nests them.
4. Fail-closed on invalid root (no silent fallback to a wrong/cwd dir).
5. Non-git fallback keeps the SAME apply broker (only workdir source differs) — no boundary bypass.
6. SEED_DIRS env cannot widen past APPLY_DENY (e.g. `RUNTIME_SEED_DIRS=".git"` → still blocked by APPLY_DENY). Verify.

---

## Exit Gate (F5)
- [ ] `RUNTIME_REPO_ROOT=/other/repo` → swarm reads + applies inside THAT repo (live, Task 4).
- [ ] Default (unset) = MissionAlpha, zero behavior change (287 tests untouched).
- [ ] Containment + APPLY_DENY + token-outside-root hold for the new root (tests + security).
- [ ] Non-git target degrades to copy-sandbox (no crash) — isGitRepo test + fallback wiring.
- [ ] Invalid root fails closed (clear error, refuses to boot).
- [ ] Tests green (287 + repo-root), tsc 0; security-reviewer clean; commits per GREEN.

## Self-Review (against F5 spec §183-219 + architect blueprint)
- env REPO_ROOT + exists/dir validation + fail-closed, default unchanged → Task 1. ✔
- SEED_DIRS → RUNTIME_SEED_DIRS csv, deny guards intact → Task 1 + security item 2/6. ✔
- non-git → copy-sandbox fallback → Task 2 + Task 3 Step 4. ✔
- token/sandbox-outside-root invariant → Task 3 Step 2 boot assertion (R2). ✔
- containment `../` blocked vs new root → Task 1 test + security item 1. ✔
- tests: temp root read/apply, escape blocked, token outside, non-git fallback, unset=default → Task 1/2/4. ✔
- R1 env-timing handled (cache-bust dynamic import). ✔
- Placeholder scan: real code per step; one locate-the-site note in Task 3 Step 4 (engine workdir create) — node-specialist greps `engineWorktrees.create`/`ctx.workdir`. ✔
