# MissonAlpha — memory

Facts about this codebase. Rules live in CLAUDE.md; progress lives in STATUS.md.

## Generated inventory

<!-- LOGBOOK:GENERATED start - do not edit by hand -->

_Produced by `~/.claude/scripts/logbook-scan.sh` on 2026-09-19 13:51 CDT at commit `85796ae`. Re-run it rather than editing these numbers._

### JS/TS packages

| Package | Version | Runtime deps | Scripts |
|---|---|---:|---|
| `deps` | - | 0 | - |
| `missionalpha-agent-runtime` | 0.1.0 | 4 | start, test |
| `missionalpha` | 1.0.0 | 9 | build, dev, doctor, electron:build, electron:dev, gen:skills |

### Entry points

- `package.json`

<!-- LOGBOOK:GENERATED end -->


## Curated notes

Durable facts, learned the expensive way. Progress belongs in STATUS.md.

### Visual parity harness (test/visual/tab-audit.spec.mjs, opt-in `TAB_AUDIT=1`) — 2026-10-02
- `FREEZE_CSS` hides every `<canvas>`: a canvas "rendering 0×0" in an audit capture is the probe, not the app.
- `installHermetic` sets `ma.onboarded.v1`; first-run tests must use `FIRST_RUN_BRIDGE_JS` (parity-fixtures.mjs) and remove the flag.
- Playwright matches routes newest-first: an override registered BEFORE the fixtures loses. Use `openFirstRun`'s `before`.
- The `webServer` builds the app before each run: a mutant that does not compile proves nothing (build exits 2). Use type-safe mutants.
- A data-delta mask counts only after the probe shows it hits the same element in both captures (`probeMasks`). Hidden text still sizes its column — collapse it (font-size 0) in both.
- Since 2026-10-02 the audit is a GATE (`npm run test:parity`): every frame is journalled, then a NO-MATCH outside `PARITY_ALLOWLIST` (test/visual/parity-gate.mjs) fails, and so does an allowlisted frame that now MATCHes.
- The visual harness hashes `src/` + index.html + tailwind/postcss configs (scripts/lib/build-id.mjs) and fails every frame with STALE BUNDLE if they change mid-run. Never edit `src/` while a visual run is in flight.

### Runtime facts
- `runtimeToken()` (src/lib/runtimeBase.ts) caches a good token for the window's life and retries after a failure; a token the runtime ROTATES while the window is open is still served stale (not handled).
- `RUNTIME_TOKEN_DIR` must agree between root `.env` (Vite/Electron) and `agent-runtime/.env`; when they differ, every token-gated call 401s and the Agents page draws nothing.
- `validateWorkspace` (agent-runtime/workspace.mjs) expands a leading `~`/`~/` to the home dir since 2026-10-02; `~user` is not expanded. Every path check runs on the expanded path.
- `authedJson` returns the body on a 400 and throws `HTTP n` otherwise; `POST /runtime/workspace` answers `{ok, error?, repoPath (realpath), restartRequired, envPinned}` — REPO_ROOT never hot-swaps.

**Nothing under `agent-runtime/` is appliable by an agent except its two test dirs.**
`RUNTIME_FLOOR` (guards.mjs, decision #1, 2026-09-27) sits in `applyAllowed` after CORE_GUARD, so a
seat whose scope says `agent-runtime/**` (sr-backend) can land tests only — a job that needs runtime
code will produce refused diffs. Runtime code is a hand edit. CORE_GUARD's named rows still matter:
`fatalScopeProblem` rejects a literal CORE_GUARD scope entry. The exemption holds only while no
runtime module imports from a test dir (RTF-4) and symlinks cannot redirect a write (RTF-7).
The live server does real work on boot: its cadence tick dispatches seats at once. Since 2026-09-27
every claude/engine child is spawned DETACHED through `seatChildren.spawnSeat` (seat-children.mjs) and
SIGTERM/SIGINT kills every live group then exits synchronously — so a stopped server leaves no orphan
and the in-flight task row is left for the P4 reconcile. A SIGKILL to the server still orphans them.
Beware: 12 server-booting tests share the LIVE `agent-runtime/engine-store/` (no RUNTIME_ENGINE_STORE),
so a test run can plant tasks the real runtime then executes (chip filed).

**Seats get ONE model turn per task — "waiting" is a runtime state, not something a seat does.**
A seat that asks a peer ENDS its turn with no diff; the engine reads that as `empty-diff` and
retries. So a question needs four runtime pieces, all in `manager.mjs`: record it on the asker
(`questionTo`), hold the asker `awaiting-answer` and cancel its live attempts (`cancelGoal`),
give the ANSWERER a `replyOnly` turn if it has none of its own, and resume the asker once with
the answer fenced into its brief. `awaiting-answer` also keeps its write scope reserved in
`dispatchNext`, or the resume becomes a second writer. Proven live by run 9.

**An answer is matched on (job, asker, answerer), never on a message id.**
A seat never sees mail ids (`mail_read` shows `from` and `kind`), so it cannot quote one back.
The mailbox's CC copy to the Manager carries `origTo`; the asker is the question's sender; the
job is the seat's bound mail env. All three are unforgeable. A peer that answers BEFORE it is
asked is held on the recipient keyed to `answerFrom`, and only satisfies a later question put to
that same peer.

**The Manager's inbox is read in id order, so a CC copy's id is `<original>-cc`, never a new ulid.**
A fresh ulid stamps route time, which reorders a copy after later messages from the same sender
(live run 7: a seat's `blocked` was read before the question that caused it).

**A live-run harness must CARRY the account and its key, and verify it at /runtime/health first.**
`accounts.json` lives in `RUNTIME_TOKEN_DIR` and is encrypted with `cred.key` beside it. An
isolated run with a fresh token dir has `activeAccount: null`, and every worker task fails
`not-capable`. The harness also sources `RUNTIME_SANDBOX_DISK_BYTES` from `.env`. Kill run
servers by the PID recorded at start, never by pattern.

**A dependency stored as a task NUMBER dies at the next re-plan.**
The planner declares `dependsOn` as 1-based task numbers, and a re-plan REORDERS the rows —
`manager.mjs` maps `out.order` onto the existing tasks and hands them back to `setTasks`, which
re-mints every id. A stored number would then name whatever task landed in that position: a
graph that still validates and means something else entirely. `jobs.setTasks` mints all ids
first and resolves both shapes against that batch — a NUMBER (fresh plan, by position) and a
STRING (re-plan, the id the row already held). The column holds ids, never numbers.

**A gate that reads the whole file cannot fail when the file keeps its own history.**
`MP-GATE` asserted the source matched `APPROVED-BY: BOSS <date>`. `manager-prompts.mjs` keeps
every prior approval in its header as history, so a granted line from 2026-09-05 satisfied the
test while the GOVERNING line at the top said `_PENDING BOSS_` — green through all of Phase C,
and cited as evidence twice. The governing approval is the FIRST one; anything below it
describes older text. Same shape as addendum #5, one level up: the ratchet was never watched
firing, because it could not.

**Parallelism is granted only where it is proven, never where a check merely failed to refuse.**
`scopesDisjoint` compares the literal prefixes of two globs, which is sound in one direction
only: two globs that both match some path must have prefixes where one contains the other, so
the test can say "collide" for scopes that would never have met, but never "disjoint" for two
that would. Everything unreadable — a missing seat, an empty scope, a seat whose role is not
`worker` and is therefore NOT narrowed by `writeScope` at all (`guards.mjs` applyAllowed) —
returns "collide", which is Phase C's sequential behaviour. An install that migrates and
changes nothing else behaves exactly as it did.

**Isolating a live run takes TWO overrides for the roster, not one.**
`RUNTIME_ROSTER_FILE` governs the roster JSON; `RUNTIME_AGENTS_DIR` governs the persona
`.md`. `factory.mjs:62` defaults the latter to `join(REPO_ROOT, ".claude", "agents")` where
`REPO_ROOT` is the MODULE's own location, not `RUNTIME_REPO_ROOT`. Set only the first and a
hire writes a seat file into this repo while pointed at another one (C31).

**The exec jail image comes from `.env`, and the tests depend on it.** `.env` pins
`RUNTIME_SANDBOX_IMAGE=node:24-alpine`; node 24 strips TypeScript types by default, so the
unit-test gate can run this repo's own `.ts` tests. Boot without sourcing `.env` and the jail
falls back to the module default `node:20-alpine`, which cannot load `.ts` at all — and which
*rejects* `--experimental-strip-types` outright rather than ignoring it. `gate-jail-languages.test.mjs`
exists precisely to pin this. Do not "fix" it in `quality.mjs`: the `--experimental-*` ban there
is deliberate.

**Scopable must imply appliable.** `applyAllowed()` decides what the broker will land;
`validateRosterSpec` decides what a seat may be scoped to. They disagreed — the broker applied
root-level files, the validator refused to grant them — which stranded a hire on a task it could
never write. Any change to one belongs in the same edit as the other (C28).

**A job with commits on its branch must never be routed back to `planned`.** The PLAN stage
calls `jobs.setTasks`, which REPLACES every row. Under commit-as-you-go those rows own real
commits on `ma/job/<id>`, so replacing them orphans work the job then redoes (C30). `resume()`
and an approved gate both set `planned`; the guard lives in the plan branch for that reason.

**The engine's own trace is the only way to diagnose a stalled task.** `engine.mjs` had exactly
one `console.warn` in the whole file until C23; it now emits `task-dispatch` / `task-watchdog` /
`task-failed`, and `/runtime/health` carries `engine.inFlight` (every task the process believes
it is running, with its age). A row that is `claimed` with no entry there is an orphan.

**`node --test` inside a `node --test` child refuses to run anything.** It warns
"run() is being called recursively" and exits 0 having executed nothing — a green that proves
the opposite of what it claims. Strip `NODE_TEST_CONTEXT` from the child env when a test
spawns the test runner.

**`manager-prompts.mjs` carries an approval gate.** A material edit to any prompt re-opens it:
the header line goes back to `_PENDING BOSS_` and `MP-GATE` enforces that the file says so.
Live runs must not start while it is pending.

**The ship ladder copies bodies; it never merges.** `pr.mjs commitTask` reads each approved
path's BODY out of the task worktree and writes it into the job's assembly worktree, then
commits there. Two tasks touching disjoint paths therefore commit cleanly in any order with no
merge and no rebase — and two tasks touching the SAME path silently revert each other, with no
conflict marker, because nothing ever merges. Any parallel-dispatch design has to prevent that
collision rather than resolve it.

### Phase E facts (2026-09-24)

- **`applyAllowed(p, { seat, strict })`.** `strict` refuses ONLY an unresolved seat. It is on for the
  engine broker and both pr.mjs ladders (`commitTask`, `deliverApproved`), which resolve the seat
  from the task via `engineQueue.get(taskId).agentId → roster`. A resolved non-worker seat
  (station/manager) still gets the legacy set — open BOSS decision. The legacy single-argument
  callers are pinned by file in `test/guard-strict.test.mjs` GUARD-2; a new one turns it red.
- **Consequence:** `/runtime/engine/enqueue` for an agentId not on the roster ends refused
  (`no roster seat resolved for this task`), not held. Tests that need an engine task to land
  must use a real worker seat (tier-dispatch now uses `sr-frontend`).
- **Two `REPO_ROOT`s.** guards.mjs's follows `RUNTIME_REPO_ROOT` (the target); factory.mjs's is
  `resolve(__dir, "..")` — always the runtime's own repo. Check which one a site uses.
- **`repo-scripts.mjs` is the one trust decision for "may the target repo's code run on the
  host":** repo scripts AND the chat spawn's setting sources (`--setting-sources user` on an
  untrusted target). Trusted = target is MissionAlpha, or `RUNTIME_ALLOW_REPO_SCRIPTS=1`.
- **`claude -p` skips workspace trust** (docs, security page). Any `-p` spawn whose cwd is a
  foreign repo loads that repo's `.claude/settings.json` hooks unless setting sources exclude
  `project`/`local`.
- **Deny regexes carry `iu`.** Without `u`, `i` folds ASCII only, and APFS treats `guardſ.mjs` as
  `guards.mjs`.
- **Claude CLI sandbox (for Task 18):** `--settings '{"sandbox":{"enabled":true,
  "allowUnsandboxedCommands":false,"failIfUnavailable":true}}'`; Seatbelt/bubblewrap; covers Bash
  + children only, not Read/Edit/Write tools. Design: `docs/superpowers/specs/2026-09-24-worker-jail.md`.
- **Worker jail (built):** `worker-jail.mjs`; readiness JSON has `workerJail` and `warnings`. MissionAlpha itself
  runs unjailed by default; every other target (including /tmp clones used for live runs) is jailed.
- **Manager on an untrusted, non-git target refuses every claude-mode stage** (no isolated worktree ⇒ no spawn).

### Phase F · step 20 facts (2026-09-24)
- Job flow: intake → **strategy** → clarify → (awaiting-you) → planned → building → review → awaiting-you → shipped.
  `summary.strategy = {verdict, why, costs, cheaper, assumes}` survives every later status.
- The CEO persona is read from the RUNTIME's `.claude/agents/ceo.md`, never the target's. Missing ⇒ the job blocks.
- `STRATEGY_PROMPT_APPROVED` (manager-prompts.mjs) gates claude-mode strategy; flip it WITH the header line (REV-8).
- `onGateDecided` and `POST /runtime/jobs/:id/answer` act only on a job in `awaiting-you` (addendum #78).
- `resume()`: never judged + no tasks → strategy; unasked questions → clarify; else planned.
- Board card captures (shipped/defer/strategy, blocked-detail) are byte-identical across themes — pre-existing:
  the board renders one palette. The per-theme duplicates add no coverage.

### Security facts (2026-09-24, night)
- `deferAnswer` accepts ONE token from closed yes/no sets after NFKC + quote normalisation; anything else → 400.
- `/runtime/jobs/:id/answer` requires status awaiting-you AND an open question gate; bulk-decide never approves a
  job question gate. A single Inbox Approve on one still advances without answers (known, pre-existing).
- `configGuardKeys(path)` guards EVERY package.json (basename, NFKC). Lockfiles/.npmrc/.yarnrc/.pnpmfile are APPLY_DENY.
- `GIT_SAFE_ARGS` empties `diff.external`: a CONTENT diff must add `--no-ext-diff` or git dies (addendum #80).
- pr.mjs `safeEnv()` exports GIT_SAFE_ARGS as GIT_CONFIG_* (applied BEFORE `-c`, so credential replay still wins).
- test/git-safe-census.test.mjs fails on any new literal `"git"` spawn without `...GIT_SAFE_ARGS` first.
