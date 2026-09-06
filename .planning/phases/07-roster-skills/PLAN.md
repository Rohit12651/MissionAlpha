---
phase: 7
name: Roster + skill lock
requirements: [M2-CATALOG, M2-SSE, M2-ROSTER, M2-SCOPE, M2-TOOLS, M2-SKILLBODY]
depends_on: [6]
files_modified:
  - agent-runtime/factory.mjs (SKILL_CATALOG += ui, api, db, test, notifications; each with a vendored SKILL.md)
  - .claude/skills-curated/{ui,api,db,test,notifications}/SKILL.md (new; RUNTIME_SKILLS_CURATED_DIR, 8 entries today, MAX_CURATED=32)
  - agent-runtime/events.mjs (EVENT_NAMES += roster.changed, job.changed, mail) · src/lib/useRuntimeEvents.ts · the two EVENT_NAMES equality tests
  - agent-runtime/roster.json (new) · agent-runtime/roster.mjs (new)
  - agent-runtime/guards.mjs (applyAllowed(path, {seat}); roster.json added to CORE_GUARD)
  - agent-runtime/broker.mjs (createBroker gains injected `seatFor(taskId)`; refusal reason out-of-scope)
  - agent-runtime/server.mjs (seatFor from queue task → roster; spawn args per seat)
  - agent-runtime/station-skills.mjs (readSkillBodies)
  - src/lib/rosterClient.ts (new) · src/components/board/RosterStrip.tsx (new)
  - agent-runtime/test/{catalog-roster,roster,guards-writescope,spawn-args-seat}.test.mjs + agent-runtime/test/events.test.mjs (existing)
autonomous: true
waves: {1: [7.0, 7.0b], 2: [7.1], 3: [7.2, 7.3], 4: [7.4, 7.5]}
checkpoints: [7.2]  # guards.mjs is CORE_GUARD — BOSS OK recorded in the task header before edit
commit_policy: NO COMMITS until BOSS says
---

<objective>
A worker holds only its domain skills and can only write inside its domain paths — enforced
by the broker, not by a polite prompt. The roster is one JSON file the Manager reads to
assign and HR appends to when it hires. The board shows the roster. Prerequisites the
checker found: the roster skill ids must exist in the governed catalog, and the three new
SSE names must be declared in all four places before anything emits them.
</objective>

<skills mandatory="true">
- security-review — guards.mjs is CORE_GUARD; writeScope is an allow-list beneath CORE_GUARD/APPLY_DENY, never above
- sp-test-driven-development · sp-verification-before-completion · code-reviewer · /review /qa
</skills>

<tasks>

<task id="7.0" name="Skill catalog: add the roster skills" tdd="true">
Files: agent-runtime/factory.mjs (SKILL_CATALOG), .claude/skills-curated/{ui,api,db,test,notifications}/SKILL.md (new), agent-runtime/test/catalog-roster.test.mjs (new).
Action: Add five governed catalog entries in the REAL shape `{id, label, desc, tools, platforms, posting}` (factory.mjs SKILL_CATALOG) mirroring the existing nine (`repo-read, repo-edit, research-brief, data-summary, code-implement-go, code-implement-angular, repo-health-check, workflow-audit, claude-code-handoff`). Each ships a ≤ 6 KB SKILL.md (what the role does, what it must never touch). `notifications` exists only so 10.2 can prove a hire for a skill NOT on the seed roster.
Verify: `factory.SKILL_CATALOG.find(c=>c.id==="db")` truthy; every new id has a SKILL.md; the existing `factory.test.mjs` catalog assertions still pass (update the expected count in ONE place).
Done when: `GET /factory/skills` lists 14 ids.
</task>

<task id="7.0b" name="SSE names: roster.changed · job.changed · mail — declared in all four places" tdd="true">
Files: agent-runtime/events.mjs, src/lib/useRuntimeEvents.ts, agent-runtime/test/events.test.mjs (existing), src/lib/__tests__/useRuntimeEvents.test.ts (the two existing equality tests).
Action: Add the three names to `EVENT_NAMES` and to the client mirror in the same change (STATE.md:213 rule — one coordinated change across all four files). Nothing emits them yet; 7.1, 8.1, 9.1 emit.
Verify: both equality tests green; an `emit("job.changed")` in a unit test is not dropped.
Done when: unit 551+ green with the widened set.
</task>

<task id="7.1" name="roster.json + roster.mjs" tdd="true">
Files: agent-runtime/roster.json, agent-runtime/roster.mjs, agent-runtime/server.mjs (`GET /runtime/roster`), agent-runtime/test/roster.test.mjs.
Action: Schema `{version, members:[{id, name, seat, role:"manager|hr|ceo|worker", skills:[catalogId], writeScope:[glob], tools:[toolName], createdBy:"seed|hr", createdAt}]}`. Seed: Manager (role manager, skills [repo-read], tools Read,Glob,Grep,Bash-ro), HR (role hr), Ash (role ceo), Pikachu [ui] `["src/**/*.tsx","src/**/*.css"]`, Charizard [api] `["src/lib/**","agent-runtime/**"]`, Bulbasaur [db] `["**/migrations/**","**/schema*","agent-runtime/db.mjs"]`, Squirtle [test] `["**/__tests__/**","**/*.test.*"]`. GLOB RULE (stated once): a `**`-rooted glob is accepted by `load()` and is INTERSECTED with SEED_DIRS at match time (`src/x/__tests__/a.test.ts` matches; `node_modules/x/__tests__/a.test.ts` does not because `node_modules` is outside SEED_DIRS); a glob rooted at a literal path must start under SEED_DIRS; worker tools Read,Glob,Grep,Edit,Write,Bash. `load()` validates (ids unique, skills ⊆ catalog from 7.0, globs relative, no `..`, writeScope ⊆ SEED_DIRS, CORE_GUARD paths never in scope), fails closed. `match(skillsRequired)` → workers whose skills ⊇ required, deterministic. `add(member)` atomic write 0600, emits `roster.changed`.
Verify: invalid skill refused; CORE_GUARD path in scope refused; match [db] → Bulbasaur; empty match → [].
Done when: runtime boots reading roster.json; `GET /runtime/roster` returns 7 members.
</task>

<task id="7.2" name="writeScope enforced in the broker, per the TASK's worker seat" tdd="true">
Files: agent-runtime/guards.mjs, agent-runtime/broker.mjs, agent-runtime/server.mjs, agent-runtime/test/guards-writescope.test.mjs.
Action: BOSS OK recorded here before edit (CORE_GUARD). `applyAllowed(relPath, {seat})`: CORE_GUARD → APPLY_DENY → SEED_DIRS → writeScope(seat). `createBroker({repoRoot, workdirFor, scrub, seatFor})`; `seatFor(taskId)` = roster member for `queue.get(taskId).agentId` (injected from server.mjs). Every apply/listChanges resolves the seat from the TASK, so a ship-time apply (11.3) runs as the worker that produced the diff, never as Manager. LEGACY RULE (stated once): when `seatFor(taskId)` is absent, unresolvable, or resolves to a member whose role ≠ `worker` (station/factory agents enqueued via `POST /runtime/engine/enqueue`, pr.mjs single-arg `allowed(p)`, manager/hr/ceo), `applyAllowed` behaves EXACTLY as today (CORE_GUARD → APPLY_DENY → SEED_DIRS). writeScope narrowing applies ONLY when a `role:"worker"` member resolves. Pinned by a test that runs the existing broker/pr/pipeline suites unchanged and a direct single-arg `applyAllowed(p)` call. Glob matcher: prefix + `**` + extension, no new dependency. `roster.json` added to CORE_GUARD.
Verify: Pikachu → `src/lib/x.ts` refused, `src/components/X.tsx` allowed; Squirtle → `src/lib/foo.ts` refused, `src/lib/__tests__/foo.test.ts` allowed; CORE_GUARD wins for every seat; `roster.json` refused for every seat; single-arg `applyAllowed("src/a.ts")` and an unknown seat both allow exactly what today allows (legacy rule). Ratchet proven.
Done when: live: a seat told to edit outside its scope yields a Delivery with that path under `refused[out-of-scope]`, not applied.
</task>

<task id="7.3" name="Per-seat tools and skill bodies in the spawn" tdd="true">
Files: agent-runtime/server.mjs (`buildSeatSpawnArgs(member)` pure), agent-runtime/station-skills.mjs (`readSkillBodies(ids)` reads `<RUNTIME_SKILLS_CURATED_DIR>/<id>/SKILL.md`, default `.claude/skills-curated`), agent-runtime/test/spawn-args-seat.test.mjs.
Action: `--allowed-tools` (the flag the repo already uses ×8 in server.mjs) from `roster.tools`; Manager's Bash restricted to a read-only allowlist via `--allowed-tools "Bash(ls:*)" "Bash(rg:*)" "Bash(git log:*)" "Bash(git show:*)" "Bash(cat:*)"`; `--append-system-prompt` = name + writeScope + SKILL bodies (cap 12 × 6 KB, scrubbed) ; `--setting-sources project` (6.6).
Verify: snapshot of args for Pikachu and Manager; bodies present; cap enforced.
Done when: live loop_steps show a seat citing a rule from its SKILL body.
</task>

<task id="7.4" name="Roster on the board">
Files: src/lib/rosterClient.ts, src/components/board/RosterStrip.tsx, src/lib/__tests__/rosterClient.test.ts, test/visual (snapshot 31).
Action: member cards (name, seat, skill pills, writeScope tooltip); subscribes to `roster.changed`.
Verify: unit for client parsing; visual snapshot with the 7 seed members. The "8th card appears without refresh" proof is 10.2 (HR is the ONLY creator — no dev route that bypasses it).
Done when: unit + visual green.
</task>

<task id="7.5" name="Phase gate">
Action: contract BEFORE and AFTER (dev servers stopped); live proofs 7.2/7.3/7.4 in STATE.md; PES report.
Done when: numbers recorded.
</task>

</tasks>

<must_haves>
- Roster skill ids exist in the governed catalog; roster boots
- The three new SSE names are declared before any emitter exists
- A worker cannot land a file outside its writeScope; apply resolves the seat from the task
- Seats receive SKILL bodies, not names
</must_haves>

<threat_model>
- writeScope narrows, never widens (pinned: CORE_GUARD refused for every seat; roster.json itself CORE_GUARD).
- SKILL bodies are vendored text → scrubbed like artifacts before entering a prompt.
- Manager Bash allowlist is read-only commands only; any other Bash refused by the CLI.
</threat_model>
