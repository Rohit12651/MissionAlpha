---
phase: 6
name: Foundation fixes
requirements: [M2-D1, M2-D2, M2-D3, M2-D4, M2-CTX, M2-APPLY]
depends_on: [5]
files_modified:
  - agent-runtime/worktree.mjs (SNAPSHOT_DENY narrowing)
  - agent-runtime/broker.mjs (listChanges excludes snapshot-refused + post-snapshot operator edits)
  - agent-runtime/stage-retry.mjs (stall clock pauses at human gates)
  - agent-runtime/router-tier.mjs (explicit tier wins; intents only on one-line tasks)
  - agent-runtime/server.mjs (claude spawn: --setting-sources; engine/apply decides Delivery + commits)
  - .env (RUNTIME_SANDBOX_DISK_BYTES)
  - agent-runtime/test/*.test.mjs (one file per defect)
autonomous: true
waves: {0: [6.0], 1: [6.1, 6.2], 2: [6.3, 6.4, 6.5, 6.6], 3: [6.7]}
checkpoints: [6.0]  # BOSS sign-off: worktree.mjs + broker.mjs are CORE_GUARD — edited by hand, deliberately
commit_policy: NO COMMITS until BOSS says
---

<objective>
Close the four defects found live on 2026-09-02 plus the two that make the Claude CLI road
expensive and the apply path dishonest. After this phase a seat's Delivery contains ONLY the
seat's own changes, a human reading a diff can never block a story, the ship rung is
reachable, the requested model is the model that runs, and a seat starts with a clean
context instead of 180k tokens of the operator's global rules.
</objective>

<skills mandatory="true">
- security-review — 6.1 and 6.2 touch CORE_GUARD files (worktree.mjs, broker.mjs); block on CRITICAL
- sp-test-driven-development · sp-verification-before-completion — every task; every ratchet proven to FIRE (mutate, watch red, restore)
- sp-systematic-debugging — if any live proof disagrees with the unit test
- code-reviewer agent — per task
- gstack /review + /qa — phase gate
- caveman + headroom — session ops
</skills>

<tasks>

<task id="6.0" name="BOSS gate — CORE_GUARD edits (BLOCKING)">
Files: .planning/phases/06-foundation-fixes/CORE-GUARD-EDITS.md (new).
Action: One page naming the exact lines to change in worktree.mjs and broker.mjs, why, and the invariant each edit protects. BOSS approves in the doc header.
Verify: header says APPROVED with date.
Done when: approval recorded. Nothing in 6.1/6.2 starts before this.
</task>

<task id="6.1" name="Defect #1a — the snapshot deny list catches only secret FILES, never source modules" tdd="true">
Files: agent-runtime/worktree.mjs, agent-runtime/test/worktree-snapshot-deny.test.mjs (new).
Action: ONE rule, stated once: the `credentials|secrets` deny row applies ONLY to paths that are NOT source code, where "source code" = under a source root (`agent-runtime/`, `src/`, `scripts/`, `electron/`) AND ending in `.mjs|.js|.ts|.tsx`. Everything else that row matches stays denied (`credentials`, `credentials.json`, `.credentials` — new explicit row `/(^|\/)\.credentials(\.|$)/i` — `secrets.yaml`, root-level `secrets.js`). Keep every other deny row untouched.
Verify: fixture table of 12 paths — ALLOWED: `agent-runtime/providers/credentials.mjs`, `src/lib/secrets.ts`, `scripts/credentials.mjs`, `src/x.tsx`, `docs/a.md`, `agent-runtime/db.mjs`; DENIED: `credentials`, `config/credentials.json`, `.credentials`, `secrets.yaml`, `secrets.js` and `secret.js` (root, no source root — the row is `secrets?`), `.env.local`. Ratchet proven: revert the rule, watch the `.mjs` row go red, restore.
Done when: a fresh worktree for this repo contains the operator's 16,610-byte credentials.mjs, not HEAD's 8,302-byte copy (assert by size in a live check recorded in STATE.md).
</task>

<task id="6.2" name="Defect #1b — a path the snapshot refused, or the operator edited after the snapshot, is never attributed to the agent" tdd="true">
Files: agent-runtime/broker.mjs, agent-runtime/worktree.mjs (expose `snapshotManifest(taskId)` = {sha, refusedPaths[], snapshotAt}), agent-runtime/test/broker-attribution.test.mjs (new).
Action: `listChangesDetailed` compares worktree → SNAPSHOT COMMIT (not → live operator tree). Any path in `refusedPaths` is dropped and reported under `notAttributed: [{path, reason:"snapshot-refused"}]`. Any path whose live-tree mtime > snapshotAt and whose worktree content == snapshot content is reported `reason:"operator-edited-after-snapshot"`. The Delivery's `changedPaths` are ONLY the agent's own writes.
Verify: fixture repo with (a) a refused file, (b) a file edited in the live tree after snapshot, (c) one agent-written file → changes = [c], notAttributed = [a, b]. Ratchet proven both ways.
Done when: live task on this repo mints a Delivery whose `changedPaths` has exactly the seat's file(s); `credentials.mjs` and `docs/SESSION_MEMORY.md` appear under notAttributed in the Delivery detail.
</task>

<task id="6.3" name="Defect #2 — the stall clock stops at every human gate" tdd="true">
Files: agent-runtime/stage-retry.mjs (createStageRetry gains injected `deliveries.listGates(storyId, kind)` (exists) and `queue.all()` (exists; filtered by storyId in the caller) seams; story-level only — Jobs get their own clock in 9.2), agent-runtime/server.mjs (wire the two seams), agent-runtime/test/stage-retry-human-gate.test.mjs (new).
Action: "no progress" excludes any interval in which (a) a task of the story is HELD, or (b) a pending gate/Delivery exists for the story, or (c) the story is `waiting-you`. Time in those states is subtracted, not counted. Log row `stall-clock-paused {reason}` once per pause.
Verify: injected clock: story HELD for 20 min → no retry; then RUNNING with no steps for 771 s → retry fires. Ratchet proven.
Done when: live: leave a Delivery pending 15 min, story stays `build/active`.
</task>

<task id="6.4" name="Defect #3 — the ship rung is reachable" >
Files: .env (RUNTIME_SANDBOX_DISK_BYTES=1073741824), agent-runtime/deploy-config.mjs (default deployCmd scoped: `npm run build` only when `src/**` changed, else `npm run typecheck`), agent-runtime/test/deploy-config-scope.test.mjs (new).
Action: Raise the cap by env (containment control stays, value is operator-owned). Deploy command chosen from changed paths.
Verify: unit: changedPaths under src → build; under agent-runtime → typecheck. Live: approve a release gate → `deploy-succeeded` → story `shipped`.
Done when: one story reaches `shipped` on the running install — first time ever; recorded in STATE.md with the story id.
</task>

<task id="6.5" name="Defect #4 — an explicit tier is never overridden" tdd="true">
Files: agent-runtime/router-tier.mjs, agent-runtime/engine.mjs (enqueueGoal stores `requestedTier` = the caller-supplied value, `null` when omitted — distinct from DEFAULT_TIER), agent-runtime/server.mjs (engineDispatch ~line 1771: `effectiveTier` only when `requestedTier` is null; CODEMOD path unchanged), agent-runtime/test/router-tier-explicit.test.mjs (new).
Action: `classifyTier(task, {requestedTier})` returns requestedTier when non-null. Intent regexes run only when the task is a single line ≤ 140 chars. Reason strings unchanged otherwise.
Verify: the exact 4-sentence brief from 2026-09-02 with requestedTier sonnet → sonnet; "add a jsdoc comment to foo" (one line) with no requested tier → haiku. Ratchet proven.
Done when: a live task requested at sonnet records `tier: sonnet` in `usage`.
</task>

<task id="6.6" name="Seat context diet + apply decides the Delivery" tdd="true">
Files: agent-runtime/server.mjs (claude spawn args; /runtime/engine/apply), agent-runtime/test/apply-decides.test.mjs (new).
Action: (a) spawn `claude -p` for ENGINE tasks with `--setting-sources project` so `~/.claude/CLAUDE.md`, `~/.claude/rules/**` and the 1,562 skill dirs are not loaded; keep repo CLAUDE.md. (b) `POST /runtime/engine/apply {taskId, paths}` marks the Delivery `approved` with `decidedBy` = session user and `feedback:"path-selective apply: <paths>"`, commits on the task branch via the same ladder `POST /inbox/:id/approve` uses.
Verify: (a) usage row for a trivial task shows `cacheCreationTokens` < 40,000 (was 180,199). (b) after apply: Delivery status approved, `git log ma/task/<id>` shows the commit, Inbox pending count drops by one.
Done when: both observed live and recorded.
</task>

<task id="6.7" name="Phase gate — regression + live proof + report">
Action: Stop dev servers. Full contract. Start servers, verify PID owns :3006. Run one direct task on the Claude CLI road; record: Delivery paths (only the seat's), usage tokens (< 40k), tier honored, apply → commit. PES delivery report with Known Gaps & Risks appended to STATE.md.
Done when: all numbers in STATE.md.
</task>

</tasks>

<must_haves>
- Delivery.changedPaths ⊆ paths the seat wrote (proven by fixture AND live)
- A HELD task or pending Delivery never counts toward "no progress"
- One story reaches `shipped` on the running install
- `usage.tier` == requested tier for an explicit request
- Engine seat cacheCreationTokens < 40,000 on a trivial task
- `engine/apply` leaves the Delivery decided and the commit on the task branch
</must_haves>

<threat_model>
- Narrowing SNAPSHOT_DENY: a `.ts`/`.mjs` file under a source root is git-tracked code that a human reviews; a real secret never lives as `src/lib/secrets.ts`. Root-level `secrets.js` stays denied because it is outside every source root. The fixture pins both sides of that line.
- Raising the disk cap widens the jail's write budget → operator-owned env, not code; doctor reports the value.
- `--setting-sources project` drops the operator's global CLAUDE.md from seats → intended; the seat brief carries what it needs (plan-scope.mjs).
- `engine/apply` gains a COMMIT (today it only `applyChanges` + `onOperatorApplied`, server.mjs:3621): same ladder as `POST /inbox/:id/approve`, branch allow-list `^ma/task/[a-z0-9_]+$`, no push, D3 index content-hash asserted unchanged before/after.
</threat_model>

<exit_gate>
Contract green before/after · every ratchet shown red-then-green · 6.7 numbers recorded · BOSS informed which CORE_GUARD lines changed.
</exit_gate>
