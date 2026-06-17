#!/usr/bin/env bash
# Waahyu Agent Sync helper — post a SYNC_LOG entry + drop into recipient inbox.
# Usage:
#   agent-sync.sh <from-agent> <to-agent|ALL> <topic-slug> <ref-or-empty> "<body>"
# Example:
#   agent-sync.sh senior-backend-1 principal-db-engineer schema-approval ADR-0042 "validator + 2dsphere index proposed at services/order-service/db_init/0042.py"

set -euo pipefail

FROM="${1:?from agent required}"
TO="${2:?to agent or ALL required}"
TOPIC="${3:?topic slug required}"
REF="${4:--}"
BODY="${5:?body required}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATUS_DIR="$ROOT/agent-status"
SYNC_LOG="$STATUS_DIR/SYNC_LOG.md"
INBOX_DIR="$STATUS_DIR/INBOX"

NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
LINE="$NOW FROM=$FROM TO=$TO TOPIC=$TOPIC REF=$REF BODY=\"$BODY\""

if command -v flock >/dev/null 2>&1; then
  ( flock -x 200; echo "$LINE" >> "$SYNC_LOG" ) 200>"$SYNC_LOG.lock"
else
  echo "$LINE" >> "$SYNC_LOG"
fi

if [ "$TO" = "ALL" ]; then
  for f in "$INBOX_DIR"/*.md; do
    [ -e "$f" ] || continue
    echo "$LINE" >> "$f"
  done
else
  INBOX="$INBOX_DIR/$TO.md"
  if [ ! -f "$INBOX" ]; then
    printf "# Inbox: %s\n\n" "$TO" > "$INBOX"
  fi
  echo "$LINE" >> "$INBOX"
fi

echo "$LINE"
