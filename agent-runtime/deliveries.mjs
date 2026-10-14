// ADR-051 — Delivery engine. Mints the Inbox's core record from the EXISTING
// broker diff, persists patch bodies on disk, and executes the three decision
// verbs through the SAME broker.applyChanges the operator /apply route already
// uses. This module NEVER writes the live repo itself and NEVER re-implements a
// diff walk — it consumes `listChanges()` output.
//
// SECURITY (ADR-051 §7 + security table):
//   • Ids are server-minted ULIDs — never user input, never a path component the
//     caller controls (db.patchDirFor re-asserts containment anyway).
//   • summary/title/feedback are scrubbed AT REST and every egress payload is
//     scrubbed again on the way out, using the server's shared scrub() (injected).
//     No second SECRET_RE lives here.
//   • `auto_approved` is BLOCKED: this module refuses to write that status and
//     refuses any verb that would produce it. Reserved for ADR-053 (P6), which
//     ships with its own security sign-off.
//   • Every statement is parameterized; status/agentId filters are validated
//     against allow-lists before binding.
//   • Emit-on-persist (ADR-052 §2): the function that writes the row is the
//     function that emits — no watcher, no dual path.

import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync, rmSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { DELIVERY_STATUSES } from "./db.mjs";
import { classify, detectNewDependency } from "./risk.mjs";
import { isAutoSafe } from "./policy.mjs";
// P-EDIT (Phase 4) — approve-with-edit. Validation + staging only: this module still
// never writes the live repo, and the edited content lands through the SAME
// broker.applyChanges every other approve uses.
import {
  validateEdits,
  validateUnifiedDiff,
  reviewedMatchesDisk,
  restoreTerminator,
  stageEdits,
  readWorkdirFile,
} from "./patch-edit.mjs";

// MUNDER-ADOPTION A7 — 'slack' joins as a READ-ONLY external source (like claude-code):
// a Slack message can ask, it can never ship. decide() refuses it below.
const SOURCES = Object.freeze(["swarm", "claude-code", "github-pr", "slack", "external"]);
// P7 / ADR-054 — the sources an ADAPTER may mint. `swarm` stays the ONLY auto-appliable
// source (autoApprove refuses everything else); these two are ingested from outside.
const EXTERNAL_SOURCES = Object.freeze(["github-pr", "claude-code", "slack"]);
// `failure` (P4 / ADR-051 §9) is mint-able ONLY through mintFailure(): it is the
// diff-less "agent stuck — needs you" row, never a code delivery with zero files.
// Story-Pipeline S2/S5 — `question`, `design-approval` and `release-approval` are the HUMAN-GATE
// kinds, minted ONLY through mintGate(): also diff-less, also "needs you", but they carry a
// `storyId` back-pointer and their decision routes back to a Story (never a repo apply).
// `release-approval` (S5) is the release-accept gate the BOSS decides before a deploy executes.
// mint() refuses all diff-less kinds; each has its own dedicated mint path.
// EXPORTED so the drift between these two lists, risk.mjs's copy and the client's mirror
// can be ASSERTED rather than assumed (job-approval.test.mjs JA-6/JA-7). Nothing pinned
// them before, and a kind that is a gate in one module and a diff row in another is a row
// the Inbox cannot render.
export const KINDS = Object.freeze(["code", "doc", "post", "command", "failure", "question", "design-approval", "release-approval", "job-approval"]);
// The diff-less human-gate kinds (S2). Kept as a set for the decide() gate-branch below:
// a gate decision flips status, emits, and fires onDecided — then STOPS. It never touches a
// broker, a worktree or an engine goal, because a gate has no diff and no task to advance;
// its ONLY side effect is the Story transition, which the pipeline owns via onDecided.
export const GATE_KINDS = Object.freeze(new Set(["question", "design-approval", "release-approval", "job-approval"]));

/** #4 — a job's CLARIFY gate (slot `<job>-q`): the Manager's questions, ANSWERED through
 *  /runtime/jobs/:id/answer. Its other question gates (-hire, -esc-N, -blocked-T) are decisions. */
export const isJobClarifyGate = (row) =>
  row?.kind === "question" && !!row?.jobId && row?.taskId === `${row.jobId}-q`;
// Every placeholder the scrub layer can substitute into reviewed text. Their presence
// means the reviewer is NOT looking at the bytes on disk, which makes the file
// un-editable (Phase 4). Keep in step with factory.mjs and secret-scrub.mjs.
const REDACTION_MARKERS = Object.freeze(["[redacted-secret]", "[redacted-mcp-cred]", "<redacted>"]);
const VERBS = Object.freeze({ approve: "approved", reject: "rejected", request_changes: "changes_requested" });
const MAX_TITLE = 200;
const MAX_SUMMARY = 4000;
const MAX_FEEDBACK = 2000;
const MAX_CHANGES = 200;

// ── ULID (ADR-051 §6) ────────────────────────────────────────────────────────
// Crockford base32, 10 chars of ms timestamp + 16 chars of randomness. Sorts
// lexicographically by creation time (so the Inbox list needs no ORDER BY
// createdAt) and is opaque (no enumerable counter in an operator-visible URL).
// Monotonic within a millisecond: the randomness field is incremented rather than
// re-rolled, so a burst inside one tick still sorts in creation order.
const ENC = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

let lastMs = -1;
let lastRand = null; // array of 16 base32 digit values

function randDigits() {
  const b = randomBytes(16);
  return Array.from(b, (x) => x % 32);
}
function bumpDigits(d) {
  const out = d.slice();
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i] < 31) { out[i]++; return out; }
    out[i] = 0;
  }
  return randDigits(); // overflowed a full 80-bit field in one ms — practically unreachable
}
function encodeTime(ms) {
  let out = "";
  let n = ms;
  for (let i = 0; i < 10; i++) { out = ENC[n % 32] + out; n = Math.floor(n / 32); }
  return out;
}
export function ulid(nowMs = Date.now()) {
  if (nowMs === lastMs && lastRand) lastRand = bumpDigits(lastRand);
  else { lastMs = nowMs; lastRand = randDigits(); }
  return encodeTime(nowMs) + lastRand.map((i) => ENC[i]).join("");
}

// ── unified diff (ADR-051 §3 — patch bodies live on disk as real .patch files) ─
// before/after are already capped at 4000 chars by broker.mjs's trunc(), so an
// O(n·m) LCS over ~100 lines is cheap and gives an exact minimal diff — which is
// what makes diffFiles/Additions/Deletions honest for the Inbox row and for P6's
// risk router.
function lines(s) {
  if (s === null || s === undefined) return [];
  const out = s.split("\n");
  if (out.length && out[out.length - 1] === "") out.pop(); // trailing newline is not a line
  return out;
}

// Walk the LCS table into an ops list: {op:' '|'-'|'+', text}.
function diffOps(before, after) {
  const a = lines(before), b = lines(after);
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ op: " ", text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ op: "-", text: a[i] }); i++; }
    else { ops.push({ op: "+", text: b[j] }); j++; }
  }
  while (i < n) ops.push({ op: "-", text: a[i++] });
  while (j < m) ops.push({ op: "+", text: b[j++] });
  return ops;
}

export function diffStat(before, after) {
  let additions = 0, deletions = 0;
  for (const o of diffOps(before, after)) {
    if (o.op === "+") additions++;
    else if (o.op === "-") deletions++;
  }
  return { additions, deletions };
}

// FULL context, deliberately. broker.mjs already truncates before/after at 4000
// chars (~100 lines), so a whole-file hunk costs nothing — and it makes the .patch
// LOSSLESS: get() reconstructs the exact before/after from the frame's own -/+/space
// lines for the P3 review pane, while the file stays a valid unified diff. With
// 3-line context, lines outside a hunk would silently vanish from that
// reconstruction, which is worse than a slightly longer patch.
const CONTEXT = Number.POSITIVE_INFINITY;

export function unifiedDiff(path, before, after) {
  const ops = diffOps(before, after);
  const head = `--- ${before === null || before === undefined ? "/dev/null" : `a/${path}`}\n+++ b/${path}\n`;
  // Group changed ops into hunks with CONTEXT lines of surrounding equality.
  const changed = ops.map((o, i) => (o.op === " " ? -1 : i)).filter((i) => i >= 0);
  if (!changed.length) return head;
  const hunks = [];
  let start = changed[0], end = changed[0];
  for (const idx of changed.slice(1)) {
    if (idx - end <= CONTEXT * 2) { end = idx; continue; }
    hunks.push([start, end]);
    start = idx; end = idx;
  }
  hunks.push([start, end]);

  let out = head;
  for (const [s, e] of hunks) {
    const from = Math.max(0, s - CONTEXT);
    const to = Math.min(ops.length - 1, e + CONTEXT);
    // 1-based start lines + counts for each side of the hunk header.
    let aStart = 1, bStart = 1;
    for (let k = 0; k < from; k++) {
      if (ops[k].op !== "+") aStart++;
      if (ops[k].op !== "-") bStart++;
    }
    let aCount = 0, bCount = 0;
    for (let k = from; k <= to; k++) {
      if (ops[k].op !== "+") aCount++;
      if (ops[k].op !== "-") bCount++;
    }
    out += `@@ -${aStart},${aCount} +${bStart},${bCount} @@\n`;
    for (let k = from; k <= to; k++) out += `${ops[k].op}${ops[k].text}\n`;
  }
  return out;
}

// Patch files mirror the changed path under the delivery's own dir. The path is
// re-sanitised here (strip drive/leading separators, drop `..` segments) and the
// resolved destination is asserted inside the delivery dir — an agent-authored
// path never becomes a write outside data/patches/<id>/.
function patchFileFor(deliveryDir, relPath) {
  const safeParts = String(relPath)
    .split(/[\\/]+/)
    .filter((p) => p && p !== "." && p !== "..")
    .map((p) => p.replace(/[\x00-\x1f]/g, "_")); // eslint-disable-line no-control-regex
  if (!safeParts.length) safeParts.push("unnamed");
  const dest = resolve(deliveryDir, `${safeParts.join(sep)}.patch`);
  if (!dest.startsWith(resolve(deliveryDir) + sep)) throw new Error("patch path escapes the delivery dir");
  return dest;
}

// Never write THROUGH a symlink — a pre-planted link at the patch destination would
// redirect the write outside data/patches/<id>/, defeating the containment check
// above. Same posture as the broker's apply-time guard (broker.mjs L105).
function isSymlinkDest(dest) {
  try { return lstatSync(dest).isSymbolicLink(); } catch { return false; /* absent — fine */ }
}

const isTaskKey = (k) => /^task_[0-9a-f]{6,}$/i.test(String(k || ""));

export function createDeliveries(deps = {}) {
  const store = deps.db;                       // openDb() handle
  const events = deps.events || { emit: () => {} };
  const scrub = deps.scrub || ((s) => s);
  const audit = deps.audit || (() => {});
  const applyFn = deps.applyFn || (async () => []);
  const listChangesFn = deps.listChangesFn || (async () => []);
  const reportBackFn = deps.reportBackFn || (() => {});
  const discardFn = deps.discardFn || (() => {});
  const rerunFn = deps.rerunFn || (() => {});
  // P4 auto-chain — called with the queue taskId AFTER a successful approve+apply so
  // the engine advances its goal chain (engine.onOperatorApplied) and the agent's next
  // task dispatches with no human action. Optional: unset ⇒ P2/P3 behavior unchanged.
  const onApproved = deps.onApproved || null;
  // Phase 4 — approve-with-edit. `workdirFor(brokerKey)` resolves the agent's isolation
  // dir (engine worktree or copy-sandbox), which is where an operator edit is STAGED.
  // Unset ⇒ editing is refused with 501; every pre-Phase-4 behaviour is untouched.
  const workdirFor = typeof deps.workdirFor === "function" ? deps.workdirFor : null;
  // P5 (ADR-026 as-built) — how an approved Delivery LEAVES the runtime. Returns
  // {mode,branch,prUrl,reason,refused}. Unset ⇒ pre-P5 behavior exactly: the broker
  // applies straight into the live working tree and the mode is recorded as 'apply'.
  const deliverFn = deps.deliverFn || null;
  // P6 (ADR-053) — band → SLA window (ms). Injected by the server from the band
  // policy + env. Unset ⇒ no deadline is written (slaDeadline stays null), so any
  // caller that does not wire SLA behaves exactly as it did pre-P6.
  const slaFor = typeof deps.slaFor === "function" ? deps.slaFor : () => null;
  // P7 (ADR-054) — how a github-pr Delivery's decision LEAVES the runtime: an OUTBOUND
  // `gh pr review/close` (wired by the server to the GitHub adapter). Unset ⇒ a github-pr
  // decide returns 501 rather than silently applying through the local broker.
  const externalDecideFn = typeof deps.externalDecideFn === "function" ? deps.externalDecideFn : null;
  // B2 / ADR-055 — the DECISION choke point. Called ONCE per delivery that actually
  // flips to a terminal status (a lost race changes no row and fires nothing), with
  // the row and `{status, by, feedback}`, so the Knowledge Vault can persist the
  // decision into its `decisions` node. Fired for BOTH the local path and the
  // github-pr path — a decision is a decision wherever it landed. Isolated in a try:
  // the record is OBSERVATIONAL and must never un-decide a committed decision.
  // Optional: unset ⇒ pre-B2 behavior exactly.
  const onDecided = deps.onDecided || null;
  const fireDecided = (row, info) => { if (onDecided) { try { onDecided(row, info); } catch { /* observational — the decision is already committed */ } } };
  const now = deps.now || (() => Date.now());
  if (!store || !store.db) throw new Error("createDeliveries: db handle required");
  const db = store.db;

  const nowIso = () => new Date(now()).toISOString();
  // Band → absolute-UTC SLA deadline (ISO), or null when SLA is not wired / the band
  // has no window. Stored ABSOLUTE so the client renders a drift-free countdown.
  const deadlineFor = (band) => {
    const ms = Number(slaFor(band));
    return Number.isFinite(ms) && ms > 0 ? new Date(now() + ms).toISOString() : null;
  };
  // Strip control chars (keeping \t \n \r so a summary/feedback stays readable),
  // then run the SHARED scrub (ADR-051 §7), then cap. Scrub-at-rest AND on egress.
  // eslint-disable-next-line no-control-regex
  const CTRL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
  const clean = (s, cap) => scrub(String(s ?? "").replace(CTRL, "")).slice(0, cap);
  const oneLine = (s, cap) => clean(s, cap).replace(/\s+/g, " ").trim().slice(0, cap);

  // Row → the master-spec §3 Delivery shape, scrubbed on the way out (§7).
  function hydrate(row) {
    if (!row) return null;
    return {
      id: row.id,
      agentId: row.agentId,
      taskId: row.taskId,
      title: scrub(row.title),
      summary: scrub(row.summary),
      source: row.source,
      kind: row.kind,
      diffstat: { files: row.diffFiles, additions: row.diffAdditions, deletions: row.diffDeletions },
      diffFiles: row.diffFiles,
      diffAdditions: row.diffAdditions,
      diffDeletions: row.diffDeletions,
      changedPaths: safeJson(row.changedPaths, []),
      risk: { score: row.riskScore, band: row.riskBand, reasons: safeJson(row.riskReasons, []) },
      status: row.status,
      slaDeadline: row.slaDeadline,
      createdAt: row.createdAt,
      decidedAt: row.decidedAt,
      decidedBy: row.decidedBy,
      feedback: row.feedback === null || row.feedback === undefined ? null : scrub(row.feedback),
      auditRef: row.auditRef,
      // P5 (migration v3) — HOW this Delivery left the runtime. Null until decided.
      mode: row.mode ?? null,
      branch: row.branch ?? null,
      prUrl: row.prUrl ?? null,
      // P6 (migration v5) — SLA escalation stage. Null while inside the first half of
      // the window; 'halflife' / 'expired' once the sweep has escalated it.
      slaState: row.slaState ?? null,
      // P7 (migration v6) — external ingestion. `externalKey` is the idempotency key;
      // `externalMeta` carries the adapter's decide-routing + render data (repo, PR
      // number, url, sessionId, readOnly). Both NULL for swarm rows.
      externalKey: row.externalKey ?? null,
      externalMeta: row.externalMeta ? safeJson(row.externalMeta, null) : null,
      // P9 (migration v8) — advisory assignment pointer to the approver expected to
      // decide this Delivery. NULL = unassigned. Not an ownership constraint: any
      // approver may still decide (assignment is a hint, enforced nowhere on decide).
      assignee: row.assignee ?? null,
      // S2 (migration v16) — the Story a HUMAN-GATE delivery (question / design-approval)
      // belongs to. NULL for every non-gate row. The pipeline reads it to route a gate
      // decision back to its Story; server-minted, never caller-supplied.
      storyId: row.storyId ?? null,
      jobId: row.jobId ?? null,
    };
  }
  const safeJson = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };

  const SEL = "SELECT * FROM deliveries WHERE id = ?";
  const getRow = (id) => db.prepare(SEL).get(id) || null;
  // P7 — the pending-key now keys on externalKey FIRST (migration v6), so two pending
  // PRs from the SAME bot author don't collapse to one 'agent:'||agentId slot. Swarm
  // rows pass externalKey=null and behave exactly as before.
  const mintKeyOf = (taskId, agentId, externalKey) => externalKey || taskId || `agent:${agentId}`;
  const findPendingByKey = (taskId, agentId, externalKey = null) =>
    db.prepare("SELECT * FROM deliveries WHERE status='pending' AND COALESCE(externalKey, taskId, 'agent:' || agentId) = ?").get(mintKeyOf(taskId, agentId, externalKey)) || null;
  // P7 — adapter idempotency + state-sync lookups (any status for the exact key; all
  // pending external rows for a source, matched on externalMeta by the adapter).
  const findByExternalKey = (key) =>
    key ? db.prepare("SELECT * FROM deliveries WHERE externalKey = ? ORDER BY id DESC LIMIT 1").get(String(key)) || null : null;

  // ── mint (ADR-051 §4) ──────────────────────────────────────────────────────
  // Called from the engine's DIFFED→GATING transition and from the manual /run +
  // /changes path. Both feed it the SAME listChanges() output — no new diff walk.
  function mint(input = {}) {
    if (input.status && input.status !== "pending") {
      // ADR-051 security table: only ADR-053 (P6) may ever write auto_approved,
      // and no caller may pre-set a terminal status at mint time.
      throw new Error(`mint: status must be 'pending' (got '${input.status}')`);
    }
    const agentId = String(input.agentId || "").replace(/[^a-z0-9_-]/gi, "").slice(0, 64);
    if (!agentId) throw new Error("mint: agentId required");
    const taskId = input.taskId ? String(input.taskId).replace(/[^a-z0-9_-]/gi, "").slice(0, 80) : null;
    const source = SOURCES.includes(input.source) ? input.source : null;
    if (!source) throw new Error(`mint: source must be one of ${SOURCES.join("|")}`);
    const kind = KINDS.includes(input.kind) ? input.kind : null;
    if (!kind) throw new Error(`mint: kind must be one of ${KINDS.join("|")}`);
    if (kind === "failure") throw new Error("mint: kind 'failure' is minted only via mintFailure()");
    if (GATE_KINDS.has(kind)) throw new Error(`mint: kind '${kind}' is a diff-less gate, minted only via mintGate()`);
    const changes = Array.isArray(input.changes) ? input.changes.slice(0, MAX_CHANGES) : [];
    if (!changes.length) throw new Error("mint: changes[] required (a Delivery with no diff is a P4 failure-delivery, not this path)");

    // A pending row for this work unit already exists → return it, emit nothing.
    const existing = findPendingByKey(taskId, agentId);
    if (existing) return { ...hydrate(existing), deduped: true };

    let additions = 0, deletions = 0;
    const changedPaths = [];
    for (const c of changes) {
      const st = diffStat(c.before ?? null, c.after ?? "");
      additions += st.additions;
      deletions += st.deletions;
      changedPaths.push(String(c.path));
    }

    const id = ulid(now());
    const auditRef = `delivery:${id}`;
    const createdAt = nowIso();
    const title = oneLine(input.title || changedPaths[0] || "Delivery", MAX_TITLE) || "Delivery";
    const summary = clean(input.summary || "", MAX_SUMMARY);

    // P6 (ADR-053) — classify risk from the SAME diff the row already carries (no LLM,
    // no second walk) and stamp the absolute-UTC SLA deadline for the band. The band
    // GATES auto-apply upstream; a mint that does not wire slaFor writes a null deadline.
    const risk = classify({
      changedPaths, additions, deletions, files: changes.length, kind,
      newDependency: detectNewDependency(changes),
    });
    const slaDeadline = deadlineFor(risk.band);

    // Patch bodies to disk BEFORE the row, so a crash can only ever leave orphan
    // patch files (harmless, id-scoped) — never a row pointing at nothing.
    const dir = store.patchDirFor(id);
    for (const c of changes) {
      const dest = patchFileFor(dir, c.path);
      mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
      if (isSymlinkDest(dest)) continue; // refuse write-through to a link target
      writeFileSync(dest, scrub(unifiedDiff(String(c.path), c.before ?? null, c.after ?? "")), { mode: 0o600 });
    }

    let row;
    try {
      db.transaction(() => {
        db.prepare(
          `INSERT INTO deliveries
             (id, agentId, taskId, title, summary, source, kind, diffFiles, diffAdditions, diffDeletions,
              changedPaths, riskScore, riskBand, riskReasons, slaDeadline, status, createdAt, auditRef)
           VALUES (@id, @agentId, @taskId, @title, @summary, @source, @kind, @diffFiles, @diffAdditions, @diffDeletions,
              @changedPaths, @riskScore, @riskBand, @riskReasons, @slaDeadline, 'pending', @createdAt, @auditRef)`,
        ).run({
          id, agentId, taskId, title, summary, source, kind,
          diffFiles: changes.length, diffAdditions: additions, diffDeletions: deletions,
          changedPaths: JSON.stringify(changedPaths),
          riskScore: risk.score, riskBand: risk.band, riskReasons: JSON.stringify(risk.reasons), slaDeadline,
          createdAt, auditRef,
        });
      })();
      row = getRow(id);
    } catch (e) {
      // Lost a race against a concurrent mint for the same work unit (the partial
      // unique index is the referee). Return whatever won.
      if (String(e?.code || "").includes("SQLITE_CONSTRAINT")) {
        const winner = findPendingByKey(taskId, agentId);
        if (winner) return { ...hydrate(winner), deduped: true };
      }
      throw e;
    }

    const out = hydrate(row);
    audit("delivery.created", { ref: auditRef, id, agentId, taskId, files: changes.length, paths: changedPaths });
    events.emit("delivery.created", out); // emit-on-persist, same function (ADR-052 §2)
    return out;
  }

  // ── mintFailure (ADR-051 §9, wired in P4) ──────────────────────────────────
  // Retry budget exhausted, or a terminal (non-retryable) error: the agent is STUCK.
  // Surface it in the Inbox as a diff-less Delivery instead of letting it die on the
  // heartbeat bus. No patch files are written (there is no diff), the row carries the
  // classified kind + a scrubbed tail of the agent's last output, and it dedupes on
  // the SAME pending-unique index as mint() — but only against another `failure` row.
  // A pending `code` row for the same work unit is SUPERSEDED (expired), never kept:
  // the task is already terminal, so that diff will never be applied.
  const MAX_DETAIL = 1200;
  function mintFailure(input = {}) {
    const agentId = String(input.agentId || "").replace(/[^a-z0-9_-]/gi, "").slice(0, 64);
    if (!agentId) throw new Error("mintFailure: agentId required");
    const taskId = input.taskId ? String(input.taskId).replace(/[^a-z0-9_-]/gi, "").slice(0, 80) : null;
    const failKind = String(input.kind || "unknown").replace(/[^a-z-]/gi, "").slice(0, 32) || "unknown";
    const attempts = Number.isFinite(Number(input.attempts)) ? Math.max(0, Math.floor(Number(input.attempts))) : 0;

    // Dedupe is per WORK UNIT but NOT across kinds. The pending row for a task that
    // has just gone terminal is a stale `code` Delivery for work that will never land;
    // returning it here swallowed the apply-rejected / retries-exhausted failure the
    // operator actually needs to see, AND left that stale row pending against a task
    // the queue already marked FAILED. Expire it (which frees the partial unique index
    // so the INSERT below lands) and let the failure row take its place. A second
    // identical terminal failure still dedupes — onto the failure row.
    const existing = findPendingByKey(taskId, agentId);
    if (existing && existing.kind !== "failure") {
      db.prepare("UPDATE deliveries SET status='expired', decidedAt=?, decidedBy='system' WHERE id=? AND status='pending'")
        .run(nowIso(), existing.id);
      // emit-on-persist (ADR-052 §2): the badge counted that row on delivery.created,
      // so the supersede MUST announce itself or the Inbox over-counts by one forever.
      events.emit("delivery.decided", { id: existing.id, status: "expired", by: "system" });
      audit("delivery.expired", { ref: existing.auditRef, id: existing.id, agentId, taskId, by: "system", reason: "superseded-by-failure" });
    } else if (existing) {
      return { ...hydrate(existing), deduped: true };
    }

    const id = ulid(now());
    const auditRef = `delivery:${id}`;
    const createdAt = nowIso();
    const title = oneLine(`${agentId} is stuck — ${failKind}`, MAX_TITLE);
    // clean() runs the SHARED scrub, so a secret in a stderr tail never lands at rest.
    const summary = clean(
      `Agent ${agentId} could not finish this task.\n`
      + `Classified error: ${failKind}\n`
      + `Attempts: ${attempts}\n`
      + `Last output:\n${String(input.detail ?? "").slice(-MAX_DETAIL)}`,
      MAX_SUMMARY,
    );

    // A stuck-agent failure is its own risk band (high — it needs prompt attention)
    // and gets the high-band SLA so it escalates fast if ignored.
    const risk = classify({ kind: "failure" });
    const slaDeadline = deadlineFor(risk.band);
    let row;
    try {
      db.transaction(() => {
        db.prepare(
          `INSERT INTO deliveries
             (id, agentId, taskId, title, summary, source, kind, diffFiles, diffAdditions, diffDeletions,
              changedPaths, riskScore, riskBand, riskReasons, slaDeadline, status, createdAt, auditRef)
           VALUES (@id, @agentId, @taskId, @title, @summary, 'swarm', 'failure', 0, 0, 0,
              '[]', @riskScore, @riskBand, @riskReasons, @slaDeadline, 'pending', @createdAt, @auditRef)`,
        ).run({ id, agentId, taskId, title, summary, riskScore: risk.score, riskBand: risk.band, riskReasons: JSON.stringify(risk.reasons), slaDeadline, createdAt, auditRef });
      })();
      row = getRow(id);
    } catch (e) {
      // Lost a race against a concurrent mint for the same work unit — return the winner.
      if (String(e?.code || "").includes("SQLITE_CONSTRAINT")) {
        const winner = findPendingByKey(taskId, agentId);
        if (winner) return { ...hydrate(winner), deduped: true };
      }
      throw e;
    }

    const out = hydrate(row);
    audit("delivery.created", { ref: auditRef, id, agentId, taskId, files: 0, paths: [], failure: failKind });
    events.emit("delivery.created", out); // emit-on-persist, same function (ADR-052 §2)
    return out;
  }

  // ── mintExternal (ADR-054 §ingestion) ──────────────────────────────────────
  // The adapter mint path. Unlike mint() (which walks a broker before/after diff),
  // this accepts a PRE-PARSED change set — each change carries a raw unified-diff
  // `patch` string (from `gh pr diff --patch`) plus its own additions/deletions — and
  // a stable `externalKey` for idempotency (repo#number@head-sha, or session id).
  //
  // SECURITY (ADR-054, BLOCKING): title/summary/patch/author are UNTRUSTED external
  // content. clean() runs the SHARED scrub (SECRET_RE + extended shapes + token + MCP
  // creds) AND strips control chars before anything lands at rest; patch bodies are
  // scrubbed on write and again on egress (readChanges). An external Delivery is NEVER
  // auto-appliable — mintExternal does not call any auto-apply path, and autoApprove
  // hard-refuses source!=='swarm'. Read-only sources (claude-code) carry no decide route.
  function mintExternal(input = {}) {
    const source = EXTERNAL_SOURCES.includes(input.source) ? input.source : null;
    if (!source) throw new Error(`mintExternal: source must be one of ${EXTERNAL_SOURCES.join("|")}`);
    // A bot author id / session slug — kept human-readable but stripped to a safe charset.
    const agentId = String(input.agentId || "").replace(/[^a-z0-9_.-]/gi, "").slice(0, 64);
    if (!agentId) throw new Error("mintExternal: agentId required");
    const externalKey = String(input.externalKey || "").slice(0, 200);
    if (!externalKey) throw new Error("mintExternal: externalKey required (idempotency)");
    const kind = KINDS.includes(input.kind) && input.kind !== "failure" ? input.kind : "code";

    // Idempotency: a row already exists for this exact external key (ANY status) →
    // return it, mint nothing. A NEW head-sha is a NEW key, so an updated PR mints a
    // fresh row; the adapter reconciles/supersedes the stale one separately.
    const prior = findByExternalKey(externalKey);
    if (prior) return { ...hydrate(prior), deduped: true };

    const rawChanges = Array.isArray(input.changes) ? input.changes.slice(0, MAX_CHANGES) : [];
    // github-pr always has a diff; a claude-code session may touch zero files (pure chat)
    // yet still be worth surfacing read-only.
    if (source === "github-pr" && !rawChanges.length) {
      throw new Error("mintExternal: a github-pr delivery needs at least one changed file");
    }

    let additions = 0, deletions = 0;
    const changedPaths = [];
    const withPatch = [];
    for (const c of rawChanges) {
      // sr-security P7 LOW: the file path is attacker-named on an external PR — CTRL-strip
      // + secret-scrub it (clean) so it lands scrubbed in the row, on the SSE bus and in
      // /inbox JSON (M5 "no unscrubbed field"). External paths never feed applyAllowed
      // (github-pr decides via gh, claude-code is read-only) and patchFileFor re-sanitises
      // for fs safety, so cleaning here is display-only and lossless for classification.
      const path = clean(c?.path, 400);
      if (!path) continue;
      changedPaths.push(path);
      additions += Math.max(0, Number(c?.additions) || 0);
      deletions += Math.max(0, Number(c?.deletions) || 0);
      if (c?.patch) withPatch.push({ path, patch: String(c.patch) });
    }

    const id = ulid(now());
    const auditRef = `delivery:${id}`;
    const createdAt = nowIso();
    const title = oneLine(input.title || changedPaths[0] || `${source} delivery`, MAX_TITLE) || `${source} delivery`;
    const summary = clean(input.summary || "", MAX_SUMMARY);

    // Same P6 classifier the swarm path uses — on the SAME diff shape. A github-pr's
    // paths + size + new-dependency signal decide its band; the band GATES nothing here
    // (external never auto-applies) but drives SLA + the risk chip.
    const risk = classify({
      changedPaths, additions, deletions, files: changedPaths.length, kind,
      newDependency: !!input.newDependency,
    });
    const slaDeadline = deadlineFor(risk.band);

    // externalMeta is stored as opaque JSON — the adapter is the ONLY writer and the
    // decide path reads it as data (never a shell arg). Scrubbed as a whole (secret
    // shapes in an untrusted branch/author value are redacted; the JSON stays valid
    // because scrub only substitutes fixed tokens inside string values).
    const externalMeta = input.externalMeta && typeof input.externalMeta === "object"
      ? scrub(JSON.stringify(input.externalMeta).replace(CTRL, "")) : null;

    // Write the per-file patches (already unified diffs) BEFORE the row — a crash leaves
    // only orphan id-scoped patch files, never a row pointing at nothing. Scrubbed on write.
    const dir = store.patchDirFor(id);
    for (const c of withPatch) {
      const dest = patchFileFor(dir, c.path);
      mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
      if (isSymlinkDest(dest)) continue;
      writeFileSync(dest, scrub(c.patch), { mode: 0o600 });
    }

    let row;
    try {
      db.transaction(() => {
        db.prepare(
          `INSERT INTO deliveries
             (id, agentId, taskId, title, summary, source, kind, diffFiles, diffAdditions, diffDeletions,
              changedPaths, riskScore, riskBand, riskReasons, slaDeadline, status, createdAt, auditRef,
              externalKey, externalMeta)
           VALUES (@id, @agentId, NULL, @title, @summary, @source, @kind, @diffFiles, @diffAdditions, @diffDeletions,
              @changedPaths, @riskScore, @riskBand, @riskReasons, @slaDeadline, 'pending', @createdAt, @auditRef,
              @externalKey, @externalMeta)`,
        ).run({
          id, agentId, title, summary, source, kind,
          diffFiles: changedPaths.length, diffAdditions: additions, diffDeletions: deletions,
          changedPaths: JSON.stringify(changedPaths),
          riskScore: risk.score, riskBand: risk.band, riskReasons: JSON.stringify(risk.reasons), slaDeadline,
          createdAt, auditRef, externalKey, externalMeta,
        });
      })();
      row = getRow(id);
    } catch (e) {
      // Lost a race with a concurrent poll for the same key — return the winner.
      if (String(e?.code || "").includes("SQLITE_CONSTRAINT")) {
        const winner = findByExternalKey(externalKey);
        if (winner) return { ...hydrate(winner), deduped: true };
      }
      throw e;
    }

    const out = hydrate(row);
    audit("delivery.created", { ref: auditRef, id, agentId, source, files: changedPaths.length, paths: changedPaths, externalKey });
    events.emit("delivery.created", out); // same bus, same emit-on-persist rule
    return out;
  }

  // ── mintGate (S2) ──────────────────────────────────────────────────────────
  // The HUMAN-GATE mint path. Like mintFailure(), it is DIFF-LESS — no changes[], no patch
  // files, no broker — but it belongs to a STORY, not a task: a `question` (pm-analyst
  // needs the BOSS to clarify) or a `design-approval` (architect design gate). The row
  // carries the `storyId` back-pointer (v16) so the pipeline can find a story's pending
  // gates and, on decide, route the verdict back to the right Story.
  //
  // Dedupe rides the SAME partial pending-unique index every mint uses: the caller passes a
  // stable `slot` (e.g. `<storyId>-q3`, `<storyId>-design`) that lands in taskId, so a
  // re-entrant mint for the same gate returns the existing pending row instead of a
  // duplicate. `slot` is the ONLY thing here that touches the uniqueness key; storyId is a
  // plain indexed back-pointer.
  //
  // SECURITY (S2 — gate text is agent-authored, i.e. UNTRUSTED): title/body are scrubbed AT
  // REST via the SHARED scrub + control-char strip + cap (clean/oneLine), exactly like every
  // other row. A gate never auto-applies (classify → high band, autoApprove refuses both the
  // band and the non-code kind) and never reaches a broker (the decide() gate-branch stops
  // before any apply). storyId/slot are sanitized to a safe id charset — never a path, never
  // a shell arg.
  function mintGate(input = {}) {
    const kind = GATE_KINDS.has(input.kind) ? input.kind : null;
    if (!kind) throw new Error(`mintGate: kind must be one of ${[...GATE_KINDS].join("|")}`);
    const agentId = String(input.agentId || "").replace(/[^a-z0-9_-]/gi, "").slice(0, 64);
    if (!agentId) throw new Error("mintGate: agentId required");
    // Phase 9 — a gate belongs to EXACTLY ONE owner: a Story or a Job. Both would give a
    // decision two pipelines to notify and neither would own it; neither leaves the gate
    // orphaned, decided by a human and connected to nothing.
    const storyId = String(input.storyId || "").replace(/[^a-z0-9_-]/gi, "").slice(0, 80);
    const jobId = String(input.jobId || "").replace(/[^a-z0-9_-]/gi, "").slice(0, 80);
    if (storyId && jobId) throw new Error("mintGate: pass storyId OR jobId, never both");
    if (!storyId && !jobId) throw new Error("mintGate: storyId or jobId required");
    const ownerId = storyId || jobId;
    // The dedupe/pending-slot key. Defaults to the storyId, but a story with several
    // simultaneous gates (N clarify questions) MUST pass a distinct slot per gate or they
    // collapse onto one pending slot — so the caller supplies `<storyId>-q<i>` etc.
    const slot = String(input.slot || ownerId).replace(/[^a-z0-9_-]/gi, "").slice(0, 80) || ownerId;

    // A pending gate for this exact slot already exists → return it, emit nothing (idempotent
    // re-entry — the pipeline may re-run a stage without double-minting).
    const existing = findPendingByKey(slot, agentId);
    if (existing && existing.storyId === (storyId || null) && existing.jobId === (jobId || null) && existing.kind === kind) {
      return { ...hydrate(existing), deduped: true };
    }

    const id = ulid(now());
    const auditRef = `delivery:${id}`;
    const createdAt = nowIso();
    const title = oneLine(input.title || `${kind} for ${ownerId}`, MAX_TITLE) || kind;
    const summary = clean(input.body || "", MAX_SUMMARY);
    // A gate is diff-less and always needs a human — its own high band + high-band SLA, so it
    // escalates through the EXISTING sweepSla if the BOSS leaves it sitting.
    const risk = classify({ kind });
    const slaDeadline = deadlineFor(risk.band);

    let row;
    try {
      db.transaction(() => {
        db.prepare(
          `INSERT INTO deliveries
             (id, agentId, taskId, title, summary, source, kind, diffFiles, diffAdditions, diffDeletions,
              changedPaths, riskScore, riskBand, riskReasons, slaDeadline, status, createdAt, auditRef, storyId, jobId)
           VALUES (@id, @agentId, @slot, @title, @summary, 'swarm', @kind, 0, 0, 0,
              '[]', @riskScore, @riskBand, @riskReasons, @slaDeadline, 'pending', @createdAt, @auditRef, @storyId, @jobId)`,
        ).run({ id, agentId, slot, kind, title, summary, riskScore: risk.score, riskBand: risk.band, riskReasons: JSON.stringify(risk.reasons), slaDeadline, createdAt, auditRef, storyId: storyId || null, jobId: jobId || null });
      })();
      row = getRow(id);
    } catch (e) {
      // Lost a race with a concurrent mint for the same slot — return the winner.
      if (String(e?.code || "").includes("SQLITE_CONSTRAINT")) {
        const winner = findPendingByKey(slot, agentId);
        if (winner) return { ...hydrate(winner), deduped: true };
      }
      throw e;
    }

    const out = hydrate(row);
    audit("delivery.created", { ref: auditRef, id, agentId, storyId: storyId || null, jobId: jobId || null, kind });
    events.emit("delivery.created", out); // emit-on-persist, same function (ADR-052 §2)
    return out;
  }

  // Every PENDING gate delivery for a Story (optionally one kind) — the pipeline reads this
  // to learn whether a stage already has an open gate (idempotency) and to count how many
  // clarify questions are still unanswered. Hydrated ⇒ scrubbed on egress.
  // Phase 9 — matches EITHER owner column. The caller passes an owner id and does not have
  // to know which kind it is, so the Manager and the pipeline read gates the same way.
  function listGates(ownerId, kind) {
    const oid = String(ownerId || "").replace(/[^a-z0-9_-]/gi, "").slice(0, 80);
    if (!oid) return [];
    const rows = kind
      ? db.prepare("SELECT * FROM deliveries WHERE status='pending' AND (storyId=? OR jobId=?) AND kind=? ORDER BY id ASC").all(oid, oid, String(kind))
      : db.prepare("SELECT * FROM deliveries WHERE status='pending' AND (storyId=? OR jobId=?) ORDER BY id ASC").all(oid, oid);
    return rows.map(hydrate);
  }

  // Every PENDING external delivery (optionally filtered by source) — the adapter reads
  // this on each poll to reconcile a PR that was merged/closed directly on GitHub.
  function listExternalPending(source) {
    const s = SOURCES.includes(source) ? source : null;
    const rows = s
      ? db.prepare("SELECT * FROM deliveries WHERE status='pending' AND source=? AND externalKey IS NOT NULL").all(s)
      : db.prepare("SELECT * FROM deliveries WHERE status='pending' AND externalKey IS NOT NULL").all();
    return rows.map(hydrate);
  }

  // ── list / get ─────────────────────────────────────────────────────────────
  function list(q = {}) {
    const where = [];
    const args = [];
    if (q.status) {
      if (!DELIVERY_STATUSES.includes(q.status)) return []; // unknown filter → empty, never a SQL error
      where.push("status = ?"); args.push(q.status);
    }
    if (q.agentId) {
      const a = String(q.agentId).replace(/[^a-z0-9_-]/gi, "").slice(0, 64);
      if (!a) return [];
      where.push("agentId = ?"); args.push(a);
    }
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
    const offset = Math.max(Number(q.offset) || 0, 0);
    const sql = `SELECT * FROM deliveries ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ? OFFSET ?`;
    return db.prepare(sql).all(...args, limit, offset).map(hydrate);
  }

  // P8 (ADR-055) — STREAM every delivery whose createdAt falls in [from,to] (inclusive),
  // oldest first, hydrated (⇒ scrubbed on egress). better-sqlite3 `.iterate()` yields
  // row-by-row so the audit export never buffers the whole table. `from`/`to` are compared
  // lexicographically against the ISO createdAt (the caller normalizes date-only bounds);
  // absent/blank bounds fall through to an open range (never a SQL error).
  function* iterateRange({ from, to } = {}) {
    const where = [];
    const args = [];
    if (from) { where.push("createdAt >= ?"); args.push(String(from)); }
    if (to) { where.push("createdAt <= ?"); args.push(String(to)); }
    const sql = `SELECT * FROM deliveries ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY createdAt ASC`;
    for (const row of db.prepare(sql).iterate(...args)) yield hydrate(row);
  }

  function get(id) {
    if (typeof id !== "string" || !ULID_RE.test(id)) return null;
    const row = getRow(id);
    if (!row) return null;
    const out = hydrate(row);
    out.changes = readChanges(id, out.changedPaths);
    return out;
  }

  // Rebuild the reviewable change set from the on-disk patches. `before`/`after`
  // are reconstructed from the patch's own -/+ lines, so the DB stays small and
  // the review pane still gets the full text (P3).
  function readChanges(id, paths) {
    let dir;
    try { dir = store.patchDirFor(id); } catch { return []; }
    const out = [];
    for (const p of paths || []) {
      let text = "";
      try {
        const f = patchFileFor(dir, p);
        if (!existsSync(f)) continue;
        text = readFileSync(f, "utf-8");
      } catch { continue; }
      const body = text.split("\n");
      const before = [], after = [];
      let isNew = false;
      for (const ln of body) {
        if (ln.startsWith("--- ")) { isNew = ln.includes("/dev/null"); continue; }
        if (ln.startsWith("+++ ") || ln.startsWith("@@")) continue;
        if (ln.startsWith("-")) before.push(ln.slice(1));
        else if (ln.startsWith("+")) after.push(ln.slice(1));
        else if (ln.startsWith(" ")) { before.push(ln.slice(1)); after.push(ln.slice(1)); }
      }
      // Phase 4 — is this file EDITABLE, and if not, why?
      //
      // An operator may only edit a file whose reviewed text is a faithful rendering of
      // what is on disk. broker.mjs truncates at 4000 chars and scrub() redacts secrets
      // BEFORE the reviewer ever sees the text, and decide() fails closed on any edit to
      // such a file. Computing that here means the UI can disable the Edit button with
      // the reason, instead of accepting a full retyped file and refusing it only after
      // the operator presses Approve on a production write. A control that cannot succeed
      // must not be offered.
      const afterText = scrub(after.join("\n"));
      const patchText = scrub(text);
      const truncated = patchText.includes("…(truncated)");
      const redacted = REDACTION_MARKERS.some((m) => patchText.includes(m));
      out.push({
        path: p,
        status: isNew ? "new" : "modified",
        before: isNew ? null : scrub(before.join("\n")),
        after: afterText,
        patch: patchText,
        editable: !truncated && !redacted,
        editableReason: truncated
          ? "This file is too long to show in full, so an edit could not be applied safely."
          : redacted
            ? "This file contains a redacted secret, so an edit could not be applied safely."
            : null,
      });
    }
    return out;
  }

  // ── approve-with-edit (Phase 4) ────────────────────────────────────────────
  //
  // Stages an operator's revision into the agent's OWN workdir, then lets the normal
  // approve path run untouched. The repo write still happens exactly once, in
  // broker.applyChanges, behind applyAllowed + CONFIG_GUARD + symlink/realpath. There is
  // deliberately no second landing path — an "edited approve" is an ordinary approve of
  // a proposal whose bytes a human corrected first.
  //
  // ORDER MATTERS: this runs BEFORE the status flip. A rejected edit therefore leaves the
  // row PENDING and nothing applied, rather than approving a delivery whose correction
  // failed to stage. The cost is a small window in which a validated edit is written to
  // the workdir and the flip then loses a race with a concurrent decider — the concurrent
  // approve would land the EDITED bytes. That is disclosed in the delivery report; the
  // alternative (flip first) silently applies the agent's ORIGINAL text after the operator
  // asked for a change, which is strictly worse.
  //
  // THE CORRUPTION GATE. What the reviewer saw is `scrub(trunc(after))` — secrets
  // redacted, body cut at 4000 chars. Writing that back would bake "[redacted]" into
  // source or silently delete the tail of a long file. So an edit is refused unless the
  // reviewed text is BYTE-IDENTICAL to the workdir file. Fails closed, loudly, with the
  // reason named.
  async function stageOperatorEdits(row, rawEdits) {
    if (!workdirFor) return { code: 501, error: "editing is not wired for this runtime" };
    if (GATE_KINDS.has(row.kind)) return { code: 400, error: "this delivery has no diff to edit" };

    const paths = safeJson(row.changedPaths, []);
    const v = validateEdits(rawEdits, { allowedPaths: paths });
    // `editErrors` binds a refusal to the file that caused it, so the UI can show it ON
    // that field. A pane-level banner leaves the operator to map a message back to a
    // filename by hand, which on a multi-file delivery is guesswork.
    if (!v.ok) return { code: v.code, error: v.error, ...(v.path ? { editErrors: [{ path: v.path, message: v.error }] } : {}) };

    const workdir = workdirFor(row.taskId || row.agentId);
    const reviewed = readChanges(row.id, paths);
    const byPath = new Map(reviewed.map((c) => [c.path, c]));

    // The editor works on the REVIEWED text, which by the unified-diff convention has no
    // trailing newline. Writing it verbatim would strip the final newline from every file
    // an operator touches, so the file's own terminator convention is restored here.
    const toStage = [];
    for (const e of v.edits) {
      const rec = byPath.get(e.path);
      if (!rec) {
        return {
          code: 409,
          error: `no reviewable diff on record for ${e.path}`,
          editErrors: [{ path: e.path, message: "There is no reviewable diff on record for this file." }],
        };
      }
      const onDisk = await readWorkdirFile(workdir, e.path);
      if (onDisk === null) {
        return {
          code: 409,
          error: `${e.path} is no longer in the agent's workdir`,
          editErrors: [{ path: e.path, message: "This file is no longer in the agent's workdir." }],
        };
      }
      if (!reviewedMatchesDisk(rec.after, onDisk)) {
        return {
          code: 409,
          // The UI normally prevents this by disabling Edit (readChanges sets
          // `editable:false`). Reaching it means a hand-rolled POST or a file that
          // changed under review, so the message has to stand on its own.
          error: `${e.path} was shown redacted or truncated, so an edit cannot be applied safely. Approve it as-is, or request changes.`,
          editErrors: [{
            path: e.path,
            message: "This file was shown redacted or truncated, so an edit cannot be applied safely.",
          }],
        };
      }
      toStage.push({ path: e.path, after: restoreTerminator(e.after, onDisk) });
    }

    const staged = await stageEdits({ workdir, edits: toStage });
    if (!staged.ok) return { code: staged.code, error: scrub(String(staged.error)) };

    // Rewrite the on-disk patch record so the audit trail shows what was APPROVED, not
    // what the agent originally proposed. A record that disagrees with the bytes that
    // landed is worse than no record. `before` is the same rendering the reviewer saw —
    // the edit does not make that side any less faithful than it already was at mint.
    const dir = store.patchDirFor(row.id);
    const editedAfter = new Map(v.edits.map((e) => [e.path, e.after]));
    let additions = 0;
    let deletions = 0;
    for (const c of reviewed) {
      const after = editedAfter.has(c.path) ? editedAfter.get(c.path) : c.after;
      const stat = diffStat(c.before, after);
      additions += stat.additions;
      deletions += stat.deletions;
      if (!editedAfter.has(c.path)) continue;
      const patch = unifiedDiff(c.path, c.before, after);
      const check = validateUnifiedDiff(patch, { path: c.path });
      if (!check.ok) return { code: 500, error: `regenerated patch is invalid for ${c.path}: ${check.error}` };
      const dest = patchFileFor(dir, c.path);
      mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
      if (isSymlinkDest(dest)) return { code: 409, error: `patch record for ${c.path} is a symlink` };
      writeFileSync(dest, scrub(patch), { mode: 0o600 });
    }

    // Keep the row's own headline numbers honest with the rewritten patches.
    db.prepare("UPDATE deliveries SET diffAdditions = ?, diffDeletions = ? WHERE id = ? AND status = 'pending'")
      .run(additions, deletions, row.id);

    audit("delivery.edited", { ref: row.auditRef, id: row.id, agentId: row.agentId, paths: staged.staged });
    return { ok: true, editedPaths: staged.staged };
  }

  // ── decide (ADR-051 §5) ────────────────────────────────────────────────────
  // The status flip + decidedAt/By/feedback commit in ONE transaction; that commit
  // IS the pre-apply marker. Only afterwards does any side effect run, and every
  // side effect is captured so a failure can never leave a half-decided row.
  async function decide(id, verb, opts = {}) {
    if (typeof id !== "string" || !ULID_RE.test(id)) return { code: 404, error: "not found" };
    const nextStatus = Object.prototype.hasOwnProperty.call(VERBS, verb) ? VERBS[verb] : null;
    if (!nextStatus) return { code: 400, error: `unknown verb (valid: ${Object.keys(VERBS).join("|")})` };

    const row = getRow(id);
    if (!row) return { code: 404, error: "not found" };
    if (row.status !== "pending") return { code: 409, error: "already decided", status: row.status, id };

    // P7 (ADR-054) — a Claude Code session is READ-ONLY in v1. The decide buttons are
    // hidden client-side; refuse here too so a hand-rolled POST cannot decide it either.
    if (row.source === "claude-code") return { code: 403, error: "read-only — decide in Claude Code", id };
    // MUNDER-ADOPTION A7 — same posture for Slack ingress: the row is visibility, the
    // work it asks for arrives (if at all) as a normal swarm Delivery that IS decidable.
    if (row.source === "slack") return { code: 403, error: "read-only — a Slack request is never applied directly", id };

    const feedback = opts.feedback === undefined || opts.feedback === null ? null : clean(opts.feedback, MAX_FEEDBACK);
    if (verb === "request_changes" && !feedback) return { code: 400, error: "feedback required for request-changes" };
    // sr-security LOW-3: `by` that sanitizes to empty must still yield a WRITABLE
    // author downstream (vault slugs are [a-z0-9-]); "BOSS" fallback keeps the
    // decision record flowing instead of silently dropping it at vault.write().
    const by = String(opts.by || "BOSS").replace(/[^\w .@-]/g, "").slice(0, 64).trim() || "BOSS";
    const decidedAt = nowIso();

    // P7 — an external GitHub PR decision is an OUTBOUND, irreversible-ish gh action, NOT
    // a local broker apply. Run it FIRST and flip the row ONLY if gh returned ok — never
    // fabricate an approve/close that did not actually happen on GitHub.
    if (row.source === "github-pr") return decideGithub(row, verb, nextStatus, { feedback, by, decidedAt });

    // Phase 4 — an optional operator revision, staged BEFORE the flip so a refused edit
    // leaves the row pending rather than approving something the operator did not mean.
    let editedPaths = null;
    if (opts.edits !== undefined && opts.edits !== null) {
      if (verb !== "approve") return { code: 400, error: "edits are only valid with approve", id };
      const staged = await stageOperatorEdits(row, opts.edits);
      if (!staged.ok) return { ...staged, id };
      editedPaths = staged.editedPaths;
    }

    // #5 — the landing marker rides the SAME transaction as the status flip. An
    // approve is "decided but not yet landed" from this instant until the mode write
    // resolves it; a crash in the window leaves the marker set, and reconcile() then
    // refuses to auto-apply rather than guessing that a NULL mode meant "apply".
    const landingAtFlip = verb === "approve" ? "pending" : null;
    const changed = db.transaction(() => db.prepare(
      "UPDATE deliveries SET status = ?, decidedAt = ?, decidedBy = ?, feedback = ?, landing = ? WHERE id = ? AND status = 'pending'",
    ).run(nextStatus, decidedAt, by, feedback, landingAtFlip, id).changes)();
    if (!changed) { // lost a race with a concurrent decision
      const cur = getRow(id);
      return { code: 409, error: "already decided", status: cur?.status, id };
    }

    const out = hydrate(getRow(id));
    if (editedPaths) out.editedPaths = editedPaths; // what the operator revised before approving
    events.emit("delivery.decided", { id, status: nextStatus, by }); // catalog shape, program plan §2
    audit(`delivery.${nextStatus}`, { ref: row.auditRef, id, agentId: row.agentId, by, paths: safeJson(row.changedPaths, []) });
    // B2 — the decision enters shared memory the moment it is committed, BEFORE the
    // apply/discard/re-run side effects run: what the operator decided is true from
    // the transaction, independently of whether the mechanical follow-through fell
    // back a rung. Scrubbed free-text (out.title/out.feedback) — never the raw row.
    fireDecided(out, { status: nextStatus, by, feedback });

    // S2 — a HUMAN-GATE delivery (question / design-approval) has no diff, no task and no
    // worktree: its ONLY side effect is the Story transition, which fireDecided → onDecided
    // (the pipeline) has just been handed. So STOP here — a gate must never trigger a broker
    // apply, a discard-cancel, or an engine re-run goal (those are code-delivery follow-
    // throughs). The row is already flipped + announced; the pipeline drives the story.
    if (GATE_KINDS.has(row.kind)) return out;

    const paths = safeJson(row.changedPaths, []);
    const brokerKey = row.taskId || row.agentId; // engine worktree vs manual sandbox

    if (verb === "approve") {
      // P5 LADDER. deliverFn commits the approved paths on the task branch and
      // reports which rung executed. mode 'apply' — or no deliverFn at all, or a
      // fault — means the pre-P5 direct broker apply is still the right thing to
      // do. The row is ALREADY `approved`, so this must degrade, never strand.
      let landed = { mode: "apply", branch: null, prUrl: null, reason: "", refused: [] };
      if (deliverFn && row.taskId) {
        try {
          landed = (await deliverFn({
            taskId: row.taskId, paths, title: row.title, summary: row.summary,
            agentId: row.agentId, kind: row.kind,
          })) || landed;
        } catch (e) {
          out.deliverError = scrub(String(e?.message || e));
          landed = { mode: "apply", branch: null, prUrl: null, reason: out.deliverError, refused: [] };
        }
      }

      if (landed.mode === "apply") {
        try {
          const results = await applyFn(brokerKey, paths);
          // Broker failure text is raw (fs paths, guard internals) and rides straight
          // out to the client — run it through the SHARED scrub like every other
          // egress field (ADR-051 §7).
          out.applyResults = (results || []).map((r) => ({ ...r, error: r?.error ? scrub(String(r.error)) : undefined }));
          const okPaths = (results || []).filter((r) => r && r.ok).map((r) => r.path);
          if (okPaths.length) reportBackFn(row.agentId, `${okPaths.length} file(s): ${okPaths.join(", ")}`);
        } catch (e) {
          out.applyError = scrub(String(e?.message || e));
        }
      } else {
        // The change is on a BRANCH (and possibly a PR). The live working tree was
        // deliberately NOT written — that is the whole point of the branch mode.
        reportBackFn(row.agentId, `${paths.length} file(s) on ${landed.branch}${landed.prUrl ? " (PR opened)" : ""}`);
      }

      // Persist the outcome so a reload or a restart still shows the truth. The
      // marker is RESOLVED in the SAME transaction as the mode write (#5): the two
      // facts "how it landed" and "the landing is settled" can never disagree, so
      // there is no window in which crash recovery sees a NULL mode and re-applies
      // branch-mode work into the live tree.
      db.transaction(() => {
        db.prepare("UPDATE deliveries SET mode = ?, branch = ?, prUrl = ?, landing = 'resolved' WHERE id = ?")
          .run(landed.mode, landed.branch, landed.prUrl, id);
      })();
      out.mode = landed.mode;
      out.branch = landed.branch;
      out.prUrl = landed.prUrl;
      if (landed.reason) out.modeReason = scrub(String(landed.reason));
      if (landed.refused?.length) out.refusedPaths = landed.refused.map((p) => scrub(String(p)));
      audit("delivery.landed", { ref: row.auditRef, id, mode: landed.mode, branch: landed.branch, prUrl: landed.prUrl });

      // P4 auto-chain — the engine advances its goal chain the moment the operator
      // approves, so the agent's next queued step dispatches itself. Isolated in its
      // own try: a chain fault must never un-approve an apply that already landed.
      // keepBranch: a COMMITTED branch must survive the chain advance — the engine's
      // default cleanup would `git branch -D` that commit out of existence.
      if (onApproved && row.taskId) {
        try { onApproved(row.taskId, { keepBranch: landed.mode !== "apply" }); }
        catch (e) { out.chainError = scrub(String(e?.message || e)); }
      }
    } else if (verb === "reject") {
      try { discardFn(out); } catch (e) { out.discardError = scrub(String(e?.message || e)); }
    } else {
      try { out.rerun = rerunFn({ delivery: out, feedback }); } catch (e) { out.rerunError = scrub(String(e?.message || e)); }
    }
    return out;
  }

  // ── decideGithub (ADR-054) ─────────────────────────────────────────────────
  // OUTBOUND gh dispatch for a github-pr Delivery. externalDecideFn (wired by the
  // server to the GitHub adapter) maps the verb to a gh command:
  //   approve         → gh pr review --approve   (+ optional merge, policy default OFF)
  //   request_changes → gh pr review --request-changes -b <feedback>
  //   reject          → gh pr close -c <comment>
  // The row flips to the terminal status ONLY when gh returns ok. A gh failure leaves
  // the row PENDING and surfaces the error — the local Inbox never claims a GitHub
  // action that did not happen.
  async function decideGithub(row, verb, nextStatus, { feedback, by, decidedAt }) {
    if (!externalDecideFn) return { code: 501, error: "no GitHub adapter is wired for this delivery", id: row.id };
    const meta = row.externalMeta ? safeJson(row.externalMeta, null) : null;
    let res;
    try {
      res = await externalDecideFn({ verb, meta, feedback, title: row.title, summary: row.summary, agentId: row.agentId });
    } catch (e) {
      return { code: 502, error: scrub(String(e?.message || e)).slice(0, 300), id: row.id };
    }
    if (!res || !res.ok) {
      return { code: 502, error: scrub(String((res && res.error) || "GitHub action failed")).slice(0, 300), id: row.id };
    }

    const changed = db.transaction(() => db.prepare(
      "UPDATE deliveries SET status=?, decidedAt=?, decidedBy=?, feedback=? WHERE id=? AND status='pending'",
    ).run(nextStatus, decidedAt, by, feedback, row.id).changes)();
    if (!changed) { const cur = getRow(row.id); return { code: 409, error: "already decided", status: cur?.status, id: row.id }; }

    const out = hydrate(getRow(row.id));
    events.emit("delivery.decided", { id: row.id, status: nextStatus, by });
    audit(`delivery.${nextStatus}`, { ref: row.auditRef, id: row.id, agentId: row.agentId, by, source: "github-pr", action: res.action || verb, ghUrl: res.url || meta?.url || null });
    // B2 — a github-pr decision is still a decision the operator made here; it belongs
    // in the `decisions` node exactly like a swarm one, or the trail has a hole.
    fireDecided(out, { status: nextStatus, by, feedback });
    out.externalAction = res.action || verb;
    if (res.url) out.ghUrl = scrub(String(res.url)).slice(0, 300);
    return out;
  }

  // ── reconcileExternal (ADR-054 §state-sync) ────────────────────────────────
  // Two-way state sync: a PR merged/closed DIRECTLY on GitHub means the matching pending
  // Delivery is now settled. The adapter detects that on poll and calls this — it flips
  // the row WITHOUT any gh call (the action already happened remotely) and announces it
  // on the bus so the Inbox badge stays exact. merged → approved, closed → rejected.
  function reconcileExternal(id, opts = {}) {
    if (typeof id !== "string" || !ULID_RE.test(id)) return { code: 404, error: "not found" };
    const row = getRow(id);
    if (!row) return { code: 404, error: "not found" };
    if (row.source !== "github-pr") return { code: 400, error: "not an external github delivery" };
    if (row.status !== "pending") return { code: 409, error: "already decided", status: row.status, id };
    const status = opts.status;
    if (status !== "approved" && status !== "rejected") return { code: 400, error: "reconcile status must be approved|rejected" };
    const by = String(opts.by || "github").replace(/[^\w .@-]/g, "").slice(0, 64) || "github";
    const decidedAt = nowIso();
    const changed = db.transaction(() => db.prepare(
      "UPDATE deliveries SET status=?, decidedAt=?, decidedBy=? WHERE id=? AND status='pending'",
    ).run(status, decidedAt, by, id).changes)();
    if (!changed) { const cur = getRow(id); return { code: 409, error: "already decided", status: cur?.status, id }; }
    const out = hydrate(getRow(id));
    events.emit("delivery.decided", { id, status, by });
    audit(`delivery.${status}`, { ref: row.auditRef, id, agentId: row.agentId, by, source: "github-pr", reason: String(opts.reason || "reconciled from GitHub").slice(0, 120) });
    return out;
  }

  // ── crash recovery (ADR-051 §5) ────────────────────────────────────────────
  // Runs inside engine.reconcile()'s existing boot sweep (one sweep, not two). An
  // `approved` row whose diff has converged to empty means the apply landed; a
  // non-empty diff means the process died mid-apply — re-call the SAME broker
  // (deterministic content copy, ADR-024 §4).
  // #5 — two rows are NEVER auto-applied here, because for both of them applying
  // into the live working tree would DOUBLE-land work:
  //   mode IN ('pr','branch') — the commit is on a branch by design; the live tree
  //     was deliberately left untouched, and a non-empty diff is the expected state.
  //   landing = 'pending'     — the process died between the status flip and the
  //     mode write, so which rung ran is UNKNOWN. Unknown is not "apply". The row
  //     stays visible as approved-but-unsettled for the operator to re-drive.
  // NULL landing = pre-migration row → reconciled exactly as it was before.
  async function reconcile() {
    let n = 0;
    const rows = db.prepare(
      `SELECT * FROM deliveries
        WHERE status = 'approved'
          AND (mode IS NULL OR mode = 'apply')
          AND (landing IS NULL OR landing = 'resolved')`,
    ).all();
    for (const row of rows) {
      const key = row.taskId || row.agentId;
      let pending = [];
      try { pending = await listChangesFn(key); } catch { continue; }
      if (!pending || !pending.length) continue;
      try {
        const results = await applyFn(key, safeJson(row.changedPaths, []));
        const okPaths = (results || []).filter((r) => r && r.ok).map((r) => r.path);
        if (okPaths.length) reportBackFn(row.agentId, `${okPaths.length} file(s): ${okPaths.join(", ")}`);
        n++;
      } catch { /* best-effort, same posture as engine.reconcile() */ }
    }
    return n;
  }

  // ── retention: boot sweep of DECIDED deliveries ─────────────────────────────
  // A decided Delivery is history. It stays queryable for the audit window, then it
  // goes — and its patch bodies go with it, which is the bulky part (full before/after
  // text for every changed file). Mirrors server.mjs's sweepStaleUploads: TTL-bounded,
  // best-effort, boot-only, returns counts for the boot log. `pending` rows are NEVER
  // swept, whatever their age — an undecided Delivery is live state, not history.
  //
  // `auto_approved` is deliberately absent: ADR-053 (P6) has not shipped, this module
  // refuses to write that status, so no such row can exist. P6 adds it with its own
  // retention decision rather than inheriting one made before the feature existed.
  const DECIDED_STATUSES = Object.freeze(["approved", "rejected", "changes_requested", "expired"]);
  const DELIVERY_RETENTION_MS = Math.max(0, Number(deps.retentionDays ?? process.env.RUNTIME_DELIVERY_RETENTION_DAYS ?? 14)) * 86_400_000;
  function sweepDecided(ttlMs = DELIVERY_RETENTION_MS, at = now()) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) return { rows: 0, patchDirs: 0 };
    const cutoff = new Date(at - ttlMs).toISOString();
    const doomed = db.prepare(
      `SELECT id FROM deliveries
        WHERE status IN (${DECIDED_STATUSES.map(() => "?").join(",")})
          AND COALESCE(decidedAt, createdAt) < ?`,
    ).all(...DECIDED_STATUSES, cutoff);
    let patchDirs = 0;
    for (const r of doomed) {
      // patchDirFor re-asserts containment under data/patches/ before anything is
      // removed — the SAME vetted check mint() uses. No second path walk lives here.
      try { rmSync(store.patchDirFor(r.id), { recursive: true, force: true }); patchDirs++; } catch { /* best-effort */ }
    }
    let rows = 0;
    const del = db.prepare("DELETE FROM deliveries WHERE id = ?");
    db.transaction(() => { for (const r of doomed) rows += del.run(r.id).changes; })();
    return { rows, patchDirs };
  }

  // ── autoApprove (ADR-053 §auto-apply) ──────────────────────────────────────
  // The ONE and ONLY producer of `auto_approved`. NOT a decide verb (VERBS has no
  // such entry and never will) — the server's maybeAutoApply is the sole caller,
  // after it has already checked the band policy, the deny-list and isAutoSafe.
  //
  // SECURITY (BLOCKING, ADR-053): four independent gates, deny-by-default —
  //   1. never a failure row (nothing to apply);
  //   2. never a high-risk row (typed_confirm can NEVER auto-apply);
  //   3. the SAME broker.applyChanges a human approve uses (applyAllowed + CONFIG_GUARD
  //      + symlink + containment re-validate every path);
  //   4. the status flips to auto_approved ONLY if the apply is FULLY clean — one
  //      refused path leaves the whole row `pending` for a human, it never
  //      half-approves. Auto-applied rows still land in the Inbox (Auto strip) with a
  //      policy.autoapplied event + a delivery.auto_approved audit line.
  async function autoApprove(id, opts = {}) {
    if (typeof id !== "string" || !ULID_RE.test(id)) return { code: 404, error: "not found" };
    const row = getRow(id);
    if (!row) return { code: 404, error: "not found" };
    if (row.status !== "pending") return { code: 409, error: "already decided", status: row.status, id };
    // P7 (ADR-054, BLOCKING) — ONLY swarm work can auto-apply. An external delivery
    // (github-pr / claude-code) can NEVER auto-apply regardless of band policy: it has
    // no local worktree to apply into and its decision is an outbound gh action or is
    // read-only. This is the producer-side enforcement; the server also never routes an
    // external mint through maybeAutoApply.
    if (row.source !== "swarm") return { code: 400, error: "external deliveries never auto-apply" };
    if (row.kind === "failure") return { code: 400, error: "a failure delivery has nothing to apply" };
    if (row.riskBand === "high") return { code: 400, error: "high-risk deliveries never auto-apply" };
    const paths = safeJson(row.changedPaths, []);
    if (!paths.length) return { code: 400, error: "no changed paths" };
    // Producer-side invariant (sr-security P6 MEDIUM): re-assert isAutoSafe HERE, not only
    // in the maybeAutoApply caller, so autoApprove — the ONLY writer of `auto_approved` —
    // can never auto-apply an applyAllowed-but-not-auto-safe path (e.g. public/*.css) if a
    // future caller forgets the gate. isAutoSafe(p) ⟹ applyAllowed(p) by construction.
    if (!paths.every((p) => isAutoSafe(p))) return { code: 400, error: "path not auto-safe" };

    const brokerKey = row.taskId || row.agentId; // manual sandbox (agentId) — engine path is deferred
    let results;
    try { results = await applyFn(brokerKey, paths); }
    catch (e) { return { code: 500, error: "auto-apply failed", applyError: scrub(String(e?.message || e)) }; }

    // FULLY clean or nothing: any refusal (guard fired) → stay pending for a human.
    const allClean = Array.isArray(results) && results.length === paths.length && results.every((r) => r && r.ok);
    if (!allClean) {
      return {
        code: 409,
        error: "auto-apply not clean; left for human review",
        applyResults: (results || []).map((r) => ({ ...r, error: r?.error ? scrub(String(r.error)) : undefined })),
      };
    }

    const by = String(opts.decidedBy || "policy").replace(/[^\w .@-]/g, "").slice(0, 64) || "policy";
    const reasons = Array.isArray(opts.reasons) && opts.reasons.length
      ? opts.reasons.map((r) => clean(String(r), 200)).slice(0, 20)
      : safeJson(row.riskReasons, []);
    const decidedAt = nowIso();
    const changed = db.transaction(() => db.prepare(
      "UPDATE deliveries SET status='auto_approved', decidedAt=?, decidedBy=?, mode='apply', landing='resolved' WHERE id=? AND status='pending'",
    ).run(decidedAt, by, id).changes)();
    if (!changed) { const cur = getRow(id); return { code: 409, error: "already decided", status: cur?.status, id }; }

    const okPaths = results.filter((r) => r && r.ok).map((r) => r.path);
    if (okPaths.length) reportBackFn(row.agentId, `${okPaths.length} file(s) auto-applied under policy: ${okPaths.join(", ")}`);

    const out = hydrate(getRow(id));
    events.emit("delivery.decided", { id, status: "auto_approved", by }); // catalog shape (badge--)
    events.emit("policy.autoapplied", { id, band: row.riskBand, reasons }); // Auto strip + audit
    audit("delivery.auto_approved", { ref: row.auditRef, id, agentId: row.agentId, band: row.riskBand, reasons, paths });
    audit("delivery.landed", { ref: row.auditRef, id, mode: "apply", branch: null, prUrl: null });
    return out;
  }

  // ── sweepSla (ADR-053 §SLA) ────────────────────────────────────────────────
  // PURE, idempotent escalation over PENDING deliveries with a deadline. Advances the
  // slaState marker monotonically (NULL → 'halflife' → 'expired'), emitting EXACTLY
  // ONCE per stage. An expired SLA ESCALATES, it does NOT auto-decide — the row stays
  // pending. The server drives this on an unref'd 60s interval (never the dispatch
  // scheduler, which owns no wall-clock timer). Returns per-stage counts for the log.
  function sweepSla(at = now()) {
    const rows = db.prepare(
      "SELECT id, agentId, riskBand, createdAt, slaDeadline, slaState, auditRef FROM deliveries WHERE status='pending' AND slaDeadline IS NOT NULL",
    ).all();
    let halflife = 0, expired = 0;
    const setState = db.prepare("UPDATE deliveries SET slaState=? WHERE id=? AND status='pending'");
    for (const r of rows) {
      const deadline = Date.parse(r.slaDeadline);
      const created = Date.parse(r.createdAt);
      if (!Number.isFinite(deadline) || !Number.isFinite(created)) continue;
      if (at >= deadline) {
        if (r.slaState === "expired") continue;
        setState.run("expired", r.id);
        events.emit("delivery.expired", { id: r.id, agentId: r.agentId, band: r.riskBand });
        audit("delivery.expired", { ref: r.auditRef, id: r.id, agentId: r.agentId, band: r.riskBand });
        expired++;
      } else if (r.slaState == null && at >= created + (deadline - created) / 2) {
        setState.run("halflife", r.id);
        events.emit("delivery.sla_halflife", { id: r.id, agentId: r.agentId, band: r.riskBand });
        audit("delivery.sla_halflife", { ref: r.auditRef, id: r.id, agentId: r.agentId, band: r.riskBand });
        halflife++;
      }
    }
    return { halflife, expired };
  }

  const counts = () => store.counts();

  // ── assign (P9) ─────────────────────────────────────────────────────────────
  // Set/clear the advisory assignee on a Delivery. `assignee` is a user NAME (or
  // null to unassign), sanitized to the same charset decide() uses for `by`. This is
  // metadata only — it does NOT change status, does NOT gate who can decide, and
  // (deliberately) emits NO event: the SSE catalog is CLOSED (ADR-052 §2). The
  // updated Delivery is returned so the assigning client updates optimistically;
  // other seats pick it up on their next /inbox fetch. Only a PENDING delivery can
  // be (re)assigned — a decided one is history.
  function assign(id, assignee) {
    if (typeof id !== "string" || !ULID_RE.test(id)) return { code: 404, error: "not found" };
    const row = getRow(id);
    if (!row) return { code: 404, error: "not found" };
    if (row.status !== "pending") return { code: 409, error: "already decided", status: row.status, id };
    const name = assignee === null || assignee === undefined || assignee === ""
      ? null
      : String(assignee).replace(/[^\w .@-]/g, "").slice(0, 64) || null;
    db.prepare("UPDATE deliveries SET assignee = ? WHERE id = ? AND status = 'pending'").run(name, id);
    const out = hydrate(getRow(id));
    audit("delivery.assigned", { ref: row.auditRef, id, agentId: row.agentId, assignee: name });
    return out;
  }

  // P10 — dogfood scoreboard: "N deliveries approved ÷ human-minutes" over a window.
  // Per human-approved delivery, review latency = decidedAt − createdAt; humanMinutes is
  // the sum. auto_approved rows are counted separately (shipped without you) and never
  // contribute human-minutes — no human decided them. Pure read: no mutation, no emit.
  //
  // B1 (additive) — `decided` is every decision a human actually made in the window:
  // approved + rejected + changes_requested. `pending` has no decision yet and
  // `auto_approved` had no human, so neither counts. Same malformed-row guard as the
  // approved metric, so `decided >= approved` always holds.
  function scoreboard({ windowMs, nowMs } = {}) {
    const win = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 7 * 24 * 60 * 60 * 1000;
    const at = Number.isFinite(nowMs) ? nowMs : now();
    const sinceIso = new Date(at - win).toISOString();
    const rows = db.prepare(
      "SELECT createdAt, decidedAt, status FROM deliveries WHERE status IN ('approved','rejected','changes_requested','auto_approved') AND decidedAt IS NOT NULL AND decidedAt >= ?",
    ).all(sinceIso);
    let approved = 0, autoApproved = 0, decided = 0, totalMs = 0;
    for (const r of rows) {
      if (r.status === "auto_approved") { autoApproved++; continue; }
      const c = Date.parse(r.createdAt), dd = Date.parse(r.decidedAt);
      if (!Number.isFinite(c) || !Number.isFinite(dd) || dd < c) continue; // skip malformed/negative
      decided++;
      if (r.status !== "approved") continue; // rejections/change-requests are decisions, not approvals
      approved++;
      totalMs += dd - c;
    }
    const round1 = (n) => Math.round(n * 10) / 10;
    const humanMinutes = round1(totalMs / 60000);
    const avgMinutes = approved > 0 ? round1(humanMinutes / approved) : null;
    const perHour = humanMinutes > 0 ? round1(approved / (humanMinutes / 60)) : null;
    return { windowMs: win, since: sinceIso, approved, autoApproved, decided, humanMinutes, avgMinutes, perHour };
  }

  return {
    mint, mintFailure, mintExternal, list, iterateRange, get, decide, assign, autoApprove, reconcile, sweepDecided, sweepSla, counts, isTaskKey, scoreboard,
    // P7 (ADR-054) — external ingestion surface for the adapters.
    findByExternalKey: (key) => { const r = findByExternalKey(key); return r ? hydrate(r) : null; },
    listExternalPending, reconcileExternal,
    // Story-Pipeline S2 — the human-gate mint path + the per-story pending-gate lookup.
    mintGate, listGates,
  };
}
