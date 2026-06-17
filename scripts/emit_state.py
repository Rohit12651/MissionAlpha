#!/usr/bin/env python3
"""
Waahyu Agent State emitter — parses the markdown comms bus into agent-status/state.json.
Called by agent-scheduler.sh each tick (and standalone for testing).

Reads:
  agent-status/BROADCAST.md   -> agents[]
  agent-status/SYNC_LOG.md    -> feed[] (last N)
  agent-status/HEARTBEAT.md   -> heartbeats[] (last N)
  agent-status/SCHEDULER.md   -> scheduler health
Writes (atomic tmp+rename):
  agent-status/state.json

Schema documented in docs/ceo/agent-dashboard-PLAN.md §1.
Zero external deps (stdlib only).
"""
import json, os, re, sys, datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SD = os.path.join(ROOT, "agent-status")
BROADCAST = os.path.join(SD, "BROADCAST.md")
SYNC_LOG = os.path.join(SD, "SYNC_LOG.md")
HEARTBEAT = os.path.join(SD, "HEARTBEAT.md")
SCHEDULER = os.path.join(SD, "SCHEDULER.md")
OUT = os.path.join(SD, "state.json")

FEED_LIMIT = 120
HB_LIMIT = 400
INBOX_LIMIT = 15  # per-agent inbox slice attached to each agent (A1 drawer)
INBOX_DIR = os.path.join(SD, "INBOX")
ACKS_JSON = os.path.join(SD, "acks.json")        # loop-closing: written by consume_commands.py
RESPAWNS_JSON = os.path.join(SD, "respawns.json")  # loop-closing: written by consume_commands.py

# ---- role + tier + pipeline-stage metadata (matches ORCHESTRATION.md) ----
META = {
    "ceo":                      ("Chief Executive",      "supreme",   "strategy"),
    "architect":                ("System Architect",     "principal", "design-arch"),
    "principal-ux-design":      ("Principal UX",         "principal", "design-arch"),
    "principal-db-engineer":    ("Principal DB",         "principal", "design-arch"),
    "senior-security-engineer": ("Security Lead",        "senior",    "design-arch"),
    "senior-cicd-engineer":     ("CI/CD Platform",       "senior",    "deploy"),
    "senior-lead-dev":          ("Lead Developer",       "senior",    "build"),
    "senior-web-1":             ("Web Dev (cust+admin)", "senior",    "build"),
    "senior-web-2":             ("Web Dev (vend+drv)",   "senior",    "build"),
    "principal-rn-mobile-1":    ("Mobile (cust+admin)",  "principal", "build"),
    "principal-rn-mobile-2":    ("Mobile (vend+drv)",    "principal", "build"),
    "senior-backend-1":         ("Backend (commerce)",   "senior",    "build"),
    "senior-backend-2":         ("Backend (platform)",   "senior",    "build"),
    "senior-qa":                ("QA / SDET",            "senior",    "qa"),
    "senior-code-reviewer":     ("Code Reviewer",        "senior",    "review"),
    "memory-updater":           ("Memory Custodian",     "support",   "memory"),
}

# state -> kanban column (state view)
STATE_COLUMN = {
    "IDLE": "idle",
    "IN_PROGRESS": "in_progress",
    "BLOCKED": "blocked",
    "AWAITING_REVIEW": "review",
    "AWAITING_USER_DECISION": "awaiting_user",
    "STRATEGY_APPROVED_BY_USER": "in_progress",
    "STRATEGY_PARKED": "offline",
    "MONITORING": "in_progress",
    "RETURNED_FOR_FIX": "blocked",
    "RETURNED_FOR_STRATEGY_FIX": "blocked",
    "RETURNED_FOR_DESIGN_FIX": "blocked",
    "RETURNED_FOR_DB_FIX": "blocked",
    "SECURITY_RETURNED_FOR_FIX": "blocked",
    "READY_FOR_LEAD": "review",
    "DESIGN_CONTRACT_PUBLISHED": "in_progress",
    "MIGRATION_APPROVED": "in_progress",
    "SECURITY_APPROVED": "in_progress",
    "CICD_PLAN_READY": "in_progress",
    "IMPL_DONE": "done",
    "TESTS_GREEN": "done",
    "TESTS_RED": "blocked",
    "APPROVED_FOR_MERGE": "done",
    "MERGE_READY": "done",
    "MEMORY_SYNCED": "done",
    "STALE": "blocked",
    "KILLED": "offline",
    "OFFLINE": "offline",
}

def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

def iso_to_epoch(ts):
    if not ts or ts.strip() in ("", "—", "-"):
        return None
    try:
        return int(datetime.datetime.strptime(ts.strip(), "%Y-%m-%dT%H:%M:%SZ")
                   .replace(tzinfo=datetime.timezone.utc).timestamp())
    except Exception:
        return None

def read_lines(path):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return f.readlines()
    except FileNotFoundError:
        return []

def clean(s):
    return s.strip().strip("—").strip() if s else ""

def parse_broadcast(now_e):
    agents = []
    row_re = re.compile(r"^\|\s*([a-z0-9-]+)\s*\|")
    for line in read_lines(BROADCAST):
        m = row_re.match(line)
        if not m:
            continue
        cols = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cols) < 7:
            continue
        aid = cols[0]
        if aid == "Agent" or aid not in META:
            continue
        state = cols[1] or "OFFLINE"
        task = clean(cols[2])
        fileref = clean(cols[3])
        blocked = clean(cols[4])
        hb_iso = clean(cols[5])
        ttl_raw = clean(cols[6]).replace("s", "")
        hb_e = iso_to_epoch(hb_iso)
        age = (now_e - hb_e) if hb_e else None
        try:
            ttl = int(ttl_raw)
        except Exception:
            ttl = 60
        is_dead = state in ("OFFLINE", "STRATEGY_PARKED", "KILLED")
        stale = bool(age is not None and age >= 120 and not is_dead)
        role, tier, stage = META[aid]
        agents.append({
            "id": aid,
            "role": role,
            "tier": tier,
            "state": state,
            "column": STATE_COLUMN.get(state, "idle"),
            "pipelineStage": stage,
            "task": task or None,
            "file": fileref or None,
            "blockedBy": (blocked if blocked and blocked not in ("—", "-", "") else None),
            "heartbeatAt": hb_iso or None,
            "ageSec": age,
            "ttlSec": ttl,
            "stale": stale,
            "dead": is_dead,
        })
    return agents

FEED_RE = re.compile(
    r"^(?P<ts>\S+)\s+FROM=(?P<from>\S+)\s+TO=(?P<to>\S+)\s+TOPIC=(?P<topic>\S+)\s+REF=(?P<ref>\S+)\s+BODY=\"(?P<body>.*)\"\s*$"
)
def parse_feed_lines(lines):
    """Parse SYNC-format lines (FROM=/TO=/TOPIC=/REF=/BODY=) into FeedEvent dicts.
    Shared by the global feed (SYNC_LOG.md) and per-agent inboxes (INBOX/*.md)."""
    out = []
    for line in lines:
        m = FEED_RE.match(line.strip())
        if not m:
            continue
        d = m.groupdict()
        out.append({"ts": d["ts"], "from": d["from"], "to": d["to"],
                    "topic": d["topic"], "ref": d["ref"], "body": d["body"]})
    return out

def parse_feed():
    return parse_feed_lines(read_lines(SYNC_LOG))[-FEED_LIMIT:]

def parse_inbox(agent_id):
    """Last ~INBOX_LIMIT SYNC-format messages from agent-status/INBOX/<id>.md."""
    path = os.path.join(INBOX_DIR, f"{agent_id}.md")
    return parse_feed_lines(read_lines(path))[-INBOX_LIMIT:]

HB_RE = re.compile(r"^(?P<ts>\S+)\s+(?P<agent>\S+)\s+HEARTBEAT\s+(?P<state>\S+)")
# A5: trailing `next=...` (up to ` eta=` or EOL) and optional `eta=...` carried at the
# END of a heartbeat line, e.g. `... HEARTBEAT IN_PROGRESS phase2 next=tsc verify eta=2m`.
NEXT_RE = re.compile(r"\bnext=(?P<next>.+?)(?:\s+eta=\S.*)?$")
ETA_RE = re.compile(r"\beta=(?P<eta>\S+)")


def parse_hb_next_eta(line):
    """Extract (next, eta) from the tail of one heartbeat line. Either may be None.
    `next=` captures everything up to ` eta=` or EOL; `eta=` is a single token."""
    nxt = None
    eta = None
    mn = NEXT_RE.search(line)
    if mn:
        nxt = mn.group("next").strip() or None
    me = ETA_RE.search(line)
    if me:
        eta = me.group("eta").strip() or None
    return nxt, eta


def parse_heartbeats():
    out = []
    for line in read_lines(HEARTBEAT):
        s = line.strip()
        m = HB_RE.match(s)
        if not m:
            continue
        out.append(m.groupdict())
    return out[-HB_LIMIT:]


def latest_next_eta_by_agent():
    """Walk HEARTBEAT.md in order; the LAST line per agent wins. Returns
    { agent_id: {"next": str|None, "eta": str|None} }. Additive/backward-compatible."""
    by_agent = {}
    for line in read_lines(HEARTBEAT):
        s = line.strip()
        m = HB_RE.match(s)
        if not m:
            continue
        nxt, eta = parse_hb_next_eta(s)
        by_agent[m.group("agent")] = {"next": nxt, "eta": eta}
    return by_agent

def load_acks():
    """Read agent-status/acks.json (written by consume_commands.py when an operator
    acknowledges a stall). Returns { agent_id: {"ackedAt": iso, ...} }. Missing/empty
    file → {} (no-op). This is the loop-closing read: the dashboard surfaces the ack
    so the operator sees the command landed and the nag is owned."""
    try:
        with open(ACKS_JSON, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError, ValueError):
        return {}

def load_respawns():
    """Read agent-status/respawns.json (written by consume_commands.py when an operator
    requests a re-dispatch). Returns { agent_id: {"respawnAt": iso, ...} }. Missing/empty
    file → {} (no-op). Loop-closing read: dashboard surfaces respawnRequested so the
    operator sees the request landed."""
    try:
        with open(RESPAWNS_JSON, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError, ValueError):
        return {}

def parse_scheduler():
    health = {"running": None, "cadenceSec": None, "lastTick": None,
              "activeCount": None, "staleCount": None}
    txt = "".join(read_lines(SCHEDULER))
    def grab(label, cast=str):
        m = re.search(rf"- {re.escape(label)}:\s*(.+)", txt)
        if not m:
            return None
        v = m.group(1).strip()
        if cast is int:
            mm = re.search(r"\d+", v)
            return int(mm.group()) if mm else None
        return v
    health["lastTick"] = grab("Last tick")
    cad = grab("Tick cadence")
    health["cadenceSec"] = int(re.search(r"\d+", cad).group()) if cad and re.search(r"\d+", cad) else None
    health["activeCount"] = grab("Active agents", int)
    health["staleCount"] = grab("Stale this tick", int)
    health["running"] = health["lastTick"] is not None
    return health

def main():
    now_e = int(datetime.datetime.now(datetime.timezone.utc).timestamp())
    agents = parse_broadcast(now_e)
    # Attach each agent's own inbox (A1 drawer surfaces this). Backward-compatible
    # additive field — existing fields unchanged.
    # A5: attach each agent's latest `next=`/`eta=` from its most recent heartbeat
    # line so the operator sees the intended next step + ETA (null if absent).
    ne = latest_next_eta_by_agent()
    acks = load_acks()       # loop-closing: operator acknowledgements from the command channel
    respawns = load_respawns()  # loop-closing: operator respawn requests from the command channel
    for a in agents:
        a["inbox"] = parse_inbox(a["id"])
        slot = ne.get(a["id"], {})
        a["next"] = slot.get("next")
        a["eta"] = slot.get("eta")
        ack = acks.get(a["id"])
        a["acknowledged"] = bool(ack)
        a["acknowledgedAt"] = ack.get("ackedAt") if ack else None
        respawn = respawns.get(a["id"])
        a["respawnRequested"] = bool(respawn)
        a["respawnRequestedAt"] = respawn.get("respawnAt") if respawn else None
    state = {
        "generatedAt": now_iso(),
        "scheduler": parse_scheduler(),
        "counts": {
            "total": len(agents),
            "active": sum(1 for a in agents if not a["dead"]),
            "inProgress": sum(1 for a in agents if a["column"] == "in_progress"),
            "blocked": sum(1 for a in agents if a["column"] == "blocked"),
            "stale": sum(1 for a in agents if a["stale"]),
            "offline": sum(1 for a in agents if a["dead"]),
        },
        "agents": agents,
        "feed": parse_feed(),
        "heartbeats": parse_heartbeats(),
    }
    tmp = OUT + f".{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)
    os.replace(tmp, OUT)
    if "--print" in sys.argv:
        print(json.dumps(state, indent=2))
    else:
        print(f"emit_state: wrote {OUT} ({state['counts']['total']} agents, "
              f"{state['counts']['active']} active, {state['counts']['stale']} stale)")

if __name__ == "__main__":
    main()
