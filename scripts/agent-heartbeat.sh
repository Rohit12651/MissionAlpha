#!/usr/bin/env bash
# Waahyu Agent Heartbeat helper — emits one cycle's BROADCAST/HEARTBEAT/SYNC update.
# Usage:
#   agent-heartbeat.sh <agent-name> <STATE> "<task>" "<files>" "<blocked-by-or-empty>" "<next-action>"
# Example:
#   agent-heartbeat.sh senior-backend-1 IN_PROGRESS "impl POST /orders/cancel" "services/order-service/src/routes/orders.py" "" "write red test"
#
# Atomic write-then-rename. flock for HEARTBEAT.md / SYNC_LOG.md append safety.
# Requires Bash 4+, flock (util-linux on Linux; brew install flock on macOS).

set -euo pipefail

AGENT="${1:?agent name required}"
STATE="${2:?state required (IDLE|IN_PROGRESS|BLOCKED|AWAITING_REVIEW|RETURNED_FOR_FIX|DONE_CYCLE|OFFLINE)}"
TASK="${3:--}"
FILES="${4:--}"
BLOCKED_BY="${5:--}"
NEXT="${6:--}"

# AGENT is spliced into the awk program text below — validate strictly to prevent
# awk-program injection (sr-security #2b). Also strip | from table-bound fields.
[[ "$AGENT" =~ ^[a-z0-9_-]{1,64}$ ]] || { echo "invalid agent name" >&2; exit 2; }
TASK="${TASK//|/ }"; FILES="${FILES//|/ }"; STATE="${STATE//|/ }"; BLOCKED_BY="${BLOCKED_BY//|/ }"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATUS_DIR="$ROOT/agent-status"
BROADCAST="$STATUS_DIR/BROADCAST.md"
HEARTBEAT="$STATUS_DIR/HEARTBEAT.md"

NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
TTL="60s"

# --- update BROADCAST.md row atomically ---
TMP="$STATUS_DIR/.BROADCAST.$$.tmp"
awk -v agent="$AGENT" -v state="$STATE" -v task="$TASK" -v files="$FILES" -v blocked="$BLOCKED_BY" -v hb="$NOW" -v ttl="$TTL" '
  BEGIN { OFS="" }
  /^\| '"$AGENT"' \|/ {
    print "| ", agent, " | ", state, " | ", task, " | ", files, " | ", blocked, " | ", hb, " | ", ttl, " |"
    next
  }
  { print }
' "$BROADCAST" > "$TMP"
mv "$TMP" "$BROADCAST"

# --- append HEARTBEAT.md with flock ---
LINE="$NOW $AGENT HEARTBEAT $STATE $TASK"
[ "$BLOCKED_BY" != "-" ] && [ -n "$BLOCKED_BY" ] && LINE="$LINE blocked=$BLOCKED_BY"
[ "$NEXT" != "-" ] && [ -n "$NEXT" ] && LINE="$LINE next=$NEXT"

if command -v flock >/dev/null 2>&1; then
  (
    flock -x 200
    echo "$LINE" >> "$HEARTBEAT"
  ) 200>"$HEARTBEAT.lock"
else
  # macOS w/o flock — fall back to mv-merge
  printf "%s\n" "$LINE" >> "$HEARTBEAT"
fi

echo "$LINE"
