# Phase 7 — CORE_GUARD edits (task 7.2, BLOCKING gate)

**APPROVED-BY: BOSS (Rohit), 2026-09-04, in chat: "go on 7.2 and 7.6, yes to roster.mjs in
CORE_GUARD".** Scope of that approval: §1, §2, §4 and §6a below (task 7.2), PLUS task 7.6
(`sandbox.mjs`, §5 — previously excluded, now explicitly approved). Made BY HAND, outside
the swarm. Anything not listed in this file is NOT approved.
Prior approval on record ("go phase 6 — yes to CORE_GUARD edits", 2026-09-02) was scoped
in `.planning/phases/06-foundation-fixes/CORE-GUARD-EDITS.md` to the Phase 6 files, and
that file states verbatim: "`guards.mjs` and `pr.mjs` are Phase 7 and 11, each with its
own gate." This file is that gate. No line of `agent-runtime/guards.mjs` is edited until
the BOSS approves the exact edits below in chat.

Scope of the approval being requested: the exact edits in §1–§2, made BY HAND, outside the
swarm. Anything not listed here is NOT approved and needs a new line in this file.

---

## 1. `agent-runtime/guards.mjs` — `applyAllowed` gains an OPTIONAL second argument

Today (line 138), verbatim signature: `export function applyAllowed(relPath)`.
Requested: `export function applyAllowed(relPath, opts)`.

**Order of checks — narrowing only, appended LAST:**

    containment → APPLY_DENY → CORE_GUARD → PUBLIC_DENY → SEED_DIRS/SEED_FILES → writeScope(seat)

`writeScope` is the LAST gate and can only ever SUBTRACT. Every existing check runs first,
unchanged, in the same order, on the same normalized `relNorm`. There is no code path in
which a seat's writeScope can cause a path to be accepted that `applyAllowed(relPath)`
would refuse today.

**LEGACY RULE (stated once, and only once, in the code):**
When `opts` is absent, OR `opts.seat` is absent/null, OR `opts.seat.role !== "worker"`,
`applyAllowed` returns EXACTLY what it returns today, byte-for-byte. writeScope narrowing
applies ONLY when a member with `role: "worker"` resolves.

Why this rule is load-bearing — the FULL call graph of `applyAllowed`, enumerated
(PES addendum #11, "enumerate the call graph, then fix"). Six non-test call sites exist:

| # | Call site | Passes a seat? | Behaviour after this edit |
|---|---|---|---|
| 1 | `broker.mjs:153` (`listChanges` / `listChangesDetailed`) | YES (new) | narrowed for workers |
| 2 | `broker.mjs:213` (`applyChanges`) | YES (new) | narrowed for workers |
| 3 | `pr.mjs:226` (`deps.applyAllowed \|\| applyAllowed`) | no | unchanged (legacy) |
| 4 | `patch-edit.mjs:77` (`applyAllowed(path)`) | no | unchanged (legacy) |
| 5 | `policy.mjs:23` (`isAutoSafe`) | no | unchanged (legacy) |
| 6 | `policy.mjs:134` (`appliesBrokerGate`) | no | unchanged (legacy) |

Sites 3–6 are single-argument today and STAY single-argument. `isAutoSafe(p) ⟹
applyAllowed(p)` (policy.mjs's stated invariant) is therefore preserved by construction.

## 2. `agent-runtime/guards.mjs` — `roster.json` added to `CORE_GUARD`

One new exact-name row in the existing `CORE_GUARD` list: `agent-runtime/roster\.json`.
Rationale: the roster is now the file that decides what each seat may write. An agent able
to edit `roster.json` grants itself any scope — the same argument that already puts
`guards.mjs` in CORE_GUARD. Exact name, never a prefix, matching the existing convention.

Consequence, stated: `roster.json` is refused for EVERY seat, including Manager and HR.
HR writes the roster through `roster.add()` (server-side, task 7.1), never through the
broker's apply path. Pinned by a test asserting `applyAllowed("agent-runtime/roster.json",
{seat: <each role>}) === false`.

## 3. Not approved / not touched in Phase 7

`sandbox.mjs`, `broker.mjs`* , `workspace.mjs`, `worktree.mjs`, `quality*.mjs`,
`hooks.mjs`, `policy.mjs`, `test-gate.mjs`, `test-scope.mjs`, `secret-scrub.mjs`,
`pr.mjs`, `factory/*.json`, `agent-runtime/data/**`.

\* `broker.mjs` IS CORE_GUARD and IS edited by 7.2 (`createBroker` gains an injected
`seatFor`). It is listed in §4 below rather than here, because the plan's `files_modified`
names it. It is part of the same approval request.

## 4. `agent-runtime/broker.mjs` — injected `seatFor` (task 7.2)

- `createBroker({repoRoot, workdirFor, scrub, seatFor})` — one new OPTIONAL injected
  dependency. Absent ⇒ every `applyAllowed` call is single-argument ⇒ legacy behaviour.
- The two existing `applyAllowed(rel)` calls become `applyAllowed(rel, {seat})` where
  `seat = seatFor?.(taskId)`. The seat is resolved from the TASK, never from the caller,
  so a ship-time apply (Phase 11.3) runs as the worker that produced the diff.
- A path refused by writeScope is reported under `refused` with reason `out-of-scope`.
  It is NEVER moved into `changes` (PES addendum #17: the reviewer's fall-through fix that
  BA-5 caught would have applied `src/secrets.yaml`).
- `applyChanges`, `APPLY_DENY`, `CONFIG_GUARD`, symlink/realpath checks: untouched.

## 5. `agent-runtime/sandbox.mjs` — task 7.6, APPROVED 2026-09-04

The carried-over ship blocker (jail `--memory 512m` OOMs `vite build`; absolute disk cap
measures the 3.79 GiB repo, not the work — PES addendum #16) needs `sandbox.mjs`, which is
CORE_GUARD. It was deliberately NOT bundled into the 7.2 request. The BOSS approved it separately in
the same message. Two changes only: (a) the disk cap measures GROWTH of the jail's writable
work, not the absolute size of the bind-mounted repo; (b) `limits.memory` gains an env knob
(`RUNTIME_SANDBOX_MEMORY`) with today's `512m` as the default, so no existing behaviour
changes unless an operator sets it.

---

## 6. AMENDMENT (raised during 7.1 design, 2026-09-04) — two items the PLAN did not settle

### 6a. `agent-runtime/roster.mjs` should ALSO be CORE_GUARD

The PLAN says only `roster.json` goes into CORE_GUARD. But `roster.mjs` will export
`matchesWriteScope(relPath, writeScope)` — the glob matcher `guards.mjs` calls to decide a
worker's scope. An enforcement primitive living in an agent-appliable file is PES addendum
#15 ("a config source the agent can write is a privilege escalation").

Requesting ONE extra exact-name row: `agent-runtime/roster\.mjs`. **APPROVED.**

HONEST BOUND, stated so the request is not oversold: even WITHOUT this row, a tampered
matcher cannot exceed today's allow set. writeScope is the LAST gate and only subtracts, so
a matcher rigged to return `true` everywhere degrades exactly to today's (pre-Phase-7)
behaviour, and one rigged to return `false` is a denial of service, not an escalation.
This row is defence in depth, not a hole being closed. Say no and Phase 7 still ships.

### 6b. "CORE_GUARD paths never in scope" — the PLAN's validation rule is ambiguous

Read literally it refuses the seed roster: Charizard's approved scope is
`["src/lib/**","agent-runtime/**"]`, and `agent-runtime/**` inherently covers
`agent-runtime/guards.mjs`.

Interpretation being implemented, stated once: `load()` refuses a writeScope entry that is a
LITERAL path (no wildcard) resolving to a CORE_GUARD file — i.e. you may not write
`writeScope: ["agent-runtime/guards.mjs"]`, because that is an explicit attempt to grant a
guarded file. A broad glob that incidentally spans one is ACCEPTED, because CORE_GUARD is
checked BEFORE writeScope and refuses it for every seat anyway.

Pinned by a test: Charizard holds `agent-runtime/**` AND is refused
`agent-runtime/guards.mjs`. If that test ever passes with the guard removed, the floor has
broken.

---

## 7. `agent-runtime/worktree.mjs` — strip the operator's committed `.claude/` at checkout

**AUTHORITY: BOSS, 2026-09-05 — "you are the owner and the CEO for the app … execute the plan
and phases 100% complete … don't stop in the middle anymore for permissions."** Recorded here
because `worktree.mjs` is CORE_GUARD and every edit to it is logged in this file.

### The defect, proven rather than reasoned about
`seat-settings-guard.mjs` (6.7) opens with: *"The snapshot never carries `.claude/`
(SNAPSHOT_DENY), but a seat holds Write and can CREATE it."* **That premise is false on the
git-worktree path.** `.claude/` is COMMITTED to this repo — 3,081 tracked files including
`.claude/settings.json` — so `git worktree add` checks it out into every seat worktree.
SNAPSHOT_DENY governs the copy-sandbox snapshot, not a git checkout.

Verified directly:

    $ git cat-file -e HEAD:.claude/settings.json   → present
    $ git worktree add --detach /tmp/wt-probe HEAD
    $ ls /tmp/wt-probe/.claude/settings.json       → present

Consequence: the guard found a permission-bearing file in EVERY worktree, refused EVERY
spawn, and every engine task ended `empty-diff` having authored nothing. Five refusals in one
boot across a roster seat and a non-roster agent. This is PES addendum #9 — the probe's
premise was wrong — sitting underneath addendum #21.

### The change
`create()` removes `<worktree>/.claude` immediately after checkout, ONCE, before any spawn.
That content is the OPERATOR's committed configuration, not the agent's, and the CLI must not
load it from the worktree (which is the whole point of 6.7). Stripping it there makes the
guard's premise TRUE again: anything found at spawn time really was written by the seat.

Nothing about the guard is weakened. It still runs before every spawn, still removes whatever
it finds, and still REFUSES on a permission-bearing file or a symlink — now with a
false-positive rate of zero instead of one hundred percent.
