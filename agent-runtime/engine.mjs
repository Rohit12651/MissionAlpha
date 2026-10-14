// ADR-024 — Autonomous Loop Engine. The SPINE. Orchestrates the EXISTING handlers
// (broker.listChanges/applyChanges, worktree isolation, reportBack) into an
// auto-chaining state machine: QUEUED→DISPATCHED→EDITING→DIFFED→GATING→
// (APPLIED|HELD)→REPORTED→DONE, with idempotency, retry (ADR-028), and per-task git
// worktrees (ADR-026). It NEVER writes to the live repo itself — every apply flows
// through broker.applyChanges, so applyAllowed/CONFIG_GUARD/symlink/realpath re-run
// identically whether the apply was auto (policy ADR-029) or operator-confirmed.
//
// Dispatch is INJECTED (dispatchFn) so tests run deterministically without a live
// `claude` binary; production wires it to a headless claude-write run in the worktree.

import { mkdirSync, writeFileSync, readFileSync, readdirSync, openSync, fsyncSync, closeSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { classify, classifyDispatchError, shouldRetry, backoffMs } from "./self-heal.mjs";
// 6.5 — the CLOSED set of tier names a caller may be recorded as having REQUESTED.
import { TIER_BY_NAME } from "./router-tier.mjs";

const TERMINAL = new Set(["done", "failed", "cancelled"]);

export function createEngine(deps = {}) {
  const queue = deps.queue;
  const policy = deps.policy;
  const worktreeMgr = deps.worktreeMgr || null;
  const scheduler = deps.scheduler;
  const broker = deps.broker; // { listChanges(id), applyChanges(id, paths) }
  const dispatchFn = deps.dispatchFn; // async (ctx) → { acc } | { error }
  const reportBackFn = deps.reportBackFn || (() => {});
  const escalateFn = deps.escalateFn || (() => {});
  const now = deps.now || (() => Date.now());
  let watchdogMs = deps.watchdogMs ?? 0; // 0 = no watchdog (tests)
  const jitter = deps.jitter || (() => 0);
  // #8 — a FLOOR under every retry delay, in milliseconds. The engine's own backoff is
  // about THIS task; the provider breaker's hold is about EVERY caller sharing one
  // endpoint. Taking only the former is what let a full queue re-knock on a rate-limited
  // provider every few seconds while six stories did the same on their own timers.
  // Optional and FAIL-OPEN: unset, or throwing, means the historical backoff exactly.
  const retryFloorMs = typeof deps.retryFloorMs === "function" ? deps.retryFloorMs : null;
  const goalsDir = deps.goalsDir;
  // ADR-051 §4 — Delivery mint point. Called at the DIFFED→GATING transition with
  // the diff the engine ALREADY computed via broker.listChanges, so no second diff
  // walk exists. Optional: unset (tests, older callers) ⇒ behavior unchanged.
  const onDiffed = deps.onDiffed || null;
  // ADR-051 §5 — the approve-crash sweep runs inside THIS reconcile (one recovery
  // pass, not two). Optional; unset ⇒ behavior unchanged.
  const reconcileExtra = deps.reconcileExtra || null;
  // ADR-051 §9 (wired in P4) — a terminally stuck task must SURFACE in the Inbox,
  // not only on the heartbeat bus. Called once per terminal failure with the
  // classified kind, the attempt count and a bounded raw detail (the delivery layer
  // scrubs it). Optional: unset ⇒ P2/P3 behavior unchanged.
  const onTerminalFailure = deps.onTerminalFailure || null;
  // B2 / ADR-055 — the COMPLETION choke point. Called once per task that reaches DONE,
  // with the task and `{report, paths}`, so the Knowledge Vault can persist what the
  // agent actually finished. There are exactly TWO ways a task reaches DONE —
  // finishApplied() (auto-apply + reconcile) and onOperatorApplied() (the approve
  // path) — and BOTH call this: "the work is finished" is the same fact either way,
  // and the vault write is idempotent per taskId, so a task that somehow travelled
  // both routes still yields one record. Every call is isolated in a try: the record
  // is OBSERVATIONAL, and a vault fault must never strand a task whose apply already
  // landed. Optional: unset ⇒ pre-B2 behavior exactly.
  const onDone = deps.onDone || null;
  const fireDone = (task, info) => { if (onDone) { try { onDone(task, info); } catch { /* observational — the work already landed */ } } };
  // Phase 9 — HELD is a TERMINAL outcome for whoever is waiting on this task: the diff exists
  // and the next move is a human's. Without this seam a Manager-planned job sat in `building`
  // forever, because `onDone` only fires on the AUTO-APPLY branch and most work is held.
  // Observational like its siblings: a listener fault must never strand a task whose diff is
  // already recorded.
  const onHeld = deps.onHeld || null;
  const fireHeld = (task, info) => { if (onHeld) { try { onHeld(task, info); } catch { /* observational */ } } };
  // S4 — the UNIT-TEST GATE. Injected (deterministic tests) with a real hardened execFile
  // path in production. Called POST-diff, BEFORE the delivery is minted/applied, ONLY for
  // story-build tasks (a task carrying a storyId). Returns { pass, tail } — a fail drives the
  // engine's existing red→green retry loop (kind `test-failed`); the budget is `maxAttempts`.
  // Optional: unset ⇒ pre-S4 behaviour exactly (no gate runs).
  const testGateFn = deps.testGateFn || null;
  // P4 — injectable timers so the wake gate below is unit-testable without real sleeps.
  // The default is an UNREF'd setTimeout: the loop must never be the reason the process
  // stays alive.
  // C23 — THE ENGINE MUST SAY WHAT IT IS DOING. Before this, engine.mjs held exactly one
  // console.warn in the whole file. The Phase C live run lost a job to a task that sat in
  // `claimed`/`EDITING` for 16 minutes, and there was no record of the dispatch starting, the
  // watchdog firing, or a retry being scheduled — three hypotheses had to be eliminated by
  // building loops instead of by reading evidence. Defaults to a no-op so nothing else changes.
  const log = deps.log || (() => {});
  // C23 (2026-09-19) — THE LAST-RESORT BOUND. Never reproduced in three red-capable loops, and
  // every mechanism around it is coherent: the scheduler releases its slot, `running.delete`
  // sits in a `finally`, and reclaimExpiredLeases deliberately SKIPS a task still in `running`
  // because re-queuing a live task would put a second writer on its worktree. That coherence is
  // the trap — if the watchdog ever fails to fire, nothing else can intervene, and live run 1
  // sat in claimed/EDITING for 16 minutes with no process and a leaked slot.
  //
  // So this bounds the CLASS rather than a diagnosed cause: a task held past twice its own
  // watchdog is a contract violation whatever produced it. 0 disables (tests, and any install
  // that turns the watchdog off).
  const stuckAfterMs = deps.stuckAfterMs ?? 0;
  const setTimer = deps.setTimer || ((fn, ms) => { const t = setTimeout(fn, ms); if (typeof t?.unref === "function") t.unref(); return t; });
  const clearTimer = deps.clearTimer || ((t) => { try { clearTimeout(t); } catch { /* not a real timer */ } });

  const goalPlans = new Map(); // goalId → { agentId, tier, priority, steps:[text] }
  const running = new Map();   // taskId → { killed, kill }
  // Per-ENGINE (not per-module): the flag means "this engine's loop is draining".
  // A module-level flag would leak between engine instances — the test suite builds
  // many engines in one process, and server.mjs's boot order (reconcile → start) is
  // an instance property, not a process one.
  let booted = false;

  // ── boot invariant: watchdog MUST fire before the lease expires ─────────────
  // reclaimExpiredLeases() now runs at RUNTIME too (the wake gate below), so a
  // watchdog longer than the lease would let a task that is STILL RUNNING be
  // re-queued and claimed a second time: two writers on one worktree, and a first
  // child nothing can kill (its handle left `running` with the re-claim). The
  // `running` skip below is the hard guard; this keeps the two knobs coherent so
  // the skip is a belt, not the only thing holding it up. Warn + clamp, never throw:
  // a misconfigured env var must not stop the runtime from booting.
  const leaseMs = Number(deps.leaseMs ?? queue?.leaseMs ?? process.env.RUNTIME_LEASE_MS ?? 600_000);
  if (watchdogMs > 0 && Number.isFinite(leaseMs) && leaseMs > 0 && watchdogMs >= leaseMs) {
    const clamped = Math.max(1, leaseMs - 1000);
    console.warn(
      `[engine] RUNTIME_STEP_TIMEOUT_MS (${watchdogMs}ms) >= RUNTIME_LEASE_MS (${leaseMs}ms):`
      + ` a step could outlive its own lease. Clamping the watchdog to ${clamped}ms.`,
    );
    watchdogMs = clamped;
  }
  // Default the reaper bound to TWICE the (possibly clamped) watchdog: far enough out that it
  // can never race honest work, close enough that a stuck task is minutes, not forever.
  const reapAfterMs = stuckAfterMs || (watchdogMs > 0 ? watchdogMs * 2 : 0);

  if (goalsDir) {
    mkdirSync(goalsDir, { recursive: true });
    for (const name of (() => { try { return readdirSync(goalsDir); } catch { return []; } })()) {
      if (!name.endsWith(".json")) continue;
      try {
        const g = JSON.parse(readFileSync(join(goalsDir, name), "utf-8"));
        if (g && g.goalId) goalPlans.set(g.goalId, g);
      } catch { /* skip corrupt */ }
    }
  }

  function persistGoal(plan) {
    if (!goalsDir) return;
    const file = join(goalsDir, `${plan.goalId}.json`);
    const tmp = `${file}.tmp`;
    const fd = openSync(tmp, "w", 0o600);
    try { writeFileSync(fd, JSON.stringify(plan)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, file);
  }

  // ── Phase 6 / 6.5 — requestedTier: "did a caller CHOOSE this, or is it the default?" ──
  //
  // `tier` has defaulted to "sonnet" here since ADR-024, so on the wire an explicit
  // `tier:"sonnet"` is byte-identical to an omitted one. That is why the tier router could
  // "override" a request on 2026-09-02 without ever seeing one: there was nothing to see.
  //
  // requestedTier records the CALLER'S value and nothing else — a valid tier name when one
  // was supplied, null when it was omitted or unusable. It is ADDITIVE metadata (default
  // null), exactly like S3's storyId: `tier` keeps its default so every existing caller,
  // test and persisted record behaves identically.
  //
  // The recognised names are the providers registry's own (router-tier.mjs TIER_BY_NAME),
  // via hasOwnProperty, so a prototype key ("toString", "constructor") can never be recorded
  // as a request. An unrecognised name is NOT a request — recording it would let a typo
  // ("Sonnet", "gpt-5") short-circuit the router into a tier nothing can resolve.
  const requestedTierOf = (raw) => (typeof raw === "string" && Object.prototype.hasOwnProperty.call(TIER_BY_NAME, raw) ? raw : null);

  // The task record is built field-by-field inside queue.enqueue (it does not spread its
  // input), and queue.mjs is out of scope for this task, so the value is written with the
  // queue's own persist path immediately after the enqueue returns. queue.update() spreads
  // the patch over the record and re-runs the atomic tmp→fsync→rename write, so the field
  // lands in the task JSON on disk and survives a restart. It is NOT part of computeIdemKey
  // (the key is computed before this runs) — a task's identity is its work unit, not the
  // tier someone asked for. A DEDUPED enqueue is left alone: that task already carries the
  // request its own caller made, and overwriting it would silently re-tier live work.
  function tagRequestedTier(r, requestedTier) {
    if (!r || r.error || r.deduped || !r.taskId) return;
    try { queue.update(r.taskId, { requestedTier }); } catch { /* metadata — never strand a queued task */ }
  }

  // Enqueue a goal as an ordered chain of steps. Step 0 is enqueued now; each next
  // step is enqueued only when its predecessor reaches DONE (ADR-024 §3).
  // NB: `tier` is read off the raw options object rather than through a destructuring
  // default. The default is the whole problem — `{tier = "sonnet"}` fires before any code
  // can see that the caller said nothing, which is precisely how an omission became
  // indistinguishable from a choice. The fallback below is byte-identical to the old
  // default (undefined ⇒ "sonnet"; an explicit null still passes through as null), so
  // `tier` itself is unchanged for every existing caller.
  function enqueueGoal(opts = {}) {
    const { agentId, priority = "normal", steps, storyId = null } = opts;
    // Phase D · task 13 — a REPLY turn: its whole job is to send one mail, so writing nothing is
    // success rather than `empty-diff`, and anything it does write is discarded (runStep). Only
    // the literal `true` opts in; a truthy string from some caller must not change semantics.
    const replyOnly = opts.replyOnly === true;
    const tier = opts.tier === undefined ? "sonnet" : opts.tier;
    if (!Array.isArray(steps) || !steps.length) throw new Error("enqueueGoal: steps[] required");
    const requestedTier = requestedTierOf(opts.tier);
    const goalId = `goal_${randomBytes(6).toString("hex")}`;
    // S3 — storyId is ADDITIVE goal metadata (default null): it is written into the persisted
    // goal plan and carried onto every task record the chain produces, so the Story's Build
    // panel can find the goal by story. It never touches computeIdemKey (task identity is the
    // work unit, not its owning story). Sanitized to a safe id charset.
    const sid = storyId ? String(storyId).replace(/[^a-z0-9_-]/gi, "").slice(0, 80) || null : null;
    // Phase C · task 9 — an OPTIONAL base for this goal's worktrees. Ship-as-you-go commits
    // each finished task onto `ma/job/<id>` and bases the next task on that tip, so a task can
    // see the work ordered before it (probe P-F08). Sanitised to a ref-safe charset; absent,
    // worktree.create resolves the base exactly as it always did.
    const baseRef = opts.baseRef ? String(opts.baseRef).replace(/[^a-z0-9._/-]/gi, "").slice(0, 200) || null : null;
    const plan = { goalId, agentId, tier, requestedTier, priority, storyId: sid, baseRef, replyOnly, steps: steps.map((s) => String(s).slice(0, 4000)) };
    const r = queue.enqueue({ goalId, stepIndex: 0, attempt: 0, agentId, tier, priority, storyId: sid, task: plan.steps[0] });
    if (r.error) return { error: r.error }; // backlog full → do NOT persist a goal that can't start
    tagRequestedTier(r, requestedTier);
    goalPlans.set(goalId, plan);
    persistGoal(plan);
    tick();
    return { goalId, firstTaskId: r.taskId };
  }

  function tick() {
    scheduler.tick();
  }

  // ── backoff wake gate (P4) ──────────────────────────────────────────────────
  // A retry carries `notBefore`, so claimNext skips it until its gate opens — and
  // NOTHING else ticks the scheduler once the loop goes idle (drain stops the moment
  // claimNext returns null; there is no heartbeat anywhere in the runtime). Without
  // this, the first retry on an otherwise-empty queue strands forever and "BOSS walks
  // away" dies at the first transient failure.
  //
  // Exactly ONE pending wake at a time, always the earliest, so a burst of retries
  // cannot grow a timer per task.
  //
  // UPPER CLAMP: setTimeout stores its delay in a signed 32-bit int, so anything
  // above ~24.8 days silently becomes 1ms and the wake fires in a permanent hot loop.
  // A corrupt `notBefore` or a backwards clock jump is enough to produce that delay,
  // so the wake is capped at 60s and simply re-arms (armNextWake runs in the callback)
  // until the real gate opens — a bounded poll instead of a spin.
  let wakeTimer = null;
  let wakeAt = 0;
  const MAX_WAKE_MS = 60_000;
  function scheduleWake(delayMs) {
    const raw = Math.floor(Number(delayMs));
    // A non-finite delay reaches setTimeout as 1ms too — same hot loop, same clamp.
    const ms = Number.isFinite(raw) ? Math.min(Math.max(1, raw), MAX_WAKE_MS) : MAX_WAKE_MS;
    const at = now() + ms;
    if (wakeTimer && wakeAt <= at) return; // an earlier wake already covers this one
    if (wakeTimer) clearTimer(wakeTimer);
    wakeAt = at;
    wakeTimer = setTimer(() => {
      wakeTimer = null;
      wakeAt = 0;
      // A lease whose holder died mid-step is also freed here — the boot sweep is no
      // longer the only place reclaimExpiredLeases runs. A task still in `running` is
      // NOT dead: re-queuing it would put a second writer on its worktree and orphan
      // the first child (its kill handle would be gone from `running`). Skip those.
      try { queue.reclaimExpiredLeases((taskId) => running.has(taskId)); } catch { /* best-effort */ }
      try { reapStuck(); } catch { /* best-effort — a reaper fault must never stop the loop */ }
      tick();
      armNextWake(); // more gates still closed? keep the loop self-driving.
    }, ms);
  }

  // Re-arm from durable state: the earliest future `notBefore` among ready tasks.
  // Called after reconcile so a backoff that outlived a restart is not stranded.
  function armNextWake() {
    let soonest = Infinity;
    for (const t of queue.all()) {
      if (t.status !== "queued" || !t.notBefore) continue;
      const at = Date.parse(t.notBefore);
      if (Number.isFinite(at) && at > now() && at < soonest) soonest = at;
    }
    // C23 — a task in `running` also deserves a wake: it is the ONLY thing that will notice a
    // step held past its bound. Without this the reaper never runs, because a job whose single
    // task is claimed has nothing queued and therefore nothing to wake for — which is exactly
    // the shape live run 1 was stuck in.
    if (reapAfterMs) {
      for (const id of running.keys()) {
        const since = Date.parse(queue.get(id)?.claimedAt ?? "");
        if (!Number.isFinite(since)) continue;
        const due = since + reapAfterMs + 1;
        if (due < soonest) soonest = due;
      }
    }
    if (soonest !== Infinity) scheduleWake(Math.max(1, soonest - now()));
  }

  function withWatchdog(promise, ms, onTimeout) {
    if (!ms) return promise;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { try { onTimeout?.(); } catch { /* */ } const e = new Error("watchdog timeout"); e.__timeout = true; reject(e); }, ms);
      Promise.resolve(promise).then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
    });
  }

  function chainNext(task) {
    const plan = goalPlans.get(task.goalId);
    if (!plan) return;
    const nextIndex = (task.stepIndex ?? 0) + 1;
    if (nextIndex >= plan.steps.length) return; // goal complete
    const r = queue.enqueue({
      goalId: plan.goalId, stepIndex: nextIndex, attempt: 0,
      agentId: plan.agentId, tier: plan.tier, priority: plan.priority,
      storyId: plan.storyId ?? null, // S3 — carry the story back-pointer onto every chained step
      task: plan.steps[nextIndex], parentTaskId: task.taskId,
    });
    // Backlog full mid-chain → do NOT stall silently; escalate so the operator sees it.
    if (r.error) {
      escalateFn(plan.agentId, "chain-stalled", task.attempts ?? 0, `cannot enqueue step ${nextIndex}: ${r.error}`);
      return;
    }
    // 6.5 — the request belongs to the GOAL, so every chained step carries it. A plan
    // persisted before this field existed has no requestedTier: that reads as null, which is
    // exactly right (nobody recorded a choice), never as a fabricated "sonnet".
    tagRequestedTier(r, requestedTierOf(plan.requestedTier ?? null));
    tick();
  }

  function finishApplied(task, okPaths) {
    worktreeMgr?.remove(task.taskId);
    queue.update(task.taskId, { status: "done", engineState: "DONE", applyMarker: "applied", result: `applied ${okPaths.length}: ${okPaths.join(", ")}` });
    const report = `${okPaths.length} file(s): ${okPaths.join(", ")}`;
    reportBackFn(task.agentId, report);
    fireDone(task, { report, paths: okPaths });
    chainNext(task);
  }

  // Terminal failure (apply-rejected OR retries exhausted): discard worktree, escalate,
  // PAUSE the goal chain (do not enqueue the next step). OQ-028.2 = pause + escalate.
  function failTerminal(task, kind, reason, attempts) {
    worktreeMgr?.remove(task.taskId);
    queue.update(task.taskId, { status: "failed", engineState: "FAILED", applyMarker: null, error: { kind, msg: reason } });
    escalateFn(task.agentId, kind, attempts ?? task.attempts, reason);
    // Mint AFTER the queue write + escalation so a Delivery-layer fault can never
    // strand the task in a non-terminal state or swallow the bus escalation.
    if (onTerminalFailure) {
      try {
        onTerminalFailure(task, {
          agentId: task.agentId, taskId: task.taskId,
          kind, attempts: attempts ?? task.attempts ?? 0, detail: String(reason ?? ""),
        });
      } catch { /* the Inbox row is observational — the task is already terminal */ }
    }
  }

  // Retryable failure: discard worktree, mark this attempt failed, re-enqueue a fresh
  // attempt (new idemKey + new worktree) with backoff + self-heal re-prompt enrichment.
  /**
   * C23 — end any task held past `reapAfterMs`. Kills the child FIRST (so a later requeue can
   * never put a second writer on the worktree) and marks the handle killed, which makes a
   * late-settling runStep return at its existing `if (handle.killed)` guards instead of writing
   * over the row this just failed.
   */
  function reapStuck() {
    if (!reapAfterMs) return 0;
    let n = 0;
    for (const [id, handle] of [...running.entries()]) {
      const row = queue.get(id);
      if (!row) { running.delete(id); continue; }
      const since = Date.parse(row.claimedAt ?? "");
      if (!Number.isFinite(since)) continue;
      const heldFor = now() - since;
      if (heldFor <= reapAfterMs) continue;
      log({ event: "task-reaped", taskId: id, agentId: row.agentId ?? null, heldForMs: heldFor, reapAfterMs, watchdogMs, at: now() });
      handle.killed = true;
      try { handle.kill?.(); } catch { /* the child may already be gone */ }
      running.delete(id);
      try {
        handleRetryable(row, "timeout", `the engine held this task for ${Math.round(heldFor / 1000)}s — past ${Math.round(reapAfterMs / 1000)}s, twice its own ${Math.round(watchdogMs / 1000)}s watchdog. The step watchdog did not fire; reaped so the job can move.`);
      } catch (e) { log({ event: "task-reap-failed", taskId: id, error: e?.message }); }
      n++;
    }
    return n;
  }

  function handleRetryable(task, kind, reason, refused = []) {
    const attempts0 = (task.attempts ?? 0) + 1;
    log({ event: "task-failed", taskId: task.taskId, agentId: task.agentId, kind, attempt: attempts0, reason: String(reason).slice(0, 300), at: now() });
    worktreeMgr?.remove(task.taskId);
    const attempts = attempts0;
    queue.update(task.taskId, { status: "failed", engineState: "FAILED", error: { kind, msg: reason }, attempts });
    if (!shouldRetry(kind, attempts, task.maxAttempts ?? 3)) {
      return failTerminal(task, kind, reason, attempts); // exhausted
    }
    const plan = goalPlans.get(task.goalId);
    const baseText = plan ? plan.steps[task.stepIndex ?? 0] : task.task;
    const enrich = (kind === "empty-diff" || kind === "no-output")
      // A refused-path empty diff is NOT "no work happened". The seat DID write; the
      // broker declined the paths. Telling it to "make the edit NOW" sends it to repeat
      // exactly what just failed — which is how this burned a Phase 14 session, and the
      // text was live on the Tech Lead station. Narrow, not replace: an honest empty diff
      // keeps the original wording (pinned by ENG-SC2).
      ? (refused.length
          ? `\n\n(Your prior attempt DID write files, but ${refused.length} path(s) were outside this seat's write scope and were refused, so nothing could be applied: ${refused.slice(0, 5).join(", ")}${refused.length > 5 ? ", …" : ""}. Make the change INSIDE your scope, or report that the task requires a path you do not own.)`
          : "\n\n(prior attempt produced no diff; make the concrete file edit in the working directory NOW.)")
      : kind === "test-failed"
        // S4 — the red→green feedback: the scrubbed test-output tail becomes the fixer's brief.
        ? `\n\n(The unit-test gate FAILED on the prior attempt. Change the code so the tests pass — do NOT edit the tests to hide a real failure. Test output (tail):\n${String(reason).slice(0, 1500)})`
        : "";
    let delay = backoffMs(attempts, { jitter });
    if (retryFloorMs) {
      try { delay = Math.max(delay, Number(retryFloorMs()) || 0); }
      catch { /* an optimisation that throws must not change the retry */ }
    }
    queue.enqueue({
      goalId: task.goalId, stepIndex: task.stepIndex,
      attempt: attempts,   // idemKey differentiator (distinct attempt → distinct task)
      attempts,            // the RETRY COUNTER must carry forward, else retries never exhaust
      agentId: task.agentId, tier: task.tier, priority: task.priority,
      storyId: task.storyId ?? null, // S3 — a retry is the SAME work unit for the SAME story
      task: `${baseText}${enrich}`, parentTaskId: task.taskId, maxAttempts: task.maxAttempts ?? 3,
      notBefore: new Date(now() + delay).toISOString(),
    });
    tick();
    scheduleWake(delay); // the gate is closed now — wake ourselves when it opens
  }

  // The step state machine. One agent, one worktree, one diff, one gate decision.
  async function runStep(task) {
    const id = task.taskId;
    const cur = queue.get(id);
    if (!cur || TERMINAL.has(cur.status) || cur.status === "held") return; // re-entry guard

    // DISPATCHED — create per-task git worktree (ADR-026).
    let workdir = null, wtInfo = {};
    if (worktreeMgr) {
      // Phase C · task 9 — the goal's base, when it has one, decides what this checkout sits on.
      const goalBase = goalPlans.get(cur.goalId)?.baseRef || null;
      try { wtInfo = worktreeMgr.create(id, goalBase ? { baseRef: goalBase } : {}); workdir = wtInfo.path; }
      catch (e) { return handleRetryable(task, "spawn", `worktree create failed: ${e.message}`); }
    }
    queue.update(id, { engineState: "EDITING", branch: wtInfo.branch || null, baseRef: wtInfo.baseRef || null, claimedAt: cur.claimedAt });
    const handle = { killed: false, kill: null };
    running.set(id, handle);
    // C23 — arm the reaper's wake the moment this task becomes in-flight. Nothing else will:
    // armNextWake ran only on gate/retry paths, so a job whose one task is claimed had nothing
    // queued, nothing to wake for, and therefore nothing that could ever notice it was stuck.
    if (reapAfterMs) { try { armNextWake(); } catch { /* best-effort */ } }

    try {
      // EDITING — dispatch the agent (writes into the worktree), watchdog-guarded.
      let res;
      try {
        // `storyId` rides along so a dispatch-level hook can tell a STORY-BUILD task (whose
        // quality gate runs below, inside this function) from everything else (which has
        // never had one). Without it a post-edit gate would run the container twice per
        // story turn to reach one verdict.
        const ctx = { taskId: id, agentId: task.agentId, tier: task.tier, requestedTier: task.requestedTier ?? null, task: task.task, storyId: task.storyId ?? null, goalId: task.goalId ?? null, workdir, registerKill: (fn) => { handle.kill = fn; } };
        log({ event: "task-dispatch", taskId: id, agentId: task.agentId, goalId: task.goalId ?? null, storyId: task.storyId ?? null, attempt: task.attempts ?? 0, watchdogMs, at: now() });
        res = await withWatchdog(dispatchFn(ctx), watchdogMs, () => {
          log({ event: "task-watchdog", taskId: id, agentId: task.agentId, ms: watchdogMs, at: now() });
          handle.kill?.();
        });
      } catch (e) {
        return handleRetryable(task, e.__timeout ? "timeout" : "spawn", e.message);
      }
      if (handle.killed) return; // cancelled mid-edit — cancel() already cleaned up
      // D4 — a dispatch that REFUSED (a hook veto, an account that cannot drive the loop,
      // a backend with no model) has already given its final answer. Folding those into
      // the transient `spawn` bucket spent three live model turns and three container runs
      // per goal to re-derive the same verdict, and labelled a quality-gate veto "spawn".
      // classifyDispatchError leaves an UNKNOWN/absent code exactly as retryable as before;
      // shouldRetry then makes the terminal kinds terminal on the first attempt.
      if (res && res.error) return handleRetryable(task, classifyDispatchError(res.code).kind, String(res.error));

      // DIFFED — compute the diff from the worktree via the shared broker.
      //
      // `refused` is reporting only (the appliable set is unchanged): an agent that wrote
      // OUTSIDE the broker's scope produced no diff for a completely different reason than
      // one that wrote nothing, and telling the operator "no diff produced" for both sent
      // them round the same impossible task three times on a live model. Older/injected
      // brokers without the detailed call keep the historical message exactly.
      const detailed = typeof broker.listChangesDetailed === "function"
        ? await broker.listChangesDetailed(id)
        : { changes: await broker.listChanges(id), refused: [] };
      const changes = detailed.changes;
      // A REPLY turn ends here, whatever it wrote. Its product is the mail it sent; a file it
      // touched is outside its contract and is DISCARDED with the worktree — never minted as a
      // delivery, never held for review, never applied (ENG-REPLY-2). Recorded, not silent.
      if (goalPlans.get(task.goalId)?.replyOnly) {
        const touched = [...changes.map((c) => c.path), ...(detailed.refused || [])];
        worktreeMgr?.remove(id);
        queue.update(id, {
          status: "done", engineState: "REPLIED",
          result: touched.length ? `reply turn — discarded ${touched.length} file(s): ${touched.slice(0, 5).join(", ")}` : "reply turn — no files",
        });
        log({ event: "task-replied", taskId: id, agentId: task.agentId, goalId: task.goalId ?? null, discarded: touched.length, at: now() });
        return;
      }
      if (!changes.length) {
        const refused = detailed.refused || [];
        const why = refused.length
          ? `no appliable diff — the agent wrote ${refused.length} path(s) OUTSIDE the appliable scope, so nothing can be applied: ${refused.slice(0, 5).join(", ")}${refused.length > 5 ? ", …" : ""}`
          : "no diff produced";
        return handleRetryable(task, "empty-diff", why, refused);
      }
      queue.update(id, { engineState: "DIFFED" });

      // S4 — UNIT-TEST GATE. Post-diff, PRE-mint/PRE-apply, INSIDE this worktree. Only for
      // story-build tasks (a task carrying a storyId — a manual /run or cadence task has no
      // quality gate). A pass lets the diff proceed to mint/apply; a fail re-enters the
      // engine's red→green loop as a bounded `test-failed` retry (the seat re-runs with the
      // scrubbed failure tail as feedback), and an exhausted budget → failTerminal → the
      // story blocks via the onTerminalFailure seam. A gate error is treated as a FAIL
      // (fail-closed) — a diff that could not be verified never lands.
      if (testGateFn && task.storyId) {
        let verdict;
        try { verdict = await testGateFn({ task, workdir }); }
        catch (e) { verdict = { pass: false, tail: `test gate error: ${e?.message || e}` }; }
        if (!verdict || verdict.pass === false) {
          const tail = (verdict && verdict.tail) || `tests failed (exit ${verdict?.exitCode ?? "?"})`;
          return handleRetryable(task, "test-failed", tail);
        }
      }

      // Mint the Delivery BEFORE the policy gate (ADR-051 §4) so P6's risk band can
      // later attach to an already-minted row without a second mint path. A mint
      // failure must NEVER break the loop — the engine's job is the diff+apply.
      if (onDiffed) { try { onDiffed(task, changes); } catch { /* mint is observational */ } }

      // GATING — policy decides auto-apply vs hold (ADR-029). Broker re-validates either way.
      const paths = changes.map((c) => c.path);
      const decision = policy.decide(task.agentId, paths);
      if (!decision.autoApply) {
        // HELD — keep the worktree so the operator can /apply from it; chain pauses.
        queue.update(id, { status: "held", engineState: "HELD", heldReason: decision.heldReason });
        fireHeld(queue.get(id) || task, { heldReason: decision.heldReason, changedPaths: paths });
        return;
      }

      // APPLIED (auto) — persist the pre-apply marker BEFORE applyChanges (idempotency §4),
      // then converge on the SAME broker.applyChanges the operator path uses.
      queue.update(id, { engineState: "GATING", applyMarker: "applying" });
      const results = await broker.applyChanges(id, paths);
      if (handle.killed) return; // cancelled during apply — cancel() already set terminal + cleaned up
      const cls = classify({ type: "apply", applyResults: results });
      if (cls.kind === "apply-rejected") {
        const why = results.filter((r) => !r.ok).map((r) => r.error).join("; ");
        return failTerminal(task, "apply-rejected", why); // NON-retryable (guard fired)
      }
      const okPaths = results.filter((r) => r.ok).map((r) => r.path);
      finishApplied(task, okPaths);
    } finally {
      running.delete(id);
    }
  }

  // Operator confirmed a HELD step via the existing /apply route → advance the chain.
  //
  // P5: when the approved work was COMMITTED to the task branch (pr.mjs rungs
  // 'pr'/'branch'), the branch must SURVIVE — worktreeMgr.remove() ends in
  // `git branch -D`, which would delete the very commit the operator just approved.
  // release() drops only the scratch checkout. Default (no opts) is unchanged.
  function onOperatorApplied(taskId, opts = {}) {
    const task = queue.get(taskId);
    if (!task || task.status !== "held") return;
    if (opts.keepBranch && typeof worktreeMgr?.release === "function") worktreeMgr.release(taskId);
    else worktreeMgr?.remove(taskId);
    queue.update(taskId, {
      status: "done", engineState: "DONE", applyMarker: "applied",
      result: opts.keepBranch ? "operator-approved (branch kept)" : "operator-applied",
    });
    fireDone(task, {
      report: opts.keepBranch ? "operator-approved (branch kept)" : "operator-applied",
      paths: [],
    });
    chainNext(task);
  }

  // Cancellation (ADR-025 §5) — kill the in-flight child, discard worktree, never apply.
  //
  // #6 — TERMINAL GUARD. remove() ends in `git branch -D`. After a P5 mode:'branch'
  // landing the task is already `done` and that ref is the ONLY copy of work the
  // operator approved; a late cancel (stale UI, a reject on an already-approved row)
  // would destroy it. A task that has reached a terminal state has nothing left to
  // cancel, so this is a no-op rather than a destructive one. Reuses the module's
  // existing TERMINAL set (L17) — one definition of "terminal", not two.
  //
  // MED-3 (P5 re-review) — an ABSENT record must be a no-op too. queue.sweepTerminal()
  // deletes terminal records after RUNTIME_TASK_RETENTION_DAYS at every boot, so a
  // mode:'branch' landing from 8 days ago has no row left; `existing && …` let that
  // fall straight through to remove() → `git branch -D`, destroying the only copy of
  // approved work. Nothing in the queue = nothing to cancel.
  function cancel(taskId) {
    const existing = queue.get(taskId);
    if (!existing || TERMINAL.has(existing.status)) return false;
    const h = running.get(taskId);
    if (h) { h.killed = true; try { h.kill?.(); } catch { /* */ } }
    worktreeMgr?.remove(taskId);
    queue.update(taskId, { status: "cancelled", engineState: "CANCELLED" });
    tick();
    return true;
  }

  // Crash recovery (ADR-024 §4 + ADR-026 §6).
  async function reconcile() {
    worktreeMgr?.pruneOrphans();
    queue.reclaimExpiredLeases((taskId) => running.has(taskId));
    for (const task of queue.all()) {
      if (task.applyMarker === "applying") {
        // crashed mid-apply — re-converge: empty diff ⇒ already landed; else re-apply.
        const changes = await broker.listChanges(task.taskId);
        if (!changes.length) {
          queue.update(task.taskId, { status: "done", engineState: "DONE", applyMarker: "applied", result: "reconciled-applied" });
        } else {
          const results = await broker.applyChanges(task.taskId, changes.map((c) => c.path));
          const okPaths = results.filter((r) => r.ok).map((r) => r.path);
          if (okPaths.length) finishApplied(task, okPaths);
          else {
            // re-apply rejected (a guard now fires) → don't strand at 'applying'; terminal + escalate.
            const why = results.filter((r) => !r.ok).map((r) => r.error).join("; ") || "reconcile re-apply produced no applied paths";
            failTerminal(task, "apply-rejected", why);
          }
        }
      } else if (task.status === "claimed" && !booted) {
        // The runtime is single-process: BEFORE start(), no claim can still have a live
        // worker, whether or not the crash landed before the first state write. Requiring
        // engineState here stranded a task claimed-but-not-yet-EDITING for the whole
        // 10-minute lease. Re-queue every claim; nothing was applied (the applyMarker
        // branch above owns the mid-apply case), so a fresh attempt is safe.
        //
        // `!booted` is that reasoning made ENFORCEABLE rather than left as a comment:
        // once the loop is draining, a `claimed` task is very likely a LIVE one, and
        // re-queuing it would double-dispatch the same work unit.
        queue.update(task.taskId, { status: "queued", engineState: null, claimedAt: null, leaseExpiry: null });
      }
    }
    // ADR-051 §5 — re-converge `approved` Deliveries whose apply may not have landed.
    // Same sweep, same boot moment; best-effort like every branch above.
    if (reconcileExtra) { try { await reconcileExtra(); } catch { /* best-effort */ } }
    tick();
    armNextWake(); // a backoff that outlived the crash still gets its wake
  }

  // ── PHASE 2 TASK 2.4 — THE HEARTBEAT ────────────────────────────────────────
  //
  // The gap this closes, and it was written down as a comment above rather than fixed:
  // reclaimExpiredLeases ran in exactly TWO places — the boot reconcile, and the backoff
  // wake timer. The wake only arms when some task carries a `notBefore`, so on a queue with
  // no pending retry nothing re-armed it, and a lease whose holder DIED was never reclaimed
  // for as long as the process stayed up. A task claimed and never settled was orphaned
  // until the next restart.
  //
  // Called from the runtime's ONE existing periodic timer (the SLA/cadence interval in
  // server.mjs). Deliberately NOT its own timer: ADR-025 says the dispatch scheduler owns
  // no wall-clock, and a second heartbeat is a second thing that can drift, keep the
  // process alive, or fire during a test teardown.
  //
  // The `running` veto is the load-bearing part. A task this process is STILL EXECUTING is
  // not a dead one however long it has been going — re-queuing it would put a second writer
  // on one worktree and orphan the first child, whose kill handle would be gone from
  // `running`. Killing a genuinely hung step is the WATCHDOG's job (withWatchdog), not the
  // sweep's; these two mechanisms answer different questions and must not be merged.
  //
  // Returns how many leases were freed, so the caller can log a real number.
  function sweep() {
    let n = 0;
    try { n = queue.reclaimExpiredLeases((taskId) => running.has(taskId)); } catch { /* best-effort */ }
    // A requeue nobody picks up is not a recovery. Ticking here means the freed work runs
    // now rather than waiting for the next enqueue to happen along.
    tick();
    armNextWake();
    return n;
  }

  function start() {
    booted = true; // reconcile's claimed→requeue branch is boot-only from here on
    scheduler.start(runStep);
  }

  /**
   * C23 — every task this process believes it is running, with its age. `running` is the
   * engine's own in-memory truth; a row that is `claimed` with no entry here is an ORPHAN
   * (the process that claimed it is gone), which is precisely the state the live run hit and
   * could not name.
   */
  function stuckTasks() {
    const out = [];
    for (const id of running.keys()) {
      const row = queue.get(id);
      if (!row) continue;
      const since = Date.parse(row.claimedAt ?? "");
      out.push({
        taskId: id, agentId: row.agentId ?? null, status: row.status, engineState: row.engineState ?? null,
        claimedForMs: Number.isFinite(since) ? Math.max(0, now() - since) : null,
      });
    }
    return out;
  }

  return { enqueueGoal, runStep, tick, start, cancel, onOperatorApplied, reconcile, sweep, stuckTasks, _goalPlans: goalPlans };
}
