# Loop repair — design (2026-08-24)

**Problem.** MissionAlpha's stated goal is *idea → Delivery → human decision → branch/PR*.
Measured on the live install this session, that loop had **never completed once**: 53
deliveries, 0 approved code deliveries, 0 branches, 0 PRs, engine queue lifetime `done: 0`
against `failed: 42`.

Three defects produced that, and one root cause connects them.

## Root cause

The engine's baseline was `HEAD`; the operator's reality was a 216-file uncommitted tree.
Everything downstream inherited a false premise.

| ID | Defect | Consequence |
|---|---|---|
| D3 | Task worktrees branch from `HEAD` (Aug 10) while the tree carries 14 days of uncommitted work | agents build against dead code; `broker.listChanges` reports the operator's edits as the agent's, so a Delivery proposes reverting them |
| D1 | The post-edit quality gate runs `node --test` (the WHOLE repo, ~2,500 tests) under a 120 s deadline, on every task | it reached test 328 and was killed — the gate could never pass, so no task ever produced a Delivery |
| D4 | Every dispatch error is classified `spawn` (transient) and retried | a settled refusal (a gate veto, a not-tool-capable account) burned 3 live model turns + 3 container runs to re-derive the same answer, and was reported to the operator under the wrong name |

## Decisions

### D3 — snapshot base, not HEAD (`worktree.mjs`)

The obvious fix is "commit the tree", which the standing operator mandate forbids. So the
base becomes a commit built from the current working tree in a **temporary index**:

```
read-tree HEAD → status --porcelain -z -uall → filter snapshotAllowed → add -A -- <paths>
              → write-tree → (tree == HEAD tree ? HEAD : commit-tree)
```

- The operator's `.git/index`, HEAD, branches and staging area are never touched (pinned by
  a content-hash assertion on `.git/index`).
- Deterministic identity + dates ⇒ an unchanged tree yields the same sha, so the object
  store does not churn per task.
- A **clean** tree short-circuits to HEAD — pre-D3 behaviour byte-for-byte.
- `RUNTIME_WORKTREE_BASE=head` restores the old behaviour; a snapshot fault falls back to
  HEAD **loudly** (`baseMode: "head-fallback"`), never silently.

**Security.** A HEAD-based worktree could only contain committed files, so an untracked
secret was invisible to the agent. A snapshot would carry it into a tree that is
bind-mounted into the test-gate Docker jail. `snapshotAllowed` therefore filters every
candidate **before** staging and is deliberately wider than `broker.APPLY_DENY` (which
matches `.env` exactly and would pass `.env.backup`).

**Performance.** A fresh index has no stat cache, so `git status` re-hashes every tracked
file: 1.97 s per call, per task. The scratch index and its seeded-HEAD marker persist
outside the repo, plus a 1.5 s memo for burst creation. Measured: 6.9 s → 2.65 s per
create, against a 2.45 s floor that is `git worktree add` itself.

### D1 — run the tests that relate to the diff (`test-scope.mjs`, `test-gate.mjs`)

`jest --findRelatedTests` in a pure function: changed paths → related test files, matched
on a **whole stem** (`queue` must not drag in `queueModel`) and restricted to configured
`testDirs` **or** the changed file's own directory (co-located layouts).

Three verdicts, and the difference is load-bearing:

- **targets found** → run exactly those
- **`scope-empty`** → the change has no related tests (a docs edit). Honest pass, recorded
  in the loop steps. Vetoing it is the defect, not the fix.
- **`scope-unknown`** → git said nothing. Never scope on a blind list — fall back to the
  full configured command.

A **timeout** is reclassified by whether we chose the command: on a scoped run it is
evidence about the diff and still vetoes; on an unscoped run it is `gate-timeout-unscoped`,
an infrastructure reason the hook proceeds past unverified. Judging a diff by a suite that
never ran is what killed 42 consecutive runs.

Every scoped argv is re-validated through `quality.mjs validateCmd` (allow-listed binary +
`SAFE_ARG` per element) because targets are agent-influenced filenames.

### D4 — a refusal is not a failure (`self-heal.mjs`, `engine.mjs`)

`classifyDispatchError(code)` maps `HOOK_VETO → gate-veto`, `NOT_TOOL_CAPABLE →
not-capable`, `BACKEND_UNAVAILABLE → backend`, `CHAT_ONLY → chat-only`, all non-retryable.
An unknown or absent code stays `spawn`/retryable — byte-identical to before, because an
unrecognised failure is a reason to retry, not a reason to give up.

## Adjacent defects fixed in the same pass

Driving the loop end to end required these; leaving them would have made "it works" untrue.

- **D5** `stage-retry.mjs` — the story pipeline had no retry at all. One upstream 429 parked
  a story `blocked` forever. Bounded, backed off, transient-only, budget read from
  `story_log` so a restart cannot reset or double-spend it; a declined re-entry is put back
  to `blocked` rather than left `active` with nothing working on it.
- **D6** `StoryAdvance.tsx` — nothing in the app ever called `POST /stories/:id/advance`, so
  a story created in the UI sat at `idea` forever.
- **D7** `queueModel.isQueueEvent` + an updater-form nonce — `lastEvent` is a single value
  slot and SSE delivers bursts in one chunk, so React batching kept only the last frame.
  The strip showed "0 running" beside a claimed task and re-read twice in twenty minutes.
- **D8** doctor `throughput` — every existing check asked about a precondition; all were
  green on an install with 0 done / 42 failed. The report now asks the outcome question.
- **D9** chat `is_error` — session 14 fixed this in the pipeline; the chat path still saved
  the provider's `401` prose into the thread as the agent's own words.
- **Wrong-account credential** — `adapterReply` used `getActiveSecret()` while driving
  `chatRoute.account`'s baseUrl, so a two-account install sent one provider's key to
  another provider's host.

## Not done

A real GitHub PR needs `gh` installed and authenticated as the operator. `gh` is absent and
authentication is theirs to perform, so the approve ladder demotes to rung (b) — commit on
the task branch, honestly reported. That is the boundary, and it is stated rather than
papered over.

---

## Addendum — the three carried-forward gaps (#8, #9, #10)

Closed in the same session, after the loop itself was working. Each was named as a known
gap in the delivery report above; none of them is speculative.

### #8 — a provider circuit breaker (`provider-breaker.mjs`)

`stealth/ox-alpha` rate-limited essentially every call for the better part of an hour.
Backoff existed everywhere and helped nowhere, because every backoff was **private**: the
story pipeline waited per (story, stage), the engine waited per task, chat waited not at
all. Six blocked stories and a queue of build tasks each paid an upstream 429 to learn the
same fact, then all knocked again on their own schedule.

This is the shared memory of "the endpoint is refusing everyone". Deliberately **not**
`breaker.mjs`: that one asks whether an AGENT is misbehaving, this one asks whether an
ENDPOINT is refusing. Different question, different key, different remedy.

- **Only provider weather opens it** — 429, 5xx, overloaded, dropped socket. A 401, a
  missing model id, a bad prompt are settled answers *about us*; a cooldown on those would
  hide a blocker the operator must clear behind a timer that looks like rate limiting.
  Unrecognised errors open nothing.
- **Fail open, always.** Unknown key, malformed outcome, throwing probe → callable. This is
  an optimisation over a shared resource, never a gate.
- A provider-supplied `Retry-After` can only ever *lengthen* the guard.
- Wired: all three adapter legs record; the story sweep checks **once per sweep** (the whole
  point is that the stories share one endpoint); the engine takes the hold as a **floor**
  under its own backoff. Surfaced on `GET /runtime/breaker` (`providers[]`) and as a doctor
  check that names the provider, the wait and the reason.

### #9 — the appliable scope, and the floor under it (`guards.mjs`)

`SEED_DIRS` was `["src","public"]`. On a repo whose product **is** `agent-runtime/`, that
made most self-directed work unappliable by construction — observed live, a build seat
produced a correct file under `agent-runtime/providers/` four times and every one was
dropped as "no appliable diff".

Widened to `["src","public","agent-runtime","docs"]`. Widening without a floor would be a
mistake of a different order, so `CORE_GUARD` is checked **before** the allow-list and is
**not configurable** — no value of `RUNTIME_SEED_DIRS` reaches it:

| Guarded | Why |
|---|---|
| `guards.mjs` | `applyAllowed` itself |
| `broker.mjs` | the only write path |
| `workspace.mjs`, `worktree.mjs`, `sandbox.mjs` | containment and the jail |
| `quality.mjs`, `quality-hook.mjs`, `hooks.mjs`, `test-gate.mjs`, `test-scope.mjs` | what gets executed, and the veto that can stop it |
| `policy.mjs` | deny-by-default auto-apply |
| `secret-scrub.mjs`, `pr.mjs`, `server.mjs` | egress, the push ladder, the auth gates |
| `factory/quality.json`, `factory/deploy.json` | the commands the runtime executes |
| `agent-runtime/data/**` | the Delivery store — a diff replacing it rewrites every decision ever made |

The human approval gate is not a sufficient answer on its own: a diff that quietly relaxes a
predicate is exactly the kind a tired reviewer waves through. **The broker must never be the
tool that edits the broker.**

Two holes the widening opened, both caught by its own tests before shipping:
- `agent-runtime/data/mission.db` became appliable → directory clause added.
- `APPLY_DENY` required `.env` to be followed by a slash or end-of-string, so
  `agent-runtime/.env.local` sailed past it. Tightened to `\.env(\.[^/]*)?`, the same fix
  and the same reasoning as `snapshotAllowed`.

### #10 — collect orphaned worktrees (`worktree.reapOrphans`)

`git worktree prune` clears metadata for dirs that are gone; nothing cleared dirs whose
metadata is gone, which is what a SIGKILL between `create()` and `remove()` leaves. Measured
live: 164 directories, one still claimed.

- A dir a task still claims (queued / claimed / **held**) is kept — a held task's worktree is
  the operator's only copy of the diff they are being asked to approve.
- Uses `release()`, never `remove()`: `remove()` ends in `git branch -D`, and after an
  approve that ref is the only copy of a commit the operator accepted.
- A liveness probe that throws reaps **nothing**.
- Runs at boot, after the terminal-task sweep.
