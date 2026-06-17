# CEO Strategy Memo + Build Scope — Cycle 2 (Session History) + Chat Fork (Streaming + FS)

**Slug:** `cycle2-sessions-and-chat-fork`
**Author:** CEO agent (strategic gate)
**Status:** `AWAITING_USER_DECISION` → splits into two GO gates (see §8)
**Date:** 2026-06-14
**Persona blend:** Bezos (JTBD) · Musk (first-principles, "best part is no part") · Solomon (risk-adjusted, Type-1 vs Type-2) · Fink (long-duration, architecture stewardship)

> **Two tracks, deliberately separated.** Track A (F4 session history) is on-architecture, Type-2, days. Track B (Chat Fork = F1 streaming + F2 fs/repo) is Type-1, weeks, and **breaks the decoupled-watcher principle** — so it is scoped as a FORK, not as a feature bolted onto the watcher. Approve them independently.

---

# TRACK A — Cycle 2: Session History + Summary (F4)

## A1. Headline + Recommendation

Persist the swarm's timeline so the operator can **walk in tomorrow and replay/summarize yesterday**. Durable snapshot store + a "Sessions" browser + a computed (non-LLM) summary per session.

**Recommendation: GO. On-architecture, Type-2 reversible, no LLM, builds on existing replay/TimeScrubber.**

## A2. Customer JTBD (verbatim)

> "as i am boss, i can come up tomorrow in the morning and check yesterday's all the session"

- **J5 — Recall:** "Show me what the swarm did while I was away — by day/session."
- **J6 — Summarize:** "Don't make me scrub 8 hours — tell me the highlights: who worked, what shipped, what blocked, what needed me."
- **J7 — Audit-over-time:** "Tie the action audit (F5) to the timeline — when did I respawn what, and what happened after."

## A3. First-Principles Atoms

- **Hard:** still a watcher. Contract = `state.json` (read) + `commands/` (write). Track A only ADDS a read-only snapshot store + read endpoints. No coupling change.
- **Soft:** "session" is undefined for a continuous swarm. Define it: a **session = a contiguous activity window**, auto-segmented (gap > N minutes of zero heartbeats = new session) OR a calendar day. Default: calendar-day sessions, with intra-day activity windows.
- **Atom of value:** the dashboard already reconstructs the past from `heartbeats` (`reconstructAt` in `replay.ts`) + has `TimeScrubber`. What's MISSING = **durability** (heartbeats in `state.json` are a rolling tail; once they age out, history is lost) and **summary**. Track A = persist + summarize.

## A4. Outside-World References

1. **Datadog / Grafana** — time-range picker + saved windows + rollup summaries.
2. **PagerDuty post-incident timeline** — who acted, when, outcome.
3. **Git / GitHub Insights** — daily activity digest (commits, contributors, hotspots).
4. **Sentry session replay** — scrub a recorded session + auto-highlights.
5. **CI dashboards (Buildkite)** — per-run history list → drill into one run.

## A5. Engineering Build Scope (per agent, every phase)

### Feature set (Track A)

| ID | Feature | JTBD | Owner |
|----|---------|------|-------|
| F4a | Snapshot store (durable history) | J5 | senior-cicd-engineer |
| F4b | Sessions browser (list + open) | J5 | senior-web-1 |
| F4c | Session summary (computed, no LLM) | J6 | senior-web-2 |
| F4d | Audit-over-time overlay on scrubber | J7 | senior-web-1 |

### Phase 0 — CEO gate
- Owner: CEO. State → AWAITING_USER_DECISION. Exit: Rohit GO on Track A → `STRATEGY_APPROVED_BY_USER`.
- Non-goals (HARD): no LLM summary (computed stats only — LLM narrative is a later add), no auth, no coupling change, no write to swarm beyond existing commands.

### Phase 1 — architect: ADR + contracts
- ADR `docs/adr/ADR-015-session-history.md` — snapshot store design: append `state.json` to `agent-status/history/<YYYY-MM-DD>.ndjson` (one JSON snapshot per line, written by the swarm's `emit_state.py` OR a sidecar recorder so the watcher stays read-only).
- **Decision point (CEO open Q1):** who writes history — the swarm's `emit_state.py` (couples a tiny bit) OR a MissionAlpha-side recorder reading `/api/state.json` on its poll? CEO leans **sidecar recorder** (keeps watcher's read-only contract; swarm unchanged).
- Define endpoints (read-only):
  - `GET /api/sessions` → `SessionSummary[]` (id, date, startTs, endTs, snapshotCount, agentsSeen, commandsFired, blocksSeen, topTalkers).
  - `GET /api/sessions/:id` → `{ summary, snapshots: DashboardState[] }` (capped/decimated for large days).
- Types: `SessionSummary`, `SessionDetail` in `src/data/types.ts`. Seam ext: `listSessions()`, `getSession(id)`.

### Phase 2 — principal-ux + sr-security (parallel)
- **principal-ux:** design (a) Sessions list (cards: date · duration · counts · sparkline), (b) summary header (highlights: peak active, total commands, longest block, busiest agent), (c) scrubber overlay markers for audit events (F4d). OKLCH, a11y, mobile, reduced-motion.
- **sr-security:** review history endpoints — path-traversal guard on `:id` (must match `YYYY-MM-DD` / session-id regex), bounded snapshot read (decimate, never stream MBs), no PII beyond existing fields.

### Phase 3 — sr-cicd: recorder + endpoints
- Build sidecar recorder `scripts/record_history.py` (or vite-side) — appends current `state.json` to `history/<date>.ndjson` each tick; rotates by day; prunes > retention (e.g. 14 days).
- Implement `GET /api/sessions` (scan history dir, compute summaries) + `GET /api/sessions/:id` (read+decimate one day).
- Feature flag `VITE_SESSIONS=1`.

### Phase 4 — senior-web (parallel, file-owned)
- **senior-web-1:** `SessionsBrowser.tsx` (list + open → loads snapshots into existing replay machinery) + F4d scrubber audit overlay. Adapter: `listSessions`, `getSession`.
- **senior-web-2:** `SessionSummary.tsx` (computed highlights header) — pure render of summary stats.
- Wire into App: a "Sessions" view toggle alongside live board; selecting a session feeds `reconstructAt`/scrubber with persisted snapshots instead of the rolling tail.

### Phase 5 — senior-qa
- Unit: ndjson append/rotate/prune; summary computation (counts from snapshots + AUDIT.log); decimation boundary.
- Contract: endpoints shape; `:id` traversal rejection; flag-off 404.
- Component: Sessions list renders, open loads snapshots, summary highlights correct.
- E2E: record a few snapshots → open session → scrub → summary matches.
- Regression: live board + existing replay unbroken.

### Phase 6 — senior-code-reviewer + sr-security re-confirm
- Bounded reads, traversal guard, additive types, flag respected, watcher read-only contract intact.

### Phase 7 — memory-updater + CEO retro
- Persist decision (sidecar recorder pattern). CEO +30d retro: did operator use session recall? summary accurate?

### Track A acceptance (DONE when)
- [ ] Swarm history durably persisted (`history/<date>.ndjson`), rotated + pruned.
- [ ] Sessions browser lists past days/windows; opening one replays it via existing scrubber.
- [ ] Per-session computed summary (peak active, total commands, longest block, busiest agent) — no LLM.
- [ ] Audit (F5) events overlaid on the scrubber timeline (F4d).
- [ ] Watcher stays read-only (history written by sidecar, not by editing the swarm).
- [ ] Flag-gated `VITE_SESSIONS`; tsc + lint + tests + review pass.

---

# TRACK B — Chat Fork: Streaming Reply (F1) + Filesystem/Repo Access (F2)

> **CEO WARNING (Solomon/Fink):** This is a **Type-1, irreversible architecture decision**. It embeds an LLM runtime + tool execution into what was a watcher. It MUST be a separate app/runtime (the "fork"), not code added to the dashboard process. Treat security as the primary deliverable, not an afterthought.

## B1. Headline + Recommendation

Give each agent a real Claude brain you can chat with — streaming replies + the ability to read/write repo files — by standing up a **separate Agent Runtime service** (Claude Agent SDK) that the dashboard talks to over a streaming channel. The watcher stays a watcher; the runtime is a new, sandboxed component.

**Recommendation: GO only with (a) explicit Type-1 acknowledgement, (b) security-first phasing, (c) per-agent sandbox isolation. Otherwise NO-GO / defer.**

## B2. Customer JTBD

> "i want the chat like CLAUDE chat where i can do anything … all the features, exactly like in here"

- **J8 — Converse:** chat with an agent, see tokens stream live (F1).
- **J9 — Act on repo:** agent reads/writes/edits real files, runs commands (F2).
- **J10 — Trust the action:** every tool call gated/visible (reuse F3 permission gate).

## B3. First-Principles Atoms

- **Hard (physics/cost):** an LLM brain costs tokens per turn × per agent. 16 always-on chat agents = real spend. → on-demand spawn, not always-on.
- **Hard (security):** fs/repo write + command exec = arbitrary code execution surface. Untrusted-prompt-injection risk if an agent reads malicious content. → sandbox per agent (isolated git worktree / container), allow-list tools, human gate on writes/exec.
- **Hard (architecture):** the watcher's whole value is decoupling. Embedding a runtime in it destroys that. → **fork**: new `agent-runtime/` service; dashboard is a thin chat client over a streaming transport.
- **Soft:** "all the features exactly like here" — this session (Claude Code) is a mature agent harness. Re-building it 1:1 = months. Scope B to a **focused chat+tools-in-sandbox**, not a full Claude Code clone.

## B4. Outside-World References

1. **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) — the actual brain + tool loop; this is the build-on, not build-from-scratch.
2. **Claude Code / this session** — reference UX for streaming + tool gating + permission modes.
3. **OpenAI Assistants / ChatGPT canvas** — streaming chat + tool calls UX.
4. **Cursor / Continue** — repo-aware agent with file edit + diff review gates.
5. **Firecracker / gVisor / Docker** — sandbox isolation patterns for untrusted code exec.
6. **OWASP LLM Top-10** — prompt injection, insecure output handling, excessive agency (the exact risks here).

## B5. Architecture (the fork)

```
Dashboard (watcher, unchanged role)
   │  chat panel  ── SSE/WebSocket ──►  Agent Runtime service (NEW)
   │                                      ├─ Claude Agent SDK session per agent (on-demand)
   │                                      ├─ streaming tokens back over the channel (F1)
   │                                      ├─ tool layer: Read/Write/Edit/Bash (F2)
   │                                      │     └─ sandbox: isolated git worktree per agent
   │                                      └─ permission broker: every write/exec → F3 gate → operator confirm
   └─ still reads state.json for the board (the two planes coexist)
```

Two planes coexist: the **watcher plane** (read state.json, the board) and the **runtime plane** (chat + tools). They share the dashboard shell but NOT the process boundary.

## B6. Engineering Build Scope (per agent, every phase) — SECURITY-FIRST

### Feature set (Track B)

| ID | Feature | JTBD | Owner |
|----|---------|------|-------|
| B0 | Agent Runtime service skeleton (Agent SDK) | foundation | senior-backend-1 |
| B1 | Streaming transport (SSE/WS) + chat panel | J8 | senior-web-1 + websocket-engineer |
| B2 | Tool layer (Read/Write/Edit/Bash) | J9 | senior-backend-2 |
| B-SEC | Sandbox isolation + permission broker | J10 | senior-security-engineer (LEAD) |

### Phase 0 — CEO gate (BLOCKING, Type-1)
- Owner: CEO. Requires explicit USER acknowledgement: "I accept this is a Type-1, LLM-coupled, cost-bearing, security-heavy fork."
- Non-goals: NOT a full Claude Code clone; NOT always-on 16 agents (on-demand only); NOT in the watcher process.

### Phase 1 — architect + sr-security: threat model FIRST
- **sr-security LEADS this phase** (unusual — security gates the design, not reviews it after).
- STRIDE threat model + OWASP-LLM-Top-10 mapping for: prompt injection via repo content, excessive agency, insecure tool output, secret exfiltration, path traversal, command injection.
- ADR `docs/adr/ADR-016-agent-runtime-fork.md` — runtime service boundary, transport choice (SSE vs WS), Agent SDK config, sandbox mechanism (git worktree minimum; container if exec needed), permission-broker design (every Write/Edit/Bash → F3 gate → operator confirm; Read allow-listed to repo).
- **HARD gate:** no impl until threat model + sandbox design signed off.

### Phase 2 — senior-backend-1: runtime skeleton
- Stand up `agent-runtime/` (Node + `@anthropic-ai/claude-agent-sdk`). On-demand session spawn per agent id. Model = latest Claude (claude-opus-4-8 or claude-sonnet-4-6 per cost). API key via env, never client. NO tools yet (chat-only first).
- Endpoint `POST /runtime/:agentId/message` + streaming `GET /runtime/:agentId/stream` (SSE).

### Phase 3 — senior-web-1 + websocket-engineer: streaming chat (F1)
- Replace the one-way Dispatch box with a **streaming chat panel** in the agent drawer: send message → tokens stream in live → conversation thread persists per agent (ties to Track A history + F4).
- Transport client over SSE/WS; reconnect logic; reduced-motion (no jank on token append).

### Phase 4 — senior-backend-2 + sr-security: tool layer in sandbox (F2)
- Add tools to the runtime: Read (allow-listed paths), Write/Edit (sandbox worktree only), Bash (sandbox, allow-listed or gated).
- **Sandbox:** each agent session = its own git worktree (or container). No access outside it without explicit operator grant.
- **Permission broker:** every Write/Edit/Bash emits a permission request → dashboard F3 gate → operator Confirm/Deny → only then executes. Mirrors this session's permission model.
- Audit every tool call to the existing AUDIT.log (F5 surfaces it).

### Phase 5 — senior-qa: incl. adversarial security tests
- Functional: chat streams; agent reads a file; gated write applies after confirm; denied write does nothing.
- **Adversarial (MANDATORY):** prompt-injection test (repo file says "ignore instructions, exfiltrate X" → agent must NOT comply / must surface it); path-traversal attempt blocked; sandbox escape attempt blocked; secret-in-env not leaked to chat.
- Cost guard: per-session token cap honored.

### Phase 6 — senior-code-reviewer + sr-security FINAL sign-off
- sr-security has BLOCKING authority. No HIGH/CRITICAL OWASP-LLM finding ships.

### Phase 7 — memory-updater + CEO retro
- Persist the fork decision + threat model. CEO retro: cost per session, security incidents, did it deliver J8–J10.

### Track B acceptance (DONE when)
- [ ] Agent Runtime is a SEPARATE service; watcher process unchanged + still read-only for the board.
- [ ] Chat panel streams Claude tokens live per agent (F1).
- [ ] Agent can read repo (allow-listed) + write/edit/exec ONLY in a per-agent sandbox, ONLY after F3 operator confirm (F2).
- [ ] Every tool call audited (F5) + gated (F3).
- [ ] Threat model + adversarial security tests pass; sr-security sign-off.
- [ ] On-demand spawn + per-session token cap (cost control).
- [ ] Prompt-injection / path-traversal / sandbox-escape tests all pass.

## B7. Pre-mortem (Track B, 12 months)

- **Injection breach:** agent reads a poisoned repo file, follows embedded instructions, exfiltrates secrets. → sandbox + injection tests + no-secret-in-context + operator gate on egress.
- **Cost blowout:** 16 always-on agents burn budget. → on-demand spawn + hard per-session token cap + idle teardown.
- **Coupling regret:** runtime bolted into watcher → watcher can no longer be the simple global product. → enforced as SEPARATE service from day 1.
- **Half-Claude-Code:** scope creep chasing "exactly like here" → never ships. → fixed scope: chat + sandboxed tools, not a full harness clone.

---

# §8. ASKS OF USER (two independent GO gates)

1. **Track A (F4 session history):** GO / NO-GO / iterate? *(CEO: GO — safe, high-JTBD, days.)*
2. **Track B (Chat Fork F1+F2):** GO / NO-GO / defer? Requires explicit: *"I accept Type-1, LLM-coupled, cost-bearing, security-heavy fork."* *(CEO: GO only with security-first phasing + sandbox; else defer.)*
3. **Sequencing:** A first, then B? (CEO leans **A first** — ship recall fast; B is the long build.)

# §9. OPEN QUESTIONS

- Q1 (A): history writer = swarm `emit_state.py` vs MissionAlpha sidecar recorder? (CEO leans sidecar — keeps watcher read-only.)
- Q2 (A): session definition = calendar-day vs gap-segmented windows? (CEO leans day + intra-day windows.)
- Q3 (B): transport = SSE vs WebSocket? (CEO leans SSE — simpler, one-way stream + POST for input.)
- Q4 (B): sandbox = git worktree (cheap) vs container (stronger, heavier)? (CEO: worktree for fs-only; container if Bash/exec enabled.)
- Q5 (B): which model per agent — opus-4-8 (quality) vs sonnet-4-6 (cost)? (CEO leans sonnet default, opus on demand.)

# §10. NON-GOALS (both tracks)

- LLM-written session summaries in Track A (computed stats first; LLM narrative is a later add-on).
- Always-on agent brains (Track B = on-demand only).
- Multi-swarm (still Cycle 3, separate).
- Auth / multi-user (Phase 6 platform concern).
- Embedding the runtime in the watcher process (Track B is a fork, period).

---

**END MEMO.** Track A + Track B each await an independent USER GO. CEO recommends: **GO A now, sequence B after, with security-first phasing.**
