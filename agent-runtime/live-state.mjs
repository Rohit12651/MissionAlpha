// agent-runtime/live-state.mjs — pure: overlay LIVE status onto a roster.
// No I/O; server passes roster (from the state file) + runtime signals.
const COLUMN_BY_STATUS = { queued: "in_progress", claimed: "in_progress", running: "in_progress", held: "blocked", failed: "blocked", done: "done" };

function latestTaskFor(agentId, tasks) {
  let best = null;
  for (const t of tasks) {
    if (t.agentId !== agentId) continue;
    if (!best || String(t.updatedAt || "") > String(best.updatedAt || "")) best = t;
  }
  return best;
}

// `settled` (P2) — agentId → ISO timestamp of when that agent's LAST turn finished.
// The server records it right after markActivity() on every settle path. Without it
// a finished turn kept the agent lit as ACTIVE for the whole staleMs window (P1
// observation: ceo stayed active post-stream). Defaults to {} so every existing
// caller and test is byte-identical.
export function buildLiveState({ roster = [], engineTasks = [], activity = {}, settled = {}, inflightAgents = new Set(), chatFeed = [], aliases = {}, liveOnly = false, alwaysShow = [], nowMs = Date.now(), staleMs = 300000 }) {
  const pinned = new Set(alwaysShow);
  const nowIso = new Date(nowMs).toISOString();
  // Alias fold — map an EXTERNAL chat id onto its roster card (the cockpit's "boss" chat
  // thread → the "ceo" roster entry). The heartbeat/inflight signal arrives under "boss"
  // but the visible card is "ceo"; without this the CEO card never beats from a real chat.
  const activityF = { ...activity };
  const settledF = { ...settled };
  const inflightF = new Set(inflightAgents);
  for (const [from, to] of Object.entries(aliases)) {
    if (activity[from] && (!activityF[to] || String(activity[from]) > String(activityF[to]))) activityF[to] = activity[from];
    if (settled[from] && (!settledF[to] || String(settled[from]) > String(settledF[to]))) settledF[to] = settled[from];
    if (inflightAgents.has(from)) inflightF.add(to);
  }
  const agents = roster.map((r) => {
    const task = latestTaskFor(r.id, engineTasks);
    const act = activityF[r.id] || null;
    let column = "idle", state = "IDLE", taskText = null, heartbeatAt = act, blockedBy = null;
    if (inflightF.has(r.id)) {
      column = "in_progress"; state = "STREAMING"; heartbeatAt = nowIso;
    } else if (task) {
      column = COLUMN_BY_STATUS[task.status] || "idle";
      state = String(task.status || "").toUpperCase() || "IDLE";
      taskText = task.task || null;
      heartbeatAt = task.updatedAt || act;
      blockedBy = task.blockedBy || null;
    } else if (act && nowMs - Date.parse(act) < staleMs && !(settledF[r.id] && String(settledF[r.id]) >= String(act))) {
      // Recent activity with NO settle marker at-or-after it ⇒ the turn is still
      // in flight from this view's perspective. A settle marker clears it at once.
      column = "in_progress"; state = "ACTIVE";
    }
    const hbMs = heartbeatAt ? Date.parse(heartbeatAt) : NaN;
    const stale = Number.isFinite(hbMs) ? nowMs - hbMs > staleMs : false;
    return {
      id: r.id, role: r.role || r.id, tier: r.tier || "support",
      state, column, pipelineStage: "build", task: taskText, file: null,
      blockedBy, heartbeatAt, ageSec: Number.isFinite(hbMs) ? Math.round((nowMs - hbMs) / 1000) : null,
      ttlSec: Math.round(staleMs / 1000), stale, dead: false, factory: !!r.factory, imported: !!r.imported,
      inbox: [], next: null, eta: null,
    };
  });
  // liveOnly — hide dormant seed/roster entries that have never run: no heartbeat, no
  // task, not streaming. Keeps the board honest (only agents actually doing something),
  // while the roster file stays the "potential org". A dispatched/chatting agent reappears.
  const visible = liveOnly
    ? agents.filter((a) => pinned.has(a.id) || a.heartbeatAt != null || a.task != null || a.column !== "idle")
    : agents;
  const col = (c) => visible.filter((a) => a.column === c).length;
  const counts = {
    total: visible.length,
    active: visible.filter((a) => a.column === "in_progress" && !a.stale).length,
    inProgress: col("in_progress"),
    blocked: col("blocked"),
    stale: visible.filter((a) => a.stale).length,
    offline: visible.filter((a) => a.column === "idle" && !a.heartbeatAt).length,
  };
  const engineFeed = engineTasks
    .filter((t) => t.task)
    .map((t) => ({ ts: t.updatedAt || nowIso, from: t.agentId, to: "boss", topic: String(t.status || "status"), ref: String(t.task).slice(0, 60), body: String(t.task).slice(0, 200) }));
  // Merge the chat feed (CEO/agent turns) with engine-task events, newest-first, cap 40.
  const feed = [...chatFeed, ...engineFeed]
    .sort((a, b) => (String(a.ts) < String(b.ts) ? 1 : -1))
    .slice(0, 40);
  const rosterIds = new Set(roster.map((r) => r.id));
  const heartbeats = Object.entries(activityF)
    .filter(([agent]) => rosterIds.has(agent)) // roster members only (data minimization)
    .map(([agent, ts]) => ({ ts, agent, state: "beat" }));
  return {
    generatedAt: nowIso,
    scheduler: { running: true, cadenceSec: 5, lastTick: nowIso, activeCount: counts.active, staleCount: counts.stale },
    counts, agents: visible, feed, heartbeats,
  };
}
