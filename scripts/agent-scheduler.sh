#!/usr/bin/env bash
# Waahyu Agent Scheduler — the heartbeat driver daemon.
# Ticks every TICK_SECONDS (default 50). Each tick:
#   1. Parse agent-status/BROADCAST.md
#   2. For each non-OFFLINE agent: compute heartbeat age
#        > STALE_1 (120s)  -> page-1 into INBOX + mark STALE in BROADCAST
#        > STALE_2 (180s)  -> page-2 + escalate to senior-code-reviewer
#        > STALE_3 (240s)  -> mark OFFLINE + emit respawn request in SYNC_LOG
#   3. Rotate HEARTBEAT.md if > MAX_HEARTBEAT_LINES (default 5000)
#   4. Write scheduler's own heartbeat + SCHEDULER row
#   5. (optional) If AGENT_DRIVER=claude, invoke `claude -p` headless for each DUE agent
#
# Sub-minute cadence: cron CANNOT do <60s. This daemon self-loops with sleep.
# Keep it alive via launchd (macOS) or systemd (Linux) — see scheduler-ctl.sh.
#
# Usage:
#   agent-scheduler.sh                 # run daemon loop (foreground)
#   agent-scheduler.sh --once          # single tick then exit (for testing/cron-fallback)
#   TICK_SECONDS=45 agent-scheduler.sh # override cadence
#   AGENT_DRIVER=claude agent-scheduler.sh   # actually invoke agents headless (COST!)
#
# Env:
#   TICK_SECONDS         default 50   (clamp 30..60)
#   MAX_HEARTBEAT_LINES  default 5000
#   STALE_1/2/3          default 120/180/240 (seconds)
#   AGENT_DRIVER         default "none" (set "claude" to invoke `claude -p` per due agent)
#   AGENT_DUE_SECONDS    default 50   (an agent is "due" for a tick if its hb older than this)

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATUS_DIR="$ROOT/agent-status"
BROADCAST="$STATUS_DIR/BROADCAST.md"
HEARTBEAT="$STATUS_DIR/HEARTBEAT.md"
SYNC_LOG="$STATUS_DIR/SYNC_LOG.md"
INBOX_DIR="$STATUS_DIR/INBOX"
ARCHIVE_DIR="$STATUS_DIR/heartbeat-archive"
SCHED_LOG="$STATUS_DIR/SCHEDULER.md"
LOCK_DIR="$STATUS_DIR/.sched.lock"

TICK_SECONDS="${TICK_SECONDS:-50}"
MAX_HEARTBEAT_LINES="${MAX_HEARTBEAT_LINES:-5000}"
STALE_1="${STALE_1:-120}"
STALE_2="${STALE_2:-180}"
STALE_3="${STALE_3:-240}"
AGENT_DRIVER="${AGENT_DRIVER:-none}"
AGENT_DUE_SECONDS="${AGENT_DUE_SECONDS:-50}"

# clamp cadence 30..60
[ "$TICK_SECONDS" -lt 30 ] && TICK_SECONDS=30
[ "$TICK_SECONDS" -gt 60 ] && TICK_SECONDS=60

now_iso()  { date -u +%Y-%m-%dT%H:%M:%SZ; }
now_epoch() { date -u +%s; }

# Portable ISO8601 -> epoch (BSD then GNU fallback)
iso_to_epoch() {
  local ts="$1"
  [ -z "$ts" ] && { echo 0; return; }
  [ "$ts" = "—" ] && { echo 0; return; }
  local e
  e="$(date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "$ts" +%s 2>/dev/null)" \
    || e="$(date -u -d "$ts" +%s 2>/dev/null)" \
    || e=0
  echo "${e:-0}"
}

log_sched() { echo "$(now_iso) scheduler $*" >> "$HEARTBEAT"; }

# Append a SYNC_LOG line + drop into recipient inbox (no flock; low contention)
post_sync() {
  local from="$1" to="$2" topic="$3" ref="$4" body="$5"
  local line="$(now_iso) FROM=$from TO=$to TOPIC=$topic REF=$ref BODY=\"$body\""
  echo "$line" >> "$SYNC_LOG"
  if [ "$to" = "ALL" ]; then
    for f in "$INBOX_DIR"/*.md; do [ -e "$f" ] && echo "$line" >> "$f"; done
  else
    local ib="$INBOX_DIR/$to.md"
    [ -f "$ib" ] || printf "# Inbox: %s\n\n" "$to" > "$ib"
    echo "$line" >> "$ib"
  fi
}

acquire_lock() {
  local tries=0
  while ! mkdir "$LOCK_DIR" 2>/dev/null; do
    tries=$((tries+1))
    [ "$tries" -gt 30 ] && { echo "scheduler: stale lock, forcing"; rm -rf "$LOCK_DIR"; mkdir "$LOCK_DIR" 2>/dev/null; break; }
    sleep 0.2
  done
}
release_lock() { rm -rf "$LOCK_DIR" 2>/dev/null; }

rotate_heartbeat_if_needed() {
  local lines
  lines="$(wc -l < "$HEARTBEAT" 2>/dev/null | tr -d ' ')"
  [ -z "$lines" ] && return
  if [ "$lines" -gt "$MAX_HEARTBEAT_LINES" ]; then
    mkdir -p "$ARCHIVE_DIR"
    local stamp; stamp="$(now_iso | tr ':' '-')"
    local archive="$ARCHIVE_DIR/HEARTBEAT-$stamp.md"
    mv "$HEARTBEAT" "$archive"
    {
      echo "# Waahyu HEARTBEAT — append-only event log (rotated)"
      echo ""
      echo "$(now_iso) system ROTATION prev=$(basename "$archive")"
    } > "$HEARTBEAT"
    log_sched ROTATED prev="$(basename "$archive")"
  fi
}

# Update a BROADCAST row's STATE + heartbeat columns in place (atomic write-then-rename)
mark_broadcast_state() {
  local agent="$1" new_state="$2"
  local tmp="$STATUS_DIR/.BROADCAST.$$.tmp"
  awk -v agent="$agent" -v st="$new_state" '
    BEGIN { FS="|"; OFS="|" }
    $0 ~ ("^\\| " agent " \\|") {
      # columns: "| agent | state | task | files | blocked | hb | ttl |"
      $3 = " " st " "
      print
      next
    }
    { print }
  ' "$BROADCAST" > "$tmp" && mv "$tmp" "$BROADCAST"
}

# Parse BROADCAST rows -> "agent|state|hb_iso"
read_rows() {
  awk '
    BEGIN { FS="|" }
    /^\| [a-z0-9-]+ \|/ {
      a=$2; s=$3; hb=$7
      gsub(/^[ \t]+|[ \t]+$/,"",a)
      gsub(/^[ \t]+|[ \t]+$/,"",s)
      gsub(/^[ \t]+|[ \t]+$/,"",hb)
      if (a=="Agent") next
      print a "|" s "|" hb
    }
  ' "$BROADCAST"
}

drive_agent() {
  # Optional headless invocation. OFF by default (cost). Override with AGENT_DRIVER=claude.
  local agent="$1"
  [ "$AGENT_DRIVER" != "claude" ] && return 0
  command -v claude >/dev/null 2>&1 || { log_sched DRIVER_MISSING claude_cli_not_found; return 0; }
  # Fire-and-forget headless cycle. Agent reads its own .md + protocol, runs ONE heartbeat cycle.
  local prompt="<<heartbeat-cycle>> You are the '$agent' agent. Read .claude/agents/${agent}.md + .claude/agents/PROTOCOL.md. Read agent-status/BROADCAST.md + agent-status/INBOX/${agent}.md. Run exactly ONE heartbeat cycle: reconcile, do one atomic step if work assigned, then update BROADCAST + HEARTBEAT + INBOX via scripts/agent-heartbeat.sh and scripts/agent-sync.sh. Do not loop."
  ( cd "$ROOT" && nohup claude -p "$prompt" --dangerously-skip-permissions >/dev/null 2>&1 & )
  log_sched DRIVE agent="$agent" mode=claude-headless
}

tick() {
  acquire_lock
  trap release_lock RETURN

  local now_e; now_e="$(now_epoch)"
  local active=0 stale=0 offline=0

  # Load the set of acknowledged agent ids from acks.json.
  # acks.json schema: { "<agent>": { "ackedAt": ..., ... }, ... }
  # We extract the top-level keys as a space-separated list.
  # Guarded: missing or empty file → empty set (no suppression).
  local acked_ids
  acked_ids="$(python3 -c "
import json, sys
try:
    data = json.load(open('$STATUS_DIR/acks.json'))
    if isinstance(data, dict):
        print(' '.join(data.keys()))
except Exception:
    pass
" 2>/dev/null)" || acked_ids=""

  # Helper: returns 0 (true) if \$1 is in the acked set, 1 otherwise.
  is_acked() {
    local id="$1"
    local a
    for a in $acked_ids; do
      [ "$a" = "$id" ] && return 0
    done
    return 1
  }

  while IFS='|' read -r agent state hb; do
    [ -z "$agent" ] && continue
    case "$state" in
      OFFLINE|STRATEGY_PARKED|KILLED) offline=$((offline+1)); continue ;;
    esac
    active=$((active+1))
    local hb_e; hb_e="$(iso_to_epoch "$hb")"
    local age=$(( now_e - hb_e ))
    [ "$hb_e" -eq 0 ] && age=999999

    if   [ "$age" -ge "$STALE_3" ]; then
      # STALE_3: declare OFFLINE regardless of ack status — a fully dead agent must
      # be flagged even if an operator previously acknowledged the stall.
      mark_broadcast_state "$agent" "OFFLINE"
      post_sync scheduler "$agent" stall-respawn BROADCAST.md "page-3: hb stale ${age}s >= ${STALE_3}s. Declared OFFLINE. Re-spawn required (lead via mcp__ruvnet-claude-flow__*)."
      [ "$agent" = "ceo" ] && post_sync scheduler USER pipeline-frozen BROADCAST.md "CEO OFFLINE (stale ${age}s). Pipeline frozen. USER action: re-spawn ceo."
      stale=$((stale+1))
      log_sched STALE3 agent="$agent" age="$age"
    elif [ "$age" -ge "$STALE_2" ]; then
      stale=$((stale+1))
      if is_acked "$agent"; then
        # Operator owns this stall — skip page-2 nag lines; log suppression instead.
        log_sched ACK_SUPPRESS agent="$agent" age="$age" level=STALE2
      else
        post_sync scheduler senior-code-reviewer stall-escalate BROADCAST.md "page-2: $agent hb stale ${age}s. Escalating."
        post_sync scheduler "$agent" stall-page BROADCAST.md "page-2: hb stale ${age}s. Respond now."
        log_sched STALE2 agent="$agent" age="$age"
      fi
    elif [ "$age" -ge "$STALE_1" ]; then
      mark_broadcast_state "$agent" "STALE"
      stale=$((stale+1))
      if is_acked "$agent"; then
        # Operator owns this stall — skip page-1 nag; log suppression instead.
        log_sched ACK_SUPPRESS agent="$agent" age="$age" level=STALE1
      else
        post_sync scheduler "$agent" stall-page BROADCAST.md "page-1: hb stale ${age}s >= ${STALE_1}s. Heartbeat now."
        log_sched STALE1 agent="$agent" age="$age"
      fi
    else
      # Agent is fresh/healthy — auto-clear its ack entry so future stalls page normally.
      if is_acked "$agent"; then
        python3 "$ROOT/scripts/ack_clear.py" "$agent" 2>/dev/null || true
        log_sched ACK_CLEAR agent="$agent" age="$age"
      fi
      # fresh & active — drive a cycle if due (optional headless)
      if [ "$age" -ge "$AGENT_DUE_SECONDS" ]; then drive_agent "$agent"; fi
    fi
  done < <(read_rows)

  rotate_heartbeat_if_needed

  # scheduler self-heartbeat row + log
  local tmp="$STATUS_DIR/.SCHED.$$.tmp"
  {
    echo "# Scheduler Status"
    echo ""
    echo "- Last tick: $(now_iso)"
    echo "- Tick cadence: ${TICK_SECONDS}s"
    echo "- Active agents: $active"
    echo "- Stale this tick: $stale"
    echo "- Offline/parked/killed: $offline"
    echo "- Driver: $AGENT_DRIVER"
    echo "- Thresholds: STALE_1=${STALE_1}s STALE_2=${STALE_2}s STALE_3=${STALE_3}s"
  } > "$tmp" && mv "$tmp" "$SCHED_LOG"

  # write-back channel: drain operator commands (e.g. ack) BEFORE emit, so this
  # tick's state.json reflects the fresh acknowledgement (loop closes in one tick).
  if command -v python3 >/dev/null 2>&1; then
    python3 "$ROOT/scripts/consume_commands.py" >/dev/null 2>&1 || log_sched CMD_FAIL consume_commands.py
  fi

  # emit machine-readable state.json for the dashboard UI (Phase 0)
  if command -v python3 >/dev/null 2>&1; then
    python3 "$ROOT/scripts/emit_state.py" >/dev/null 2>&1 || log_sched EMIT_FAIL emit_state.py
  fi

  log_sched TICK active="$active" stale="$stale" offline="$offline" cadence="${TICK_SECONDS}s"
  release_lock
  trap - RETURN
}

main_loop() {
  echo "$(now_iso) scheduler START pid=$$ cadence=${TICK_SECONDS}s driver=$AGENT_DRIVER" >> "$HEARTBEAT"
  post_sync scheduler ALL scheduler-online agent-status/SCHEDULER.md "Heartbeat scheduler ONLINE. Tick ${TICK_SECONDS}s. Stall detection live."
  while true; do
    tick
    # jitter +/- up to 10s to avoid lockstep, stay within 45-60 window when TICK=50
    local jitter=$(( (RANDOM % 11) - 5 ))
    local sleep_for=$(( TICK_SECONDS + jitter ))
    [ "$sleep_for" -lt 30 ] && sleep_for=30
    sleep "$sleep_for"
  done
}

case "${1:-}" in
  --once) tick; echo "scheduler: single tick done" ;;
  --help|-h)
    grep '^#' "$0" | sed 's/^# \{0,1\}//'
    ;;
  *) main_loop ;;
esac
