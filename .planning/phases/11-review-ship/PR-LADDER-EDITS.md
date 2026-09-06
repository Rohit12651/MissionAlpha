# Phase 11 · task 11.0 — THE pr.mjs EDIT PLAN (BOSS GATE)

**APPROVED-BY: BOSS 2026-09-05**
Option A (dedicated job worktree) approved. `agent-runtime/pr.mjs` is CORE_GUARD; these are the
only edits sanctioned by this approval, and a change beyond them re-opens this gate.

---

## Why this gate is not a formality

`pr.mjs` is the runtime's **only outbound write path**: `git commit`, `git push`, `gh pr create`.
Phase 11 adds a second shape to it. Getting it wrong does not produce a failed test — it
produces a commit on a branch you did not expect, or a mutation of the working tree you are
sitting in, with 312 uncommitted files in it.

## The finding that changes the plan

The phase plan says: *"the runtime applies each task's own changed paths … then commits per
task on `ma/job/<id>`"*, and lists as a must-have: *"Operator index hash unchanged across ship"*.

**Those two cannot both be true as written.** Measured, not assumed:

- `broker.applyChanges(taskId, paths)` (broker.mjs:237) copies files from the task's worktree
  into **`repoRoot` — your working tree**. It never runs `git add`, which is exactly why
  `git write-tree == HEAD^{tree}` has held all session.
- Committing those files afterwards requires **staging them**, and staging mutates the index.
  `git commit -- <pathspec>` does not avoid this cleanly either.

So a ship that applies-then-commits would either dirty your index or silently mix Phase 11's
output into your 312 uncommitted files.

## Recommendation — Option A: a dedicated job worktree

Ship never touches your working tree at all.

```
git worktree add <tmp>/job_<id> -b ma/job/<id> <baseSha>
  for each task, in plan order:
      copy that task's changedPaths from its OWN task worktree → the job worktree
      git -C <job worktree> add -- <exact paths>
      assert the staged set == the approved set, else reset and abort
      git -C <job worktree> commit -m <message>
  push + gh pr create (when gh exists), else stop at the branch and say so
```

| | Option A — job worktree | Option B — apply to your tree, then commit |
|---|---|---|
| Your index | provably untouched | mutated; must be restored |
| Your 312 dirty files | never involved | ship output mixes with them |
| Branch base | clean `baseSha` | whatever your tree happens to hold |
| Rollback | delete the worktree | unpick a commit from your tree |
| Cost | one extra worktree per shipped job | none |

**Recommendation: Option A.** The must-have ("index unchanged") is only actually achievable
this way, and it is the only option where a bug in ship cannot reach the tree you work in.

**Consequence you should know:** under Option A, a shipped job's files do **not** appear in your
working copy. They exist on `ma/job/<id>`. That is a deliberate difference from today's
per-task `/apply`, which does land files in your tree.

## The exact edits to `pr.mjs`

Three new exported functions on the object `createPr(...)` returns. `deliverApproved` — today's
per-task ladder — is **not touched**; its tests must stay byte-identical.

### 1. `createJobBranch(jobId, baseSha)`
- Branch name built as `ma/job/${jobId}` and matched against `^ma\/job\/[a-z0-9_]+$`. A jobId
  failing that is refused before any git runs.
- `git worktree add --detach` then `-b`, based at `baseSha` (the job's recorded snapshot sha).
- Refuses if the branch already exists (no reuse, no force).
- Returns `{ ok, branch, worktree, reason }`.

### 2. `commitTask({ jobWorktree, taskId, paths, message })`
- Re-runs `allowed(p)` per path — the SAME predicate the broker uses. One rule, two exits.
- Re-runs the `CONFIG_GUARD` check already in `deliverApproved` (protected `package.json` keys,
  symlink refusal, unreadable-file refusal — all fail closed).
- Copies each approved path from the TASK's worktree into the job worktree.
- `git add -- <paths>` (`--` first, so a path can never parse as a flag).
- **Asserts the staged set equals the approved set**; on drift, `git reset -q` and abort.
- Commits with `-c user.name/-c user.email` as today.
- Returns `{ ok, sha, refused[], reason }`.

### 3. `openJobPr({ jobWorktree, branch, title, body })`
- Only after every task committed.
- `git push -u origin <branch>` — **never `--force`, never any other ref**.
- `gh pr create` invoked as argv, `shell: false`, as today.
- Body passed through the existing `scrub()` before it leaves the process.
- Result validated by the existing `isSafePrUrl()`; a non-GitHub URL is refused and NOT stored.
- Returns `{ mode: "pr"|"branch", prUrl, reason }`.

## Guards — every one already exists in this file

| Guard | Where it comes from |
|---|---|
| path allow-list (`allowed(p)`) | the broker's own predicate, reused |
| CONFIG_GUARD on protected keys | `deliverApproved`, lifted verbatim |
| symlink / unreadable → refuse | `deliverApproved`, fail-closed |
| staged-set == approved-set | `deliverApproved`, lifted verbatim |
| secret scrub on anything outbound | `scrub()` |
| PR URL validation | `isSafePrUrl()` |
| argv-only, `shell: false` | existing `gh.run` contract |
| branch allow-list | NEW — `^ma\/job\/[a-z0-9_]+$` |
| no force-push, no other ref | NEW — asserted by test, not by hope |
| operator index untouched | NEW — `operatorIndexHash()` (server.mjs:1584) asserted before AND after ship |

## When `gh` is absent — which it is on this machine

`gh` is not installed here, so the live proof will stop at **branch only**. That is reported as
`mode: "branch"` with a plain reason, never as a success. The PR rung stays unproven until
`gh` is installed (task 14.0). Stated now so the Phase 11 report cannot quietly claim it.

## What this does NOT do

- No force-push, ever.
- No push to any ref other than the one `ma/job/<id>` branch.
- No commit on your current branch. No commit on `main`.
- No edit to `deliverApproved` or its tests.
- No new dependency.

## Blast radius if approved and wrong

Worst case is a junk commit on a `ma/job/*` branch and an orphaned worktree — both deletable,
neither reaching your working tree, your index, or any shared ref. That is the bound Option A
buys, and it is the reason it is the recommendation.
