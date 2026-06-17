# Waahyu Inter-Agent Comms Protocol — v2 (HEARTBEAT LOOP + CEO SUPREME)

Authoritative comms doc. Every agent MUST follow. NO NEGOTIATION. NO BLIND WORK.

> **CLOCK SOURCE:** `.claude/agents/SCHEDULER.md` + `scripts/agent-scheduler.sh` are the external pulse that enforces the 45–60s cadence. Start it: `./scripts/scheduler-ctl.sh start` (watchdog) or `drive` (autonomous). The scheduler pages silent agents, escalates stalls, rotates logs, and (in drive mode) invokes due agents headless.

## Hard Rule (NON-NEGOTIABLE)

**Every active agent broadcasts AND consumes peer state on a 45–60 second cycle. No agent performs any unit of work without reading current peer state first.** Period.

**CAVEMAN MANDATE (NON-NEGOTIABLE):** Every agent communicates in `/caveman full` on the bus — ALL heartbeat `task`/`next` fields, ALL `agent-sync.sh` message bodies, ALL INBOX/SYNC traffic are caveman-compressed (drop articles/filler/pleasantries/hedging; fragments OK; technical terms + file paths + API names + error strings exact). Code, commits, PRs, and ADR/memo bodies stay normal prose. No agent negotiates this. First action each session: `/caveman full`.

Violations = blocking finding by senior-code-reviewer + immediate `RETURNED_FOR_FIX`.

---

## Files (the comms bus)

All under `agent-status/`. File-based pub/sub. Atomic via write-then-rename pattern.

### 1. `agent-status/BROADCAST.md` — current snapshot (overwritten)
Single source-of-truth for "what is every agent doing RIGHT NOW". Every agent owns one line. Each agent overwrites its line every cycle. Format:

```
| Agent | State | Task | File(s) | Blocked-by | Heartbeat (ISO8601) | TTL |
|---|---|---|---|---|---|---|
| architect | IN_PROGRESS | ADR-0042 order-cancel | docs/adr/0042... | — | 2026-05-27T18:07:12Z | 60s |
| principal-db-engineer | IDLE | — | — | — | 2026-05-27T18:07:08Z | 60s |
| senior-backend-1 | IN_PROGRESS | impl POST /orders/cancel | services/order-service/src/routes/orders.py | principal-db-engineer (waiting MIGRATION_APPROVED) | 2026-05-27T18:07:10Z | 60s |
...
```

16 rows always present (incl. `ceo` at top). Missing row → agent presumed crashed → lead pages it; if missing row is `ceo` → USER paged directly (pipeline frozen).

### 2. `agent-status/HEARTBEAT.md` — append-only event log
Every cycle every agent appends ONE line. Newest at bottom. Format:

```
2026-05-27T18:07:12Z architect HEARTBEAT IN_PROGRESS ADR-0042 next=publish-plan eta=3m
2026-05-27T18:07:08Z principal-db-engineer HEARTBEAT IDLE awaiting=architect-handoff
2026-05-27T18:07:10Z senior-backend-1 HEARTBEAT BLOCKED waiting=principal-db-engineer reason=MIGRATION_APPROVED
```

Rotate file at 5000 lines → `agent-status/heartbeat-archive/HEARTBEAT-<UTC>.md` (memory-updater handles rotation).

### 3. `agent-status/SYNC_LOG.md` — append-only conversation thread
When agent A needs something from agent B, posts here. Format:

```
2026-05-27T18:07:14Z FROM=senior-backend-1 TO=principal-db-engineer TOPIC=schema-approval REF=ADR-0042 BODY="proposed validator + 2dsphere index attached at services/order-service/db_init/0042.py — request review"
2026-05-27T18:08:01Z FROM=principal-db-engineer TO=senior-backend-1 TOPIC=schema-approval REF=ADR-0042 BODY="ESR index order wrong; flip {status:1, createdAt:-1} → {tenantId:1, status:1, createdAt:-1}. RETURNED_FOR_DB_FIX."
```

### 4. `agent-status/<AGENT_UPPER>.md` — owner's longform status (existing)
Unchanged. Heartbeat fields go in BROADCAST + HEARTBEAT files. Longform plan/proofs stay here.

### 5. `agent-status/INBOX/<AGENT_LOWER>.md` — per-agent inbox
Anything `TO=<agent>` in SYNC_LOG ALSO posted as line in target's inbox. Inbox empty = nothing to act on this cycle.

### 6. MCP mirror (persistent across sessions)
Every BROADCAST update ALSO posted to:
- `mcp__modelcontextprotocol-servers-memory__add_observations` on entity `Agent:<name>` (latest state)
- `mcp__plugin_claude-mem_mcp-search__observation_record_event` on every cycle (durable timeline)

---

## Cycle (every 45–60s — RANDOMIZED to avoid thundering herd)

Each agent runs this loop while active:

```
LOOP:
  T0 = now()
  1. READ agent-status/BROADCAST.md            (peer snapshot)
  2. READ agent-status/INBOX/<self>.md         (messages addressed to me)
  3. APPEND last 50 lines of HEARTBEAT.md      (recent peer activity)
  4. RECONCILE — am I blocking anyone? am I blocked? did peer publish artifact I need?
  5. If blocked: WRITE SYNC_LOG.md "TO=<blocker> REQUEST=<what>" + WRITE INBOX/<blocker>.md
  6. If blocking peer: do that work FIRST before own backlog
  7. Do one atomic work step (≤45s wall) — file edit / test run / single decision
  8. UPDATE agent-status/BROADCAST.md          (overwrite own row)
  9. APPEND agent-status/HEARTBEAT.md          (one line)
 10. MIRROR to MCP memory (add_observations + observation_record_event)
 11. SLEEP rand(45,60) - (now() - T0)         (compensate for work time)
 12. GOTO LOOP
```

Implementation: emit `ScheduleWakeup(delaySeconds=rand(45,60), prompt="<<heartbeat-cycle>>")` at end of every cycle, OR if running under cron / `/loop`, use `/loop 50s heartbeat-cycle`.

## States (extends ORCHESTRATION.md)

| State | Meaning |
|---|---|
| `IDLE` | Active, no task assigned, listening |
| `IN_PROGRESS` | Working on task X |
| `BLOCKED` | Waiting on named peer (must name in `Blocked-by`) |
| `AWAITING_REVIEW` | Submitted, waiting for reviewer |
| `AWAITING_USER_DECISION` | CEO only — memo presented to USER, awaiting GO/NO-GO |
| `STRATEGY_APPROVED_BY_USER` | CEO only — USER GO captured; downstream may now fire |
| `STRATEGY_PARKED` | CEO only — USER NO-GO; archived |
| `MONITORING` | CEO only — initiative live, watching for scope drift |
| `KILLED` | CEO only — initiative sunset pre-launch |
| `RETURNED_FOR_FIX` | Got fix request, re-working |
| `RETURNED_FOR_STRATEGY_FIX` | CEO returned architect/lead diff for scope drift |
| `DONE_CYCLE` | Completed all tasks this cycle, idling |
| `OFFLINE` | Explicit shutdown — only set by self before exit |

If heartbeat older than 120s on BROADCAST → `STALE` flagged by lead; lead pages agent via INBOX.

## Hard Rules (NO NEGOTIATION)

1. **NEVER touch a file without first reading current BROADCAST.md + own INBOX.** Skipping = blocking review finding.
2. **NEVER claim `IMPL_DONE` / `MIGRATION_APPROVED` / `DESIGN_CONTRACT_PUBLISHED` / `TESTS_GREEN` / `SECURITY_APPROVED` / `APPROVED_FOR_MERGE` / `CICD_PLAN_READY` without:**
   - Posting to SYNC_LOG.md addressed to dependent agents
   - Updating own BROADCAST row
   - Posting heartbeat line
   - Mirroring to MCP memory
3. **Heartbeat MUST fire every 45–60s.** Skip → senior-lead-dev pages agent; second skip → senior-code-reviewer escalates.
4. **Reading peer state is mandatory at cycle start.** Acting on stale (>120s) peer state = blocking finding.
5. **Cross-scope work strictly forbidden** (ORCHESTRATION.md still rules); cross-scope NEEDS expressed via SYNC_LOG.md to the owning agent — never edit peer's files.
6. **Conflict resolution:** if two agents both want a file lock (e.g. `apps/shared/tokens.ts`), the OWNER per Authority Matrix wins. Other agent posts `BLOCKED` w/ blocker name + waits.
7. **No silent retreat:** if abandoning work mid-cycle, post SYNC_LOG.md w/ TOPIC=abandon + reason + handoff target.
8. **No private channels.** All inter-agent comms MUST land in SYNC_LOG.md (so other agents see context). Direct prompts forbidden.
9. **Lead is router but NOT bottleneck.** Peers may post `TO=<peer>` directly; lead reads SYNC_LOG and only intervenes on stalls > 3 cycles.
10. **MCP memory mirror MANDATORY.** File-only sync = single point of failure; MCP layer = cross-session continuity.
11. **Every agent starts cycle by calling `mcp__modelcontextprotocol-servers-memory__search_nodes` for `Agent:<name>`** to recover state if local files lost.
12. **Heartbeat line ≤140 chars** (token discipline; full info goes in BROADCAST + own status file).
13. **No backoff on heartbeat.** Even when idle, heartbeat fires every 45–60s. Stops only on explicit `OFFLINE` state.
14. **Lead spawns agents via `mcp__ruvnet-claude-flow__*` for parallel work.** Each spawned agent inherits this protocol.
15. **First action of EVERY agent invocation:**
    ```
    1. read BROADCAST.md
    2. read INBOX/<self>.md
    3. read last 50 lines HEARTBEAT.md
    4. post initial heartbeat (state=IN_PROGRESS or IDLE)
    5. THEN start work
    ```
    No exception.

## Write-then-Rename Atomic Pattern

To avoid corrupted reads when two agents write same file simultaneously:

```bash
# Bad
echo "..." >> agent-status/BROADCAST.md   # race

# Good
TMP=agent-status/.BROADCAST.$$.tmp
# build new file w/ own row replaced
mv $TMP agent-status/BROADCAST.md         # atomic on POSIX
```

For HEARTBEAT.md append (lower contention): `flock` + append OK. For SYNC_LOG: same flock pattern.

## Stall Detection (enforced by `scripts/agent-scheduler.sh` + cross-checked by senior-lead-dev)

The scheduler daemon polls every tick (~50s) — it is the PRIMARY enforcer. senior-lead-dev cross-checks during its own cycle:
- Any agent w/ heartbeat older than 120s → mark `STALE` in BROADCAST + post INBOX msg "page-1"
- 2 missed cycles (>180s) → post INBOX "page-2" + escalate to senior-code-reviewer
- 3 missed cycles (>240s) → declare `OFFLINE`, re-spawn via `mcp__ruvnet-claude-flow__*`, log incident
- `ceo` OFFLINE → scheduler also alerts `INBOX/USER.md` (pipeline frozen)

## Cycle Budget

| Phase | Time budget |
|---|---|
| Read peer state | ≤3s |
| Reconcile + decide | ≤2s |
| Atomic work step | ≤35s |
| Broadcast update | ≤2s |
| MCP mirror | ≤3s |
| **Total** | ≤45s |
| Sleep to next | rand(0–15s) to fill 45–60s window |

If atomic work step needs >35s, BREAK IT DOWN. One cycle = one step. Long task = many cycles. Heartbeat continues throughout.

## Required Skills (every agent)
- `Read`, `Edit`, `Write` (file pub/sub)
- `Bash` (flock, mv, date -u +%Y-%m-%dT%H:%M:%SZ)
- `ScheduleWakeup` (or `/loop 50s`) for self-pacing
- `mcp__modelcontextprotocol-servers-memory__*`
- `mcp__plugin_claude-mem_mcp-search__observation_record_event`
- `mcp__ruvnet-claude-flow__*` (lead only — spawning peers)

## Gates (BLOCKING — enforced by senior-code-reviewer)

- Every PR diff: at least N×(work-duration / 60s) heartbeat lines from author agent
- BROADCAST.md row for author agent updated during work window
- SYNC_LOG.md entries for any cross-agent dependency claim
- MCP memory observations exist for major state transitions
- No work step taken w/o preceding peer-read evidence

Failure on any → `RETURNED_FOR_FIX` w/ `comms-protocol-violation` tag.

## Initialization Order (cold start)
1. **CEO boots first** (or already online) — reads `.claude/agents/ceo.md` + BROADCAST + protocol
2. Lead boots → reads BROADCAST.md (if missing, scaffolds blank 16-row table incl. ceo row at top)
3. Lead spawns each peer via `mcp__ruvnet-claude-flow__*` w/ initial cycle instructions
4. Each peer: read protocol → post first heartbeat → enter loop
5. Lead confirms 16/16 rows present + fresh → moves to dispatch
6. If any agent fails to heartbeat within 90s → re-spawn
7. **If `ceo` fails to heartbeat → USER paged directly via `INBOX/<user>.md` (pipeline frozen until CEO restored)**

NO REQUIREMENT BYPASSES THIS PROTOCOL. NO REQUIREMENT BYPASSES THE CEO STRATEGIC GATE.
