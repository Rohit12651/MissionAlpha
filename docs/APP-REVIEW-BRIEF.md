# MissionAlpha — review brief

Written 2026-09-16 for an external reviewer (Codex) with no prior context.
Every number here was recomputed from the repo on the date above, not copied
from an earlier document. Where something is unproven, it says so.

---

## 1. What the app is, in plain English

MissionAlpha is a desktop app that lets one person run a software team made of AI agents.

You paste in a job — "fix this bug", "add this feature", a Jira ticket. A Manager agent
reads it, reads the actual repository, asks you one round of questions, writes a plan,
hands pieces of the work to specialist agents, collects what they produce, and comes back
to you with one summary. You say yes once. It opens a pull request.

The point is the gap between those two moments. Between "here is the job" and "here is the
PR to approve", nobody should have to touch it. That is the whole product thesis.

It is a local app. Runtime on `127.0.0.1:3005` (Node 20, ESM, SQLite in WAL mode, server-sent
events for the live feed), React 19 + Vite UI on `:3004`, packaged with Electron. Nothing is
hosted. Your code never leaves the machine except when you push a branch.

## 2. The route a job takes

```
you paste a job
  ↓
intake        Manager reads the repo, works out what is true
  ↓
clarify       asks ONCE, as a single gate
  ↓
awaiting-you  ← your first stop: answer the questions
  ↓
planned       plan validated, seats matched BY SKILL (never by name)
  ↓
building      workers work; Manager drains its inbox: done / blocked / out-of-scope
  ↓
review        every task accounted for, one summary written
  ↓
awaiting-you  ← your second stop: the one yes
  ↓
shipped       apply → ma/job branch → gh pr create
```

`blocked` is reachable from every live state. An operator or the Manager can push a blocked
job back to `planned` or `building`. Nothing leaves `shipped`.

Source: `agent-runtime/jobs.mjs` (state machine), `agent-runtime/manager.mjs` (the loop).

## 3. Who is in the org

Twelve seats in `agent-runtime/roster.json`. Roles are `ceo`, `manager`, `hr`, `station`, `worker`.

The routing table is by ROLE, not id, so a new hire cannot widen it (`mailbox.mjs`):

```
worker  ↔ worker
worker  ↔ manager
manager ↔ hr
system  → manager      (the runtime reports terminal task outcomes; narrowest rule in the table)
ceo     — refused on both ends
```

The human operator is `boss`. Today `boss` is *displayed* as the `ceo` card — one person,
two labels — and the `ceo` role is refused by the mailbox precisely because it is you.
**This is mid-change.** See §7.

The Manager is `tech-lead`. It is the only sender HR obeys (`hr.mjs:73`).

## 4. What was actually built

Two milestones. Both are committed; see §6 for what is proven versus merely present.

**Milestone 1 — the engine room (phases 1–5).** Lifecycle hooks, cadence workers, model-tier
routing, a `doctor` self-audit command, a learning loop that stores success signatures,
vault retrieval, cross-model review (the review stage runs on a different provider than the
build stage), skill prompt budgets, a metaharness, trust scoring, PII scrubbing, prompt-injection
heuristics, encryption at rest, anti-drift stall detection, and graph ranking for retrieval.

Phase 5 ("loop repair") is the one with a recorded, met exit criterion: a task reaches HELD
with a diff containing only the agent's own work; approve → apply → commit lands on the task
branch; a story walks idea → requirements → design gate → plan → build from the UI; a transient
provider failure retries with no human involved.

**Milestone 2 — the manager loop (phases 6–14).** This is the product described in §2:
per-seat write scope enforced at the broker, a file-based mailbox with `mail_send`/`mail_read`
tools and a role router, the Job/Task store and the Manager state machine, HR that can hire a
new seat on the Manager's request, a review-and-ship path with a job-approval gate and
path-selective apply, a chat seat, a job board, a Jira connector, and hardening.

Scale, counted today:

| | |
|---|---|
| Runtime modules | 91 files, ~70,600 lines (`agent-runtime/*.mjs`) |
| UI | 189 files, ~35,400 lines (`src/**/*.ts,tsx`) |
| Test files | 206 |
| Production dependencies | 9 (React, Three.js, framer-motion, lucide, recharts) |
| `agent-runtime/server.mjs` | 6,768 lines, 396 KB — one file |

Nine production dependencies for a system this size is deliberate. A standing rule for the
whole program was: adopt patterns, never implementations, never dependencies.

## 5. What we tried to build and did not finish

This is the section most worth your attention.

**The unattended week never happened.** The milestone's exit criterion is five jobs pasted on
Monday, shipped as PRs by Friday, zero incidents, suites green. It has never been run. Until
very recently it *could not* be run: no LLM account was active, and 974 of roughly 1,084
queue failures were that single cause. An account is active now (verified against the engine's
own readiness predicate — `standing: runs` on the `cli` and `api` backends), so the week is
possible for the first time. It is still untried.

**Most seats cannot write anything.** Of 12 roster members, 3 have a write scope: `sr-frontend`
(`src/**`), `sr-backend` (`src/lib/**`, `agent-runtime/**`), `qa` (test globs). Seven seats with
worker-ish roles — `pm-analyst`, `architect`, `reviewer`, `devops`, `sre`, `docs-writer`,
`java17-engineer` — have none. The Manager assigns by skill, so a correct skill match can land
work on a seat whose diff the broker then refuses wholesale. That is the source of the
`EMPTY-DIFF ... OUTSIDE the appliable scope` failures in the live queue.

**The live Jira half is unproven.** The connector works against a fake Jira. It has never been
pointed at a real instance. Paging past the first page of results is written but never exercised.

**A rejection does not re-plan.** You can reject a plan; the rejection is recorded, but the job
does not re-plan on resume. It sits. The first real rejection will hit this.

**One review prompt was fixed but never run live.** The prompt failed to tell the model that
the diff it was reviewing was unapplied. It is corrected and unit-tested; the one live chain
that ran used the old text.

## 6. What is proven, and what is only present

The distinction matters more than the totals.

Last full measurement (from the session record, not re-run today):

| Suite | Result | Trust |
|---|---|---|
| unit | 595 / 0 | clean |
| vendor | 54 / 0 | clean |
| electron | 9 / 0 | clean |
| tsc / lint | 0 / 0 | clean |
| runtime | 2616 / 3 | **not clean** — host load 82–199 |

The three runtime failures are timeouts. Each passes in isolation (60/60, 18/18, 18/18) and
none is in a file the last change touched; one was proven not-ours by reverting three files to
an earlier commit and watching it still fail. **But the contract has not been measured clean on
a quiet host since commit `62312d5`.** Do not treat the phase gate as passed.

Today I re-ran only what the current change touches: `tsc --noEmit` exit 0, and 16/16 on the
pool and station-skills suites.

Visual regression baselines are stale — they still show a layout from before the Roster moved
off the squad board.

A known test-harness defect: `npm run test:runtime` writes into a tracked file
(`.claude/agents/notifications-engineer.md`), so `git write-tree == HEAD^{tree}` reports a false
negative after any contract run.

## 7. Work in flight right now

The `ceo` seat is being converted from a label for the human operator into a real agent that
sits between the operator and the Manager. Done so far:

- `.claude/agents/ceo.md` — a persona with one job: judge whether a job is worth building
  before it is planned, and answer in a fixed shape (verdict / why / costs / cheaper option /
  unchecked assumption). It holds no write scope by design.
- A new `strategy-gate` entry in `SKILL_CATALOG` (`factory.mjs`), read-only, no posting.
- The `ceo` roster entry now carries five real skills.

Not done: the mailbox still refuses the `ceo` role on both ends, so the agent cannot yet
receive a message. Four files need to change together — `mailbox.mjs`, `server.mjs` (two alias
sites), `live-state.mjs`, and `src/components/cockpit/AgentRoster.tsx`. An open design question
goes with it: once the `boss → ceo` display alias is removed, the human operator has no roster
card of their own.

## 8. Where the risk is concentrated

1. **`server.mjs` is 6,768 lines and every phase touches it.** It is why phases 6–14 could not
   be committed as nine separate commits — any per-phase slice fails to boot. This is the single
   largest structural problem in the codebase.
2. **The security model rests on a few small files.** `broker.applyChanges` is meant to be the
   only path to the repository. `mailbox.routeAllowed` is the only thing keeping seats from
   talking to whoever they like. `guards.mjs` enforces write scope. These are short, well-commented,
   and load-bearing far beyond their size.
3. **Green suites have repeatedly sat on top of holes.** The project keeps a defect ledger at
   `docs/PES-ADDENDUM.md` — 47 entries, numbered 14 to 60, each one something that shipped,
   passed review, and was found later. (Classes 1-13 predate this repo and live in the sibling
   project's `CLAUDE.md`.) Worth reading before reviewing anything: #44 and #39 (rungs disclosed
   but never closed), #57-60 (the most recent, from write-scope visibility), and in the sibling
   file #1 (a control that looks alive and enforces nothing), #11 (fixing where the bug was
   reported instead of where the class lives), #13 (a ratchet that could never fail).

## 9. What we would like reviewed

- Is the seat/role/write-scope model actually sound, or is it ceremony over a single shared
  filesystem? Specifically: can a worker reach outside its `writeScope` by any path?
- Is `mailbox.routeAllowed` sufficient, given that roles come from a JSON file that HR writes to
  at runtime?
- `server.mjs` — propose a decomposition that can be landed incrementally without a boot-breaking
  intermediate state.
- The Manager state machine: are there reachable states where a job stalls forever with nobody
  waiting on a human?
- The engine readiness predicate (`engine-readiness.mjs`) claims to be the single source of truth
  for "can the engine run". Verify no second copy of that judgement exists anywhere.
- Anything in the defect ledger that looks like it is still live rather than closed.

## 10. Map of the code

| Path | What is there |
|---|---|
| `agent-runtime/server.mjs` | HTTP + SSE surface, session handling, prompt assembly. The monolith |
| `agent-runtime/manager.mjs` | The Manager state machine. Pure, injected clock, no I/O |
| `agent-runtime/jobs.mjs` | Job store and the legal state transitions |
| `agent-runtime/mailbox.mjs` | Inter-agent messaging and the role routing table |
| `agent-runtime/roster.mjs` + `roster.json` | Who exists, what they may write |
| `agent-runtime/broker.mjs`, `guards.mjs` | The only sanctioned path to the repository |
| `agent-runtime/engine*.mjs`, `queue.mjs` | The autonomous task loop |
| `agent-runtime/hr.mjs`, `factory.mjs`, `pool.mjs` | Hiring, the skill catalog, agent personas |
| `agent-runtime/jira-*.mjs`, `pr.mjs` | Outbound integrations |
| `.claude/agents/*.md` | Agent personas, imported into prompts at runtime |
| `src/` | React 19 cockpit UI |
| `.planning/ROADMAP.md` | Phases, gates, and the carried backlog C1–C16 |
| `.planning/STATE.md` | 272 KB session record. The real history |
| `docs/PES-ADDENDUM.md` | 60 defect classes, each one learned the expensive way |

## 11. Repository state

Branch `feat/multi-provider-credentials`, 17 commits ahead of origin, **none pushed**.
A standing rule in this project is that nothing is committed without the owner saying so
explicitly, and permission does not carry between sessions.
