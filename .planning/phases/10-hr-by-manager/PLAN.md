---
phase: 10
name: HR by Manager
requirements: [M2-HR, M2-FACTORY-ROSTER]
depends_on: [9]
files_modified:
  - agent-runtime/factory.mjs (new `createRosterAgent(spec)` path + `validateRosterSpec`; existing createAgent untouched)
  - agent-runtime/hr.mjs (new)
  - agent-runtime/manager-dispatch.mjs + its deterministic fixture (the `notifications` → hire plan from 9.3)
  - agent-runtime/manager.mjs (hire flow: hire-request → park task → hire-done assign → hire-failed escalate)
  - agent-runtime/roster.mjs (add; roster.changed)
  - agent-runtime/server.mjs (HR consumes the Manager's mailbox on heartbeat)
  - src/components/board/RosterStrip.tsx (new-hire card; emil-design-eng for the entrance)
  - agent-runtime/test/{factory-roster-agent,hr,hr-live-http}.test.mjs
autonomous: true
waves: {1: [10.0], 2: [10.1, 10.1b], 3: [10.2, 10.3]}
checkpoints: []
commit_policy: NO COMMITS until BOSS says
---

<objective>
When no roster member has the skills a task needs, the Manager asks HR, HR makes exactly one
agent with exactly those skills, it appears on the board, and it joins the roster. HR talks
to nobody but the Manager. Nothing is created without a Manager request. The factory gains
a roster-member creation path because today's `createAgent` rejects the worker shape
(`ALLOWED_TOOLS={Read,Write,Run}`, `createdBy:"BOSS"` forced, no writeScope/seat).
</objective>

<skills mandatory="true">
- security-review — agent creation is privileged: skills ⊆ catalog, writeScope ⊆ SEED_DIRS and never CORE_GUARD, tools ⊆ roster tool set, names from a fixed pool
- sp-test-driven-development · sp-verification-before-completion · code-reviewer · emil-design-eng (10.2 card motion)
</skills>

<tasks>

<task id="10.0" name="factory.createRosterAgent — a validated path for HR-made workers" tdd="true">
Files: agent-runtime/factory.mjs, agent-runtime/test/factory-roster-agent.test.mjs.
Action: `validateRosterSpec({name, seat, skills, writeScope, tools, createdBy})`: name from `NAME_POOL` only; seat unique; `skills ⊆ SKILL_CATALOG` and ≤ 4; `tools ⊆ {Read,Glob,Grep,Edit,Write,Bash}`; `writeScope ⊆ SEED_DIRS`, no CORE_GUARD path, no `..`; `createdBy ∈ {seed, hr}`. `createRosterAgent(spec)` writes the agent file via the same persistence `createAgent` uses (persona = role text + SKILL bodies), returns the member. `createAgent` (BOSS path) is untouched and its tests unchanged.
Verify: rejects Bash for a non-worker role, rejects `agent-runtime/guards.mjs` in scope, rejects unknown skill, rejects a name outside the pool; accepts Jigglypuff [notifications] `["src/lib/notifications/**"]`.
Done when: green; existing factory tests unchanged.
</task>

<task id="10.1" name="hr.mjs" tdd="true">
Files: agent-runtime/hr.mjs, agent-runtime/server.mjs, agent-runtime/test/hr.test.mjs.
Action: consumes only mailbox `hire-request {jobId, skills[], writeScope[], reason}` from `manager` (any other sender → `mail-refused`). Builds a spec via `validateRosterSpec`, calls `createRosterAgent`, `roster.add` (emits `roster.changed`), replies `hire-done {agentId}` or `hire-failed {reason}`. Idempotent per (jobId, sorted skills) — a duplicate request returns the same agent. Cap: 20 workers total; beyond → `hire-failed cap`. Heartbeat drains HR's inbox.
Verify: refused sender; catalog miss → hire-failed; duplicate → same id; cap → hire-failed; success → roster has member with `createdBy:"hr"`.
Done when: unit green.
</task>

<task id="10.1b" name="Manager side of hiring" tdd="true">
Files: agent-runtime/manager.mjs, agent-runtime/test/manager.test.mjs (hire cases), agent-runtime/test/hr.test.mjs.
Action: implement the `hire()` seam 9.2 left stubbed: on no roster match the Manager mails HR `hire-request {jobId, skills, writeScope (proposed ⊆ SEED_DIRS), reason}` and parks the task as `awaiting-hire`; on `hire-done {agentId}` it assigns that task to the new member and enqueues; on `hire-failed {reason}` it mints ONE `question` gate to BOSS ("no one can do <skills>: reuse <closest member> or skip?") and parks the Job `awaiting-you`; a second identical request for the same (jobId, skills) is not sent (idempotent with 10.1). Stall clock pauses while `awaiting-hire`.
Verify: unit — done → assigned + enqueued; failed → question gate + awaiting-you; cap → same as failed; duplicate → one request; clock paused during awaiting-hire.
Done when: green; 14.1's "+1 hire" assertion has a producer.
</task>

<task id="10.2" name="Live: Manager → HR → new desk on the board" >
Files: src/components/board/RosterStrip.tsx, test/visual (snapshot), agent-runtime/test/hr-live-http.test.mjs.
Action: paste a brief that needs `notifications` (in the catalog since 7.0, on nobody's roster) → Manager `hire-request` → HR creates **Jigglypuff · Notifications** → `roster.changed` → new card animates in (entrance ≤ 300 ms, respects reduced-motion) → Manager assigns the task to it → HELD. HTTP test does the same with the deterministic Manager.
Verify: `roster.json` gains the member; board shows it without refresh; task's `agentId` = jigglypuff; recorded in STATE.md.
Done when: observed live and in the HTTP test.
</task>

<task id="10.3" name="Phase gate">
Action: contract BEFORE and AFTER; PES report.
Done when: numbers in STATE.md.
</task>

</tasks>

<must_haves>
- HR creates only on a Manager request, only catalog skills, only inside SEED_DIRS, never CORE_GUARD
- New hire visible on the board without refresh and persisted in roster.json
- The BOSS `createAgent` path is untouched
</must_haves>

<threat_model>
- Privilege escalation via a wide writeScope → `validateRosterSpec` caps under SEED_DIRS and refuses CORE_GUARD; test pins `agent-runtime/guards.mjs` and `roster.json` can never be in a hire's scope.
- Roster growth / cost → cap 20; Manager must reuse or escalate beyond it.
- Spoofed hire-request → mailbox sender is bound server-side (8.2); HR checks role == manager.
</threat_model>
