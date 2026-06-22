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

export function buildLiveState({ roster = [], engineTasks = [], activity = {}, inflightAgents = new Set(), nowMs = Date.now(), staleMs = 300000 }) {
  const nowIso = new Date(nowMs).toISOString();
  const agents = roster.map((r) => {
    const task = latestTaskFor(r.id, engineTasks);
    const act = activity[r.id] || null;
    let column = "idle", state = "IDLE", taskText = null, heartbeatAt = act, blockedBy = null;
    if (inflightAgents.has(r.id)) {
      column = "in_progress"; state = "STREAMING"; heartbeatAt = nowIso;
    } else if (task) {
      column = COLUMN_BY_STATUS[task.status] || "idle";
      state = String(task.status || "").toUpperCase() || "IDLE";
      taskText = task.task || null;
      heartbeatAt = task.updatedAt || act;
      blockedBy = task.blockedBy || null;
    } else if (act && nowMs - Date.parse(act) < staleMs) {
      column = "in_progress"; state = "ACTIVE";
    }
    const hbMs = heartbeatAt ? Date.parse(heartbeatAt) : NaN;
    const stale = Number.isFinite(hbMs) ? nowMs - hbMs > staleMs : false;
    return {
      id: r.id, role: r.role || r.id, tier: r.tier || "support",
      state, column, pipelineStage: "build", task: taskText, file: null,
      blockedBy, heartbeatAt, ageSec: Number.isFinite(hbMs) ? Math.round((nowMs - hbMs) / 1000) : null,
      ttlSec: Math.round(staleMs / 1000), stale, dead: false, factory: !!r.factory,
      inbox: [], next: null, eta: null,
    };
  });
  const col = (c) => agents.filter((a) => a.column === c).length;
  const counts = {
    total: agents.length,
    active: agents.filter((a) => a.column === "in_progress" && !a.stale).length,
    inProgress: col("in_progress"),
    blocked: col("blocked"),
    stale: agents.filter((a) => a.stale).length,
    offline: agents.filter((a) => a.column === "idle" && !a.heartbeatAt).length,
  };
  const feed = engineTasks
    .filter((t) => t.task)
    .sort((a, b) => (String(a.updatedAt) < String(b.updatedAt) ? 1 : -1))
    .slice(0, 40)
    .map((t) => ({ ts: t.updatedAt || nowIso, from: t.agentId, to: "boss", topic: String(t.status || "status"), ref: String(t.task).slice(0, 60), body: String(t.task).slice(0, 200) }));
  const heartbeats = Object.entries(activity).map(([agent, ts]) => ({ ts, agent, state: "beat" }));
  return {
    generatedAt: nowIso,
    scheduler: { running: true, cadenceSec: 5, lastTick: nowIso, activeCount: counts.active, staleCount: counts.stale },
    counts, agents, feed, heartbeats,
  };
}
