---
phase: 12
name: Ash + Board
requirements: [M2-ASH, M2-BOARD]
depends_on: [10, 11]
files_modified:
  - agent-runtime/system-prompt.mjs (TECH_LEAD_BOSS_SYSTEM → ASH_SYSTEM)
  - agent-runtime/mcp/ash-tools.mjs (new; MCP tool `create_job`, approver-gated server-side, like 8.2's mail server)
  - agent-runtime/server.mjs (chat spawn gets the ash MCP config; status answers from GET /runtime/jobs)
  - src/components/board/JobBoard.tsx (new) · src/lib/jobsClient.ts (new) · src/components/bos/StoriesPage.tsx (Job board tab)
  - test/visual (board snapshot 32) · src/lib/__tests__/jobsClient.test.ts · agent-runtime/test/ash-chat-http.test.mjs
autonomous: true
waves: {1: [12.0], 2: [12.1, 12.2], 3: [12.3]}
checkpoints: [12.0]
commit_policy: NO COMMITS until BOSS says
---

<objective>
You talk to Ash and only Ash. Ash creates the Job, tells you where it is, relays the
Manager's one question and one summary. The board is your window: every job, task, worker
and new hire, live, read-only.
</objective>

<skills mandatory="true">
- hallmark → impeccable → taste-skill (UI order per CLAUDE.md) for the board; emil-design-eng for card motion
- sp-test-driven-development · sp-verification-before-completion · code-reviewer · build-mcp-server (12.1)
</skills>

<tasks>
<task id="12.0" name="BOSS gate — Ash is a bot, or Ash is you (BLOCKING)">
Files: docs/superpowers/specs/2026-09-02-manager-loop-design.md (§8 decision recorded), agent-runtime/system-prompt.mjs (header note).
Action: BOSS answers. Bot → 12.1 as written. You → 12.1 becomes "Manager is the chat door": `create_job` is offered directly by the Manager persona and Ash is not created.
Verify: spec §8 has the decision and date.
Done when: recorded.
</task>
<task id="12.1" name="Ash persona + create_job MCP tool" tdd="true">
Files: system-prompt.mjs, agent-runtime/mcp/ash-tools.mjs, server.mjs, test/ash-chat-http.test.mjs.
Action: `ASH_SYSTEM`: plain-English CEO front door; may call ONE tool `create_job({title, brief})` served by a stdio MCP server whose identity/permission is bound server-side (approver session required; rate cap 5 calls/min → 429; an identical brief within 10 min → 409 duplicate; brief ≤ 10 KB scrubbed); answers "where is it" from `GET /runtime/jobs`; relays open question gates and the pending summary verbatim (fenced DATA); never dispatches to workers. Chat runs on the Claude CLI road.
Verify: HTTP with mock: "build me X" → one Job row; a second identical brief within 10 min → 409; a sixth create within a minute → 429; "where is it" → status text matches the Job; a viewer-role session cannot create.
Done when: live: one job created from chat and visible on the board.
</task>
<task id="12.2" name="Job board" >
Files: JobBoard.tsx, jobsClient.ts, StoriesPage.tsx, src/lib/__tests__/jobsClient.test.ts, test/visual snapshot 32.
Action: columns intake · clarify · planned · building · review · awaiting-you · shipped · blocked; a card per task with worker avatar + status; new-hire card = the component 10.2 shipped (reused, not re-implemented); thread drawer shows mail rows (8.3); no drive controls except the existing gate decisions (question, job-approval).
Verify: unit for client parsing; visual snapshot; live: run a job, cards move column to column on SSE without refresh.
Done when: observed and recorded.
</task>
<task id="12.3" name="Phase gate">
Action: contract BEFORE and AFTER; PES report.
Done when: numbers in STATE.md.
</task>
</tasks>

<must_haves>
- The only inputs from BOSS are: the brief, answers to Manager questions, the one yes/no
- Board updates live on every job/task/roster change
</must_haves>

<threat_model>
- `create_job` is approver-gated and rate-limited server-side; the model cannot bypass by argument.
- Relayed questions/summaries are fenced DATA in Ash's context.
</threat_model>
