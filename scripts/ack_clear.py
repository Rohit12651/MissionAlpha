#!/usr/bin/env python3
"""
ack_clear.py — remove a single agent from acks.json (auto-clear on recovery).

Called by agent-scheduler.sh from the healthy/fresh branch of tick() when an
agent's heartbeat age drops below STALE_1 (i.e., the agent is no longer stale).
Removing the ack key lets a FUTURE stale event page normally again.

Usage:
    python3 scripts/ack_clear.py <agent-id>

Design notes:
  • No-op if acks.json is missing or the agent key is not present.
  • Atomic: tmp-write + rename, same pattern as consume_commands.py.
  • Stdlib only — no external deps.
  • Safe against concurrent writes: rename is atomic on POSIX.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
ACKS_JSON = REPO_ROOT / "agent-status" / "acks.json"


def main() -> None:
    if len(sys.argv) < 2:
        sys.stderr.write("usage: ack_clear.py <agent-id>\n")
        sys.exit(1)
    agent = sys.argv[1].strip()
    if not agent:
        sys.exit(0)  # nothing to do

    # Load existing acks (missing file → empty dict, malformed → empty dict).
    if not ACKS_JSON.exists():
        sys.exit(0)
    try:
        data = json.loads(ACKS_JSON.read_text("utf-8"))
        if not isinstance(data, dict):
            data = {}
    except Exception:
        data = {}

    if agent not in data:
        sys.exit(0)  # already gone — no-op

    del data[agent]

    # Atomic write.
    tmp = ACKS_JSON.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2), "utf-8")
    tmp.replace(ACKS_JSON)


if __name__ == "__main__":
    main()
