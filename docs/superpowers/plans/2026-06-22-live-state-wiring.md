# Live State Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`. Code steps RED→GREEN→commit. New read-only endpoint behavior → security-reviewer before commit.

**Goal:** Make the cockpit board reflect the REAL running runtime — chat/dispatch an agent and it flips to in-progress with its task — instead of the frozen static snapshot.

**Architecture:** The existing state file (`COCKPIT_STATE_PATH`) stays the **roster source** (agent id/role/tier — works dev + packaged). A new pure `live-state.mjs` overlays **live status** onto that roster from the runtime's real signals: `engineQueue.all()` (per-agent tasks + timestamps), a new lightweight `agentActivity` map (last-turn time, set on every chat/run turn), and an `inflightAgents` set (currently-streaming). `/api/state.json` is served by a LIVE handler that assembles `DashboardState` from these, falling back to the static file when no roster is found.

**Tech Stack:** Node ESM, `node --test`.

## Verified anchors
- `DashboardState`/`AgentState`/`Counts`/`FeedEvent` — `src/data/types.ts:25-100`. AgentColumn values: `idle`,`in_progress`,`blocked`,`review`,`done` (`agentMeta.ts` COLUMN_ORDER).
- Roster file: `COCKPIT_STATE_PATH = WAAHYU_STATE_PATH || join(__dir,"..","agent-status","state.json")` — `server.mjs:115`.
- `/api/state.json` mount: `server.mjs:1009 → _stateH` (static file). `_stateH = stateHandler(COCKPIT_STATE_PATH)` `:117`.
- `engineQueue.all()` record: `{taskId, goalId, agentId, tier, stepIndex, status, engineState, attempts, createdAt, updatedAt, branch, error, result, task}` (server.mjs:1034-1038; `status` ∈ queued/claimed/done/held/failed).
- `factory.listAgents()` → minted agents (id/role/tier/…), `factory:true`.
- Threads: `threads` Map, messages `{role,content}` (NO timestamps) — `server.mjs:205/206`. Turn append: chat `hist.push` `:683/:686`; run path also appends.
- `inflight`/`MAX_INFLIGHT` `:197-200`.

---

## File Structure
- **Create:** `agent-runtime/live-state.mjs` (pure `buildLiveState`), `agent-runtime/test/live-state.test.mjs`.
- **Modify:** `agent-runtime/server.mjs` — `agentActivity` Map + `inflightAgents` Set (record at turn sites), live `/api/state.json` handler.

---

## Task 1: `buildLiveState` pure module (TDD)

**Files:** Create `agent-runtime/live-state.mjs` + `agent-runtime/test/live-state.test.mjs`.

**Contract:** `buildLiveState({ roster, engineTasks, activity, inflightAgents, nowMs, staleMs })` → `DashboardState`.
- `roster`: `[{id, role, tier, factory?}]`.
- `engineTasks`: array of `{agentId, status, task, updatedAt, blockedBy?}`.
- `activity`: `Record<agentId, isoTs>` (last turn time).
- `inflightAgents`: `Set<agentId>` (currently streaming).
- Per agent, choose status by precedence: inflight → `in_progress` (state "STREAMING"); else latest engine task for the agent → column from status map (`queued/claimed→in_progress`, `held→blocked`, `failed→blocked`, `done→done`, else `idle`), task text + `heartbeatAt=updatedAt` + `blockedBy`; else recent activity (`now-activity < staleMs`) → `in_progress`/heartbeatAt=activity; else `idle`, heartbeatAt=activity||null.
- `stale = heartbeatAt && now-heartbeatAt > staleMs`. `dead=false`.
- `counts` recomputed from columns. `scheduler={running:true,cadenceSec:5,lastTick:nowIso,activeCount,staleCount}`. `generatedAt=nowIso`.
- `feed`: synthesize from engine tasks (most-recent 40 by updatedAt) → `{ts:updatedAt, from:agentId, to:"boss", topic:status, ref:task, body:task}`.
- `heartbeats`: from activity → `{ts, agent, state}`.

- [ ] **Step 1: Failing test**

```javascript
// agent-runtime/test/live-state.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLiveState } from "../live-state.mjs";

const roster = [
  { id: "ceo", role: "Chief Executive", tier: "supreme" },
  { id: "architect", role: "System Architect", tier: "principal" },
  { id: "senior-web-1", role: "Web Dev", tier: "senior" },
];
const nowMs = Date.parse("2026-06-22T12:00:00Z");

test("idle agent (no activity) → idle column", () => {
  const s = buildLiveState({ roster, engineTasks: [], activity: {}, inflightAgents: new Set(), nowMs, staleMs: 300000 });
  const a = s.agents.find((x) => x.id === "architect");
  assert.equal(a.column, "idle");
  assert.equal(a.task, null);
  assert.equal(s.counts.total, 3);
});

test("inflight agent → in_progress + STREAMING", () => {
  const s = buildLiveState({ roster, engineTasks: [], activity: {}, inflightAgents: new Set(["ceo"]), nowMs, staleMs: 300000 });
  const a = s.agents.find((x) => x.id === "ceo");
  assert.equal(a.column, "in_progress");
  assert.match(a.state, /STREAM/i);
});

test("engine task maps status → column + task text + heartbeat", () => {
  const tasks = [{ agentId: "senior-web-1", status: "claimed", task: "build SplitForm.tsx", updatedAt: "2026-06-22T11:59:30Z" }];
  const s = buildLiveState({ roster, engineTasks: tasks, activity: {}, inflightAgents: new Set(), nowMs, staleMs: 300000 });
  const a = s.agents.find((x) => x.id === "senior-web-1");
  assert.equal(a.column, "in_progress");
  assert.equal(a.task, "build SplitForm.tsx");
  assert.equal(a.heartbeatAt, "2026-06-22T11:59:30Z");
  assert.ok(s.feed.some((f) => f.from === "senior-web-1" && f.ref === "build SplitForm.tsx"));
});

test("held task → blocked column", () => {
  const tasks = [{ agentId: "architect", status: "held", task: "await review", updatedAt: "2026-06-22T11:59:00Z", blockedBy: "senior-web-1" }];
  const s = buildLiveState({ roster, engineTasks: tasks, activity: {}, inflightAgents: new Set(), nowMs, staleMs: 300000 });
  const a = s.agents.find((x) => x.id === "architect");
  assert.equal(a.column, "blocked");
  assert.equal(a.blockedBy, "senior-web-1");
  assert.equal(s.counts.blocked, 1);
});

test("stale: old activity, no task → stale flag", () => {
  const s = buildLiveState({ roster, engineTasks: [], activity: { ceo: "2026-06-22T11:00:00Z" }, inflightAgents: new Set(), nowMs, staleMs: 300000 });
  const a = s.agents.find((x) => x.id === "ceo");
  assert.equal(a.stale, true);
});
```

- [ ] **Step 2: Run → FAIL** (`cd agent-runtime && node --test test/live-state.test.mjs`).

- [ ] **Step 3: Implement `agent-runtime/live-state.mjs`**

```javascript
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
```

- [ ] **Step 4: Run → PASS** (5 tests). **Step 5: Commit** `feat(runtime): buildLiveState — overlay live status onto the roster (TDD)`.

---

## Task 2: Track live activity in server.mjs

**Files:** Modify `agent-runtime/server.mjs`.

- [ ] **Step 1:** Near the `threads`/`inflight` declarations (~:206), add:
```javascript
// Live cockpit signals — last-turn time per agent + who's currently streaming.
const agentActivity = new Map(); // agentId → ISO ts of last turn
const inflightAgents = new Set(); // agentIds with an in-flight turn
const markActivity = (id) => { if (id) agentActivity.set(id, new Date().toISOString()); };
```
- [ ] **Step 2:** In the chat turn path, mark activity + inflight membership. At the chat handler where `inflight++` happens (~:831) add `inflightAgents.add(agentId);` and on close/cleanup (~:836) add `inflightAgents.delete(agentId); markActivity(agentId);`. Do the same at the `/run` and engine-dispatch inflight sites (each `inflight++`/decrement pair): add the agent id on acquire, delete + `markActivity` on release. (Mirror EXACTLY the existing inflight++/-- pairs so the set never leaks — same pattern as F1's audit.)
- [ ] **Step 3:** Build + suite still green (no behavior change yet). `cd agent-runtime && npm test`.
- [ ] **Step 4: Commit** `feat(runtime): track per-agent activity + inflight for live state`.

---

## Task 3: Serve live `/api/state.json`

**Files:** Modify `agent-runtime/server.mjs`.

- [ ] **Step 1:** Import + roster loader. Near the cockpit-feeds imports (~:100):
```javascript
import { buildLiveState } from "./live-state.mjs";
```
Add a roster reader (reads id/role/tier from the existing state file once per request; cheap, file is small):
```javascript
function rosterFromFile() {
  try {
    const raw = readFileSync(COCKPIT_STATE_PATH, "utf8");
    const j = JSON.parse(raw);
    return (j.agents || []).map((a) => ({ id: a.id, role: a.role, tier: a.tier }));
  } catch { return []; }
}
```
(`readFileSync` is already imported, `server.mjs:62`.)

- [ ] **Step 2:** Replace the static `/api/state.json` route (`:1009`) with a live one:
```javascript
if (url.pathname === "/api/state.json") {
  const roster = rosterFromFile().concat(
    (factory.listAgents() || [])
      .filter((m) => m && m.id)
      .map((m) => ({ id: m.id, role: m.role || m.id, tier: m.tier || "support", factory: true }))
  );
  // de-dup by id (file roster wins)
  const seen = new Set(); const merged = [];
  for (const r of roster) { if (!seen.has(r.id)) { seen.add(r.id); merged.push(r); } }
  if (!merged.length) return _stateH(req, res); // no roster → fall back to static file
  const engineTasks = engineQueue.all().map((t) => ({ agentId: t.agentId, status: t.status, task: t.task || t.goalId || "", updatedAt: t.updatedAt || t.createdAt, blockedBy: t.heldReason && /blocked by (\S+)/i.test(t.heldReason) ? RegExp.$1 : null }));
  const state = buildLiveState({ roster: merged, engineTasks, activity: Object.fromEntries(agentActivity), inflightAgents, nowMs: Date.now() });
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(state));
  return;
}
```

- [ ] **Step 3:** Full suite + tsc. `cd agent-runtime && npm test` (267 + 5 live-state + others), `cd .. && npm run typecheck` exit 0.

- [ ] **Step 4:** Live verify (the whole point):
```bash
cd agent-runtime
RUNTIME_BACKEND=cli RUNTIME_PORT=3090 RUNTIME_TOKEN=live00000000000000000000 node server.mjs > /tmp/ma-live.log 2>&1 &
sleep 2
# baseline — agents idle, live generatedAt = now
curl -s -H "x-runtime-token: live00000000000000000000" http://127.0.0.1:3090/api/state.json | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);console.log('generatedAt fresh?', j.generatedAt, '| total', j.counts.total, '| inProgress', j.counts.inProgress)})"
# chat the CEO → it should flip to in_progress while streaming
curl -sN -X POST -H "x-runtime-token: live00000000000000000000" -H "Content-Type: application/json" -d '{"message":"say hi in one word"}' http://127.0.0.1:3090/runtime/boss/chat >/dev/null &
sleep 1
curl -s -H "x-runtime-token: live00000000000000000000" http://127.0.0.1:3090/api/state.json | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);const b=j.agents.find(a=>a.id==='boss'||a.id==='ceo');console.log('ceo/boss column:', b&&b.column, b&&b.state)})"
pkill -f "RUNTIME_PORT=3090"
```
Expected: `generatedAt` is current; after sending a chat, the boss/ceo agent column = `in_progress`/STREAMING during the turn.

- [ ] **Step 5: Commit** `feat(runtime): serve LIVE /api/state.json (roster + real activity) — board reflects real work`.

---

## Security review (BLOCKING — read-only synthesis, confirm no leak/DoS)
Dispatch `security-reviewer`. Confirm: (1) live handler is loopback-gated (existing `hostOk`), read-only (no writes); (2) it exposes only swarm status (ids/tasks/columns), no secrets/env/token — task text is already scrubbed by the engine; (3) `rosterFromFile` reads ONLY `COCKPIT_STATE_PATH` (no request-controlled path); (4) bounded (feed ≤40, roster small) — no DoS; (5) `inflightAgents`/`agentActivity` can't leak slots or grow unbounded (set add/delete mirror the inflight pairs; activity map keyed by finite roster ids).

## Exit Gate
- [ ] `/api/state.json` returns LIVE data — `generatedAt` is current, not the frozen snapshot date.
- [ ] Chatting/dispatching an agent flips its board column to in_progress with its task (Task 3 Step 4 proof).
- [ ] Idle agents show idle; held tasks → blocked; stale after TTL.
- [ ] Roster still sourced from the state file (works dev + packaged); factory agents appended.
- [ ] Suite green + tsc 0; security review clean; commits per GREEN.

## Self-Review
- Roster source = existing state file (dev + packaged) + factory. ✔
- Live status from engineQueue + activity + inflight (real signals). ✔
- No thread-timestamp dependency (threads lack ts) — activity map fills that gap. ✔
- Pure buildLiveState (testable) + thin server wiring. ✔
- Placeholder scan: real code throughout; Task 2 Step 2 says "mirror existing inflight pairs" — the engineer audits the exact `inflight++`/`--` sites (F1 enumerated them: chat :831/:836, run, engine). ✔
