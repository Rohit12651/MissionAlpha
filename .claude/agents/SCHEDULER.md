# Waahyu Heartbeat Scheduler — the loop driver

> Companion to `.claude/agents/PROTOCOL.md`. PROTOCOL defines WHAT each agent does per cycle.
> SCHEDULER defines WHO fires the clock + enforces the 45–60s cadence when no human is typing.

## Why a scheduler

Claude Code agents do not self-run on a wall-clock timer. The heartbeat protocol needs an external pulse. The scheduler daemon IS that pulse. It runs forever, ticks every ~50s, and:

1. **Enforces cadence** — anything that should heartbeat but went silent gets paged.
2. **Detects stalls** — 3-stage escalation (page-1 → page-2 → OFFLINE+respawn).
3. **Rotates logs** — HEARTBEAT.md archived at 5000 lines.
4. **Self-heals** — declares dead agents OFFLINE, requests re-spawn.
5. **Optionally drives agents** — `AGENT_DRIVER=claude` invokes `claude -p` headless per due agent (off by default — cost).

Cron CANNOT do sub-60s. The daemon self-loops with `sleep`. launchd (macOS) / systemd (Linux) keep it alive.

## Files

| File | Role |
|---|---|
| `scripts/agent-scheduler.sh` | The daemon loop. `--once` for single tick. |
| `scripts/scheduler-ctl.sh` | start / stop / restart / status / once / tail / drive |
| `scripts/agent-heartbeat.sh` | per-agent: update BROADCAST row + append HEARTBEAT |
| `scripts/agent-sync.sh` | per-agent: post SYNC_LOG + deliver to INBOX |
| `infrastructure/launchd/com.waahyu.agent-scheduler.plist` | macOS keep-alive |
| `infrastructure/systemd/waahyu-agent-scheduler.service` | Linux keep-alive |
| `agent-status/SCHEDULER.md` | live scheduler status (rewritten each tick) |
| `agent-status/.scheduler.pid` | daemon PID |
| `agent-status/scheduler.out.log` | daemon stdout/stderr |

## Run it

```bash
# foreground test — one tick
./scripts/scheduler-ctl.sh once

# start daemon (detached, PID-tracked)
./scripts/scheduler-ctl.sh start

# watch the pulse
./scripts/scheduler-ctl.sh tail

# status
./scripts/scheduler-ctl.sh status

# stop
./scripts/scheduler-ctl.sh stop

# start WITH headless agent invocation (COST — invokes claude -p per due agent)
./scripts/scheduler-ctl.sh drive
```

### Persistent (survives reboot / login)
macOS:
```bash
cp infrastructure/launchd/com.waahyu.agent-scheduler.plist ~/Library/LaunchAgents/
launchctl load -w ~/Library/LaunchAgents/com.waahyu.agent-scheduler.plist
```
Linux:
```bash
cp infrastructure/systemd/waahyu-agent-scheduler.service ~/.config/systemd/user/
systemctl --user enable --now waahyu-agent-scheduler
```

## Tick algorithm

```
every TICK_SECONDS (±jitter, clamp 30..60):
  for each BROADCAST row where state NOT in {OFFLINE, STRATEGY_PARKED, KILLED}:
    age = now - heartbeat_ts
    if age >= 240s  -> mark OFFLINE + SYNC respawn-request (+ USER alert if ceo)
    elif age >= 180s -> page-2 to agent + escalate to senior-code-reviewer
    elif age >= 120s -> mark STALE + page-1 to agent
    elif age >= 50s  -> agent is "due"; if AGENT_DRIVER=claude, invoke headless cycle
  rotate HEARTBEAT.md if > 5000 lines
  rewrite agent-status/SCHEDULER.md + append scheduler TICK line
```

## Two operating modes

### Mode A — Watchdog (default, `AGENT_DRIVER=none`)
Scheduler only watches + pages + rotates. Agents are driven by YOU invoking them in chat (each agent runs its cycle when you spawn it, posts heartbeat via the helper scripts, schedules its own next wake via `ScheduleWakeup`). Scheduler is the safety net that catches silence.

**Use when:** interactive dev, you drive the team turn-by-turn, want stall-detection + log hygiene without burning tokens.

### Mode B — Autonomous driver (`AGENT_DRIVER=claude`, `scheduler-ctl.sh drive`)
Scheduler actively invokes `claude -p "<<heartbeat-cycle>> ... agent X ..."` headless for every due agent each tick. Agents truly run on the wall clock with no human in the loop.

**Use when:** unattended runs, overnight progress, true always-on swarm. **COST WARNING:** 16 agents × every 50s = ~1150 invocations/hr. Gate behind budget. Requires `claude` CLI on PATH + `--dangerously-skip-permissions` (already in the driver prompt) or a permissions allowlist.

## Tuning (env vars)

| Var | Default | Meaning |
|---|---|---|
| `TICK_SECONDS` | 50 | base cadence (clamped 30..60) |
| `STALE_1` | 120 | page-1 threshold |
| `STALE_2` | 180 | page-2 + escalate |
| `STALE_3` | 240 | declare OFFLINE + respawn |
| `MAX_HEARTBEAT_LINES` | 5000 | rotate threshold |
| `AGENT_DRIVER` | none | `claude` = headless invoke due agents |
| `AGENT_DUE_SECONDS` | 50 | agent "due" age for driver mode |

## Safety / gates

- Single-instance via `mkdir` lock (`agent-status/.sched.lock`); stale lock force-cleared after ~6s.
- Atomic BROADCAST + SCHEDULER writes (write-then-rename).
- Scheduler NEVER writes agent business logic — only state transitions + pages.
- `ceo` going OFFLINE always alerts USER inbox (pipeline frozen).
- Driver mode requires explicit `drive` subcommand or `AGENT_DRIVER=claude` — never auto-on.

## Verified

`scheduler-ctl.sh once` tick OK. Stall path proven: ceo @300s → page-3 → OFFLINE → USER `pipeline-frozen` alert; fresh architect → no page.
