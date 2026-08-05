# ADR-026 — Git Worktree Isolation (replace seedSandbox copy with branch-per-task worktrees)

- **Status:** PROPOSED
- **Date:** 2026-06-18
- **Slug:** `git-worktree-isolation`
- **Plan:** STAGE 1 — Extend the Engine (gap #9 git worktree isolation)
- **Deciders:** architect, senior-backend-1 (owner), **senior-security-engineer (HARD gate — BLOCKING)**
- **Replaces:** the file-copy sandbox in `seedSandbox` (`agent-runtime/server.mjs` L350) — apply broker (L469) and all guards UNCHANGED

## Context

Today `seedSandbox(agentId)` (L350) prepares an agent's working area by **copying** `SEED_DIRS=["src"]` + `SEED_FILES=["README.md","package.json"]` (L77/78) into `SANDBOX_ROOT/<safeId>` (`/tmp/missionalpha-sandboxes/<id>`, L73), dereferencing symlinks (`cp … {dereference:true}`, L366/370) and skipping symlinks (L357–363). The diff is computed by walking that copy and comparing file contents vs `REPO_ROOT` (`listChanges` L438). Apply re-reads the copy and writes validated paths into the repo (`applyChanges` L469).

This works but is **not a git-state-aware isolation**:

- The copy is a flat snapshot — no branch, no base commit, no `git diff`. Diffing is a manual content walk (L438–466), which can't represent renames/deletes well and re-reads whole files.
- Concurrent steps for the same agentId share **one** sandbox dir (`sandboxDir(id)` L347) — parallel dispatch (ADR-025) would have two `claude` children writing the same copy. Branch-per-task fixes this.
- There is no clean "discard everything this task did" — rollback (ADR-028) currently means deleting a dir.

GAP #9: replace the copy with `git worktree add <path> -b <branch>` **per task**. The worktree gives real git-state isolation (a branch off the base commit), proper `git diff`, trivial rollback (`git worktree remove --force` + branch delete), and parallel-safe isolation per step.

**EXPLICIT, NON-NEGOTIABLE:** the worktree is **git-state isolation only — NOT an execution or security boundary.** Bash/exec stays **OFF** in S1 (that's S3.5). The worktree does not sandbox process execution; the `claude` child still runs with `--allowed-tools Read/Glob/Grep/Write/Edit` and **no Bash** (L570), `--permission-mode acceptEdits` (L575), `--add-dir <worktree>` (L572). The security boundary remains the **apply broker** (`applyAllowed` L401 + `CONFIG_GUARD` L83/420 + `APPLY_DENY` L80 + symlink/realpath checks L496–510) — unchanged.

## Decision

### 1. New module — `agent-runtime/worktree.mjs` (replaces seedSandbox internals only)

```
ADDED   : agent-runtime/worktree.mjs     — create/diff/remove a per-task git worktree
CHANGED : seedSandbox (server L350)      — body swapped to call worktree.create();
                                           signature/return (a working dir path) UNCHANGED
CHANGED : listChanges (server L438)      — diff source becomes `git diff` of the worktree
                                           branch vs base; OUTPUT SHAPE unchanged
                                           ({path,status,before,after}) so /changes is stable
UNCHANGED: applyChanges / applyAllowed / CONFIG_GUARD / APPLY_DENY / symlink+realpath (L401/420/469/496)
UNCHANGED: token/host/origin gates (L107/119/126), MAX_INFLIGHT (L133)
```

`cliReply` (L548) still sets `cwd = sandboxDir(agentId)` and `--add-dir cwd`; the only change is that `sandboxDir` now returns a **worktree path** (per-task, see §3) instead of a copy dir. The agent's view is identical: a directory it can Read/Write/Edit.

### 2. Worktree creation — argv-array `git`, never a shell

```js
// pseudocode — worktree.mjs. spawn ARRAY, no shell:true (same posture as L586/535)
//   git -C <REPO_ROOT> worktree add --no-track -b <branch> <worktreePath> <BASE_REF>
spawn("git", ["-C", REPO_ROOT, "worktree", "add", "--no-track",
              "-b", branch, worktreePath, BASE_REF],
      { stdio: "ignore", cwd: REPO_ROOT });   // each arg = one literal argv token
```

- **`BASE_REF`** = the current `s1-engine` HEAD commit SHA captured at create time (resolved via `git rev-parse HEAD`, not a symbolic ref) so the worktree is a stable base for diffing even if the branch advances.
- `--no-track` + explicit `-b` branch — no upstream tracking, no fetch, fully local.
- The worktree starts as a clean checkout of `src/` + the whole repo tree at BASE_REF. **Scope is still enforced at apply** (only `SEED_DIRS`/`SEED_FILES` paths pass `applyAllowed` L412), so even though the worktree contains the full tree, nothing outside the seeded scope can ever be applied. (Optionally `git sparse-checkout set src README.md package.json` to keep the worktree small — performance only, not security.)

### 3. Branch naming — sanitized, collision-safe (injection-proof)

The branch name is the highest-risk surface: it flows into `git` argv. It is **built server-side from validated parts, never raw user input**:

```js
// pseudocode — worktree.mjs
const safe = (s) => String(s).replace(/[^a-z0-9_-]/gi, "").slice(0, 40);   // same class as safeId L346/531
const branch = `ma/task/${safe(agentId)}/${safe(stepId)}-${randomBytes(4).toString("hex")}`;
```

- Character class is **strictly `[a-z0-9_-]`** — strips every git-refname-illegal and every shell/flag metacharacter (`.. ~ ^ : ? * [ \ space @{ ` and leading `-`). A name can never begin with `-` (prefix `ma/task/` guarantees it), killing flag-injection (`-b --upstream=…`).
- The 8-hex random suffix makes branches **collision-safe** across retries (ADR-028) and parallel steps of the same agent (ADR-025) — each attempt gets a fresh branch + worktree.
- The `worktreePath` is **server-derived** the same way (not from any agent/user string): `join(WORKTREE_ROOT, safe(agentId), `${safe(stepId)}-<hex>`)`.

### 4. Worktree path — OUTSIDE the repo

`WORKTREE_ROOT = process.env.RUNTIME_WORKTREE_ROOT || join(tmpdir(), "missionalpha-worktrees")` — **outside `REPO_ROOT`**, same rationale as `SANDBOX_ROOT` (L70–73) and the token dir (L95–98): an agent's `cwd` is its worktree, so an in-repo worktree could let a read of the worktree reach repo-adjacent state. Tmpdir is never in any agent's read scope. (If a repo-relative location is ever required, it MUST be a `.gitignore`d dir AND added to `APPLY_DENY` — but tmpdir is preferred and is the decision.)

Git's worktree metadata (`.git/worktrees/<name>`) lives under the main repo's `.git` — which is already blocked by `APPLY_DENY` (`/\.git/` L80) and by `applyAllowed`'s top-dir check (L411). No new exposure.

### 5. Lifecycle (create → edit → diff → apply → remove)

| Phase | Action | Maps to ADR-024 state |
|---|---|---|
| create | `git worktree add -b <branch> <path> <BASE_REF>` | `DISPATCHED` (replaces `seedSandbox`) |
| edit | `claude` child writes in worktree (cwd, `--add-dir`, no Bash) | `EDITING` |
| diff | `git -C <path> diff --name-status <BASE_REF>` + per-file before/after → mapped to `{path,status,before,after}` (scrubbed/truncated as L461) | `DIFFED` |
| apply | `applyChanges(agentId, paths)` (L469) — **re-reads worktree file content, re-validates every path** | `GATING`/`APPLIED` |
| remove | `git worktree remove --force <path>` + `git branch -D <branch>` | `DONE`/`FAILED`/`CANCELLED` cleanup |

The **diff now = `git diff` of the worktree branch vs `BASE_REF`**, but `listChanges` keeps the same return shape so `/changes` (L762) and the apply step are unchanged. Apply still reads the file from the worktree path and re-runs every guard — the worktree changing from "copy" to "git checkout" does not alter what `applyAllowed`/`CONFIG_GUARD` permit.

### 6. Cleanup on success / failure / crash

- **Success / failure / cancel:** engine calls `worktree.remove(stepId)` → `git worktree remove --force <path>` then `git branch -D <branch>`. Rollback (ADR-028) is exactly this remove.
- **Crash recovery (startup):** `git -C <REPO_ROOT> worktree prune` + reconcile against engine-store run records (ADR-024 §4): any worktree whose step record is terminal (`DONE`/`FAILED`/`CANCELLED`) is removed; any `ma/task/*` branch with no live worktree is `-D` deleted. Orphan sweep is bounded and idempotent.
- A failed `worktree remove` (e.g. lock) falls back to `git worktree remove --force` then manual dir unlink + `worktree prune`; logged, non-fatal (same fire-and-forget tolerance as `reportBack` L534).

## Security invariant (senior-security-engineer — HARD gate, BLOCKING)

**INVARIANT: the worktree is git-state isolation, NOT an execution or security boundary. Exec stays OFF (no Bash, L570). The apply broker remains the sole gate to the live repo and is unchanged — `applyAllowed` (L401), `CONFIG_GUARD` (L420), `APPLY_DENY` (L80), symlink+realpath (L496–510) all re-run on every apply regardless of worktree.**

| Attack | Vector | Mitigation |
|---|---|---|
| Branch-name injection into git argv | `agentId`/`stepId` crafted as `-b --upstream=…` or `--exec` | name built server-side from `[a-z0-9_-]`-only parts, fixed `ma/task/` prefix (never leads with `-`), argv-array spawn (no shell). Raw input never reaches argv. |
| Worktree escape via `../` in path | crafted path component | `worktreePath` is server-derived from `safe()` parts under `WORKTREE_ROOT`; never from user input |
| Symlink-through-worktree write | agent creates symlink in worktree pointing into repo/outside scope | apply UNCHANGED: `applyChanges` refuses symlink dest (L498) + `realpath(parent)` containment under `REPO_ROOT` (L506); `listChanges` walk skips symlinks (L387). Worktree doesn't relax these. |
| Apply a path outside seeded scope | worktree contains full repo tree | `applyAllowed` top-dir check (L411) + `APPLY_DENY` (L410) unchanged — only `SEED_DIRS`/`SEED_FILES` pass; full-tree worktree changes nothing |
| `.git` tampering via apply | write into worktree's or repo's `.git` | `APPLY_DENY` `/\.git/` (L80) + containment (L408); worktree `.git` metadata under main `.git` already blocked |
| Exec via git hooks in worktree | malicious hook runs on git op | git ops are server-issued (`add`/`diff`/`remove`/`branch`) with `core.hooksPath` set empty (`-c core.hooksPath=/dev/null` on every spawn); agent has no Bash to invoke git itself |
| Worktree base drift / TOCTOU | base ref moves between create and diff | `BASE_REF` pinned to a resolved SHA at create (§2), not a symbolic ref |
| Orphan worktree exhausts /tmp | crashes leave worktrees | startup `git worktree prune` + bounded orphan sweep (§6); per-task removal on every terminal state |

**sr-security HARD sign-off conditions (BLOCKING):** confirm (a) branch + path are built only from `[a-z0-9_-]` server-side parts, never raw input; (b) every `git` invocation is an argv array, no `shell:true`, with `core.hooksPath` neutralized; (c) `applyChanges` and all four guards are byte-for-byte unchanged; (d) `BASE_REF` is a pinned SHA; (e) worktree root is outside `REPO_ROOT`; (f) no Bash tool is added. This ADR may not merge without sr-security sign-off.

## Consequences

**Positive** — real git diffs (renames/deletes handled), parallel-safe per-task isolation (fixes the shared-sandbox problem for ADR-025), trivial deterministic rollback (`worktree remove --force` — ADR-028), stable base via pinned SHA. Apply broker and all guards untouched → F2b posture intact.

**Negative / accepted** — adds a hard dependency on `git` being present and the repo being a git repo (it is — branch `s1-engine`). Worktrees consume disk in /tmp (bounded by per-task removal + prune). Slightly slower create than a flat copy (acceptable). `listChanges` internals rewritten to shell out to `git diff` (output shape preserved, so callers unchanged).

**Observability** — worktree create/remove logged per step; orphan-sweep count at startup; branch name recorded in the engine run record (ADR-024 §4) for traceability.

## Alternatives rejected

1. **Keep the file copy (status quo)** — no git diff, shared-dir collision under parallel dispatch, clumsy rollback. The gap.
2. **Worktree inside the repo** — needs `.gitignore` + `APPLY_DENY` addition for zero benefit over tmpdir; risks an agent's `cwd` touching repo-adjacent state. Outside-repo per existing sandbox/token precedent.
3. **`git stash`/branch in the main working tree** — serializes all agents on one tree; no parallel isolation; pollutes the live checkout. Worktree is the right git primitive.
4. **Treat the worktree as a security/exec sandbox** — it is NOT one; conflating them would invite enabling Bash "because it's isolated." Exec stays OFF (S3.5). Explicitly rejected.
5. **Pass agentId/stepId raw into the branch name** — flag/refname injection surface. Server-side `safe()`-only construction.

## Open questions (need security decision before build)

- **OQ-026.1 (security):** neutralize git hooks via `-c core.hooksPath=/dev/null` per-invocation (recommended) vs a one-time repo config? Per-invocation is more robust against config drift — needs sr-security confirm.
- **OQ-026.2 (security/perf):** use `git sparse-checkout` to limit the worktree to `src/`+`README.md`+`package.json`? Performance only (scope is enforced at apply regardless). Confirm it does not weaken any guard.

---

## As-built (P5, 2026-07-30)

ADR-026 shipped in S1 and was already carrying every task in a real per-task worktree
when P5 opened. P5 changed four things and deliberately did NOT change a fifth.

**1. `release(key)` joins `remove(key)`.** `remove()` ends in `git branch -D`, which is
correct while the worktree is scratch space. Once P5 COMMITS the approved paths to
`ma/task/<id>`, that same call would delete the commit the operator just approved.
`release()` drops the checkout and keeps the ref. It is a separate verb, not a boolean
on `remove()`, so no future caller can lose a commit by passing the wrong flag.
`engine.onOperatorApplied(taskId, { keepBranch })` chooses between them; the default
(no options) is byte-identical to pre-P5 behavior.

**2. Branch naming stayed `ma/task/<taskId>`.** The program plan's P5 sketch said
`ma/<agent>/<slug>`. Renaming would invalidate every existing worktree and branch in
flight, break `safeBranchPart`'s proven fixed-prefix anti-flag-injection property, and
buy nothing — the taskId already resolves to an agent through the queue. NOT adopted.

**3. The degradation ladder (`agent-runtime/pr.mjs`) and the `mode` column.** Approve
now records HOW the work left the runtime: `pr` (remote + authenticated `gh` → push +
`gh pr create --fill`), `branch` (committed locally; no remote, no/unauthenticated gh,
or a failed push/PR), `apply` (no worktree / non-git target / nothing staged → the
pre-P5 direct broker apply). `mode`, `branch` and `prUrl` are DB migration v3. Nothing
is ever recorded optimistically: a failure demotes a rung, it never invents one.

**4. Deviation from the program-plan wording, disclosed.** §P5 said a remote-less repo
gets its branch "merged". The as-built leaves it as a local branch. An unattended merge
into the checked-out branch puts agent output into the operator's working tree with no
reviewer in the path — materially riskier than opening a PR, which is the case the
phase is actually about. BOSS may reverse this.

**5. UNCHANGED, and load-bearing: a worktree is git-state isolation ONLY.** It is not
an execution boundary and not a security boundary. The apply broker
(`applyAllowed` / `CONFIG_GUARD` / `APPLY_DENY` / symlink+realpath) is still the sole
authority on what may touch the repo, and `pr.mjs` re-runs `applyAllowed` on every path
before staging so a path the broker would refuse can never reach a commit either.
`agent-runtime/test/broker.test.mjs` carries a regression test that pins exactly this:
a `package.json` `scripts` change made INSIDE a worktree is still refused.

**6. Credential policy on git invocations (P5 hardening + follow-up).** Every git call
the runtime makes is prefixed with `GIT_SAFE_ARGS` (`agent-runtime/workspace.mjs`),
which includes `-c credential.helper=`. That entry is a RESET: it clears the accumulated
helper list for *every* scope at once — system, global, repo-local, and the URL-scoped
`credential.<url>.helper` form. It is what stops an archive-sourced `.git/config` from
executing a `!command` helper or handing the operator's token to one.

The reset alone was too blunt. `gh auth setup-git` writes the operator's real auth as a
*global* `credential.https://github.com.helper`, and the reset killed that too — so with
an https remote (the common case) `git push` could never authenticate and the ladder
always demoted rung (a) `pr` → rung (b) `branch`, defeating the phase's headline.

As-built: the reset stays on every call, and **the push call alone** re-adds the
operator's GLOBAL helper entries *after* it (`pushCredentialArgs` in `agent-runtime/pr.mjs`).
Git's list semantics — an empty value clears the list, later values append — make the
effective list exactly the global set, so a repo-local hostile helper (which is read
before the reset) can never survive. Values are replayed verbatim as separate argv
tokens, validated (no NUL/newline, no leading `-`) and capped. Read-only, index and
commit calls keep the bare reset with no replay; they never need a credential.
DISCLOSED: a helper configured ONLY in system scope is not replayed, so that setup still
demotes to rung (b). SSH remotes were never affected.
