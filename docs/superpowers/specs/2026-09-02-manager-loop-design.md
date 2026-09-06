# The Manager Loop — design (2026-09-02)

**Status:** approved by BOSS on the working model page
(`docs/superpowers/specs/2026-09-02-operating-model.html`). This document is the text form
of that page, plus the engineering decisions needed to build it. **No commits** — standing
mandate; the operator decides when to commit.

## 1. What we are building

One door, one boss, a team that talks.

- You hand one job (an epic or story, plain words) to **Ash**, a CEO bot. Ash is the only
  agent you talk to.
- Ash hands it to the **Manager**. The Manager reads the whole ticket AND the code, writes
  the task list, assigns each task to the worker whose skills fit, and manages until done.
- Workers (**Pikachu** UI · **Charizard** middletier · **Bulbasaur** DB · **Squirtle** tests)
  each hold ONLY their domain skills, enforced by the system. They talk to each other for
  handoffs and blockers without going through the Manager.
- When no worker fits, the Manager asks **HR** (agent maker). HR creates one agent with
  exactly the missing skills, it appears on the Kanban board, it joins the roster.
- Work happens in a safe copy, is tested, is reviewed by the Manager, and reaches you as
  **one summary and one yes/no**. Yes → pull request on your repo → ticket updated.
- **Every agent thinks the way Claude Code thinks:** a real `claude -p` session with tools,
  reading files, running commands, iterating until done — not a one-shot prompt.

### Non-goals (v1)
- Jira connector. v1 takes pasted text; Jira in/out is Phase 7.
- Multi-tenant / SaaS / billing. Local, single operator.
- New Business-OS surfaces. The board is the one surface that grows.

### Assumptions (stated, BOSS may overrule)
- **Ash is a bot**, per the "MAIN BOT: Ash Ketchum (CEO)" diagram. Ash = the existing chat
  seat, re-pointed. If BOSS later says "Ash is me", Ash collapses into the Manager door.
- Roster v1 = the four named workers + Manager + HR + Ash. Existing seats
  (`sr-backend`, `sr-frontend`, `pm-analyst`, `architect`, …) are retired from the build
  path, kept as agents for chat.
- Engine road = **Claude CLI** (active account `Claude Max (CLI)`), proven 2026-09-02
  (25 s per task, correct twice). The OpenRouter adapter remains for chat only.

## 2. Architecture

```
 you ──chat──▶ Ash ──job──▶ Manager ◀──mailbox──▶ HR
                              │ assigns (by skill)     ▲
                              ▼                        │ status
            ┌───────────┬───────────┬───────────┬──────┴────┐
            │ Pikachu   │ Charizard │ Bulbasaur │ Squirtle  │   each = claude -p in its own
            │ UI        │ Middle    │ DB        │ Tests     │   worktree, tools on, Bash on
            └─────┬─────┴─────┬─────┴─────┬─────┴─────┬─────┘
                  └───mailbox (peer talk)──┴───────────┘
                              │ diff
                              ▼
   safe copy (worktree) → scoped test gate (jail) → Manager review → Delivery → your yes
                              → commit on ma/task/* → PR (gh) → ticket comment
```

Everything below the Manager already exists in MissionAlpha (worktree, snapshot, broker,
jail, gate, Delivery, approve ladder). The Manager, the mailbox, skill enforcement, HR-by-
Manager and the summary are new. Ash is a re-pointed chat seat.

## 3. Components

### 3.1 Manager (`agent-runtime/manager.mjs`) — the product
A long-lived **claude -p session** (not a one-shot stage) with Read/Glob/Grep/Bash (read-
only Bash: `git log`, `ls`, `rg`, test runners) rooted at a read-only checkout of the repo.
It does not write code. It owns a `Job`:

```
Job { id, title, brief, repo, status: intake|clarify|planned|building|review|awaiting-you|shipped|blocked,
      tasks[], questions[], summary, createdAt }
Task { id, jobId, seat, skillsRequired[], steps[], status, worktree, deliveryId, blockedOn? }
```

Loop, driven by the existing heartbeat:
1. **intake** — read brief; read repo (`README`, layout, package manifests, files the brief names).
2. **clarify** — if essential facts are missing, emit ≤5 questions ONCE → `awaiting-you`.
   Answers land on the Job; resume. Never asks twice for the same fact.
3. **plan** — emit `tasks[]` with `skillsRequired` per task. Validated (bounded, allow-listed
   seats, every task ends in a file change — the `plan-scope.mjs` rules, already shipped).
4. **assign** — for each task, pick the roster member whose `skills ⊇ skillsRequired`. No
   match → mailbox HR (`hire-request {skills, reason}`), wait for `hire-done {agentId}`, then
   assign. Enqueue via `engine.enqueueGoal({agentId, storyId: jobId, steps})`.
5. **manage** — consume worker mailbox: `blocked` → resolve (answer, re-plan, or escalate to
   you as one question), `done` → mark task, unblock dependents. Stall clock **pauses**
   whenever a task is HELD or the Job is `awaiting-you` (fixes defect #2).
6. **review** — when all tasks are DONE/HELD: read every Delivery's diff, re-run the scoped
   gate result, write `summary` {done, notDone, risk, filesChanged, testsRun}. Mint ONE
   `release-approval`-style gate: **Job approval**. → `awaiting-you`.
7. **ship** — on your yes: apply each task's Delivery **path-selectively to the paths the
   worker actually changed** (fixes defect #1 at the consumer), commit on `ma/job/<id>`,
   `gh pr create` if available, post ticket comment. → `shipped`.

### 3.2 Roster & skill enforcement (`agent-runtime/roster.mjs`, `guards.mjs`)
- `roster.json`: `{ id, name, seat, skills[], writeScope[] , tools[] }`. v1 entries:
  Pikachu `skills:[ui]` `writeScope:["src/**/*.tsx","src/**/*.css"]`; Charizard `[api,
  services]` `["src/lib/**","agent-runtime/**"]` (per-repo config); Bulbasaur `[db]`
  `["**/migrations/**","**/schema*"]`; Squirtle `[test]` `["**/__tests__/**","**/*.test.*"]`.
- **Enforced two ways:** (a) the worker's `claude -p` is spawned with `--allowedTools`
  limited to its list and `--append-system-prompt` naming its writeScope; (b) the broker's
  `applyAllowed` gains a per-seat `writeScope` check — a write outside scope is refused and
  reported as `out-of-scope`, never applied. (b) is the real control; (a) is courtesy.
- Skills are the **existing catalog ids** (`factory.SKILL_CATALOG`), and the seat's
  SKILL.md **bodies** are appended to its system prompt (today only names are). Cap 12.

### 3.3 Mailbox (`agent-runtime/mailbox.mjs`) — peers talk
Munder-style, file-based, single-writer: `engine-store/mail/<agentId>/{inbox,outbox}/*.json`.
Message `{ id, from, to, jobId, taskId?, kind: handoff|blocked|done|question|answer|hire-request|hire-done|status, body, at }`.
A worker's `claude -p` gets two tools: `mail_send`, `mail_read` (MCP, via the existing
`--mcp-config`). The router (runtime) moves outbox → inbox on each heartbeat, appends
every message to `story_log` (so the thread shows it), and copies `status`/`blocked`/`done`
to the Manager. Rules: a worker may write to peers and Manager; only Manager ↔ HR; nobody
writes to you except the Manager (via Job questions/summary).

### 3.4 HR (`agent-runtime/hr.mjs`)
Wraps the existing Agent Factory (`factory.createAgent`). Accepts only mailbox
`hire-request` from the Manager. Creates `{name, seat, skills, writeScope}`, persists to
`roster.json`, emits `roster.changed` on SSE, replies `hire-done`. Names come from a fixed
pool (next unused Pokémon) so the board reads consistently. Never creates without a
Manager request; never grants skills outside the catalog.

### 3.5 Ash (a NEW chat seat)
**AMENDED 2026-09-05 by the §8.1 decision — this section's "re-point" language is superseded.**
`TECH_LEAD_BOSS_SYSTEM` is NOT replaced: it is the live persona for seat `boss` and the story
console parses its DISPATCH/TEAM fenced blocks byte-for-byte. Ash is a NEW seat with its own
`ASH_SYSTEM`. Read the rest of this section as describing Ash's behaviour, not a swap.

Ash: takes a job in plain words, creates the `Job`
(`POST /runtime/jobs`), answers "where is it" from Job state, relays Manager questions and
the summary. Ash never dispatches to workers. Chat runs on the same Claude CLI road.

### 3.6 Board (`src/components/board/*`)
Existing Kanban/stories board becomes the **Job board**: columns = Job statuses; a card
per task with its worker avatar; a "new hire" card animates in on `roster.changed`;
mailbox messages render in the task thread. Read-only — driving happens through Ash.

### 3.7 Ship lane — reused, three fixes
- Defect #1: `broker.listChanges` excludes every path `snapshotAllowed` refused, and the
  Manager applies only `task.changedPaths` reported by the worker's own `git status`.
- Defect #3: `RUNTIME_SANDBOX_DISK_BYTES` raised to 1 GiB in `.env`; deploy scoped to the
  changed app.
- Defect #4: `classifyTier` never overrides an explicit tier; intent regexes apply only to
  single-line tasks.
- Seat context: workers spawn with `--setting-sources project` (no `~/.claude` rules).

## 4. Data flow (one ticket)
paste → Ash → `Job(intake)` → Manager reads → `Job(clarify)`?→ you answer → `Job(planned)`
→ assign (HR if gap) → N `engine.enqueueGoal` → workers build, mail each other, gate runs
→ Deliveries HELD → Manager review → `Job(awaiting-you)` + summary gate → your yes →
path-selective apply → commit `ma/job/<id>` → `gh pr create` → `Job(shipped)`.

## 5. Error handling
- Manager turn fails → Job `blocked` with reason; one failure Delivery; retry budget from
  `stage-retry.mjs` (transient only).
- Worker exhausts attempts → Manager gets `blocked`; it re-plans (split task, reassign) once,
  then escalates to you as a question. Never silently retries forever.
- Out-of-scope write → refused by broker, `out-of-scope` mail to Manager, task continues.
- HR cannot create (catalog miss) → `hire-failed`; Manager escalates.
- Your "no" on the Job summary → Job `blocked` with your note as the Manager's next input.

## 6. Testing
- Unit (node:test): Manager state machine (pure, injected dispatch), roster matching,
  writeScope enforcement (`applyAllowed`), mailbox routing rules, HR request validation,
  tier override, stall-clock pause, listChanges exclusion.
- Deterministic loop test (existing `engine-spawner` canned mode): paste → shipped with a
  stub model, asserting each state and every mail.
- Live proof per phase on the running install (Claude CLI road), recorded in STATE.md.
- Regression contract holds before/after every phase: runtime ≥ 2068/0, unit ≥ 551/0,
  vendor 54/0, electron 9/0, visual 30/0, tsc 0, lint 0, build ✓.

## 7. Phases (detail in the plan)
0 Foundation fixes (#1 #3 #4, context diet) · 1 Roster + skill enforcement · 2 Mailbox ·
3 Manager loop (intake→plan→assign→manage) · 4 HR by Manager · 5 Review + summary + ship ·
6 Ash + Board · 7 Jira in/out · 8 Hardening + unattended week.

## 8. Open decisions (BOSS)
1. Ash = bot (assumed) or Ash = you.
   **DECIDED 2026-09-05 — BOSS: Ash = BOT, on a NEW chat seat.** `ASH_SYSTEM` is ADDED
   alongside `TECH_LEAD_BOSS_SYSTEM`, which stays byte-identical: it is the live persona for
   seat `boss` and its DISPATCH/TEAM fenced blocks are parsed byte-for-byte by the story
   console, so replacing it would break a shipped surface. Ash holds exactly ONE tool,
   `create_job`, and is the door for JOBS; the tech lead remains the door for STORIES.
   Rationale: chat wording then never lives in the 9.0 BOSS-gated prompt file, and Ash's tool
   allow-list stays one entry instead of stacking a third action surface onto a persona that
   already carries DISPATCH + TEAM.
2. Per-repo `writeScope` defaults for a NEW app (empty repo): Manager proposes, you approve.
