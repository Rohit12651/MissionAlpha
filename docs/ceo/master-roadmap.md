# Master Roadmap — MissionAlpha → Desktop "Claude Code" Cockpit (all-in-one)

**Slug:** `master-roadmap`
**Author:** CEO + architect
**Status:** PLAN — AWAITING_USER_GO
**Date:** 2026-06-18
**Absorbs:** `workspace-plan.md`, `autonomous-loop-plan.md`, `cycle2-sessions-and-chat-fork-scope.md`
**Ultimate goal:** MissionAlpha becomes an **end-to-end Claude Code app** — chat-first, swap Claude models per chat, plug in **MCP connectors**, run the **full agent tool loop** (read/write/exec) with approvals, orchestrate a swarm — all in one app.

---

## BOSS decisions (locked, NO NEGOTIATION)
1. **Claude only.** Models = Claude tiers only: Opus (`claude-opus-4-8`) / Sonnet (`claude-sonnet-4-6`) / Haiku (`claude-haiku-4-5`). **No GPT/Gemini/Codex — multi-backend permanently OUT (gap #7 dropped).**
1b. **Backend = subscription CLI (`claude -p`) ONLY — LOCKED. No Anthropic API backend.** Rationale: flat-rate (matches the Claude Code app the BOSS uses); a parallel agent swarm on per-call API billing would be cost-prohibitive. There is **no $ to display** — so usage is shown as **tokens + context% only (like Claude Code's `/context`), never dollars.** API path is revisited only under Deferred B (Enterprise / selling to others).
2. **Connectors = MCP.** "Use connectors" = manage/configure MCP servers in-app and pass them through to Claude sessions. **Core, not optional.**
3. **Full tool loop is the end-goal.** To be Claude Code "end to end," agents must run the full tool loop (Bash/edit/run) — gated by the permission broker + a Claude-Code-style approval UX. **Core.**
4. **Engine first → cockpit → connectors → review → full tool loop → polish.**
5. **Desktop app DEFERRED (exempt for now).** No Tauri/Electron/signing/notarization this program. The product ships as the existing web app (Vite/React) over the runtime. Desktop is a documented, deferred stage to pick up later. *(Gaps #16–20 deferred.)*
6. **Enterprise (SSO/RBAC/vault/SOC2) deferred** to a final optional stage — built only if multi-user/team use is confirmed.
7. **"Done + tested in one go" = per-stage, not big-bang.** Each stage is independently built, tested, gated, and shippable — you do NOT build all 6 stages then test once at the end (that would be unverifiable). "Tested in one go" means: (a) every stage exits only on green tests + security sign-off, (b) a permanent regression suite accumulates from Stage 1 and every stage re-runs all prior tests, (c) Stage 6 adds one final **full-program golden-path e2e + adversarial sweep** over the assembled whole. **Scope reality: 6 stages, 18 in-program ADRs (024–041), heaviest security work in S2.5 + S3.5 — this is weeks of work, not one session.**

## DECISION RECORD (BOSS choices that shaped this plan)
These are the answers to the scoping questions the CEO asked before drafting. They are the *why* behind the structure above. Locked unless BOSS reopens.

### D1 — Sequencing priority → **ENGINE FIRST** ✅
- **Q:** Engine first, cockpit (workspace-plan) first, or interleave?
- **Options:** (a) Engine first *(recommended)* · (b) Cockpit first · (c) Interleave.
- **Chosen:** (a) Engine first.
- **Rationale:** Build the real autonomous loop, parallel dispatch, and git worktree before reflowing the UI — avoids a "pretty shell over a skeleton."
- **Drives:** Stage order S1 (engine) → S2 (cockpit) → … . `workspace-plan.md` is demoted to Stage 2, not the starting point.

### D2 — Desktop timing → **LAST, then DEFERRED/EXEMPT** ✅ (evolved)
- **Q:** When do we wrap as a desktop app (Tauri/Electron)?
- **Options:** (a) Last, after engine+UX *(recommended)* · (b) Commit to Tauri now · (c) Electron.
- **Chosen:** (a) Last, after engine+UX — **target = Tauri** when built.
- **Later override (2026-06-18):** BOSS exempted the desktop app from this program entirely. Now **DEFERRED** (see "Deferred A"). Gaps #16–20 are documented but NOT built here.
- **Drives:** No Stage 5 build; desktop captured as Deferred A (Tauri, ADRs 041–043) for later, with zero rework to the web app it would wrap.

### D3 — Enterprise (SSO/SAML/RBAC, external vault, SOC2) → **DEFER** ✅
- **Q:** Include enterprise now or defer?
- **Options:** (a) Defer to a final optional stage *(recommended)* · (b) Include fully · (c) Drop entirely.
- **Chosen:** (a) Defer.
- **Rationale:** Single-user for now; build only if multi-user/team use is confirmed.
- **Drives:** Enterprise captured as Deferred B (ADRs 044–046, `compliance-auditor`), out of the core flow.

### D4 — Deliverable → **MASTER PLAN DOC in `docs/ceo/`** ✅
- **Q:** How to deliver the plan?
- **Options:** (a) Write to `docs/ceo/` as a master plan doc *(recommended)* · (b) Show in chat only · (c) Doc + tracked tasks.
- **Chosen:** (a) This file (`docs/ceo/master-roadmap.md`), in the existing CEO/architect format.
- **Open follow-up:** Option (c)'s `TaskCreate` tracking is still available on request — not yet created.

### D5 — Scope add (later, 2026-06-18) → **MCP connectors + full tool loop are CORE** ✅
- **Context:** BOSS clarified the ultimate goal = "MissionAlpha as Claude Code, end to end — connectors, change models, all in one."
- **Decision:** Added **Stage 2.5 (MCP connectors, gap #29)** and **Stage 3.5 (full tool loop + approval UX, gap #30)** as core stages. Multi-backend (gap #7) stays dropped — Claude only.

## Goal
A working, in-app **Claude Code cockpit**: chat is the primary surface; pick a Claude tier per chat; add MCP connectors; an agent (or swarm) runs the full tool loop in a git-worktree-isolated workspace with approvals; deep diff review with inline feedback; PR generation; durable backlog; retry/self-heal; cost/token visibility — all observable, all tested.

## What already exists (reuse — do NOT rebuild)
- In-app Claude chat via subscription — `agent-runtime` CLI backend (`claude -p`), `BossConsole` + per-agent `AgentChat`.
- Permission broker (F2b): per-agent sandbox `/tmp/missionalpha-sandboxes/<id>`, path validation, `CONFIG_GUARD`, egress scrub, AES-256-GCM credential broker — `server.mjs`, `factory.mjs`.
- Auth token + host/origin gates, constant-time compare, `MAX_INFLIGHT` cap.
- Board: kanban/heartbeat/feed/3D globe, dispatch parser, replay timeline — `App.tsx`, `AgentDrawer.tsx`.
- File-based swarm coordination + MCP/claude-mem mirror — `.claude/agents/PROTOCOL.md`, `ORCHESTRATION.md`.
- ADRs 019–023 (registry, agent-creator, integrations, model-tiers, chat-first-shell).

## Scope — gaps in / deferred / dropped

| # | Gap | Stage | Status |
|---|---|---|---|
| 1 | Loop not **auto-chained** (loop itself EXISTS + verified — dispatch→run→diff→apply→reportBack, per `SESSION_MEMORY.md`). Missing: auto-chaining cycles end-to-end without manual steps | S1 | loop ✅, auto-chain ❌ |
| 2 | No parallel dispatch in operator loop (parallel exists only at Flow-subagent layer) | S1 | ❌ |
| 3 | No auto-apply policy engine | S1 | ❌ |
| 4 | No retry / self-heal | S1 | ❌ |
| 5 | No task queue / backlog | S1 | ❌ |
| 9 | No git worktree isolation (sandbox = file copy) | S1 | ❌ |
| 6 | Single global model | S2 | ✅ shipped (workspace-plan: model-tier picker) |
| 8 | No **usage meter** — tokens + context% per chat/agent/tier (like Claude Code `/context`). **Subscription = no $, ever.** Show real counts if `claude -p` returns them, else estimate (chars/4) | S2 | ❌ |
| 12 | Session fork / resume dead (`SessionsBrowser` unwired) | S2 | ❌ (persistence ✅, fork/resume ❌) |
| **29** | **No MCP connector management (NEW)** | **S2.5** | ❌ |
| 13 | Diff review shallow (truncated 4KB, no highlight) | S3 | ❌ |
| 14 | No inline diff feedback | S3 | ❌ |
| 10 | No PR generation | S3 | ❌ |
| 11 | No conflict resolution | S3 | ❌ |
| 15 | No tab/worktree-per-session view | S3 | ❌ |
| **30** | **No full tool loop + approval UX (NEW)** | **S3.5** | ❌ |
| 25 | No onboarding / empty states | S4 | ❌ |
| 26 | No theming / settings panel | S4 | partial (model picker only) |
| 27 | No command palette | S4 | ❌ |
| 22 | No audit-trail UI | S4 | ❌ |
| 28 | No tests on runtime loop | woven S1→S4 | ❌ |
| 16–20 | Desktop shell / native / packaged / offline / signing | **DEFERRED (exempt now)** | parked |
| 21,23,24 | SSO/RBAC, external vault, SOC2 | **DEFERRED (optional)** | parked |
| ~~7~~ | ~~Multi-backend~~ | **DROPPED — Claude only** | dropped |

**Shippable program = Stages 1 → 2(finish) → 2.5 → 3 → 3.5 → 4 → 6(test).** Desktop + Enterprise are documented-but-deferred.

## CURRENT STATUS — reality vs plan (2026-06-18)
> **Sequencing deviation, acknowledged.** D1 says *engine first*, but `workspace-plan.md` (= Stage 2) **already shipped today** — chat-first reflow ✅, model-tier picker ✅, thread persistence ✅. So S2 ran *before* S1. We accept the deviation (the cockpit is useful and low-risk) and **re-anchor: the next build is S1 (engine)**, then S2 is *finished* (cost/token #8 + fork/resume #12 are the only S2 remainders).
>
> **The autonomous loop is NOT being built from zero — CODE-CONFIRMED 2026-06-18.** Read of `agent-runtime/server.mjs` confirms the loop is LIVE: `POST /runtime/:id/run` (server.mjs:800-849) spawns the agent in write-mode sandbox via `handleChat` → agent writes files → diff via `GET /changes` (server.mjs:438) → operator `POST /apply` permission broker (server.mjs:469) → `reportBack` (server.mjs:523). It works today, manually-gated. **S1 EXTENDS this** — adding auto-chaining (#1), parallel dispatch (#2), git worktree (#9), task queue (#5), retry/self-heal (#4), policy gate (#3). Do **NOT** rewrite the proven loop, broker, or guards — extend around them. The "skeleton" framing from the early Explore was wrong; the reviewer + this code read are correct.

---

## GOVERNANCE — how every stage runs
```
CEO gate → architect ADR(s) [BLOCKS] → principal design/db contract → build (TDD) → security gate → QA gate → memory persist
```
**Mandatory Superpowers pipeline per build phase:** `sp-brainstorming` → `sp-writing-plans` → `sp-test-driven-development` → `sp-executing-plans` → `sp-verification-before-completion` → `sp-requesting-code-review`.

**Hard gates (a phase cannot exit until):**
- `senior-security-engineer` sign-off via `security-review` + `cso` on any auth/sandbox/exec/MCP/tool-loop path.
- `senior-qa` reports `TESTS_GREEN` (unit + integration + e2e + adversarial) — added to the permanent suite.
- `senior-code-reviewer` clears all sev≥Medium findings.
- `memory-updater` persists decisions to ClaudeMem + `SESSION_MEMORY.md`.

## AGENT ROSTER
| Agent | Owns |
|---|---|
| `ceo` | Per-stage gate, scope, non-goals, BOSS sign-off |
| `architect` | All ADRs (024+), dependency mapping, system design |
| `principal-db-engineer` | Task-queue store, thread + cost store, MCP-connector registry schema, audit store, worktree metadata |
| `principal-ux-design` | Design contract: chat-first shell, connector panel, deep diff, approval UX, tabs, settings, command palette (tokens, a11y, motion) |
| `senior-backend-1` | Autonomous loop engine, parallel scheduler, model-tier plumbing, MCP passthrough |
| `senior-backend-2` | Git-worktree isolation, PR gen, conflict resolution, persistence, full tool-loop broker, audit log |
| `senior-web-1` | Chat-first shell, layout state, deep diff viewer, tabs-per-session |
| `senior-web-2` | Model picker, thread switcher, connector panel UI, inline diff feedback, approval UX, cost meter, command palette, settings |
| `senior-security-engineer` | Threat model + HARD gate every stage (model-param injection, worktree escape, auto-apply policy, **MCP cred handling, full tool-loop execution**) |
| `senior-qa` | Test strategy, e2e, adversarial, the permanent regression suite (gap #28) |
| `senior-code-reviewer` | Final merge gate every phase |
| `memory-updater` | Persist decisions, ADRs, retros |
| `senior-cicd-engineer` | CI wiring for the regression suite (desktop packaging deferred) |

## SKILL MATRIX
| Concern | Skills |
|---|---|
| Methodology (every phase) | `sp-using-superpowers`, `sp-brainstorming`, `sp-writing-plans`, `sp-test-driven-development`, `sp-executing-plans`, `sp-verification-before-completion`, `sp-systematic-debugging` |
| Architecture / ADRs | `kw-engineering-system-design`, `kw-engineering-architecture`, `code-architect` agent |
| MCP work (S2.5) | `build-mcp-server`, `mcp-integration`, `mcp-builder`, `context7` (current MCP/SDK docs) |
| Design (S2–S4) | `impeccable` (craft/audit/polish), `emil-design-eng` (motion), `hallmark` + `taste-skill` (anti-slop), `gstack design-review`, `ui-designer` + `frontend-developer` |
| Security (every gate) | `security-review`, `cso`, `senior-security-engineer` |
| Review / ship | `kw-engineering-code-review`, `sp-requesting-code-review`, `gstack review`, `kw-engineering-deploy-checklist` |
| Verification | `webapp-testing`, `playwright` (admin=3000, consumer=3001, merchant=3002, driver=3003), `gstack qa` |
| Memory | `memory-updater`, `mem-search`, `claude-mem` |

---

# STAGE 1 — EXTEND THE ENGINE
**Starting point (DO NOT REBUILD):** the loop already runs end-to-end and was curl-verified — `dispatch → run → diff → apply → reportBack → DONE_CYCLE` (`SESSION_MEMORY.md`, `agent-runtime/server.mjs`). Stage 1 **extends** this working loop; it does not replace it. First task of Phase 1.1 = read the existing loop and write the ADRs as *deltas* on it.
**Outcome:** auto-chained cycles (no manual steps); parallel dispatch from the operator loop; per-task git worktree; durable backlog; retry/self-heal; policy-gated auto-apply.
**Gaps:** #1 (auto-chain), #2 (parallel), #3 (policy), #4 (retry), #5 (queue), #9 (worktree).

### Phase 1.0 — CEO gate
`ceo`. Non-goals: no UI reflow, no connectors, no full tool loop yet. Exit: BOSS GO.

### Phase 1.1 — architect ADRs (BLOCKS build)
- `ADR-024-autonomous-loop-engine.md` — live loop state machine: goal → dispatch → worktree edit → diff → policy gate → apply → reportBack → DONE_CYCLE, auto-chained; idempotency; failure transitions.
- `ADR-025-parallel-dispatch-scheduler.md` — operator-loop fan-out: N concurrent `/run`, per-agent slots, backpressure vs `MAX_INFLIGHT`, fairness, cancellation.
- `ADR-026-git-worktree-isolation.md` — replace copy-sandbox with `git worktree add` per task: branch naming, lifecycle, cleanup, mapping to `applyAllowed`/`CONFIG_GUARD`.
- `ADR-027-task-queue-backlog.md` — durable queue (owner `principal-db-engineer`): schema, priorities, statuses, dedupe.
- `ADR-028-retry-self-heal.md` — failure detection, bounded retry, rollback (worktree discard), operator escalation.
- `ADR-029-auto-apply-policy.md` — per-agent trust policy; **builds on, never weakens, F2b** (exec/config keys ALWAYS gated). Security-signed.
- Skills: `kw-engineering-system-design`, `sp-writing-plans`, `code-architect`. Exit: ADRs approved; security signs 026 + 029.

### Phase 1.2 — principal-db: queue + worktree store
`principal-db-engineer`. Durable task-queue + worktree-registry (file-based, migration-ready). Exit: schema + validators.

### Phase 1.3 — backend build (TDD)
- `senior-backend-1`: loop engine (024) + scheduler (025) + queue consumer (027) + retry (028).
- `senior-backend-2`: git-worktree isolation (026) + auto-apply policy (029).
- Skills: `sp-test-driven-development`, `sp-executing-plans`, `context7`.
- **Test/Exit:** enqueue 5 goals → swarm drains in parallel → each in own worktree branch → policy gate fires → failed task retries then rolls back.

### Phase 1.4 — security gate
`senior-security-engineer`: worktree escape, branch injection, auto-apply bypass, parallel fork-bomb. `security-review` + `cso`. **HARD gate.**

### Phase 1.5 — QA (engine regression suite — seeds gap #28)
`senior-qa`: unit + integration + e2e + adversarial for the whole loop. **This becomes the permanent regression harness reused by every later stage.** Exit: `TESTS_GREEN`.

### Phase 1.6 — memory + retro
`memory-updater` persists 024–029. `ceo` retro.

**Stage 1 acceptance:** live auto-chained loop · parallel operator-loop dispatch · git worktree per task · durable backlog · retry+rollback · policy-gated auto-apply (exec/config hard-gated) · green suite.

---

# STAGE 2 — MODEL TIERS + CHAT-FIRST COCKPIT  *(mostly shipped — FINISH only)*
**Already done (workspace-plan, 2026-06-18):** chat-first reflow ✅ · model-tier picker (Opus/Sonnet/Haiku) ✅ · thread persistence ✅.
**Remaining to finish:** **usage meter** (#8 — tokens + context%, **subscription = no $**, like Claude Code `/context`) and session fork/resume (#12 — wire `SessionsBrowser`).
**Note:** Stage 2 runs *after* S1 here only because its remainders depend on the engine (cost rollup over real runs; fork/resume over worktrees). The shipped parts already work standalone.
**Gaps:** #6 ✅ · #8 (remaining) · #12 (remaining). **ADR-022 + ADR-023 already exist.**

### Phase 2.0 — CEO gate. Default tier = **Sonnet**. Exit: GO.

### Phase 2.1 — architect ADRs
- Ratify ADR-022 / ADR-023 against the new engine.
- `ADR-030-usage-tracking.md` — per-thread/agent/tier **usage meter**: tokens + context-window % + which tier ran. **NO dollars — backend is subscription `claude -p`, flat-rate, nothing is billed per call** (showing $ would be false). Modeled on Claude Code's `/context`. SPIKE first: confirm whether `claude -p` returns token counts; if yes show real counts, if no show an estimate (chars/4) clearly labelled "~est". Live meter + retro rollup of tokens by tier.
- `ADR-031-session-fork-resume.md` — wire the dead `SessionsBrowser` (`App.tsx:317`): fork a thread/worktree, resume from a past point, branch a conversation; builds on S1 worktree + `cycle2-sessions-and-chat-fork-scope.md`.
- Exit: approved; model-tier allowlist re-confirmed by security.

### Phase 2.2 — principal-ux contract
Chat-center shell; left thread/agent switcher; right collapsible "Team" board; model picker (hints: smartest/balanced/fastest); cost meter; fork/resume affordances; responsive 320–768. Skills: `impeccable shape`, `hallmark`, `gstack design-review`, `emil-design-eng`. Reference: Claude Code / Linear / Raycast. Exit: approved.

### Phase 2.3 — backend
- `senior-backend-1`: model-tier plumbing (022) — `{model}` on `/chat` + `/run`, strict allowlist → `--model <id>`, unknown tier → 400; health reports tiers.
- `senior-backend-2`: thread persistence (restart-safe, gitignored, capped) + usage accounting (030, tokens + context%, **no $**) + fork/resume backend (031).
- ⚠ **Probe BEFORE shipping:** (a) the CLI `--model` id (`claude-haiku-4-5` alias vs dated id), and (b) whether `claude -p` returns token counts — if not, estimate (chars/4), labelled "~est".
- **Test/Exit:** `/chat {model:"haiku"}` faster; `{model:"opus"}` uses Opus; bad tier → 400; usage meter shows tokens + context% (no $); restart → history + usage survive.

### Phase 2.4 — web build
- `senior-web-1`: reflow `App.tsx` → chat-first shell; board mounted as secondary "Team" panel (no feature loss); layout state persisted.
- `senior-web-2`: model picker, thread switcher, live cost meter, fork/resume wired to `SessionsBrowser`.
- Skills: `emil-design-eng`, `impeccable polish`, `gstack review`, `webapp-testing`. Exit: chat is center; per-chat tier; cost visible; fork/resume; board reachable; old features intact.

### Phase 2.5 — security → 2.6 QA + memory
Security: strict model-param allowlist (no `--dangerously…` argv injection); no regression. QA: e2e (tier switch, fork/resume, restart) + adversarial (`model="--inject"`, huge thread) + S1 regression. `memory-updater` + `ceo` retro.

**Stage 2 acceptance:** chat primary · per-chat Opus/Sonnet/Haiku (allowlisted) · **usage meter (tokens + context%, NO $)** · fork/resume · persistence · board demoted not deleted · no injection.

---

# STAGE 2.5 — MCP CONNECTOR LAYER  *(NEW — the "connectors" pillar)*
**Outcome:** Add, configure, and toggle **MCP connectors** in-app (GitHub, Notion, Supabase, Playwright, Composio apps, custom servers). Credentials stored in the existing AES broker; per-agent MCP allowlist; passthrough into `claude -p` sessions. This is what makes connectors work like Claude Code.
**Gap:** #29.

### Phase 2.5.0 — CEO gate. Non-goal: no arbitrary unvetted servers auto-trusted. Exit: GO.

### Phase 2.5.0b — SPIKE FIRST (de-risk before the ADR)
⚠ **`claude -p` reads `.mcp.json` / settings, not arbitrary argv.** Before committing ADR-032, `senior-backend-1` runs a throwaway spike: can the runtime compose a per-session MCP config (write a scoped `.mcp.json` into the worktree / pass `--mcp-config`) and have `claude -p` actually load + call it? Confirm the injection mechanism works; the ADR documents the *proven* mechanism, not an assumed one. Exit: working spike or a revised approach.

### Phase 2.5.1 — architect ADRs
- `ADR-032-mcp-connector-registry.md` — connector model: server id, transport (stdio/http), command/url, env/cred refs, scopes, enabled flag. Registry store (owner `principal-db-engineer`). Per-session MCP composition mechanism **as proven in the 2.5.0b spike** (likely a scoped `.mcp.json` written per worktree, or `--mcp-config`).
- `ADR-033-mcp-creds-and-allowlist.md` — **security crux**: creds never in plaintext/logs (reuse AES broker, decrypt only at spawn frame); per-agent MCP allowlist (an agent only gets connectors it's granted); egress scrub extended to MCP I/O; injection guard on server command/args (no flag/shell injection into spawn). Security-signed.
- Exit: approved; `senior-security-engineer` signs 033 (HARD).

### Phase 2.5.2 — principal-ux contract
Connector panel: list/add/edit/toggle MCP servers; cred entry (masked, stored via broker); per-agent grant matrix; connection health/status. Skills: `impeccable`, `gstack design-review`, `emil-design-eng`. Exit: approved.

### Phase 2.5.3 — build (TDD)
- `principal-db-engineer`: connector registry store + validators.
- `senior-backend-1`: compose per-session MCP config, inject into `claude -p` spawn; health probe per connector.
- `senior-backend-2`: cred binding via AES broker; per-agent allowlist enforcement.
- `senior-web-2`: connector panel UI + per-agent grant matrix.
- Skills: `build-mcp-server`, `mcp-integration`, `context7`, `sp-test-driven-development`, `webapp-testing`.
- **Test/Exit:** add a GitHub MCP connector in-app → grant to one agent → that agent can call it, an ungranted agent cannot → creds never appear in logs/SSE → bad server command rejected.

### Phase 2.5.4 — security gate (**heavy**)
`senior-security-engineer`: cred leakage, MCP command injection, over-broad grants, egress scrub of MCP I/O. `security-review` + `cso`. **HARD gate.**

### Phase 2.5.5 — QA + memory
e2e (add/grant/use/revoke a connector) + adversarial (injection in server args, cred-in-log probe, cross-agent access) + full regression. Persist.

**Stage 2.5 acceptance:** in-app MCP connector management · creds via AES broker (never leaked) · per-agent allowlist enforced · connectors usable from agent sessions · injection-safe.

---

# STAGE 3 — DEEP REVIEW UX + GIT WORKFLOW
**Outcome:** Warp/Claude-Code-grade review: full syntax-highlighted diffs, inline comment → agent revises, PR generation, conflict resolution, tabs-per-session/worktree.
**Gaps:** #13, #14, #10, #11, #15.

### Phase 3.0 — CEO gate → GO.

### Phase 3.1 — architect ADRs
- `ADR-034-deep-diff-review.md` — untruncated diff model, syntax highlight, search, per-line/inline comment threads that feed back to the owning agent for revision.
- `ADR-035-pr-generation.md` — agent edits → branch push → open PR via `gh` / request-review path, as an option beside direct apply.
- `ADR-036-conflict-resolution.md` — two agents one file: merge strategy / lock-queue / 3-way resolve on worktree branches.
- Exit: approved; security signs PR/push path (token scope, no secret leak).

### Phase 3.2 — principal-ux contract
Diff viewer (syntax, search, inline comment threads); tabs-per-session header (branch/PR/worktree per tab; board still reachable); conflict-resolution UX. Skills: `impeccable`, `emil-design-eng`, `gstack design-review`, `kw-design-accessibility-review`. Exit: approved.

### Phase 3.3 — build (TDD)
- `senior-backend-2`: PR generation (035) + conflict resolution (036) on worktree branches.
- `senior-web-1`: deep diff viewer + tabs-per-session (034 / #15).
- `senior-web-2`: inline diff feedback → agent-revise loop (#14).
- Skills: `sp-test-driven-development`, `context7` (gh/git), `webapp-testing`.
- **Test/Exit:** review a real diff (highlight+search); comment a line → agent revises; generate a PR; resolve a 2-agent conflict.

### Phase 3.4 security → 3.5 QA → 3.6 memory (standard gates).

**Stage 3 acceptance:** full diffs + highlight + search · inline comment → revise · PR generation · conflict resolution · tabs per session/worktree · green regression.

---

# STAGE 3.5 — FULL TOOL LOOP + APPROVAL UX  *(NEW — the "end-to-end" pillar)*
**Outcome:** Agents run the **full Claude Code tool loop** — Bash/edit/run — gated by the permission broker, a Claude-Code-style **approval prompt** (allow once / allow-for-session / deny), AND executed inside a **real OS-level sandbox**. This is what makes MissionAlpha Claude Code end-to-end. **Highest-risk stage of the program.**
**Gap:** #30.

> ⚠️ **EXECUTION-BOUNDARY CORRECTION (was a flaw in the first draft).**
> A **git worktree is NOT a security boundary.** It isolates git state only — same uid, same filesystem, same network. An agent with `Bash` inside a worktree can `cd /`, read `~/.ssh`, `rm -rf` anything the user can, or exfiltrate over the network. Approval prompts reduce *accidental* harm but do not contain a *malicious or prompt-injected* command.
> **Therefore the exec boundary MUST be a real sandbox**, not the worktree. The worktree stays (for git/diff/apply); execution is jailed by an OS-level mechanism. **This is the moat AND the liability — the doc treats it as the program's hardest security problem.**

### Phase 3.5.0 — CEO gate + execution-boundary decision
`ceo` + `senior-security-engineer`. Decide the exec sandbox mechanism BEFORE any build (options below). Confirm risk acceptance. **Non-goal: NO direct exec on the host, ever — even with approval.** Exit: GO + chosen boundary.

**Exec-boundary options (pick in 3.5.1):**
| Option | Isolation | Cost | Notes |
|---|---|---|---|
| **Docker/OCI container** (recommended default) | Process+FS+net namespace; drop caps; read-only mounts; no host network | Med | Best balance; worktree bind-mounted read-only, writes to overlay; `--cap-drop ALL`, `--network none` by default |
| **microVM** (Firecracker / Apple Virtualization) | Full kernel isolation | High | Strongest; heavier to operate |
| **seccomp-bpf + namespaces (raw)** | Syscall filter + user/mount/net ns | Med | No Docker dep, more bespoke, easier to get subtly wrong |
| ~~worktree + approval only~~ | **NONE for exec** | — | **REJECTED — not a boundary** |

### Phase 3.5.1 — architect ADRs
- `ADR-037-execution-sandbox.md` — **the exec boundary.** Chosen mechanism (default: container). Spec: FS scope (worktree mounted, host `/` NOT reachable), `--network none` by default (network = a separately-approved capability), dropped capabilities, non-root user, CPU/mem/PID/time limits, no host socket/daemon access, ephemeral + destroyed per task. Worktree explicitly documented as **git-state isolation, not exec isolation.**
- `ADR-038-full-tool-loop-broker.md` — full tool set through the broker, executed *inside the sandbox*: command classification (safe / sensitive / forbidden), default-deny, allow/deny lists; network as an explicit capability; everything runs in the sandbox over the worktree, never the live repo until apply.
- `ADR-039-approval-permission-ux.md` — per-tool-call approval (allow-once / allow-for-session / deny); per-agent + per-command-class trust policy (ties to ADR-029); full audit of every approval + every executed command. Security-signed.
- Exit: approved; `senior-security-engineer` signs ALL THREE (HARD). *(S3.5 now consumes ADR-037–039; S4 = 040–041; deferred desktop = 042–044; deferred enterprise = 045–047.)*

### Phase 3.5.2 — principal-ux contract
Approval prompt UX (command preview, declared capabilities incl. network, scope, allow/deny), running-command stream, per-agent permission + sandbox-policy settings. Skills: `impeccable`, `emil-design-eng`, `hallmark`. Exit: approved.

### Phase 3.5.3 — build (TDD, security-PAIRED throughout)
- `senior-security-engineer` (co-lead) + `senior-backend-2`: the execution sandbox (037) FIRST — stand it up and try to escape it before wiring any agent to it.
- `senior-backend-2`: tool-loop broker (038) — classification, default-deny, sandbox-jailed exec, resource/time limits, kill-switch.
- `senior-web-2`: approval prompt UX + running-command stream + per-agent/sandbox settings (039).
- Skills: `sp-test-driven-development`, `sp-systematic-debugging`, `cso`, `security-review`, `context7`. **Sandbox escape suite written and passing BEFORE the broker ships.**
- **Test/Exit:** inside the sandbox, attempts to read host `/etc`, `~/.ssh`, reach the network (when not granted), escalate to root, or escape the FS **all fail**; agent Bash → approval prompt → allow runs *in the sandbox* / deny blocks → forbidden auto-rejected → "allow-for-session" remembers → kill-switch terminates a runaway → every call audited.

### Phase 3.5.4 — security gate (**heaviest of the whole program**)
`senior-security-engineer` + `cso`, independent adversarial pass: **sandbox escape** (FS, network, syscall, privilege escalation), command injection, approval bypass, resource exhaustion, kill-switch verification, secret-exfil over network. **HARD gate — no exceptions, no override.**

### Phase 3.5.5 — QA + memory
e2e (approve/deny/allow-session; sandboxed exec; network-grant flow; kill-switch) + heavy adversarial (escape attempts across every vector) + full regression. Persist.

**Stage 3.5 acceptance:** full tool loop (read/write/exec) live · **executed in a real OS-level sandbox (host `/` + network unreachable by default)** · default-deny + classification · approval prompt (once/session/deny) · per-agent trust + sandbox policy · kill-switch · every call audited · **independent sandbox-escape suite green** · adversarial-clean.

---

# STAGE 4 — POLISH / DX / OBSERVABILITY
**Outcome:** Product-grade feel: onboarding, theming/settings, command palette, searchable audit-trail UI, and the finalized permanent test harness in CI.
**Gaps:** #25, #26, #27, #22, #28 (finalized).

### Phase 4.0 — CEO gate → GO.

### Phase 4.1 — architect ADRs
- `ADR-040-settings-theming.md` — settings panel (default tier, theme, tab colors, connector defaults, tool-loop + sandbox policy toggles), OKLCH token system.
- `ADR-041-audit-trail-ui.md` — searchable/filterable read view over the audit + heartbeat + approval + executed-command history (read model; no new write path).

### Phase 4.2 — principal-ux contract
Onboarding/empty/first-run states; settings panel; command palette (keyboard nav — Raycast/Linear); audit-trail view. Skills: `impeccable craft/polish`, `hallmark`, `emil-design-eng`, `gstack design-review`. Exit: approved.

### Phase 4.3 — build
- `senior-web-2`: onboarding, settings/theming (040), command palette (#27).
- `senior-web-1`: audit-trail UI (041 / #22) — surfaces approvals + applies + connector usage.
- `senior-qa` + `senior-cicd-engineer`: harden + wire the full permanent regression suite into CI (#28).
- **Test/Exit:** first-run flow; theme/settings persist; palette navigates everything; audit searchable; CI runs full suite green.

### Phase 4.4 security → 4.5 QA → 4.6 memory.

**Stage 4 acceptance:** onboarding · settings/theming · command palette · audit-trail UI · CI-enforced regression suite · a11y + reduced-motion + responsive.

---

# STAGE 6 — FULL-PROGRAM VERIFICATION ("tested in one go")
**Outcome:** A single end-to-end pass proving the whole product works together — the "done + tested in one go" requirement.
*(No Stage 5 here — desktop is deferred below.)*

### Phase 6.1 — full e2e (golden path)
`senior-qa` drives one continuous flow:
open app → chat (center) → switch Opus/Sonnet/Haiku → add an MCP connector → grant to an agent → enqueue several goals → swarm runs in parallel, each in its own worktree → agent requests a Bash command → approval prompt → allow → jailed exec → deep diff review → inline comment → agent revises → generate a PR → apply → cost meter updates → fork a session → restart runtime → history + cost persist → audit trail shows every step.
Skills: `webapp-testing`, `playwright`, `gstack qa`.

### Phase 6.2 — full adversarial sweep
`senior-security-engineer` + `cso`: model-param injection, MCP cred leak + command injection, worktree escape, approval bypass, auto-apply bypass on exec/config, cross-agent connector access, fork-bomb. Independent. **HARD gate.**

### Phase 6.3 — regression + sign-off
Entire accumulated suite green; `tsc` + lint clean; `senior-code-reviewer` final clear; `senior-security-engineer` sign-off; `memory-updater` persists the program retro.

**Stage 6 acceptance (program DONE):** the golden-path e2e passes start-to-finish AND the adversarial sweep is clean AND the full regression suite is green in CI.

---

# DEFERRED STAGES (documented, NOT built this program)

### DEFERRED A — Desktop App (Tauri)  *(EXEMPT for now — gaps #16–20)*
When picked up: `ADR-042-desktop-shell` (Tauri wrap + IPC + CSP), `ADR-043-runtime-supervisor` (sidecar auto-boot/health, no `/tmp` token in packaged mode), `ADR-044-packaging-signing` (`.dmg`/`.exe`/AppImage, code-sign/notarize, auto-update, offline). Owner: `senior-cicd-engineer`. Wraps the finished web app as-is. **Not in this program.**

### DEFERRED B — Enterprise  *(optional, multi-user only — gaps #21, #23, #24)*
When confirmed multi-user: `ADR-045-sso-rbac`, `ADR-046-external-secret-manager` (1Password/LastPass/Vault alongside AES broker), `ADR-047-compliance-posture` (zero-retention, residency, SOC2 evidence). Gates: `security-review` + `cso` + `compliance-auditor`. **Not in this program.**

---

## DEPENDENCY ORDER
```
S1 ENGINE
 → S2 MODEL+COCKPIT            [needs S1 worktree+loop]
   → S2.5 MCP CONNECTORS       [needs S2 session model]
     → S3 REVIEW UX + GIT      [needs S1 worktree + S2 shell]
       → S3.5 FULL TOOL LOOP   [needs S1 worktree + S2.5 connectors + S3 review]
         → S4 POLISH/DX
           → S6 FULL-PROGRAM VERIFICATION   ← "tested in one go"
   ─ ─ (later) DEFERRED A Desktop · DEFERRED B Enterprise
```
Within each stage: `CEO → architect ADRs [BLOCK] → design/db contract → build (TDD) → security gate → QA gate → memory`.

## MASTER ACCEPTANCE (program DONE when)
- [ ] Live autonomous loop, parallel dispatch, git worktree per task, durable backlog, retry/rollback, policy-gated auto-apply (exec/config always gated).
- [ ] Chat-first cockpit; per-chat Opus/Sonnet/Haiku (allowlisted); usage meter (tokens + context%, **no $** — subscription); fork/resume; persistence.
- [ ] MCP connectors: add/configure/toggle in-app; creds via AES broker (never leaked); per-agent allowlist; usable from agent sessions.
- [ ] Deep diff review + inline feedback → revise; PR generation; conflict resolution; tabs-per-session.
- [ ] Full tool loop (read/write/exec) executed in a **real OS-level sandbox** (host `/` + network unreachable by default), with default-deny classification, approval UX (once/session/deny), per-agent trust, kill-switch, full audit, and a passing independent sandbox-escape suite.
- [ ] Onboarding, settings/theming, command palette, audit-trail UI; CI-enforced regression suite.
- [ ] **Stage 6 golden-path e2e passes start-to-finish AND adversarial sweep clean AND full regression green** ("tested in one go").
- [ ] Every stage: `tsc` + lint + `TESTS_GREEN` + `senior-security-engineer` sign-off + `senior-code-reviewer` clear.

## NON-GOALS (this program)
- Non-Claude providers (GPT/Gemini/Codex) — permanently OUT (gap #7 dropped).
- Desktop app (Tauri/Electron/signing) — DEFERRED (exempt now).
- Enterprise SSO/RBAC/vault/SOC2 — DEFERRED (optional, multi-user only).
- Mobile companion — out unless separately scoped.
- Removing the board — stays, demoted to "Team" panel.

## TOP RISKS
1. **Full tool loop (S3.5) is the danger zone — and the exec boundary must be a REAL sandbox, not a worktree.** A git worktree isolates git state, NOT execution (same uid/FS/net; agent can read `~/.ssh`, `rm -rf /`, exfil over net). Approval prompts stop accidents, not malicious/injected commands. **Mitigation: OS-level sandbox (container/microVM/seccomp, host `/` + network unreachable by default — ADR-037) + default-deny classification + approval UX + kill-switch + an independent sandbox-escape suite that must pass BEFORE the broker ships + the heaviest security gate; security engineer co-leads the build.** This is the single most important correction to the original plan.
2. **MCP cred leakage / command injection (S2.5)** — reuse AES broker, decrypt only at spawn frame, extend egress scrub, injection-guard server args.
3. **CLI `--model` id mismatch** — probe before S2.3.
4. **Worktree escape / auto-apply bypass (S1)** — F2b guards must extend, never relax; hard-blocking security gate.
5. **Parallel-agent resource exhaustion** — scheduler backpressure + `MAX_INFLIGHT`, load-tested.
6. **Engine complexity creep (S1)** — tight ADRs, ship per-phase, lean on the accumulating regression suite.

## CEO NOTE
This is the honest path to "MissionAlpha = Claude Code, end to end." You already wrap `claude -p`, so this is an **alignment, not a pivot**. Order is deliberate: a real engine (S1), the Claude-Code feel + model choice (S2), **connectors** (S2.5), great review (S3), the **full tool loop with approvals** (S3.5 — the moat and the risk), polish (S4), then one **full-program verification** (S6) so it's truly done-and-tested in one go. Desktop and enterprise are deferred, documented, and ready to pick up later without rework — the web app + runtime they'd wrap is built to last.

**ASK BOSS:**
1. GO to **start S1 (extend the engine)** next — accepting that S2 (cockpit) already shipped out of order?
2. Confirm Sonnet default, and **subscription-only backend** with a **usage meter (tokens + context%, no $)** modeled on Claude Code `/context`?
3. Confirm the **full tool loop (S3.5)** is in-scope **with a real OS-level sandbox (default: container) as the exec boundary** — not a worktree — and mandatory approvals?
