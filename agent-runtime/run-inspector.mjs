// MUNDER-ADOPTION A6 — the RUN INSPECTOR: a read-only window into a running turn.
//
// WHY: between dispatch and Delivery the operator is blind — loop-steps show structure
// (think/tool/result boundaries) but not the RAW stream, so "why is this run weird" has
// no answer short of waiting for it to fail. The source repo answered this with a full
// PTY plane (node-pty + xterm). This runtime's engine turns are HEADLESS `claude -p`
// runs whose bytes ALREADY flow through the server's own stdout/stderr handlers — so
// the honest port is a tap, not a terminal: no native dependency, no new process
// machinery, nothing to babysit.
//
// READ-ONLY BY CONSTRUCTION: there is no write route and no stdin handle here. The
// operator can look; steering stays where it belongs (the gated decision surfaces).
//
// BOUNDED EVERYWHERE:
//   • per-task ring buffer capped at `cap` chars (oldest dropped, marker prepended);
//   • at most `maxTasks` buffers, LRU-evicted — a chatty fleet cannot grow this map;
//   • SCRUBBED ON APPEND with the server's SHARED scrub (never a second SECRET_RE),
//     so a secret in a stderr line never sits in memory unredacted;
//   • `run.output` frames are IDENTITY-ONLY ({taskId, agentId, bytes}) and throttled to
//     one per task per `frameMs` — the text stays behind the gated GET, same law as
//     loop.step / vault.written.

export const DEFAULT_CAP = 64 * 1024;
export const DEFAULT_MAX_TASKS = 32;
export const DEFAULT_FRAME_MS = 1000;
const TRIM_MARKER = "…[older output trimmed]…\n";

export function createRunInspector(deps = {}) {
  const scrub = typeof deps.scrub === "function" ? deps.scrub : (s) => s;
  const emit = typeof deps.emit === "function" ? deps.emit : () => {};
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();
  const cap = posInt(deps.cap, DEFAULT_CAP);
  const maxTasks = posInt(deps.maxTasks, DEFAULT_MAX_TASKS);
  const frameMs = posInt(deps.frameMs, DEFAULT_FRAME_MS);

  // taskId → { agentId, text, bytes, updatedAt, lastFrameAt, trimmed }
  const runs = new Map();

  function posInt(v, d) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : d;
  }

  function append(agentId, taskId, chunk) {
    const tid = String(taskId || "");
    if (!tid) return;
    const text = scrub(String(chunk ?? ""));
    if (!text) return;
    let r = runs.get(tid);
    if (!r) {
      r = { agentId: String(agentId || ""), text: "", bytes: 0, updatedAt: 0, lastFrameAt: 0, trimmed: false };
      runs.set(tid, r);
    }
    r.text += text;
    r.bytes += text.length;
    r.updatedAt = now();
    if (r.text.length > cap) {
      r.text = TRIM_MARKER + r.text.slice(r.text.length - cap);
      r.trimmed = true;
    }
    if (r.updatedAt - r.lastFrameAt >= frameMs) {
      r.lastFrameAt = r.updatedAt;
      try { emit("run.output", { taskId: tid, agentId: r.agentId, bytes: r.bytes }); }
      catch { /* bus is observational */ }
    }
    // Evict LAST, after this entry carries its real timestamp — evicting at create
    // time made the brand-new entry (updatedAt 0) its own victim (pinned by test).
    evictOver();
  }

  function evictOver() {
    while (runs.size > maxTasks) {
      let oldestKey = null, oldestAt = Infinity;
      for (const [k, v] of runs) if (v.updatedAt < oldestAt) { oldestAt = v.updatedAt; oldestKey = k; }
      if (oldestKey === null) break;
      runs.delete(oldestKey);
    }
  }

  /** The gated read. Scrubbed at append; served as-is. */
  function read(taskId) {
    const r = runs.get(String(taskId || ""));
    if (!r) return null;
    return { taskId: String(taskId), agentId: r.agentId, bytes: r.bytes, trimmed: r.trimmed, updatedAt: r.updatedAt, text: r.text };
  }

  function list() {
    return [...runs.entries()]
      .map(([taskId, r]) => ({ taskId, agentId: r.agentId, bytes: r.bytes, updatedAt: r.updatedAt }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  return { append, read, list };
}
