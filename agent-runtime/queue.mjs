// ADR-027 — Task Queue / Backlog. Durable, file-based, migration-ready.
//
// REUSES the codebase's proven conventions: atomic write+rename (thread persist
// server.mjs L179), 0o600 mode, safeId-style key sanitization (L144/346), bounded
// capacity (the MAX_INFLIGHT/429 spirit, sr-security #6). The JSON record schema
// IS the future DB row — `queue.mjs` exposes a narrow interface so the backing
// store can swap file→SQLite/Mongo without touching engine/scheduler.
//
// SECURITY (ADR-027 invariant): stores task metadata only — grants NO capability,
// never widens apply scope, never writes to the live repo (only applyChanges does),
// scrubs free-text, bounds capacity. Single-process atomic claim (lease + serialized
// run loop); a DB port MUST use a real atomic claim before any multi-process deploy.

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync, existsSync, openSync, fsyncSync, closeSync, rmSync } from "node:fs";
import { join } from "node:path";

const PRIORITY_BANDS = ["high", "normal", "low"];
const TERMINAL = new Set(["done", "failed", "cancelled"]);

// Dedupe / idempotency key (ADR-024 §4): stable hash over the keyed fields. `attempt`
// is included so a legitimate retry (new attempt) is a DISTINCT task, while an
// accidental double-submit of the same attempt collapses to one.
export function computeIdemKey({ goalId, stepIndex, attempt, agentId, task }) {
  return createHash("sha256")
    .update(JSON.stringify([goalId, stepIndex, attempt ?? 0, agentId, task]))
    .digest("hex");
}

const safeKey = (s) => String(s).replace(/[^a-z0-9_-]/gi, "_").slice(0, 80);

export function createQueue(opts = {}) {
  const dir = opts.dir;
  const tasksDir = join(dir, "tasks");
  const now = opts.now || (() => Date.now());
  const maxQueued = opts.maxQueued ?? Number(process.env.RUNTIME_MAX_QUEUED || 500);
  // P4 — per-agent SERIAL (program plan P4). Cross-agent parallelism stays bounded by
  // the SHARED MAX_INFLIGHT in the scheduler; within one agent, one task at a time so
  // an agent never races itself in its own worktree.
  const maxPerAgent = opts.maxPerAgent ?? Number(process.env.RUNTIME_MAX_PER_AGENT || 1);
  // R14 (a) — per-STORY concurrency. `storyId` has always been persisted but no scheduling
  // decision read it, so two DIFFERENT agents could build one story at the same time, each
  // diffing against a base the other was about to move. maxPerAgent does not cover this:
  // it serializes an agent against itself, not a story against its own steps.
  //
  // 0 (or any non-positive value) means UNCAPPED — byte-identical pre-R14 claiming, which
  // is what every existing direct caller of createQueue gets unless it opts in.
  const maxPerStory = Math.max(0, Number(opts.maxPerStory ?? process.env.RUNTIME_STORY_MAX_CONCURRENT ?? 0) || 0);
  const leaseMs = opts.leaseMs ?? Number(process.env.RUNTIME_LEASE_MS || 600_000); // 10 min (OQ-027.1)
  const scrub = opts.scrub || ((s) => s);
  // P4 — emit-on-persist (program plan §2 / ADR-052 §2): the SAME function that writes
  // a transition announces it. The bus is OBSERVATIONAL — a throwing or absent emitter
  // must never break a queue write, so every call is swallowed here.
  const rawEmit = opts.emit || (() => {});
  const emit = (name, data) => { try { rawEmit(name, data); } catch { /* bus is observational */ } };
  const wire = (rec) => ({
    taskId: rec.taskId, goalId: rec.goalId, agentId: rec.agentId,
    stepIndex: rec.stepIndex, attempts: rec.attempts, priority: rec.priority, status: rec.status,
  });
  mkdirSync(tasksDir, { recursive: true });

  // In-memory index (derived cache). Source of truth = per-task files on disk.
  // Round-robin fairness state: when each agent was last served (claim ordinal).
  const index = new Map(); // taskId → record
  let serveTick = 0;
  const lastServed = new Map(); // agentId → serveTick

  const taskFile = (taskId) => join(tasksDir, `${safeKey(taskId)}.json`);

  // Atomic crash-safe write (tmp → fsync → rename), matching server.mjs L179 posture.
  function persist(rec) {
    const file = taskFile(rec.taskId);
    const tmp = `${file}.tmp`;
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(rec));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
    index.set(rec.taskId, rec);
  }

  // Rebuild the index from disk (startup / new instance over an existing dir).
  function rebuild() {
    index.clear();
    if (!existsSync(tasksDir)) return;
    for (const name of readdirSync(tasksDir)) {
      if (!name.endsWith(".json") || name.endsWith(".tmp")) continue;
      try {
        const rec = JSON.parse(readFileSync(join(tasksDir, name), "utf-8"));
        if (rec && rec.taskId) index.set(rec.taskId, rec);
      } catch {
        /* skip a torn/corrupt record — never fatal */
      }
    }
  }
  rebuild();

  function nonTerminalCount() {
    let n = 0;
    for (const r of index.values()) if (!TERMINAL.has(r.status)) n++;
    return n;
  }

  function findByIdemKey(idemKey) {
    for (const r of index.values()) {
      if (r.idemKey === idemKey && !TERMINAL.has(r.status)) return r;
    }
    return null;
  }

  function enqueue(s) {
    const idemKey = s.idemKey || computeIdemKey(s);
    const dup = findByIdemKey(idemKey);
    if (dup) return { taskId: dup.taskId, idemKey, deduped: true };
    if (nonTerminalCount() >= maxQueued) return { error: "backlog full" };
    const taskId = `task_${randomBytes(6).toString("hex")}`;
    const ts = new Date(now()).toISOString();
    const rec = {
      taskId,
      idemKey,
      goalId: s.goalId || `goal_${randomBytes(6).toString("hex")}`,
      parentTaskId: s.parentTaskId ?? null,
      chainNext: s.chainNext ?? null,
      // S3 — the STORY back-pointer. ADDITIVE metadata, default null so every existing
      // caller/test is unaffected. It is NOT part of computeIdemKey (adding it would change
      // every existing key): a task's IDENTITY is its work unit, not the story that owns it.
      // Sanitized to the same safe id charset as agentId — a task file is keyed by taskId,
      // never by storyId, so this can never steer a path; the scrub is belt-and-braces.
      storyId: s.storyId ? String(s.storyId).replace(/[^a-z0-9_-]/gi, "").slice(0, 80) : null,
      stepIndex: s.stepIndex ?? 0,
      agentId: String(s.agentId || "").replace(/[^a-z0-9_-]/gi, "").slice(0, 64),
      tier: s.tier || "sonnet",
      task: scrub(String(s.task ?? "").slice(0, 4000)),
      priority: PRIORITY_BANDS.includes(s.priority) ? s.priority : "normal",
      status: "queued",
      attempts: s.attempts ?? 0,
      maxAttempts: s.maxAttempts ?? 3,
      createdAt: ts,
      updatedAt: ts,
      claimedAt: null,
      leaseExpiry: null,
      notBefore: s.notBefore ?? null,
      result: null,
      error: null,
    };
    persist(rec);
    // attempts>0 ⇒ this enqueue IS the retry the engine just scheduled (ADR-028 §3),
    // so it announces itself as task.retried rather than a fresh task.queued.
    emit(rec.attempts > 0 ? "task.retried" : "task.queued", wire(rec));
    return { taskId, idemKey, deduped: false };
  }

  function get(taskId) {
    return index.get(taskId) || null;
  }

  function update(taskId, patch) {
    const rec = index.get(taskId);
    if (!rec) return null;
    const next = { ...rec, ...patch, updatedAt: new Date(now()).toISOString() };
    if (patch.task != null) next.task = scrub(String(patch.task).slice(0, 4000));
    if (patch.result != null) next.result = scrub(String(patch.result).slice(0, 4000));
    if (patch.error != null && patch.error.msg) next.error = { ...patch.error, msg: scrub(String(patch.error.msg).slice(0, 1000)) };
    persist(next);
    // Only the terminal FAILED transition has a catalog name; done/held/cancelled do
    // not (the v1 catalog is CLOSED — program plan §2). Never invent one. Guarded on
    // the PREVIOUS status so a re-update of an already-failed task emits once only.
    if (patch.status === "failed" && rec.status !== "failed") {
      // `detail` is the failure's own words. The v1 catalog is closed by NAME, not by
      // payload shape, and events.mjs scrubs every nested string before persisting and
      // framing — and `error.msg` was already scrubbed and capped above. It exists so the
      // UI can say WHY a task failed, not merely that it did.
      emit("task.failed", {
        ...wire(next),
        kind: next.error?.kind || "unknown",
        detail: next.error?.msg || null,
      });
    }
    // PLAN AMENDMENT 2026-07-30 (program plan §2) — `task.done` was added to the v1
    // catalog. Without a success-terminal name the QueueStrip could only learn that a
    // task LEFT the queue from the 400ms debounced re-truth fetch, so it rendered a
    // finished task as still running for up to ~0.4s. Same emit-on-persist rule, same
    // 7-scalar wire(), same emit-once guard on the PREVIOUS status.
    if (patch.status === "done" && rec.status !== "done") emit("task.done", wire(next));
    return next;
  }

  // Reclaim leases whose holder died (claimed + expired + step not terminal).
  // `isLive(taskId)` lets the caller veto a reclaim for a task it KNOWS is still
  // executing in-process (engine.mjs passes its `running` map). Without it, a
  // watchdog longer than the lease would re-queue a live task → two writers on one
  // worktree. Default: no veto, so every existing caller behaves exactly as before.
  function reclaimExpiredLeases(isLive) {
    const t = now();
    let n = 0;
    const live = typeof isLive === "function" ? isLive : () => false;
    for (const rec of index.values()) {
      if (rec.status !== "claimed" || !rec.leaseExpiry) continue;
      if (live(rec.taskId)) continue;
      if (Date.parse(rec.leaseExpiry) <= t) {
        const requeued = { ...rec, status: "queued", claimedAt: null, leaseExpiry: null, updatedAt: new Date(t).toISOString() };
        persist(requeued);
        emit("task.queued", wire(requeued));
        n++;
      }
    }
    return n;
  }

  // Atomic claim with fairness (ADR-025 §4): highest non-empty priority band →
  // round-robin by agentId (least-recently-served) → FIFO. Respects per-agent cap +
  // notBefore gate. Single-process serialized (one event loop) → race-free in S1.
  function claimNext() {
    const t = now();
    const claimedPerAgent = new Map();
    const claimedPerStory = new Map();
    const ready = [];
    for (const rec of index.values()) {
      if (rec.status === "claimed") {
        claimedPerAgent.set(rec.agentId, (claimedPerAgent.get(rec.agentId) || 0) + 1);
        if (rec.storyId) claimedPerStory.set(rec.storyId, (claimedPerStory.get(rec.storyId) || 0) + 1);
        continue;
      }
      if (rec.status !== "queued") continue;
      if (rec.notBefore && Date.parse(rec.notBefore) > t) continue;
      ready.push(rec);
    }
    if (!ready.length) return null;

    for (const band of PRIORITY_BANDS) {
      const inBand = ready.filter((r) => r.priority === band)
        // exclude agents already at the per-agent concurrent cap
        .filter((r) => (claimedPerAgent.get(r.agentId) || 0) < maxPerAgent)
        // R14 — and stories already at the per-story cap. A task with NO storyId is not
        // part of a story and is never capped by it (a null key is not a story that every
        // story-less task shares). Skipping here DEFERS the step: nothing is written, so
        // the record stays `queued` and claims on a later pass once the story frees up.
        .filter((r) => !maxPerStory || !r.storyId || (claimedPerStory.get(r.storyId) || 0) < maxPerStory);
      if (!inBand.length) continue;
      // round-robin: least-recently-served agent first, then oldest createdAt (FIFO).
      inBand.sort((a, b) => {
        const la = lastServed.get(a.agentId) ?? -1;
        const lb = lastServed.get(b.agentId) ?? -1;
        if (la !== lb) return la - lb;
        if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
        return a.stepIndex - b.stepIndex;
      });
      const pick = inBand[0];
      const claimed = {
        ...pick,
        status: "claimed",
        claimedAt: new Date(t).toISOString(),
        leaseExpiry: new Date(t + leaseMs).toISOString(),
        updatedAt: new Date(t).toISOString(),
      };
      persist(claimed);
      emit("task.started", wire(claimed));
      lastServed.set(pick.agentId, ++serveTick);
      return claimed;
    }
    return null; // all ready agents at per-agent cap
  }

  function counts() {
    const c = { queued: 0, claimed: 0, held: 0, done: 0, failed: 0, cancelled: 0 };
    for (const r of index.values()) c[r.status] = (c[r.status] || 0) + 1;
    return c;
  }

  function all() {
    return [...index.values()];
  }

  // ── retention: boot sweep of terminal task records ──────────────────────────
  // A done/failed/cancelled record is HISTORY, not state — nothing reads it once the
  // chain has moved on, yet every one is a file on disk forever and is re-parsed into
  // `index` on every rebuild(). Mirrors uploads.mjs sweepStaleUploads: TTL-bounded,
  // best-effort, boot-only, returns a count for the boot log. Non-terminal records are
  // NEVER touched, whatever their age.
  const TASK_RETENTION_MS = Math.max(0, Number(opts.retentionDays ?? process.env.RUNTIME_TASK_RETENTION_DAYS ?? 7)) * 86_400_000;
  function sweepTerminal(ttlMs = TASK_RETENTION_MS, at = now()) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) return 0;
    const cutoff = at - ttlMs;
    let removed = 0;
    for (const rec of [...index.values()]) {
      if (!TERMINAL.has(rec.status)) continue;
      const ts = Date.parse(rec.updatedAt || rec.createdAt || "");
      if (!Number.isFinite(ts) || ts > cutoff) continue;
      try { rmSync(taskFile(rec.taskId), { force: true }); } catch { continue; }
      index.delete(rec.taskId);
      removed++;
    }
    return removed;
  }

  return { enqueue, claimNext, update, get, findByIdemKey, reclaimExpiredLeases, counts, all, rebuild, sweepTerminal, leaseMs };
}
