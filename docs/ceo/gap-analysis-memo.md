# CEO Memo — MissionAlpha Dashboard: What's Missing for the Operator

> Audience: USER (Rohit). Author: CEO agent. Date: 2026-06-04.
> Status: AWAITING_USER_DECISION. Strategy only — nothing built.
> Scope: audit the live read-only command tower (Phases 0–5 done) and rank the
> highest end-user-value gaps against our actual local file-based architecture.

---

## 1. Headline + Recommendation

We built a beautiful **glance** tool. We have not yet built a **work** tool.
The current dashboard answers *"is the swarm alive and pretty?"* in 2 seconds —
which is genuinely valuable for an always-on wall display. But the moment an
operator wants to *do their job* — figure out **why** an agent is stuck, see
**what it has been doing**, or **act** on a problem — the dashboard goes silent
and they fall back to `tail -f agent-status/HEARTBEAT.md` in a terminal.

**My recommendation: build the "Agent Drill-Down Drawer" + "Why-Stuck" first.**
It is the single highest-value, cheapest, fully-local thing we can ship, and it
is the feature that converts the dashboard from a demo into a tool an operator
keeps open all day. Details in §6.

---

## 2. Who the End Users Actually Are (personas + JTBD)

The dashboard is not for "a viewer". It is for someone who **owns** this swarm
and is responsible when it stalls. Three real personas, ranked by frequency:

**P1 — The Operator-Owner (Rohit himself, 80% of sessions).**
Runs the swarm, has it open on a second monitor, glances at it between other
work. **JTBD:** *"Tell me the instant something needs me, and when it does, let
me understand and resolve it without leaving this screen."* Today: the NEEDS-YOU
pill tells them *that* something needs them. It does not tell them **what to do
about it**, and the "focus" click literally just scrolls a card into view
(`App.tsx` comment: *"No write-back path exists… this scrolls the card into
view"*). The job ends at "I see the problem." It should end at "I fixed it."

**P2 — The 2am Debugger (the painful 15% — but the highest-stakes).**
Pipeline is frozen. CEO went OFFLINE (we can see this literally happened in the
live feed: *"CEO OFFLINE (stale 300s). Pipeline frozen."*). **JTBD:** *"Show me
the sequence of events that led here so I can find the root cause."* Today: the
dashboard shows the **current** frozen state with zero **history of how we got
here**. The full story exists in `HEARTBEAT.md` and `SYNC_LOG.md` — the UI just
doesn't expose the trail. This persona is forced back to the terminal every time.

**P3 — The Reviewer / Eng-Lead (the occasional 5%).**
Wants to assess throughput, find the bottleneck agent, see the blocked-chain.
**JTBD:** *"Where is the swarm losing time, and who is blocking whom?"* Today:
`blockedBy` is shown as a flat chip on one card; there is no chain
(QA→web-1→…), no throughput-over-time, no "this agent has been stale for 2h"
trend. They can see a snapshot, never a pattern.

**The unifying insight (first-principles):** the swarm bus already records a
rich, append-only **event history** per agent (every heartbeat, every
state-transition, every SYNC message with full body, every inbox item, every
stall-escalation with `next=` and `eta=` fields). The `emit_state.py` step then
**flattens** all of it into a single current-snapshot for the glance view. We are
sitting on a Temporal-grade event log and showing only the last frame of it.

---

## 3. First-Principles: What Each Persona NEEDS To Do That They Can't

| Persona | Wants to… | Current dashboard | Data already exists? |
|---|---|---|---|
| P1 Operator | **Act** on a stuck/stale agent (nudge, re-spawn, acknowledge) | Read-only; "focus" only scrolls | ❌ no command channel (one-way) |
| P1 Operator | Know **what to do** when NEEDS-YOU fires | Pill says "needs you", no next-step | ✅ `next=` field in heartbeat, unused |
| P2 Debugger | See the **timeline** of how we got to "stuck" | Only current frame | ✅ full HEARTBEAT + SYNC history |
| P2 Debugger | See **why** an agent is stale (last msg, last error, stall page) | Just a red breathing glow | ✅ SYNC bodies + scheduler stall pages |
| P2 Debugger | **Scrub back in time** / replay the swarm 10 min ago | No history at all | ✅ heartbeats[] timeline in state.json |
| P3 Reviewer | See the **blocked-chain** (A→B→C) | Flat single `blockedBy` chip | ✅ blockedBy is transitive in data |
| P3 Reviewer | See **throughput / trend** (states over time) | Single sparkline ribbon | ✅ heartbeats[] is a time series |
| All | **Drill into one agent**: full status, inbox, recent messages | No drawer; card is the terminus | ✅ all of it in the bus |
| All | **Search / filter** the feed by agent/topic | Feed is collapsed last-3 | ✅ full feed in state.json |

The pattern is unmistakable. The dashboard's ceiling is **"glance"**. Every
persona's real job needs one of three things it lacks: **drill-down**,
**history/time**, or **act**.

---

## 4. Outside-World References — How Best-in-Class Tools Solve This

Five+ references; the agent-native tools (LangSmith, Langfuse, AgentOps,
Temporal) are the most directly relevant because they watch *autonomous
multi-step systems* exactly like ours.

1. **AgentOps** — built specifically for *multi-agent* systems; its signature
   feature is **time-travel debugging / trace replay** — track collaboration and
   interaction between agents, then replay the run. This is the single most
   relevant precedent: a multi-agent tower whose core value is *replaying what
   the agents did*, not just showing the current frame.
   ([aimultiple](https://aimultiple.com/agentic-monitoring), [akira.ai](https://www.akira.ai/blog/langsmith-and-agentops-with-ai-agents))
2. **Langfuse** — **hierarchical traces** capture every call/tool/step, filterable
   by session, cost, latency, metadata; you *inspect and debug complex logs and
   sessions*. The unit of value is the **drill-into-one-trace** view — exactly the
   per-agent drawer we lack.
   ([langfuse.com](https://langfuse.com/), [github](https://github.com/langfuse/langfuse))
3. **LangSmith** — *"see exactly what your agent is doing step by step"* and
   auto-cluster traces to surface **common failure modes**. Confirms the
   highest-value surface is step-by-step history + failure-mode detection.
   ([langchain.com](https://www.langchain.com/langsmith/observability), [docs](https://docs.langchain.com/langsmith/observability))
4. **Temporal Web UI** — for *durable execution* it exposes the full **Event
   History** per workflow and lets you **inspect each event and the state at any
   point in time**, and **reset a stuck workflow** from the UI. Our `HEARTBEAT.md`
   *is* an event history; we should expose it like Temporal does — and "re-spawn
   a stalled agent" is our analog of Temporal's "reset".
   ([Temporal docs](https://docs.temporal.io/workflow-execution/event), [debugging](https://www.xgrid.co/resources/temporal-event-history-debugging/))
5. **PagerDuty** — every incident has a **Timeline tab** (every status change +
   action + notification), and **acknowledge** *claims ownership and halts
   escalation*. This is the model for our stall-escalation flow: when the
   scheduler pages an agent, the operator should be able to **acknowledge** it so
   it stops nagging. We already *generate* these escalation events — we just
   don't let anyone act on them.
   ([PagerDuty incidents](https://support.pagerduty.com/main/docs/incidents), [escalation](https://support.pagerduty.com/main/docs/escalation-policies))
6. **Datadog / Grafana** — **event overlay / annotations on the timeline** so you
   *correlate an action with a change in behavior*, plus an **audit trail** of
   who-did-what-when. Maps directly to overlaying scheduler ticks / stall pages
   on our heartbeat ribbon so a spike in "stale" lines up with a visible cause.
   ([Datadog audit](https://docs.datadoghq.com/account_management/audit_trail/), [Grafana viz](https://grafana.com/integrations/datadog/visualize/))

**Convergent finding:** every serious tool exposes the same three things our
dashboard does not — **(A) per-entity drill-down trace, (B) time/history &
replay, (C) act-on-it (ack / reset / escalate).** We have the *data* for A and B
fully on our local model. C is the one that needs a command channel.

---

## 5. Ranked Gaps — Value × Feasibility on OUR Architecture

Honest feasibility scoring against the real constraints: **READ-ONLY** (state.json
is one-way, no write-back), **SINGLE swarm**, **LOCAL** (no auth/hosting). I do
not hand-wave which gaps cross the Phase-6 line.

### GROUP A — High value + buildable NOW (pure read-only, local, on current data)

| # | Capability | Pain it kills | Effort | Fits read-only? |
|---|---|---|---|---|
| **A1** | **Agent Drill-Down Drawer** — click a card → side panel with full status, the agent's own heartbeat timeline, its recent SYNC messages (full body, not truncated), its inbox, its `next=`/`eta=` | "I can see it's stuck but not what it was doing or saying" — kills the terminal fallback for P1/P2 | **S–M** | ✅ 100% — all data in state.json/bus, just a new view |
| **A2** | **"Why Stuck" / Blocked-Chain + last-event** — render the transitive blockedBy chain (QA→web-1→…) and, for any stale/blocked agent, surface its last heartbeat line + last SYNC body + any scheduler stall-page | P3 finds the bottleneck instantly; P2 sees the proximate cause without grepping | **S** | ✅ — blockedBy + feed already present |
| **A3** | **Time Scrubber / Mini-Replay** — a horizontal timeline of the `heartbeats[]` array; drag to a past moment → board re-renders the swarm *as it was then*. Overlay scheduler ticks + stall pages as annotations (Datadog/Temporal pattern) | P2's #1 job: "show me how we got to frozen." Turns the demo globe into a debugging instrument | **M** | ✅ — `heartbeats[]` is already a time series in state.json; needs richer emit (see note) |
| **A4** | **Searchable / filterable full feed + transition log** — expand LiveFeed into a full, filter-by-agent/topic, full-body event log (the missing "what was actually said") | P3 audit; P2 root-cause; removes "collapsed last-3" ceiling | **S** | ✅ — full feed in state.json |
| **A5** | **Stall / NEEDS-YOU actionability (read-only version)** — when NEEDS-YOU or a stall fires, show the exact next-step (`next=` field) + the *copy-paste re-spawn command* the protocol already specifies, so the operator acts in one keystroke even without a write channel | P1's core loop: "needs you" → "here's exactly the command to fix it" | **XS–S** | ✅ — we don't write back; we hand the operator the command |

> **Note on A3 fidelity:** `heartbeats[]` currently carries only `{ts, agent, state}`.
> True frame-accurate replay (task/file/blockedBy at each tick) needs `emit_state.py`
> to snapshot a bit more per tick, or to retain N recent full snapshots. That is a
> **small scheduler/emitter change, still fully local** — not Phase 6. Worth calling
> out so we don't promise frame-perfect replay on day one.

### GROUP B — High value but needs the Phase-6 backend (command channel / push / persistence)

| # | Capability | Why it needs Phase 6 |
|---|---|---|
| **B1** | **Act on agents: acknowledge stall, nudge, re-spawn, pause** (PagerDuty "ack", Temporal "reset") | Requires a **write-back command channel** to the swarm — the one thing our one-way model explicitly lacks. This is the true ceiling-breaker but it is architecturally Phase 6. |
| **B2** | **Real-time push (SSE/WebSocket)** instead of 2s poll | LiveStreamAdapter + gateway — already named as Phase 6. Cheap *latency* win, but needs the server. |
| **B3** | **Durable long-history / cross-session analytics** (throughput trends over days, MTTR per agent, "how often does CEO stall") | Local state.json is a rolling snapshot; deep trend history needs a persistence layer (DB/store) = Phase 6. Short in-session trend is A3; *durable* trend is B3. |
| **B4** | **Multi-swarm registry** (watch several swarms, switch between them) | Explicitly Phase 6 (multi-tenant). |

### GROUP C — Nice-to-have (do later / low value-per-effort)

- C1 Notifications when NEEDS-YOU fires (browser/desktop notification) — small, but only matters once the operator *isn't* already staring at it. Pairs well with A5.
- C2 Keyboard navigation / command palette (jump to agent, ⌘K) — power-user polish.
- C3 Per-agent "mute/pin" personalization — only matters at multi-swarm scale.
- C4 Export / share a snapshot (PNG/permalink) — depends on Phase-6 hosting to be truly useful.
- C5 Cost/token telemetry per agent (the LangSmith lens) — high value *if* we ever instrument token spend, but that data doesn't exist in our bus today. Out of scope until we emit it.

---

## 6. Top-3 Recommendations (through the four CEO lenses)

Lenses: **Bezos** (customer obsession), **Musk** (first-principles, delete the
unnecessary), **Solomon** (risk), **Fink** (durability).

**#1 — A1 Agent Drill-Down Drawer + A2 Why-Stuck (build together).**
- *Bezos:* directly serves all three personas' core JTBD — it's the single most
  customer-obsessed move. It's the difference between "I see a problem" and "I
  understand the problem."
- *Musk:* zero new infrastructure, no new data — we already emit everything; we
  are just *not rendering it*. The cheapest possible path to the biggest value.
  "The best part is no part" — no backend required.
- *Solomon:* near-zero risk; purely additive read-only view, can't break the
  glance experience.
- *Fink:* durable — the drawer is the surface every future feature (replay,
  act-on-it) plugs into. Build it once, extend forever.
- **Type 2 (reversible).** Reversible, additive, local. Ship in days.

**#2 — A3 Time Scrubber / Mini-Replay.**
- This is the AgentOps/Temporal core feature and it is the #1 job of the 2am
  debugger. *Musk caveat:* honestly scope it — frame-accurate replay wants a
  small emitter change (the §5 note). Ship "state-over-time scrub + annotated
  ribbon" first (fully local now), upgrade fidelity later. *Fink:* this is the
  feature that makes the dashboard *durably* differentiated vs a kanban.

**#3 — A5 Actionable NEEDS-YOU (read-only, command-handoff version).**
- *Bezos:* closes P1's loop cheaply *today* without waiting for Phase 6. The
  operator gets the exact `scripts/...` re-spawn command to copy-paste.
- *Solomon:* it's the honest bridge to B1 — we deliver the *act* job's value
  without taking on the write-channel risk yet. Low cost, de-risks the Phase-6
  decision by proving demand first.

I am deliberately **not** putting B1 (write-back commands) in the top 3 despite
it being the ultimate ceiling-breaker — because it crosses the architecture line
and deserves its own Phase-6 GO. A5 lets us test that demand cheaply first.

---

## 7. Pre-Mortem — Why This Dashboard Gets Abandoned After the Demo

Imagine it's 30 days from now and the dashboard is closed, not open. The
obituary reads:

> *"It was gorgeous for the first three opens. Then the operator realized that
> every time something actually went wrong, they still had to switch to a
> terminal to find out why and to fix it. The pretty globe didn't help them at
> 2am. So they stopped opening the dashboard and went back to `tail -f`."*

**Failure mode:** a glance-only tool has a *novelty half-life*. Once you've seen
the globe spin, a read-only status board gives you nothing on the second day
that you couldn't get from the terminal — and the terminal lets you *act*. The
dashboard competes with `tail -f` and **currently loses on the only axis that
matters when it counts: doing something about a problem.**

**The ONE missing thing that makes an operator keep it open all day:**

> **When something needs the operator, the dashboard must let them go from
> "I see it" → "I understand it" → "I acted on it" without leaving the screen.**

The cheapest, fully-local first bite of that is **A1+A2 (drill-down + why-stuck)**
— it kills the "switch to terminal to understand" half of the problem today. The
second bite is **A5** (hand them the fix command). The full cure is **B1**
(act-in-place), which is the real reason Phase 6 will eventually be worth it.

A pretty dashboard gets opened. A dashboard that **resolves your 2am incident**
gets *left* open.

---

## 8. Ask of USER — Explicit GO / NO-GO

Which do you want built next? My ranked recommendation:

- **[ ] GO — Build A1 + A2** (Drill-Down Drawer + Why-Stuck/Blocked-Chain).
  *My #1 pick. Cheapest, biggest, fully local, no architecture change.*
- **[ ] GO — Add A3** (Time Scrubber / annotated replay) — alone or after A1+A2.
- **[ ] GO — Add A5** (Actionable NEEDS-YOU with copy-paste re-spawn command).
- **[ ] DECIDE — Open the Phase-6 question** (B1 write-back command channel) — the
  real ceiling-breaker, but a separate architecture GO. A5 first to prove demand?
- **[ ] NO-GO / iterate** — different priority, or want me to re-scope.

On your GO I will write the strategy memo for the chosen gap (3 options, scored),
return for your decision, then dispatch architect + senior-web-1.

## 9. Open Questions (where I'm uncertain)

1. Is the **2am-debugger** persona frequent enough to justify A3's effort, or is
   the operator's day-to-day (A1) the only one that matters near-term?
2. How much do you actually want **write-back (B1)** — is read-only a deliberate
   safety boundary you want to keep, or just a v1 limitation?
3. For A3 replay: is "state-over-time scrub" (free now) enough, or do you want
   frame-accurate replay (small emitter change) from day one?

---

*Appendix — feasibility constraints honored: read-only (one-way state.json),
single swarm, local (no auth/hosting). Groups B/C honestly flagged as
Phase-6/deferred. All Group-A items verified against the live data contract in
`src/data/types.ts` + `agent-status/state.json`.*
