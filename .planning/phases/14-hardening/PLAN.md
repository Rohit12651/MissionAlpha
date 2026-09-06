---
phase: 14
name: Hardening
requirements: [M2-LIVE]
depends_on: [12, 13]
files_modified:
  - agent-runtime/test/loop-paste-to-shipped.test.mjs (new; deterministic Manager + deterministic spawner)
  - agent-runtime/doctor.mjs (manager, mailbox, roster, hr checks; throughput += jobs/7d)
  - agent-runtime/kpis.mjs + src/components/bos/StatTiles.tsx (PRs shipped this week)
  - docs/operating-model.md (operator guide: paste → PR in 8 steps)
  - .planning/STATE.md
autonomous: true
waves: {1: [14.0, 14.1, 14.2], 2: [14.3], 3: [14.4]}
checkpoints: [14.0]
commit_policy: NO COMMITS by the agent — BOSS decides the milestone commit at 14.4
---

<objective>
Prove the milestone: a deterministic end-to-end test of paste → shipped that runs in CI,
doctor checks that name the Manager loop's health, a PRs-per-week number on the board, and
one unattended week on Waahyu with the target met.
</objective>

<skills mandatory="true">
- security-review — final pass over every write path added in 7–13 (writeScope, mailbox, HR, ma/job commits, PR, Jira)
- sp-verification-before-completion · /qa · /review
</skills>

<tasks>
<task id="14.0" name="BOSS gate — gh installed and authenticated (BLOCKING)">
Action: BOSS runs `brew install gh && gh auth login` (the agent never performs logins). Without it 14.3 measures branches, not PRs, and says so.
Verify: `gh auth status` → logged in; `doctor.gh` → ok.
Done when: doctor green.
</task>
<task id="14.1" name="Deterministic loop test" tdd="true">
Files: agent-runtime/test/loop-paste-to-shipped.test.mjs.
Action: boots the server with `RUNTIME_MANAGER_DISPATCH=deterministic` + `RUNTIME_ENGINE_SPAWNER=deterministic` + stubbed `gh`; paste → question gate → answer → planned (2 tasks + 1 hire) → building → both HELD → review → job-approval → typed approve → shipped; asserts every Job status in order, every mail row, roster gained the hire, 2 commits on `ma/job/<id>`, PR stub called once, operator index hash unchanged.
Verify: `node --test agent-runtime/test/loop-paste-to-shipped.test.mjs` green in < 60 s; added to `test:runtime`.
Done when: green in the contract run.
</task>
<task id="14.2" name="Doctor + KPI" tdd="true">
Files: agent-runtime/doctor.mjs, agent-runtime/kpis.mjs, src/components/bos/StatTiles.tsx, agent-runtime/test/doctor-manager.test.mjs, src/lib/__tests__/kpiClient.test.ts.
Action: doctor checks `manager` (last tick age < 2× heartbeat), `mailbox` (undelivered < 50), `roster` (validates), `hr` (cap headroom); `throughput` gains `jobsShipped7d`; KPI tile "PRs shipped this week" from `jobs.status='shipped' AND prUrl IS NOT NULL`.
Verify: unit both ways (fail → ok after a completion); tile renders the number.
Done when: green and visible.
</task>
<task id="14.3" name="Unattended week on Waahyu">
Action: Monday: 5 jobs pasted (target repo = Waahyu). BOSS only answers Manager questions and approves summaries. Record daily: jobs shipped, PRs, human minutes, incidents (any operator-tree change = incident), stall false positives.
Verify: ≥ 5 shipped as PRs, 0 incidents, stall false positives 0, all suites green Friday.
Done when: the table is in STATE.md.
</task>
<task id="14.4" name="Milestone report + commit decision">
Action: contract BEFORE and AFTER; PES delivery report with Known Gaps & Risks; STATE.md; BOSS decides the commit.
Done when: report delivered.
</task>
</tasks>

<must_haves>
- ≥ 5 jobs shipped as PRs in one week, zero operator-tree incidents, all suites green
- The whole loop runs in CI with no model
</must_haves>

<threat_model>
- Final security-review over roster/writeScope/mailbox/hr/ma-job-commit/PR/Jira before the week starts; any CRITICAL blocks 14.3.
</threat_model>
