// Phase 1 / R4 — the DOCTOR. One command that answers "why is nothing happening?"
//
// THE DEFECT THIS EXISTS TO KILL, measured on this install:
//   The autonomous engine was blocked from 2026-08-16 to 2026-08-18 — three days, five
//   identical failures — with `tech-lead HEARTBEAT BLOCKED task failed: spawn after 3
//   tries` and `no active account cannot run the autonomous engine`. Every one of those
//   failures was recorded faithfully in SESSION_MEMORY and in the queue, and none of them
//   was ever SURFACED as a single actionable statement. The information existed; the
//   question "is this install healthy right now, and if not what do I type" had no answer.
//   Doctor is that answer.
//
// DESIGN RULES:
//   • READ-ONLY. Doctor never fixes. It reports, and every failing check carries a `fix`
//     string the operator can act on. A tool that silently repairs config is a tool that
//     hides the drift that caused the outage.
//   • EVERY probe is INJECTED. No check reaches for a global. Tests drive all of them.
//   • A check that THROWS is a check that reports `warn`, never a crash. Doctor is the
//     thing you run when the system is already broken; it must survive a broken system.
//   • NEVER leaks a secret. Checks report presence/shape, never a token value. The account
//     check reports id + standing, never the credential.
//
// STATUS VOCABULARY (closed): ok | warn | fail.
//   fail — the loop cannot do useful work until this is fixed.
//   warn — degraded; the loop runs but something is off or unproven.
//   ok   — measured good.

/** Closed status set. Anything else is a programming error. */
export const DOCTOR_STATUSES = Object.freeze(["ok", "warn", "fail"]);

/** Minimum supported Node major. Matches package.json engines + the repo's ESM usage. */
export const MIN_NODE_MAJOR = 20;

function mk(id, label, status, detail, fix = null) {
  return { id, label, status, detail, ...(fix ? { fix } : {}) };
}

/** Never let a single check's throw take down the report. */
async function safely(id, label, fn) {
  try {
    return await fn();
  } catch (e) {
    return mk(id, label, "warn", `check errored: ${e?.message || e}`, "Re-run `npm run doctor`; if it persists this is a doctor bug.");
  }
}

/**
 * Build the doctor.
 *
 * Injected seams (all optional — an absent seam becomes a `warn`, never a crash):
 *   nodeVersion   () => "v22.1.0"
 *   which         (bin) => Promise<string|null>          — resolved path or null
 *   run           (bin, args) => Promise<{ok, stdout}>   — argv array, shell:false
 *   readiness     () => { standing, accountId?, reason? } — engine-readiness composed
 *   guard         { status(): Promise<{ok, reason, availPct}> }
 *   db            { open: bool, path: string, wal: bool }
 *   ports         () => Promise<{[port]: 'listening'|'free'}>
 *   repoRoot      () => { path, isGit: bool }
 *   cadenceConfig () => { ok: bool, error?: string, workers?: number }   (R2 wiring)
 *   embedModel    () => { present: bool, path?: string }                 (R6 wiring)
 *   encryption    () => { enabled: bool, keyPresent: bool }              (R13 wiring)
 */
export function createDoctor(deps = {}) {
  const {
    nodeVersion = () => process.version,
    which = async () => null,
    run = async () => ({ ok: false, stdout: "" }),
    readiness = null,
    guard = null,
    db = null,
    ports = null,
    repoRoot = null,
    cadenceConfig = null,
    embedModel = null,
    encryption = null,
    hooks = null,
    selfGrade = null,
    // D8 — () => {done, failed, held, windowDays}. The only OUTCOME probe in the report.
    throughput = null,
    // #8 — () => [{key, label?, consecutive, remainingMs, reason}] for endpoints currently
    // refusing calls. Empty array = everything is answering.
    providerCooldown = null,
    // Phase 14 / 14.2 — the MANAGER LOOP's own health. Before these, doctor could report a
    // fully green runtime while no job could move: a Manager that had not ticked, a mailbox
    // backing up, an unparseable roster, or HR at its hiring cap. All four stop the loop dead
    // and none of them had a check, so the first symptom was a job that just sat there.
    //   managerTick  () => { lastTickMs, heartbeatMs, liveJobs }
    //   mailbox      () => { undelivered }
    //   rosterHealth () => { ok, error?, members?, workers? }
    //   hrHealth     () => { workers, cap }
    managerTick = null,
    mailbox = null,
    rosterHealth = null,
    hrHealth = null,
  } = deps;

  async function checkNode() {
    const v = String(nodeVersion() || "");
    const major = Number(/v?(\d+)/.exec(v)?.[1]);
    if (!Number.isFinite(major)) return mk("node", "Node.js", "warn", `unparseable version '${v}'`);
    return major >= MIN_NODE_MAJOR
      ? mk("node", "Node.js", "ok", `${v} (>= ${MIN_NODE_MAJOR} required)`)
      : mk("node", "Node.js", "fail", `${v} is below ${MIN_NODE_MAJOR}`, `Install Node ${MIN_NODE_MAJOR}+ — e.g. \`brew install node\``);
  }

  async function checkGh() {
    const path = await which("gh");
    if (!path) {
      return mk("gh", "GitHub CLI", "warn", "gh not on PATH — approve falls back to a LOCAL BRANCH (no PR)",
        "brew install gh && gh auth login");
    }
    const auth = await run("gh", ["auth", "status"]);
    return auth.ok
      ? mk("gh", "GitHub CLI", "ok", "installed and authenticated")
      : mk("gh", "GitHub CLI", "warn", "gh installed but not authenticated — approve falls back to a local branch",
          "gh auth login");
  }

  // THE CHECK THAT WOULD HAVE CAUGHT THE 3-DAY OUTAGE.
  async function checkAccount() {
    if (typeof readiness !== "function") {
      return mk("account", "Active account", "warn", "readiness probe not wired");
    }
    const r = (await readiness()) || {};
    const standing = r.standing || "none";
    if (standing === "none") {
      return mk("account", "Active account", "fail",
        "NO ACTIVE ACCOUNT — the autonomous engine cannot spawn. Every queued task will fail 'spawn' after 3 retries and mint a failure Delivery.",
        "Open Settings → Accounts, add an LLM account and set it active. (This blocked the engine 2026-08-16 → 2026-08-18.)");
    }
    if (standing === "backend") {
      return mk("account", "Active account", "fail", `account '${r.accountId || "?"}' cannot run under the current RUNTIME_BACKEND`,
        "Set RUNTIME_BACKEND to match the account transport (cli for subscription, api for key).");
    }
    if (standing === "cannot") {
      return mk("account", "Active account", "warn", `account '${r.accountId || "?"}' probed as not tool-capable`,
        "Pick a tool-capable model on the Accounts page, or re-probe.");
    }
    if (standing === "unmeasured") {
      return mk("account", "Active account", "warn", `account '${r.accountId || "?"}' has never been probed`,
        "Run a capability probe from the Accounts page.");
    }
    if (standing === "deterministic") {
      return mk("account", "Active account", "warn", "deterministic spawner active — no model is consulted (soak harness mode)",
        "Unset RUNTIME_ENGINE_SPAWNER=deterministic for live runs.");
    }
    return mk("account", "Active account", "ok", `'${r.accountId || "active"}' ready (${standing})`);
  }

  async function checkDb() {
    if (!db) return mk("db", "Delivery store", "warn", "db probe not wired");
    if (!db.open) return mk("db", "Delivery store", "fail", `cannot open ${db.path || "the SQLite store"}`,
      "Check RUNTIME_DB_PATH and that the directory exists and is writable (0600).");
    return mk("db", "Delivery store", db.wal ? "ok" : "warn",
      `${db.path || "store"} open${db.wal ? " (WAL)" : " — WAL not enabled"}`,
      db.wal ? null : "Expect WAL journal mode; a non-WAL store risks writer stalls.");
  }

  async function checkGuard() {
    if (!guard || typeof guard.status !== "function") return mk("guard", "Resource guard", "warn", "guard not wired");
    const s = await guard.status();
    if (s.reason === "degraded") {
      return mk("guard", "Resource guard", "warn", "memory probe unavailable — workers proceed (fail-open)");
    }
    if (!s.ok) {
      return mk("guard", "Resource guard", "warn",
        `workers deferring: ${s.reason} (avail ${s.availPct}% < ${s.minAvailPct}%, load/core ${s.loadPerCore})`,
        "Free memory or reduce load; workers resume automatically on the next tick.");
    }
    return mk("guard", "Resource guard", "ok", `avail ${s.availPct}%, load/core ${s.loadPerCore} — workers can run`);
  }

  async function checkPorts() {
    if (typeof ports !== "function") return mk("ports", "Ports", "warn", "port probe not wired");
    const p = (await ports()) || {};
    const entries = Object.entries(p);
    if (!entries.length) return mk("ports", "Ports", "warn", "no ports probed");
    return mk("ports", "Ports", "ok", entries.map(([k, v]) => `${k}:${v}`).join(" "));
  }

  async function checkRepo() {
    if (typeof repoRoot !== "function") return mk("repo", "Target repo", "warn", "repo probe not wired");
    const r = (await repoRoot()) || {};
    if (!r.path) return mk("repo", "Target repo", "fail", "no repo root resolved",
      "Set RUNTIME_REPO_ROOT or pick a project folder in Settings.");
    if (!r.isGit) return mk("repo", "Target repo", "fail", `${r.path} is not a git repository`,
      `cd ${r.path} && git init  — or point Settings at a real repo.`);
    return mk("repo", "Target repo", "ok", r.path);
  }

  // R2 wiring — a fail-closed cadence config means NO WORKERS, silently. That is the same
  // class of defect as the account outage, so it gets the same treatment: a named check.
  async function checkCadence() {
    if (typeof cadenceConfig !== "function") return mk("cadence", "Cadence workers", "warn", "cadence probe not wired");
    const c = (await cadenceConfig()) || {};
    if (!c.ok) {
      return mk("cadence", "Cadence workers", "fail",
        `cadence config invalid — NO background workers will run: ${c.error || "unknown error"}`,
        "Fix factory/cadence.json (it fails closed on purpose). Delete it to fall back to the built-in seed.");
    }
    if (!c.workers) {
      return mk("cadence", "Cadence workers", "warn", "no cadences enabled — the Inbox will not fill itself",
        "Enable a cadence in the cockpit, or run `cadence toggle`.");
    }
    return mk("cadence", "Cadence workers", "ok", `${c.workers} enabled`);
  }

  // R6 wiring — a missing embedding model degrades retrieval SILENTLY. Named check.
  async function checkEmbeddings() {
    if (typeof embedModel !== "function") return mk("embeddings", "Vault retrieval", "warn", "embeddings probe not wired");
    const e = (await embedModel()) || {};
    return e.present
      ? mk("embeddings", "Vault retrieval", "ok", "embedding model present — semantic prior-art active")
      : mk("embeddings", "Vault retrieval", "warn",
          "embedding model absent — retrieval degrades to empty (prompts carry no prior art)",
          "Run once with network access to fetch the model, or set RUNTIME_EMBED_DISABLED=1 to silence this.");
  }

  // R13 wiring — encryption must never fall back to plaintext silently.
  // R1 wiring — hooks that exist but are all disabled is indistinguishable, from the
  // outside, from hooks that were never wired. Both mean nothing guards a run. Named check.
  async function checkHooks() {
    if (typeof hooks !== "function") return mk("hooks", "Lifecycle hooks", "warn", "hooks probe not wired");
    const rows = (await hooks()) || [];
    if (!rows.length) return mk("hooks", "Lifecycle hooks", "warn", "no lifecycle events registered");
    const on = rows.filter((r) => r.enabled);
    const withHandlers = rows.filter((r) => (r.handlers || []).length);
    if (!on.length) {
      return mk("hooks", "Lifecycle hooks", "warn", "every hook event is DISABLED — nothing guards a run",
        "Unset the RUNTIME_HOOK_* env vars to re-enable lifecycle hooks.");
    }
    // An event that is ENABLED and EMPTY guards nothing, and from outside it is
    // indistinguishable from a guarded install. R1 shipped in exactly that state — the
    // dispatcher wired, the veto path live, zero handlers registered — and this line
    // graded it ok. Enabled-but-empty is now a named warn.
    if (!withHandlers.length) {
      return mk("hooks", "Lifecycle hooks", "warn",
        `${on.length}/${rows.length} events enabled but no handler is registered — the veto path exists and nothing uses it`,
        "Register a handler from server.mjs (engineHooks.register). Hooks are internal functions, never config-supplied commands.");
    }
    return mk("hooks", "Lifecycle hooks", "ok",
      `${on.length}/${rows.length} events enabled, ${withHandlers.length} with handlers`);
  }

  // R9 wiring — the config self-grade as a doctor line, so "is my posture drifting" is
  // answered by the same command as "is my install healthy".
  async function checkSelfGrade() {
    if (typeof selfGrade !== "function") return mk("selfgrade", "Config self-grade", "warn", "self-grade not wired");
    const g = await selfGrade();
    if (!g) return mk("selfgrade", "Config self-grade", "warn", "self-grade unavailable");
    if (g.worst === "critical") {
      return mk("selfgrade", "Config self-grade", "fail",
        `${g.score}/100 (${g.grade}) — CRITICAL: ${g.findings[0].detail}`, g.findings[0].fix);
    }
    if (g.findings.length) {
      return mk("selfgrade", "Config self-grade", "warn",
        `${g.score}/100 (${g.grade}), ${g.findings.length} finding(s); worst: ${g.findings[0].id}`,
        g.findings[0].fix);
    }
    return mk("selfgrade", "Config self-grade", "ok", `${g.score}/100 (${g.grade}), ${g.checked.length} sections graded`);
  }

  async function checkEncryption() {
    if (typeof encryption !== "function") return mk("encryption", "Encryption at rest", "warn", "encryption probe not wired");
    const e = (await encryption()) || {};
    if (!e.enabled) {
      return mk("encryption", "Encryption at rest", "warn",
        "OFF — Delivery store and vault are plaintext on disk (0600 only)",
        "Enable encryption at rest (Phase 4 / R13) if this machine leaves your control.");
    }
    if (!e.keyPresent) {
      return mk("encryption", "Encryption at rest", "fail",
        "enabled but the key is MISSING — stores will not open (fail-closed, never plaintext)",
        "Restore the key from the recovery phrase; see KEY-RECOVERY.md.");
    }
    return mk("encryption", "Encryption at rest", "ok", "enabled, key present");
  }

  // ── D8 — ENGINE THROUGHPUT ────────────────────────────────────────────────────
  //
  // Every other check here asks about a PRECONDITION: is there an account, is Docker up,
  // is the repo a repo. On 2026-08-24 all of them were green (`account: ok — 'active'
  // ready (runs)`) on an install whose engine had completed ZERO tasks and failed 42 —
  // because the quality gate could never pass. A report that is green while the product
  // does nothing is precisely the class of defect doctor exists to end, so the report now
  // also asks the outcome question: has the loop actually FINISHED anything lately.
  //
  // The three verdicts are deliberately different facts:
  //   fail — work was attempted and NONE of it completed. The loop is dead.
  //   warn — nothing was attempted (idle), or everything is sitting on a human (held).
  //   ok   — something completed.
  async function checkThroughput() {
    if (typeof throughput !== "function") {
      return mk("throughput", "Engine throughput", "warn", "throughput probe not wired");
    }
    const t = (await throughput()) || {};
    const done = Number(t.done) || 0;
    const failed = Number(t.failed) || 0;
    const held = Number(t.held) || 0;
    const days = Number(t.windowDays) || 7;
    if (done > 0) {
      // 14.2 — the MILESTONE's number rides alongside the task counts. Jobs shipped is what
      // "≥ 5 shipped as PRs in a week" is measured in; tasks are the machinery under it.
      const jobs = Number(t.jobsShipped7d);
      const jobsPart = Number.isFinite(jobs) ? `, ${jobs} job(s) shipped` : "";
      return mk("throughput", "Engine throughput", "ok", `${done} completed / ${failed} failed / ${held} held in the last ${days}d${jobsPart}`);
    }
    if (failed > 0) {
      return mk("throughput", "Engine throughput", "fail",
        `0 completed and ${failed} failed in the last ${days}d — the autonomous loop is not finishing work`,
        "Open the newest failed task (GET /runtime/engine/runs) and read its error.kind: `gate-veto` = the quality gate; `not-capable`/`backend` = the active account; `spawn`/`timeout` = the provider.");
    }
    if (held > 0) {
      return mk("throughput", "Engine throughput", "warn",
        `no completions in ${days}d; ${held} task(s) awaiting an operator decision`,
        "Decide the held work in the Inbox, or relax the per-agent auto-apply policy.");
    }
    return mk("throughput", "Engine throughput", "warn", `no engine task ran in the last ${days}d — the loop is idle`);
  }

  // ── #8 — PROVIDER COOLDOWN ────────────────────────────────────────────────────
  //
  // On 2026-08-24 the honest answer to "why is nothing happening" was that the only
  // configured endpoint was rate-limiting every caller, and this report had no way to say
  // so: account `ok`, readiness `runs`, throughput dead. A busy provider is not a broken
  // install — it is a WARN with a number on it, so the operator can tell "wait" from "fix".
  async function checkProvider() {
    if (typeof providerCooldown !== "function") {
      return mk("provider", "Provider", "warn", "provider cooldown probe not wired");
    }
    const rows = (await providerCooldown()) || [];
    if (!rows.length) return mk("provider", "Provider", "ok", "no provider is in cooldown — endpoints are answering");
    const worst = rows.slice().sort((a, b) => (b.remainingMs || 0) - (a.remainingMs || 0))[0];
    const who = worst.label || worst.key || "the active provider";
    const secs = Math.ceil((Number(worst.remainingMs) || 0) / 1000);
    return mk("provider", "Provider", "warn",
      `${who} is refusing calls (${worst.consecutive || 1}x) — holding for ${secs}s: ${String(worst.reason || "").slice(0, 120)}`,
      "Wait it out, or add a second account on the Accounts page so the swarm is not behind one shared rate limit.");
  }

  // The Manager drives every job. If it has not ticked, nothing moves and nothing says so.
  // TWO heartbeats of slack: one missed beat is scheduling, two is a loop that has stopped.
  async function checkManager() {
    // The CLI cannot answer this: a tick age is RUNTIME state and `npm run doctor` is not the
    // runtime. Say that, rather than "probe not wired", which reads like a bug in the check.
    if (typeof managerTick !== "function") {
      return mk("manager", "Manager loop", "warn",
        "not measurable from the CLI — the tick age lives in the running runtime",
        "Read it from a running runtime: GET /runtime/doctor.");
    }
    const m = (await managerTick()) || {};
    const live = Number(m.liveJobs) || 0;
    const beat = Math.max(1_000, Number(m.heartbeatMs) || 15_000);
    // An install with nothing queued has nothing to tick. Reporting that as a dead loop would
    // make the check cry wolf on every idle machine, and a check nobody believes is not a check.
    if (live === 0) return mk("manager", "Manager loop", "ok", "idle — no live jobs to tick");
    const age = Date.now() - (Number(m.lastTickMs) || 0);
    if (age > beat * 2) {
      return mk("manager", "Manager loop", "fail",
        `${live} live job(s) and the Manager has not ticked for ${Math.round(age / 1000)}s (heartbeat ${Math.round(beat / 1000)}s)`,
        "The heartbeat has stopped or a tick is wedged. Check the runtime log for `[manager] tick failed`, then restart the runtime.");
    }
    return mk("manager", "Manager loop", "ok", `${live} live job(s), last tick ${Math.round(age / 1000)}s ago`);
  }

  // Mail is how seats hand off and how the engine tells the Manager a task ended. A backlog
  // means the router is not draining, and every job in flight is waiting on news.
  async function checkMailbox() {
    if (typeof mailbox !== "function") return mk("mailbox", "Mailbox", "warn", "mailbox probe not wired");
    const m = (await mailbox()) || {};
    const n = Number(m.undelivered) || 0;
    return n >= 50
      ? mk("mailbox", "Mailbox", "warn", `${n} message(s) undelivered — the router is not draining`,
        "Check the runtime log for router errors; messages stay on disk, so nothing is lost.")
      : mk("mailbox", "Mailbox", "ok", `${n} undelivered`);
  }

  // roster.json decides WHO MAY WRITE WHERE. Unparseable is not a degraded read — it is the
  // control surface being unavailable.
  async function checkRoster() {
    if (typeof rosterHealth !== "function") return mk("roster", "Roster", "warn", "roster probe not wired");
    const r = (await rosterHealth()) || {};
    if (!r.ok) {
      return mk("roster", "Roster", "fail", String(r.error || "roster could not be read"),
        "Fix agent-runtime/roster.json — until it parses, no seat has a writeScope and no task can be assigned.");
    }
    return mk("roster", "Roster", "ok", `${Number(r.members) || 0} seat(s), ${Number(r.workers) || 0} worker(s)`);
  }

  // At the cap the NEXT unmatched skill has nowhere to go, and its job parks in `awaiting-hire`
  // with no timeout — a silent stall rather than a refusal.
  async function checkHr() {
    if (typeof hrHealth !== "function") return mk("hr", "HR capacity", "warn", "hr probe not wired");
    const h = (await hrHealth()) || {};
    const workers = Number(h.workers) || 0;
    const cap = Number(h.cap) || 0;
    if (cap > 0 && workers >= cap) {
      return mk("hr", "HR capacity", "fail", `${workers}/${cap} worker seats — HR cannot hire, so the next unmatched skill will stall its job`,
        "Retire seats you no longer need on the Agents page, or raise the worker cap.");
    }
    if (cap > 0 && workers >= cap - 1) {
      return mk("hr", "HR capacity", "warn", `${workers}/${cap} worker seats — one hire left`);
    }
    return mk("hr", "HR capacity", "ok", `${workers}/${cap || "?"} worker seats`);
  }

  /** Run every check. Never throws. Returns {checks, summary, status}. */
  async function run_() {
    const checks = await Promise.all([
      safely("node", "Node.js", checkNode),
      safely("gh", "GitHub CLI", checkGh),
      safely("account", "Active account", checkAccount),
      safely("db", "Delivery store", checkDb),
      safely("guard", "Resource guard", checkGuard),
      safely("cadence", "Cadence workers", checkCadence),
      safely("repo", "Target repo", checkRepo),
      safely("ports", "Ports", checkPorts),
      safely("embeddings", "Vault retrieval", checkEmbeddings),
      safely("hooks", "Lifecycle hooks", checkHooks),
      safely("selfgrade", "Config self-grade", checkSelfGrade),
      safely("encryption", "Encryption at rest", checkEncryption),
      safely("manager", "Manager loop", checkManager),
      safely("mailbox", "Mailbox", checkMailbox),
      safely("roster", "Roster", checkRoster),
      safely("hr", "HR capacity", checkHr),
      safely("throughput", "Engine throughput", checkThroughput),
      safely("provider", "Provider", checkProvider),
    ]);
    const counts = { ok: 0, warn: 0, fail: 0 };
    for (const c of checks) counts[c.status] = (counts[c.status] || 0) + 1;
    const status = counts.fail > 0 ? "fail" : counts.warn > 0 ? "warn" : "ok";
    return {
      checks,
      summary: counts,
      status,
      fixes: checks.filter((c) => c.status !== "ok" && c.fix).map((c) => ({ id: c.id, fix: c.fix })),
    };
  }

  return { run: run_, checkAccount, checkGuard, checkCadence, checkThroughput, checkProvider };
}

/** Human-readable render for the CLI. Pure — takes a report, returns a string. */
export function renderDoctor(report) {
  const glyph = { ok: "✓", warn: "⚠", fail: "✗" };
  const lines = ["MissionAlpha Doctor", "─".repeat(56)];
  for (const c of report.checks) lines.push(`${glyph[c.status]} ${c.label}: ${c.detail}`);
  lines.push("─".repeat(56));
  lines.push(`${report.summary.ok} ok · ${report.summary.warn} warn · ${report.summary.fail} fail`);
  if (report.fixes.length) {
    lines.push("", "Fixes:");
    for (const f of report.fixes) lines.push(`  [${f.id}] ${f.fix}`);
  }
  return lines.join("\n");
}
