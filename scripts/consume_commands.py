#!/usr/bin/env python3
"""
consume_commands.py — the swarm side of the write-back channel.

MissionAlpha's vite middleware drops validated command files into
agent-status/commands/<id>.json (the WRITE arrow). This script drains them each
scheduler tick, APPLIES the command, and moves the file to commands/done/ so it
is never applied twice.

Phase 1 verb: `ack` — claims ownership of a stall (PagerDuty-style). Applying it
means: append to ACK_LOG.md (audit) and upsert acks.json (loop-closing state
that emit_state.py can read to set an `acknowledged` flag so the scheduler stops
nagging the agent).

Phase 2 verb: `respawn` — operator requests a stalled/dead agent be re-dispatched.
Applying it means:
  • append to RESPAWN_LOG.md (audit) and upsert respawns.json (loop-closing state
    that emit_state.py reads to set `respawnRequested`).
  • ACTUATE: rewrite the agent's BROADCAST.md row state to IDLE and refresh its hb
    timestamp so the scheduler picks it up as live (without starting a new process —
    the driver loop, when separately enabled via AGENT_DRIVER=claude, will drive it).
  • Post a SYNC bus notice to SYNC_LOG.md + INBOX/<target>.md so the dashboard feed
    and agent inbox both surface the respawn event.
  SECURITY: only mutates markdown the swarm already owns. Never executes shell
  commands or relaunches processes (AGENT_DRIVER is not touched here).

Phase 3 verb: `task` — dispatch a task into the target agent's INBOX and mirror it
to SYNC_LOG.md so the dashboard live feed surfaces it (not just the drawer inbox).

Run standalone or from the scheduler tick:
    python3 scripts/consume_commands.py

Design notes / safety:
  • Idempotent: each file moves to done/ after success; reruns are no-ops.
  • Defensive parse: a malformed command is moved to commands/rejected/, never crashes the drain.
  • No shell execution: we only record intent. The scheduler/agent decides behavior.
  • Allow-list the verb here too (defense in depth — never trust the queue alone).
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

ALLOWED_TYPES = {"ack", "respawn", "task"}

# agent-status/ is the parent of scripts/'s sibling. Resolve relative to repo root.
REPO_ROOT = Path(__file__).resolve().parent.parent
STATUS_DIR = REPO_ROOT / "agent-status"
COMMANDS_DIR = STATUS_DIR / "commands"
DONE_DIR = COMMANDS_DIR / "done"
REJECTED_DIR = COMMANDS_DIR / "rejected"
ACK_LOG = STATUS_DIR / "ACK_LOG.md"
ACKS_JSON = STATUS_DIR / "acks.json"
RESPAWN_LOG = STATUS_DIR / "RESPAWN_LOG.md"
RESPAWNS_JSON = STATUS_DIR / "respawns.json"
TASK_LOG = STATUS_DIR / "TASK_LOG.md"
INBOX_DIR = STATUS_DIR / "INBOX"
BROADCAST = STATUS_DIR / "BROADCAST.md"
SYNC_LOG = STATUS_DIR / "SYNC_LOG.md"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _load_acks() -> dict:
    if ACKS_JSON.exists():
        try:
            return json.loads(ACKS_JSON.read_text("utf-8"))
        except Exception:
            return {}
    return {}


def _save_acks(acks: dict) -> None:
    tmp = ACKS_JSON.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(acks, indent=2), "utf-8")
    tmp.replace(ACKS_JSON)


def _append_ack_log(line: str) -> None:
    if not ACK_LOG.exists():
        ACK_LOG.write_text("# Acknowledgement log\n\n", "utf-8")
    with ACK_LOG.open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def apply_ack(cmd: dict, acks: dict) -> None:
    """Record an ack: audit log + loop-closing acks.json upsert."""
    target = cmd["target"]
    cmd_id = cmd.get("id", "?")
    issued_by = cmd.get("issuedBy", "operator")
    at = _now()
    acks[target] = {"ackedAt": at, "cmdId": cmd_id, "by": issued_by}
    _append_ack_log(f"- `{at}` **{target}** acknowledged by {issued_by} ({cmd_id})")


def _post_sync_bus(from_: str, to: str, topic: str, ref: str, body: str) -> None:
    """Append one SYNC-format line to SYNC_LOG.md AND the target's INBOX/<to>.md.
    Mirrors the same format used by agent-scheduler.sh post_sync().
    Creates the inbox file with the standard header if missing.
    SECURITY: body must already be sanitized (no embedded double-quotes or newlines)
    before calling this — caller is responsible.
    """
    at = _now()
    line = f'{at} FROM={from_} TO={to} TOPIC={topic} REF={ref} BODY="{body}"'

    # Append to SYNC_LOG.md (global feed)
    if not SYNC_LOG.exists():
        SYNC_LOG.write_text("# Waahyu SYNC_LOG — append-only inter-agent conversation\n\n", "utf-8")
    with SYNC_LOG.open("a", encoding="utf-8") as f:
        f.write(line + "\n")

    # Append to INBOX/<to>.md (per-agent drawer)
    INBOX_DIR.mkdir(parents=True, exist_ok=True)
    inbox = INBOX_DIR / f"{to}.md"
    if not inbox.exists():
        inbox.write_text(f"# Inbox: {to}\n\n", "utf-8")
    with inbox.open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def _rewrite_broadcast_row(target: str, new_state: str, new_hb: str) -> None:
    """Atomically rewrite the target agent's row in BROADCAST.md.

    Sets the state column (col index 1, 0-based after split) to new_state and
    the hb column (col index 5) to new_hb. All other rows and columns are left
    byte-identical. Uses tmp-write + rename for atomicity.

    Columns (pipe-split, 0-indexed inside the pipes, i.e. after stripping leading
    and trailing empty strings from ` | a | b | c | ... | ` split):
      0=agent  1=state  2=task  3=files  4=blocked  5=hb  6=ttl

    Safe no-op if BROADCAST.md is missing or the agent row is not found.
    SECURITY: new_state and new_hb are composed by this module only, never from
    raw command input.
    """
    if not BROADCAST.exists():
        return
    lines = BROADCAST.read_text("utf-8").splitlines(keepends=True)
    out_lines = []
    for line in lines:
        # Match data rows (not header/separator): "| agent | ..."
        # We look for the exact agent name as first cell.
        if line.startswith("|"):
            parts = line.split("|")
            # parts[0] is empty (before leading |), parts[-1] is empty (after trailing |)
            # agent name is parts[1], trimmed.
            if len(parts) >= 8 and parts[1].strip() == target:
                # Rebuild: preserve padding spaces (single space each side).
                parts[2] = f" {new_state} "   # state column
                parts[6] = f" {new_hb} "       # hb column (index 6 in full parts list)
                out_lines.append("|".join(parts))
                continue
        out_lines.append(line)
    tmp = BROADCAST.with_suffix(".md.tmp")
    tmp.write_text("".join(out_lines), "utf-8")
    tmp.replace(BROADCAST)


def _load_respawns() -> dict:
    if RESPAWNS_JSON.exists():
        try:
            return json.loads(RESPAWNS_JSON.read_text("utf-8"))
        except Exception:
            return {}
    return {}


def _save_respawns(respawns: dict) -> None:
    tmp = RESPAWNS_JSON.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(respawns, indent=2), "utf-8")
    tmp.replace(RESPAWNS_JSON)


def _append_respawn_log(line: str) -> None:
    if not RESPAWN_LOG.exists():
        RESPAWN_LOG.write_text("# Respawn request log\n\n", "utf-8")
    with RESPAWN_LOG.open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def apply_respawn(cmd: dict, respawns: dict) -> None:
    """Respawn an agent: audit log + loop-closing respawns.json upsert + BROADCAST
    row actuation + bus notice.

    Actuation steps (in order):
      1. Upsert respawns.json + append RESPAWN_LOG.md (existing behaviour, unchanged).
      2. Rewrite the agent's BROADCAST.md row: state -> IDLE, hb -> current UTC ISO.
         This revives the agent from OFFLINE/STALE so the scheduler's stall ladder
         resets and (when AGENT_DRIVER=claude is separately enabled) the drive loop
         picks it up. We deliberately do NOT spawn 'claude' here — AGENT_DRIVER is
         not touched. Reviving the BROADCAST state IS the actuation; the driver loop
         handles the rest.
      3. Post a SYNC bus notice to SYNC_LOG.md + INBOX/<target>.md so the dashboard
         feed and the agent's own drawer both surface the respawn event.

    SECURITY: no shell execution; only mutates markdown files the swarm already owns.
    """
    target = cmd["target"]
    cmd_id = cmd.get("id", "?")
    issued_by = cmd.get("issuedBy", "operator")
    at = _now()
    respawns[target] = {"respawnAt": at, "cmdId": cmd_id, "by": issued_by}
    _append_respawn_log(
        f"- `{at}` **{target}** respawn requested by {issued_by} ({cmd_id})"
    )

    # --- ACTUATION: revive BROADCAST row ---
    # Strip microseconds/timezone suffix to produce YYYY-MM-DDTHH:MM:SSZ format
    # (matches what the scheduler and emit_state expect).
    hb_ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    _rewrite_broadcast_row(target, "IDLE", hb_ts)

    # --- BUS NOTICE: SYNC_LOG + agent INBOX ---
    # Body is a fixed string with no special chars — no sanitization needed.
    _post_sync_bus(
        from_="operator",
        to=target,
        topic="respawn",
        ref=cmd_id,
        body="Respawned by operator — resume work.",
    )


def _sanitize_task_body(text: str) -> str:
    """Sanitize task body for safe embedding in a SYNC-format BODY="..." line.

    FEED_RE matches BODY="(?P<body>.*)" on a single line. Two invariants MUST hold:
      1. No embedded double-quotes — they would break the closing `"` match.
      2. No newlines / carriage-returns — they would split the line and break parsing.
    This is both a parse-safety AND injection-hardening measure.
    """
    text = text.replace('"', "'")          # double-quote → single-quote
    text = text.replace("\r\n", " ")       # CRLF → space
    text = text.replace("\n", " ")         # LF → space
    text = text.replace("\r", " ")         # CR → space
    return text.strip()


def _append_task_log(line: str) -> None:
    if not TASK_LOG.exists():
        TASK_LOG.write_text("# Task dispatch log\n\n", "utf-8")
    with TASK_LOG.open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def apply_task(cmd: dict) -> None:
    """Dispatch a task into the target agent's INBOX AND mirror to SYNC_LOG.md.

    The inbox line MUST match FEED_RE exactly:
      <ISO_TS> FROM=operator TO=<target> TOPIC=task-dispatch REF=<cmd_id> BODY="<text>"

    Previously only the INBOX was written; now the same sanitized SYNC line is also
    appended to SYNC_LOG.md so the dashboard's live feed surfaces it (not only the
    per-agent drawer inbox).

    SAFETY: task body is sanitized (quotes/newlines stripped) before writing.
    No loop-closing *.json file is needed — the inbox IS the visible result.
    The agent's BROADCAST state is NOT changed here — the agent decides when to
    transition (e.g. to IN_PROGRESS) after reading the task from its inbox.
    """
    target = cmd["target"]
    cmd_id = cmd.get("id", "?")
    issued_by = cmd.get("issuedBy", "operator")
    raw_body = cmd.get("body", "")
    safe_body = _sanitize_task_body(raw_body) if isinstance(raw_body, str) else ""
    at = _now()

    # Ensure the INBOX directory and the target's inbox file exist.
    INBOX_DIR.mkdir(parents=True, exist_ok=True)
    inbox_file = INBOX_DIR / f"{target}.md"
    if not inbox_file.exists():
        inbox_file.write_text(f"# Inbox: {target}\n\n", "utf-8")

    # Append one SYNC-format line — must match FEED_RE in emit_state.py exactly.
    inbox_line = (
        f'{at} FROM={issued_by} TO={target} TOPIC=task-dispatch'
        f' REF={cmd_id} BODY="{safe_body}"'
    )
    with inbox_file.open("a", encoding="utf-8") as f:
        f.write(inbox_line + "\n")

    # Mirror the SAME sanitized line to SYNC_LOG.md so the dashboard live feed
    # shows the task dispatch (not just the per-agent drawer).
    if not SYNC_LOG.exists():
        SYNC_LOG.write_text("# Waahyu SYNC_LOG — append-only inter-agent conversation\n\n", "utf-8")
    with SYNC_LOG.open("a", encoding="utf-8") as f:
        f.write(inbox_line + "\n")

    # Mirror to audit log (ACK_LOG / RESPAWN_LOG style).
    _append_task_log(
        f"- `{at}` **{target}** task by {issued_by} ({cmd_id}): {safe_body}"
    )


def drain() -> int:
    if not COMMANDS_DIR.exists():
        return 0  # nothing queued yet — normal.

    DONE_DIR.mkdir(parents=True, exist_ok=True)
    REJECTED_DIR.mkdir(parents=True, exist_ok=True)
    acks = _load_acks()
    respawns = _load_respawns()
    acks_dirty = False
    respawns_dirty = False
    applied = 0

    for path in sorted(COMMANDS_DIR.glob("*.json")):
        # Skip in-flight tmp writes and our own state files.
        if path.name.endswith(".tmp") or path.name in ("acks.json", "respawns.json"):
            continue
        try:
            cmd = json.loads(path.read_text("utf-8"))
            ctype = cmd.get("type")
            target = cmd.get("target")
            if ctype not in ALLOWED_TYPES or not isinstance(target, str) or not target:
                raise ValueError(f"invalid command: type={ctype!r} target={target!r}")

            if ctype == "ack":
                apply_ack(cmd, acks)
                acks_dirty = True
            elif ctype == "respawn":
                apply_respawn(cmd, respawns)
                respawns_dirty = True
            elif ctype == "task":
                # Phase 3: write task body into the target agent's INBOX file so
                # emit_state.parse_inbox() surfaces it in the dashboard next poll.
                # No loop-closing *.json needed — the inbox IS the visible result.
                apply_task(cmd)
            applied += 1
            path.replace(DONE_DIR / path.name)
        except Exception as e:  # never let one bad file stop the drain.
            sys.stderr.write(f"[consume_commands] rejecting {path.name}: {e}\n")
            try:
                path.replace(REJECTED_DIR / path.name)
            except Exception:
                pass

    if acks_dirty:
        _save_acks(acks)
    if respawns_dirty:
        _save_respawns(respawns)
    return applied


if __name__ == "__main__":
    n = drain()
    if n:
        print(f"[consume_commands] applied {n} command(s)")
    sys.exit(0)
