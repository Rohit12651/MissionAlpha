#!/usr/bin/env python3
"""
sim_swarm.py — bring the swarm ALIVE on the MissionAlpha dashboard WITHOUT cost.

Real agents (AGENT_DRIVER=claude) emit heartbeats + sync messages to the comms bus
each cycle; emit_state.py turns that into state.json; the dashboard renders it.
This simulator emits the SAME bus traffic for all 16 agents so you can SEE the swarm
working — tasks assigned, lifecycle moving across the kanban, heartbeats ticking,
and agents talking to each other (globe edges + live feed) — with zero API spend.

It is a DEMO/dev tool. It shells out to the proven writers so the format always
matches emit_state.py's parser:
  scripts/agent-heartbeat.sh <agent> <STATE> "<task>" "<files>" "<blocked>" "<next>"
  scripts/agent-sync.sh      <from> <to> <topic> <ref> "<body>"

Usage:
  scripts/sim_swarm.py            # loop, default 6s cadence
  scripts/sim_swarm.py --once     # one tick (test)
  TICK_SECONDS=8 scripts/sim_swarm.py
Stop: Ctrl-C, or kill the background pid.
Zero external deps (stdlib only).
"""
import os, sys, time, json, subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HB = os.path.join(ROOT, "scripts", "agent-heartbeat.sh")
SYNC = os.path.join(ROOT, "scripts", "agent-sync.sh")
REGISTRY_FILE = os.path.join(ROOT, "factory", "registry.json")
TICK = int(os.environ.get("TICK_SECONDS", "6"))

# Lifecycle ring each agent walks. DONE_CYCLE loops back to IDLE → continuous motion.
LIFECYCLE = ["IDLE", "IN_PROGRESS", "IN_PROGRESS", "AWAITING_REVIEW", "DONE_CYCLE"]

# Per-agent script: (task, files, next-step). Cycle-1 themed — the swarm "builds"
# the very control plane we scoped, so the board tells a coherent story.
# MANDATORY: every agent speaks /caveman (full) — tasks + next + talk are all
# caveman-compressed (drop articles/filler, fragments OK). No negotiation.
AGENTS = {
    "ceo":                    ("ratify Cycle 1 scope",          "docs/ceo/cycle1-control-plane-scope.md", "watch drift"),
    "architect":              ("ADR-014 endpoints",             "docs/adr/ADR-014.md",                    "def BulkResult + seam"),
    "principal-ux-design":    ("audit-panel + gate tokens",     "src/theme/tokens.css",                   "gate motion spec"),
    "principal-db-engineer":  ("no schema delta. web-only",     "-",                                      "stand by"),
    "senior-security-engineer":("review /api/command/bulk",     "vite.config.ts",                         "cap array <=64"),
    "senior-cicd-engineer":   ("impl GET /api/audit",           "vite.config.ts",                         "wire flag"),
    "senior-lead-dev":        ("split Cycle 1 tasks",           "agent-status/BROADCAST.md",              "assign web-1/web-2"),
    "senior-web-1":           ("build AuditPanel + chips",      "src/components/AuditPanel.tsx",          "wire getCommandStatus"),
    "senior-web-2":           ("build BulkBar + gate",          "src/components/BulkActionBar.tsx",       "gate-wire bulk respawn"),
    "principal-rn-mobile-1":  ("no mobile this cycle",          "-",                                      "stand by"),
    "principal-rn-mobile-2":  ("no mobile this cycle",          "-",                                      "stand by"),
    "senior-backend-1":       ("no backend this cycle",         "-",                                      "stand by"),
    "senior-backend-2":       ("no backend this cycle",         "-",                                      "stand by"),
    "senior-qa":              ("E2E bulk + gate test",          "tests/control-plane.spec.ts",            "a11y axe pass"),
    "senior-code-reviewer":   ("wait TESTS_GREEN",              "-",                                      "merge gate"),
    "memory-updater":         ("persist Cycle 1 decisions",     "memory/ARCHITECTURE_MEMORY.md",          "update dep map"),
}
IDS = list(AGENTS.keys())

# Believable talk DAG — (from, to, topic, ref, body). Rotated so the feed scrolls
# and globe edges shift each tick. ALL bodies caveman (full) — MANDATORY.
TALK = [
    ("ceo", "architect", "strategy-approved", "cycle1", "Cycle 1 GO. On-architecture only. No LLM couple."),
    ("architect", "senior-lead-dev", "adr-ready", "ADR-014", "3 endpoints def: audit, status, bulk. Split now."),
    ("senior-lead-dev", "senior-web-1", "assign", "AuditPanel", "Own AuditPanel + status chips."),
    ("senior-lead-dev", "senior-web-2", "assign", "BulkBar", "Own BulkBar + gate. F3 hard-gate F6."),
    ("senior-cicd-engineer", "senior-web-1", "endpoint-live", "/api/audit", "GET /api/audit live. AuditEntry[] tail-200."),
    ("senior-web-2", "senior-security-engineer", "review-req", "/api/command/bulk", "Bulk loops /api/command. Review surface?"),
    ("senior-security-engineer", "senior-web-2", "review-pass", "/api/command/bulk", "Cap array <=64. Audit each. OK."),
    ("principal-ux-design", "senior-web-2", "motion-spec", "PermissionGate", "Gate enter: ease-out 180ms, scale .95."),
    ("senior-web-1", "senior-qa", "ready-for-test", "AuditPanel", "AuditPanel + chips done. Verify."),
    ("senior-qa", "senior-code-reviewer", "tests-green", "control-plane", "TESTS_GREEN. Bulk + gate + a11y pass."),
    ("senior-code-reviewer", "senior-lead-dev", "merge-ok", "cycle1", "Merge OK. No sev>=Medium."),
    ("memory-updater", "ceo", "persisted", "cycle1", "Cycle 1 decisions persisted. Dep map updated."),
    ("architect", "senior-cicd-engineer", "endpoint-spec", "/api/commands/status", "GET /api/commands/status returns CommandStatusSnapshot. Wire flag."),
    ("senior-cicd-engineer", "senior-lead-dev", "flag-live", "VITE_CONTROL_PLANE", "VITE_CONTROL_PLANE flag on. 3 endpoints reachable."),
    ("senior-web-1", "principal-ux-design", "token-req", "tokens.css", "Need OKLCH tokens for status chips. green/amber/red?"),
    ("principal-ux-design", "senior-web-1", "tokens-out", "tokens.css", "OKLCH chip tokens shipped. Use --chip-ok/-warn/-err."),
    ("senior-security-engineer", "architect", "threat-note", "/api/command/bulk", "POST /api/command/bulk: cap 64, audit each, no LLM path. OK."),
    ("principal-db-engineer", "architect", "no-delta", "schema", "No schema delta. Audit reads existing log. Web-only confirm."),
    ("senior-qa", "senior-web-2", "a11y-fail", "PermissionGate", "axe flags gate. No focus-trap on modal. Fix."),
    ("senior-web-1", "senior-code-reviewer", "pr-up", "AuditPanel", "PR up. AuditEntry[] render + tail-200 virtualized."),
    ("architect", "ceo", "seam-locked", "ADR-014", "BulkResult seam locked. No couple to LLM driver. On-arch."),
    ("memory-updater", "architect", "dep-map", "ARCHITECTURE_MEMORY", "Dep map: control-plane edges added. 3 endpoints node-d."),
    ("senior-lead-dev", "senior-qa", "test-ask", "control-plane", "Cover bulk respawn + gate deny path. Want axe green."),
]


def sh(script, *args):
    try:
        subprocess.run(["bash", script, *[str(a) for a in args]],
                       check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        pass


def registry_agents():
    """Read factory/registry.json → list of {id,title,role,skills}. Built-in IDS are
    excluded so a created agent never collides with a hardcoded one. Never crashes:
    missing/empty/parse-fail → []."""
    try:
        with open(REGISTRY_FILE, "r", encoding="utf-8") as f:
            raw = f.read().strip()
        if not raw:
            return []
        arr = json.loads(raw)
        if not isinstance(arr, list):
            return []
        out = []
        for a in arr:
            if not isinstance(a, dict):
                continue
            aid = str(a.get("id") or "").strip()
            if not aid or aid in AGENTS:
                continue
            sk = a.get("skills")
            out.append({
                "id": aid,
                "title": str(a.get("title") or aid),
                "role": str(a.get("role") or ""),
                "skills": [str(s) for s in sk] if isinstance(sk, list) else [],
            })
        return out
    except Exception:
        return []


# Deterministic block: one agent is always BLOCKED so the dashboard BLOCKED
# column populates + globe renders that node red/amber. senior-web-2 waits on
# senior-security-engineer to sign off the bulk-surface review.
BLOCKED_AGENT = "senior-web-2"
BLOCKED_BY = "senior-security-engineer"


def tick(n):
    # 1) heartbeat every agent at its current lifecycle phase.
    #    senior-web-2 is forced BLOCKED every tick (not part of the rotation);
    #    the other 15 keep cycling through LIFECYCLE.
    for i, aid in enumerate(IDS):
        if aid == BLOCKED_AGENT:
            sh(HB, aid, "BLOCKED", "build BulkBar + gate", AGENTS[aid][1],
               BLOCKED_BY, "wait sec review")
            continue
        task, files, nxt = AGENTS[aid]
        state = LIFECYCLE[(n + i) % len(LIFECYCLE)]
        sh(HB, aid, state, task, files, "", nxt)
    # 1b) created agents (factory registry) are REAL board citizens — same LIFECYCLE
    #     rotation + heartbeat as the built-ins. Re-read every tick so agents created
    #     while the sim runs appear within one tick (and deleted ones drop out).
    reg = registry_agents()
    for idx, ag in enumerate(reg):
        task = (ag["skills"][0] if ag["skills"] else f"factory agent: {ag['title']}")[:60]
        state = LIFECYCLE[(n + idx) % len(LIFECYCLE)]
        sh(HB, ag["id"], state, task, "-", "", "await dispatch")
    # 2) emit a rotating slice of talk so the feed moves + globe edges shift
    k = len(TALK)
    for j in range(5):
        frm, to, topic, ref, body = TALK[(n * 5 + j) % k]
        sh(SYNC, frm, to, topic, ref, body)
    # 2b) blocked agent pings its blocker every tick about the stall
    sh(SYNC, BLOCKED_AGENT, BLOCKED_BY, "blocked", "/api/command/bulk",
       "Blocked. Need bulk-surface sign-off. ETA?")
    # 2c) light chatter for created agents so they talk on the bus (globe edges +
    #     feed). ~1 sync per registry agent per tick → feed not flooded. Alternate
    #     agent→CEO status and CEO→agent assign so edges flow both ways.
    for idx, ag in enumerate(reg):
        skill = ag["skills"][0] if ag["skills"] else "on task"
        if (n + idx) % 2 == 0:
            sh(SYNC, ag["id"], "ceo", "status", ag["id"],
               f"alive. {skill}. await dispatch.")
        else:
            sh(SYNC, "ceo", ag["id"], "assign", ag["id"],
               f"run: {ag['title']}. report back.")
    # 3) refresh state.json now so the dashboard moves at sim cadence (not the
    #    scheduler's slower tick). emit_state is idempotent + cheap.
    try:
        subprocess.run([sys.executable, os.path.join(ROOT, "scripts", "emit_state.py")],
                       check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        pass
    print(f"sim tick {n}: 16 builtin + {len(reg)} factory heartbeats "
          f"(1 BLOCKED) + 6 sync msgs + emit_state", flush=True)


def main():
    once = "--once" in sys.argv
    n = 0
    if once:
        tick(0)
        return
    print(f"sim_swarm: looping every {TICK}s (Ctrl-C to stop)", flush=True)
    try:
        while True:
            tick(n)
            n += 1
            time.sleep(TICK)
    except KeyboardInterrupt:
        print("sim_swarm: stopped", flush=True)


if __name__ == "__main__":
    main()
