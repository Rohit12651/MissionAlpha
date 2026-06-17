#!/usr/bin/env python3
"""
record_history.py — Cycle 2 / F4 sidecar recorder. Durably persists the swarm
timeline so the operator can replay/summarize past sessions.

WHY a sidecar (not emit_state): MissionAlpha is a decoupled WATCHER — it reads the
swarm's state.json, never edits the swarm. This recorder also only READS state.json
and appends a copy into MissionAlpha's OWN history store. The watcher's read-only
contract with the swarm is preserved.

Store: agent-status/history/<YYYY-MM-DD>.ndjson — one state.json snapshot per line.
Rotates by UTC day. Prunes files older than RETENTION_DAYS.

Usage:
  scripts/record_history.py            # loop, default 30s cadence
  scripts/record_history.py --once     # append one snapshot (test)
  TICK_SECONDS=15 RETENTION_DAYS=14 scripts/record_history.py
Zero external deps (stdlib only).
"""
import os, sys, json, time, datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SD = os.path.join(ROOT, "agent-status")
STATE = os.path.join(SD, "state.json")
HIST = os.path.join(SD, "history")
TICK = int(os.environ.get("TICK_SECONDS", "30"))
RETENTION_DAYS = int(os.environ.get("RETENTION_DAYS", "14"))


def today_path(now: datetime.datetime) -> str:
    return os.path.join(HIST, f"{now:%Y-%m-%d}.ndjson")


def prune(now: datetime.datetime) -> None:
    cutoff = (now - datetime.timedelta(days=RETENTION_DAYS)).date()
    try:
        for name in os.listdir(HIST):
            if not name.endswith(".ndjson"):
                continue
            try:
                d = datetime.date.fromisoformat(name[:-len(".ndjson")])
            except ValueError:
                continue
            if d < cutoff:
                os.remove(os.path.join(HIST, name))
    except FileNotFoundError:
        pass


def record_once() -> bool:
    """Append one snapshot. Returns True on success. Skips if state unreadable or
    identical generatedAt to the last line (no point storing duplicates)."""
    now = datetime.datetime.now(datetime.timezone.utc)
    os.makedirs(HIST, exist_ok=True)
    try:
        with open(STATE, "r") as f:
            raw = f.read()
        snap = json.loads(raw)
    except (FileNotFoundError, json.JSONDecodeError):
        return False

    gen = snap.get("generatedAt")
    path = today_path(now)

    # de-dupe: skip if last recorded line has the same generatedAt.
    if gen and os.path.exists(path):
        try:
            with open(path, "rb") as f:
                # read last line cheaply
                f.seek(0, os.SEEK_END)
                size = f.tell()
                back = min(size, 4096)
                f.seek(size - back)
                last = f.read().decode("utf-8", "ignore").strip().splitlines()
                if last:
                    prev = json.loads(last[-1])
                    if prev.get("generatedAt") == gen:
                        return False
        except (OSError, json.JSONDecodeError, IndexError):
            pass

    # store a compact line (state.json is already the schema we want to replay).
    line = json.dumps(snap, separators=(",", ":"))
    with open(path, "a") as f:
        f.write(line + "\n")
    prune(now)
    return True


def main():
    if "--once" in sys.argv:
        ok = record_once()
        print(f"record_history: {'wrote 1 snapshot' if ok else 'skipped (no new state)'}", flush=True)
        return
    print(f"record_history: looping every {TICK}s, retention {RETENTION_DAYS}d (Ctrl-C to stop)", flush=True)
    n = 0
    try:
        while True:
            if record_once():
                n += 1
            time.sleep(TICK)
    except KeyboardInterrupt:
        print(f"record_history: stopped after {n} snapshots", flush=True)


if __name__ == "__main__":
    main()
