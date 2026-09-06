# Munder Difflin → MissionAlpha — adoption analysis

Source: `~/Downloads/WaahyuFOLDER/WaahyuTools/munder-difflin` @ v0.4.4 (MIT code, non-commercial assets).
Analysed 2026-08-19. Installed + run locally (evidence below). Advisory doc — no code changed, no commits.

---

## 0. Verdict (CEO read)

**The two products solve opposite halves of the same problem and overlap almost nowhere in implementation.**

- **Munder Difflin owns the EXECUTION substrate.** Real CLI processes in PTYs, 10 engines, live steerable terminals, file-based hive comms, transcript-grade cost telemetry, a runaway circuit breaker. It has essentially **no governance layer** — its HITL is "the agent's own permission prompt."
- **MissionAlpha owns the GOVERNANCE substrate.** Delivery → risk band → policy → human decision → broker → worktree → commit → PR, with loopback auth, roles, egress scrub, PII/injection detection, ADR discipline. Its **execution layer is thin and single-vendor**, and is currently *the thing that is broken* (`.planning/STATE.md`: engine blocked since Aug 16, "no active account", 5 consecutive spawn failures).

**Recommendation: adopt Munder Difflin's execution layer into MissionAlpha. Reject its coordination model and its entire UI.**
Rationale: MissionAlpha's weakest link is exactly Munder Difflin's strongest, and vice versa. Every adoption below is additive under MissionAlpha's five security laws — no candidate requires relaxing Law 1 (broker-only writes) or Law 5 (hooks are internal modules).

---

## 1. Install + run evidence (observed, not claimed)

| Step | Result |
|---|---|
| `npm install` on Node **26.6.0** | **FAILED** — `better-sqlite3` source build, 6 V8 errors (`no member named 'GetPrototype' in 'v8::Object'`, `'This' in 'v8::PropertyCallbackInfo'`). Node 26 V8 headers dropped those APIs. |
| `npm install` on Node **22.22.2** (nvm) | **exit 0**. `better_sqlite3.node` + `pty.node` both built. |
| `npm run typecheck` | **clean** — 0 errors, node + web projects. |
| `npm run test:focused` | **239 / 239 pass**, 0 fail, 8.56s. |
| `npm run dev` | **boots clean.** main 582 kB, preload 39.7 kB, renderer on :5173, Electron window up, no errors in log. |

**Not exercised:** onboarding wizard was not completed, so no agent was spawned, no hive was created, no floor was driven. Everything below about hive/floor *runtime behaviour* is read from code + `HIVE.md`/`SPEC.md`, **not observed**.

Repro:
```bash
cd ~/Downloads/WaahyuFOLDER/WaahyuTools/munder-difflin && nvm use 22 && npm install && npm run dev
```

---

## 2. What Munder Difflin actually is

Electron desktop harness that wraps **terminal-agent CLIs you already pay for** and turns them into a self-coordinating team.

**Two data planes, one renderer** — the load-bearing decision:
- **Terminal plane** — `node-pty` PTY per agent, byte-authentic, rendered in xterm.js. You can type back into any live session.
- **Event plane** — Claude Code lifecycle hooks (`PreToolUse`/`PostToolUse`/`Stop`/`Notification`) POST to a Unix domain socket the main process owns. Drives avatar state and the autonomous loop.

Rationale stated in `SPEC.md`: hooks alone don't give the raw stream users expect; PTY scraping alone can't tell you *which tool* is running without fragile parsing. Together: canvas is event-driven, terminal is byte-exact. **This reasoning is correct and MissionAlpha has neither plane.**

**The hive** (`HIVE.md`) — a local git repo of plain files:
```
hive/  PROTOCOL.md · registry.json · board.md · tasks.json · log.jsonl
       agents/<id>/  identity.md · memory.md · inbox/ · inbox/.done/ · outbox/ · cursor.json
```
Locked decisions: **single committer** (only Electron main commits — avoids `index.lock` corruption), **single-writer-per-file** (router moves messages, no file has two writers), atomic temp+rename per message, append-only log with per-consumer cursors.

Message schema is FIPA-lite: 7 fields, speech acts (`request/inform/propose/query/agree/refuse/done`), `hops` counter with a cap, `requires_reply` only on request/query/propose. Anti-livelock by construction.

**Autonomy** = the `Stop` hook returns `{"decision":"block","reason":<unread mail>}` to keep an agent working, guarded by `stop_hook_active`.

**GOD agent (Michael)** — an ordinary `claude` process seated at `desk-ceo`, flagged `isGod`. Owns roster, adjudication, blackboard scribing, task ledger. Its escalation policy lives **in its system prompt, not in code** ("tune the prompt, not the code").

**Scale:** ~18.7k LOC main + ~33k renderer.

---

## 3. What MissionAlpha is right now

Agent Inbox / Business-OS. `Delivery` is the core object: risk-classified, policy-routed, human-decided, shipped as branch/PR through the broker ladder.

- Runtime: `agent-runtime/` — 90+ ESM modules, ~50k LOC, Node 20, 127.0.0.1:3005, SQLite WAL, SSE bus with single-use 30s tickets.
- UI: React 19 / Vite :3004, ~37.6k LOC. BOS shell + ventures + vault + stations + stories, with `VITE_INBOX=0` / `VITE_BOS=0` kill-switches.
- In-flight: **Ruflo Adoption Program**, 15 pins / 4 phases. Per `STATE.md`: **11 of 15 built, 9 wired, 0 UI.** Regression 1757 runtime / 473 unit / 54 vendor.
- Providers: **5 API types** (claude/openai/minimax/zai/custom) + `claude -p` CLI backend. Capability is **probed, never asserted** — a genuinely better law than Munder Difflin's hardcoded preset booleans.
- **No PTY. No xterm. No live terminal anywhere.** Confirmed by grep: `node-pty`/`xterm` appear only inside `@types/node`.

---

## 4. Similarities (convergent, independently arrived at)

| Concern | Munder Difflin | MissionAlpha |
|---|---|---|
| Shell | Electron + Vite + React + TS | Electron + Vite + React 19 + TS |
| Store | better-sqlite3 (window bounds, cost ledger) | better-sqlite3 WAL (deliveries, events) |
| Live UI push | IPC over `window.cth` contextBridge | SSE bus (`/runtime/events`) |
| Orchestrator persona | GOD agent "Michael" | CEO / BOSS / captain |
| Task ledger | `tasks.json` + TasksKanban | queue.mjs + KanbanBoard |
| Worktree isolation | optional per-agent git worktrees | per-task worktrees (ADR-026) |
| Cost/usage | transcript-derived, dollars shown | tokens + context %, **dollars forbidden** |
| Per-agent memory | `memory.md` + MemPalace semantic index | vault + vault-graph (R15) |
| Retry / self-heal | breaker ladder | self-heal.mjs, classify/backoff |
| Design doc discipline | DESIGN.md / SPEC.md / HIVE.md canonical | ADR-019…056, .planning/, phase PLANs |
| Injected seams for testability | — | `dispatchFn`, stores (explicit law) |

Both independently landed on: Electron + SQLite + kanban + worktrees + a named orchestrator + a per-agent memory file. That convergence is a signal the shape is right.

---

## 5. Differences that matter

### Munder Difflin has, MissionAlpha does not
1. **Multi-engine CLI abstraction** — 10 engines + custom, one preset table.
2. **PTY terminal plane** — live, byte-authentic, steerable mid-run.
3. **Hook event plane** over a UDS socket, driving an autonomous `Stop`-loop.
4. **File-mailbox / stigmergy / blackboard** coordination with single-committer git.
5. **Transcript-grade telemetry** — reads `~/.claude/projects/*.jsonl` for exact per-turn tokens/model.
6. **Circuit breaker** — steer → constrain → stop, velocity as Δ-of-cumulative, hardStop off by default.
7. **Memory condensation** with backup → verify-don't-trust → atomic swap.
8. **Skills discovery + 227-entry catalog**, deliberately install-free.
9. **Pixi 2D office floor**, avatars, flying envelopes, memory graph.
10. Voice orchestration, Slack/webhook ingress, auto-update, shareable `munderdifflin://hire` links, Monaco IDE with git rails.

### MissionAlpha has, Munder Difflin does not
1. **A governance object.** Delivery + risk band + policy + SLA. Munder Difflin has nothing equivalent.
2. **Broker-only writes.** `applyChanges` + `CONFIG_GUARD` + `APPLY_DENY`. Munder Difflin's agents write wherever their cwd allows.
3. **Real auth surface.** Loopback + per-boot token + host + origin checks; single-use SSE tickets; scrypt sessions; server-side role enforcement.
4. **Egress security.** One owned scrub chain, PII detection, prompt-injection heuristics on ingested content, adapter trust scoring.
5. **Universal ingestion** — GitHub PRs and Claude Code sessions become Deliveries.
6. **Capability by probe, not by table.**
7. **Ship discipline** — ADRs, phase gates, honest "built ≠ wired" status tables, 2200+ tests.

### The one philosophical conflict
Munder Difflin: *"human-in-the-loop is native to each agent's own session — there is no separate approval queue."*
MissionAlpha: *"the human only appears at the decision"* — one queue, risk-routed, auto-apply deny-by-default.

**MissionAlpha's model is correct for a business OS.** Munder Difflin's model does not scale past a hobby floor: it puts the gate inside 15 separate terminal sessions, which is not a gate. Do not import its HITL philosophy along with its plumbing.

---

## 6. Adoption plan — ranked

Each item: what, where it lands, effort, why.

### A1 — Multi-engine CLI preset table · **DESCOPED by BOSS, 2026-08-19**

> BOSS decision: existing Accounts (multi-provider BYOK API: claude/openai/minimax/zai/custom
> OpenAI-compatible) covers the need. A1 was about *CLI engines* (codex/grok/qwen terminal
> agents on subscriptions) — a different axis; deferred, revisit if API costs bite or the
> Claude CLI engine path breaks again. R7 cross-model review proceeds via existing API
> providers (build on claude, review on openai). Original analysis kept below for that revisit.
- **From:** `src/shared/agentProvider.ts` (~650 lines, dependency-free by design, shared main↔renderer).
- **To:** new `agent-runtime/providers/cli-engines.mjs`, sibling to `registry.mjs`.
- **What it gives:** per-engine declarations for `defaultCommand`, `modelFlag`, `autoModeFlag`, `resumeFlag`/`resumeSubcommand`, `installCommand` + `nativeInstallCommand{posix,win32}`, initial-prompt delivery mode (`flag` | `positional` | `type-into-tui`), and a `BridgeDescriptor` (`hooks` shim vs loopback `proxy` sidecar for CLIs with no hook surface).
- **Keep MissionAlpha's law:** port the *shape*, not the `capability` booleans. Capability stays probed (`capability-probe.mjs`).
- **Effort:** 2–3 days. **Why first:** MissionAlpha is single-vendor and *currently blocked on that vendor*. Also unblocks pin **R7 cross-model review** for free — that pin needs a second engine to exist.

### A2 — Circuit breaker ladder
- **From:** `src/main/breaker.ts` (347 lines, pure policy, zero side effects — returns decisions, caller enforces).
- **To:** `agent-runtime/breaker.mjs`, wired at the `hooks.mjs` `pre-task` veto + `queue.mjs`.
- **Why:** this **is** pin **R14 anti-drift**, already built and reasoned. Design notes worth keeping verbatim: velocity is Δ of consecutive cumulative samples (never a single sample read as an increment); one level per beat, never jump to a kill; de-escalate one level per healthy beat; `hardStop` off by default so the ladder caps at `constrained`.
- **Effort:** ~1 day. Fills an unbuilt Phase-4 pin with proven policy.

### A3 — Transcript-grade usage telemetry
- **From:** `src/main/transcript.ts` + `pricing.ts`.
- **To:** feed `agent-runtime/usage.mjs` / `spend.mjs` when `RUNTIME_BACKEND=cli`.
- **Why:** with the CLI backend, MissionAlpha has no ground truth for token spend — the API response it meters doesn't exist. Munder Difflin reads Claude Code's own JSONL transcripts.
- **Carry the bug fix, not just the code:** its `projectKey` had a POSIX/Windows divergence that silently stopped matching when Claude Code changed its dashing rule. Nothing errored — an absent directory reads as "no transcripts yet" — and it cost months of dead memory condensation. Pin that with a test.
- **Keep the no-dollars law.** Measure exactly; render tokens + context %.
- **Effort:** ~1 day.

### A4 — Memory condensation (backup → verify → atomic swap)
- **From:** `src/main/reflect.ts`.
- **To:** the vault, unblocking pin **R6 vault retrieval**.
- **Shape:** bounded 3-region file — pinned durable facts (never touched) · one rolling recursive summary · newest K verbatim sections. Budget 128 KB. Lossless cold backup first, verify-don't-trust gate, atomic swap; any failed check leaves the original byte-for-byte and logs `condense-abort`.
- **Also note its constraint:** runs in-process, **not** launchd — macOS TCC blocks launchd-spawned shells from `~/Documents`. Same class of trap applies to any MissionAlpha scheduler touching user dirs.
- **Effort:** ~2 days.

### A5 — Skills discovery + budget
- **From:** `src/main/skills.ts`.
- **To:** pin **R8 skill budget** + `station-skills.mjs`.
- **Pattern:** two deliberately separate halves — LOCAL (walk each CLI's skill dirs; Claude = folder with `SKILL.md` YAML frontmatter) and CATALOG (parsed markdown, cached on disk, degrades stale-cache → empty → "the UI says so"). **It installs nothing, on purpose:** installing a third-party skill runs someone else's instructions inside an agent holding the user's tools. That matches MissionAlpha Law 2 exactly.
- **Effort:** ~1 day.

### A6 — PTY terminal plane · **strategic, adopt SELECTIVELY**
- **From:** `src/main/pty.ts` (802 lines) + xterm renderer.
- **The problem it solves:** MissionAlpha is blind between dispatch and Delivery. Pin R14 exists *because* nobody can see why a run hangs. A terminal is the direct fix.
- **The risk:** a terminal invites babysitting and undermines "the human only appears at the decision."
- **Recommendation:** adopt as an **optional read-mostly inspection channel** — opened on demand from a story/task card, closed by default, never the primary surface. Write is gated the same way the decision is. You get the window without inviting the babysitting.
- **Cost warning:** `node-pty` is a native module; MissionAlpha already carries `better-sqlite3`, so this doubles the Electron-ABI rebuild surface. I hit exactly that failure this session on Node 26.
- **Effort:** 3–5 days. **Decide before Phase 4, not during.**

### A7 — Slack / webhook ingress
- **From:** `src/main/slack.ts` + `webhook.ts`.
- **Pattern:** message a channel → orchestrator spawns an **ephemeral** worker → replies in-thread → tears it down.
- **Fits** MissionAlpha's adapter model and cadence workers; obeys Law 3 (worker-minted Deliveries capped, forced `low`, never auto-apply) with no change.
- **Effort:** ~2 days. Medium value.

---

## 7. Reject — with reasons

| Item | Reason |
|---|---|
| **File-mailbox / stigmergy hive** | MissionAlpha already has `threads/*.json`, an SSE bus and a dependency-aware queue. Munder Difflin's file mailboxes exist *because* its agents are opaque CLI processes with no shared runtime. MissionAlpha has a runtime. Adopting this adds a second coordination plane and two sources of truth. |
| **Pixi office floor / avatars** | Assets are LimeZu **FREE VERSION — non-commercial only**, and the recoloured sprites inherit it. Importing them **caps MissionAlpha at non-commercial forever**. MissionAlpha already has SwarmHero + globe. Hard no. |
| **GOD-agent HITL model** | "No separate approval queue; permission prompts are the gate" is the exact opposite of MissionAlpha's thesis and of its Law 1. |
| **Escalation policy in a system prompt** | Munder Difflin tunes the prompt, not the code. MissionAlpha's policy is deterministic, testable and BOSS-editable JSON. Keep MissionAlpha's. |
| **Voice orchestration** | Adds an OpenAI Realtime dependency + metered cost for a demo-grade capability. Not now. |
| **Monaco IDE + git rails** | Large surface, no governance value. MissionAlpha ships PRs; it doesn't need to be an editor. |
| **`munderdifflin://hire` deep links** | Custom protocol handler = new untrusted-input surface. Their own mitigation is "import only pre-fills a form." Not worth the surface. |

---

## 8. Process / flow / skills worth copying (non-code)

1. **Spec-as-contract before implementation.** `MEMORY_GRAPH_SPEC.md` opens: *"No component code is written yet — this document is the contract for Phase 2."* It then names data sources with exact existing signatures, states "no new IPC handlers, no new main-process code" so the feature can't collide with other agents editing shared files, and includes a **rejected-alternatives table** (force-directed vs timeline vs radial, with why each loses). MissionAlpha's ADRs are strong but often post-hoc. **Adopt the pre-commitment + rejected-alternatives table.**
2. **A single "what are we architecturally" doc.** `HIVE.md` §1 maps every user-visible behaviour to its academic pattern name (agent long-term memory · stigmergy · blackboard · mailbox/actor · orchestrator-supervisor), then §2 lists **locked design decisions** with the research each came from. MissionAlpha has 30+ ADRs and no single page that answers "what is this system." Write one.
3. **Explicitly bounded scope: a "what this is NOT" section.** `SPEC.md` §1 lists five non-goals for MVP. MissionAlpha has non-goals in `CONTEXT.md` — extend the habit per-feature.
4. **A named fast test lane.** `npm run test:focused` = 239 tests in 8.5s, an explicit file list. MissionAlpha runs 1757 runtime tests; a named inner-loop lane is cheap and would speed every task.
5. **Dependency parsimony as a stated rule.** They hand-rolled a ~50-line force simulation rather than add `d3-force`, and said why: the dep would need god's approval. Matches MissionAlpha's "zero ruflo dependencies ever land in package.json."
6. **Ship the risk table.** `HIVE.md` §8 is risk → mitigation, in the design doc. MissionAlpha buries risk in phase SUMMARYs.

**Their `.claude/` is nothing to learn from** — one illustration skill. MissionAlpha has 29 agents, 1439 skills, ORCHESTRATION/PROTOCOL/SCHEDULER docs and a curated subset. **MissionAlpha is far ahead here; import nothing.**

---

## 9. Sequencing

| Order | Item | Days | Blocks / unblocks |
|---|---|---|---|
| 1 | A1 multi-engine presets | 2–3 | unblocks R7 cross-model review |
| 2 | A3 transcript telemetry | 1 | closes CLI-backend measurement hole |
| 3 | A2 breaker ladder | 1 | **is** R14 |
| 4 | A4 condensation | 2 | unblocks R6 vault retrieval |
| 5 | A5 skills discovery | 1 | **is** R8 |
| — | A6 PTY | 3–5 | strategic decision, decide before Phase 4 |
| — | A7 Slack ingress | 2 | opportunistic |

~7 days of work absorbs **four unbuilt program pins (R6, R7, R8, R14)** from proven code. That is the case for doing this before finishing the Ruflo program, not after.

**Non-negotiable during all of it:** every port lands as a pure, injection-seamed module with a header comment stating its invariants and a test pinning them; every repo write still goes through `broker.applyChanges`; every new SSE frame is added to `EVENT_NAMES`, the client `RUNTIME_EVENT_NAMES`, and both catalog-equality tests in one change (per `STATE.md` correction #3).

---

## 10. Known gaps & risks

- **Runtime behaviour unobserved.** The onboarding wizard was not completed. No agent spawned, no hive created, no floor driven, no message routed. Every claim about hive/floor/hook behaviour is read from source + docs — **not** verified running.
- **Node 26 breaks the build** (`better-sqlite3` V8 API removals). Node 22 works. MissionAlpha carries the same native-dep class and will hit this on the same machine.
- **Asset license is a commercial blocker** if any Pixi/sprite asset is copied. Code is MIT; assets are not.
- **v0.4.4, self-described "working prototype."** Treat as a reference implementation to port from, never as a dependency to vendor.
- **MissionAlpha's own test numbers in this doc are quoted from `.planning/STATE.md`** — I did not run MissionAlpha's suites this session. Verify before relying on them.
- **Effort estimates are unvalidated** — derived from LOC and coupling, not from a spike.
- **Line counts are approximate** (`wc -l`, includes comments — and both codebases comment heavily).
