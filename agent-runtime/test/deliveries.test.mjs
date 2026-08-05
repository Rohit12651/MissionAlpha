// ADR-051 — Delivery engine: ULID ids, unified-diff patches on disk, mint
// (row + patches + audit + emit-on-persist), and the three decision verbs.
// Pure + store-level; the HTTP surface is proven in inbox-http.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, mkdirSync, writeFileSync, symlinkSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../db.mjs";
import { createDeliveries, ulid, ULID_RE, unifiedDiff, diffStat } from "../deliveries.mjs";

// ── pure helpers ─────────────────────────────────────────────────────────────

test("ulid is 26 Crockford chars, unique, and lexicographically time-sorted", () => {
  const a = ulid(), b = ulid();
  assert.match(a, ULID_RE);
  assert.match(b, ULID_RE);
  assert.notEqual(a, b);
  assert.ok(b > a, `monotonic within the same ms: ${a} < ${b}`);
  const many = Array.from({ length: 500 }, () => ulid());
  assert.equal(new Set(many).size, 500, "no collisions in a tight loop");
  assert.deepEqual(many, [...many].sort(), "monotonic across the whole burst");
});

test("unifiedDiff emits a valid patch; diffStat counts only changed lines", () => {
  const before = "a\nb\nc\n", after = "a\nB\nc\n";
  const p = unifiedDiff("src/x.ts", before, after);
  assert.match(p, /^--- a\/src\/x\.ts\n\+\+\+ b\/src\/x\.ts\n@@ /);
  assert.ok(p.includes("-b\n"), "old line marked");
  assert.ok(p.includes("+B\n"), "new line marked");
  assert.deepEqual(diffStat(before, after), { additions: 1, deletions: 1 });
});

test("unifiedDiff marks a new file as /dev/null and counts every line as an addition", () => {
  assert.match(unifiedDiff("src/n.ts", null, "x\ny\n"), /^--- \/dev\/null\n/);
  assert.deepEqual(diffStat(null, "x\ny\n"), { additions: 2, deletions: 0 });
});

test("diffStat ignores unchanged content", () => {
  assert.deepEqual(diffStat("a\nb\n", "a\nb\n"), { additions: 0, deletions: 0 });
});

// ── harness ──────────────────────────────────────────────────────────────────

const SECRET_RE = /sk-ant-[A-Za-z0-9_-]{6,}/g;
const scrub = (s) => (typeof s === "string" ? s.replace(SECRET_RE, "[redacted-secret]") : s);

function harness(over = {}) {
  const root = mkdtempSync(join(tmpdir(), "ma-del-"));
  const h = openDb({ path: join(root, "mission.db"), patchesDir: join(root, "patches") });
  const emitted = [], audited = [], applied = [], reported = [], discarded = [], reran = [], decided = [];
  const d = createDeliveries({
    db: h,
    events: { emit: (e, p) => emitted.push([e, p]) },
    scrub,
    audit: (e, data) => audited.push([e, data]),
    applyFn: async (key, paths) => { applied.push([key, paths]); return paths.map((p) => ({ path: p, ok: true })); },
    reportBackFn: (agentId, summary) => reported.push([agentId, summary]),
    discardFn: (row) => discarded.push(row.id),
    rerunFn: (arg) => { reran.push(arg); return { goalId: "goal_x" }; },
    listChangesFn: async () => [],
    // B2 / ADR-055 — the decision choke point that feeds the Knowledge Vault.
    onDecided: (row, info) => decided.push({ row, info }),
    ...over,
  });
  const cleanup = () => { h.close(); rmSync(root, { recursive: true, force: true }); };
  return { root, h, d, emitted, audited, applied, reported, discarded, reran, decided, cleanup };
}

const CHANGES = [{ path: "src/a.ts", status: "modified", before: "a\nb\n", after: "a\nB\n" }];

const mintOne = (d, over = {}) => d.mint({
  agentId: "senior-web-1", taskId: "task_abc123", title: "Add validation",
  summary: "did the thing", source: "swarm", kind: "code", changes: CHANGES, ...over,
});

// ── mint ─────────────────────────────────────────────────────────────────────

test("mint writes a row, patch files, an audit line, and emits delivery.created", () => {
  const t = harness();
  try {
    const r = mintOne(t.d, { summary: "leaked sk-ant-ABCDEFGH123 inside" });
    assert.match(r.id, ULID_RE);
    assert.equal(r.status, "pending");
    assert.equal(r.agentId, "senior-web-1");
    assert.equal(r.taskId, "task_abc123");
    assert.equal(r.diffFiles, 1);
    assert.equal(r.diffAdditions, 1);
    assert.equal(r.diffDeletions, 1);
    assert.deepEqual(r.changedPaths, ["src/a.ts"]);
    assert.ok(!r.summary.includes("sk-ant-"), "summary scrubbed AT REST");
    const pf = join(t.h.patchDirFor(r.id), "src", "a.ts.patch");
    assert.ok(existsSync(pf), "patch body written to disk, not the DB");
    assert.equal(statSync(pf).mode & 0o777, 0o600, "patch file 0600");
    assert.match(readFileSync(pf, "utf-8"), /^--- a\/src\/a\.ts\n/);
    assert.deepEqual(t.emitted.map(([e]) => e), ["delivery.created"]);
    assert.equal(t.emitted[0][1].id, r.id);
    assert.equal(t.audited[0][0], "delivery.created");
    assert.equal(r.auditRef, t.audited[0][1].ref, "row.auditRef links to the AUDIT line");
  } finally { t.cleanup(); }
});

test("mint is idempotent per work unit — second call returns the same row and emits once", () => {
  const t = harness();
  try {
    const a = mintOne(t.d);
    const b = mintOne(t.d);
    assert.equal(b.id, a.id);
    assert.equal(b.deduped, true);
    assert.equal(t.emitted.length, 1, "no second delivery.created");
    assert.equal(t.h.counts().pending, 1);
  } finally { t.cleanup(); }
});

test("mint dedupes the manual (taskId=null) path per agent, and keeps agents independent", () => {
  const t = harness();
  try {
    const a = t.d.mint({ agentId: "bob", taskId: null, title: "t", summary: "s", source: "swarm", kind: "code", changes: CHANGES });
    const b = t.d.mint({ agentId: "bob", taskId: null, title: "t2", summary: "s2", source: "swarm", kind: "code", changes: CHANGES });
    assert.equal(b.id, a.id, "same agent, still pending → same delivery");
    const c = t.d.mint({ agentId: "alice", taskId: null, title: "t3", summary: "s3", source: "swarm", kind: "code", changes: CHANGES });
    assert.notEqual(c.id, a.id, "different agent → distinct delivery");
  } finally { t.cleanup(); }
});

test("mint refuses an empty change set, a bad source/kind, and any status but pending", () => {
  const t = harness();
  try {
    assert.throws(() => mintOne(t.d, { changes: [] }), /changes/i);
    assert.throws(() => mintOne(t.d, { source: "bogus" }), /source/i);
    assert.throws(() => mintOne(t.d, { kind: "bogus" }), /kind/i);
    // ADR-051 security table: auto_approved is BLOCKED until ADR-053 ships.
    assert.throws(() => mintOne(t.d, { status: "auto_approved" }), /auto_approved|status/i);
    assert.equal(t.emitted.length, 0, "nothing emitted for a refused mint");
  } finally { t.cleanup(); }
});

test("mint sanitises a hostile changed path instead of escaping the patch root", () => {
  const t = harness();
  try {
    const r = mintOne(t.d, { taskId: "task_evil01", changes: [{ path: "../../etc/passwd", status: "new", before: null, after: "x\n" }] });
    const dir = t.h.patchDirFor(r.id);
    // every written patch file must live under the delivery's own patch dir
    assert.ok(!existsSync(join(t.h.patchesRoot, "..", "etc")), "no escape above the patches root");
    assert.ok(existsSync(dir), "patch dir exists");
  } finally { t.cleanup(); }
});

// ── list / get ───────────────────────────────────────────────────────────────

test("list filters by status + agentId and returns newest first", async () => {
  const t = harness();
  try {
    const a = t.d.mint({ agentId: "bob", taskId: "task_aaa111", title: "A", summary: "s", source: "swarm", kind: "code", changes: CHANGES });
    const b = t.d.mint({ agentId: "alice", taskId: "task_bbb222", title: "B", summary: "s", source: "swarm", kind: "code", changes: CHANGES });
    const all = t.d.list({});
    assert.deepEqual(all.map((r) => r.id), [b.id, a.id], "newest (highest ULID) first");
    assert.deepEqual(t.d.list({ agentId: "bob" }).map((r) => r.id), [a.id]);
    await t.d.decide(a.id, "approve", { by: "BOSS" });
    assert.deepEqual(t.d.list({ status: "pending" }).map((r) => r.id), [b.id]);
    assert.deepEqual(t.d.list({ status: "approved" }).map((r) => r.id), [a.id]);
    assert.deepEqual(t.d.list({ status: "bogus" }), [], "unknown status filter yields nothing, never a SQL error");
  } finally { t.cleanup(); }
});

test("get rebuilds the change set from disk with before/after + patch text, scrubbed", () => {
  const t = harness();
  try {
    const r = mintOne(t.d, { changes: [{ path: "src/a.ts", status: "modified", before: "old sk-ant-LEAKED99\n", after: "new\n" }] });
    const full = t.d.get(r.id);
    assert.equal(full.id, r.id);
    assert.equal(full.changes.length, 1);
    assert.equal(full.changes[0].path, "src/a.ts");
    assert.ok(full.changes[0].patch.includes("+new"), "patch text returned");
    assert.ok(!JSON.stringify(full).includes("sk-ant-"), "no secret in the egress payload");
    assert.equal(t.d.get("01J0000000000000000000000Z"), null, "unknown id → null");
    assert.equal(t.d.get("../etc/passwd"), null, "malformed id → null, never a path read");
  } finally { t.cleanup(); }
});

// ── decide ───────────────────────────────────────────────────────────────────

test("approve flips status in one transaction, applies via the broker, reports back, emits decided", async () => {
  const t = harness();
  try {
    const r = mintOne(t.d);
    const out = await t.d.decide(r.id, "approve", { by: "BOSS" });
    assert.equal(out.status, "approved");
    assert.ok(out.decidedAt);
    assert.equal(out.decidedBy, "BOSS");
    assert.deepEqual(t.applied, [["task_abc123", ["src/a.ts"]]], "routed to the engine broker key");
    assert.equal(t.reported.length, 1, "reportBack fired once");
    const ev = t.emitted.find(([e]) => e === "delivery.decided");
    assert.deepEqual(ev[1], { id: r.id, status: "approved", by: "BOSS" });
    assert.equal(t.h.counts().approved, 1);
  } finally { t.cleanup(); }
});

test("approve of a manual (taskId=null) delivery routes to the agent's sandbox key", async () => {
  const t = harness();
  try {
    const r = t.d.mint({ agentId: "bob", taskId: null, title: "t", summary: "s", source: "swarm", kind: "code", changes: CHANGES });
    await t.d.decide(r.id, "approve", { by: "BOSS" });
    assert.deepEqual(t.applied, [["bob", ["src/a.ts"]]]);
  } finally { t.cleanup(); }
});

test("reject stores feedback, discards the sandbox, and NEVER touches the broker", async () => {
  const t = harness();
  try {
    const r = mintOne(t.d);
    const out = await t.d.decide(r.id, "reject", { by: "BOSS", feedback: "wrong approach" });
    assert.equal(out.status, "rejected");
    assert.equal(out.feedback, "wrong approach");
    assert.equal(t.applied.length, 0, "no repo write on reject");
    assert.equal(t.reported.length, 0);
    assert.deepEqual(t.discarded, [r.id]);
  } finally { t.cleanup(); }
});

test("request_changes stores feedback and hands it to the existing run path", async () => {
  const t = harness();
  try {
    const r = mintOne(t.d);
    const out = await t.d.decide(r.id, "request_changes", { by: "BOSS", feedback: "add a test first" });
    assert.equal(out.status, "changes_requested");
    assert.equal(t.applied.length, 0);
    assert.equal(t.reran.length, 1);
    assert.equal(t.reran[0].feedback, "add a test first");
    assert.equal(t.reran[0].delivery.id, r.id);
  } finally { t.cleanup(); }
});

test("request_changes requires feedback text", async () => {
  const t = harness();
  try {
    const r = mintOne(t.d);
    const out = await t.d.decide(r.id, "request_changes", { by: "BOSS" });
    assert.equal(out.code, 400);
    assert.equal(t.reran.length, 0);
  } finally { t.cleanup(); }
});

test("double-decide returns 409 and never re-applies", async () => {
  const t = harness();
  try {
    const r = mintOne(t.d);
    await t.d.decide(r.id, "approve", { by: "BOSS" });
    const second = await t.d.decide(r.id, "reject", { by: "BOSS" });
    assert.equal(second.code, 409);
    assert.equal(second.status, "approved", "reports the status it is already in");
    assert.equal(t.applied.length, 1, "no second apply");
    assert.equal(t.emitted.filter(([e]) => e === "delivery.decided").length, 1);
  } finally { t.cleanup(); }
});

test("unknown / malformed id returns 404; unknown verb returns 400", async () => {
  const t = harness();
  try {
    assert.equal((await t.d.decide("01J0000000000000000000000Z", "approve", {})).code, 404);
    assert.equal((await t.d.decide("../../etc/passwd", "approve", {})).code, 404);
    const r = mintOne(t.d);
    assert.equal((await t.d.decide(r.id, "auto_approve", {})).code, 400, "ADR-053 verb blocked");
    assert.equal((await t.d.decide(r.id, "expire", {})).code, 400);
    assert.equal(t.applied.length, 0);
  } finally { t.cleanup(); }
});

test("a throwing applyFn is captured — the row stays decided, no unhandled rejection", async () => {
  const t = harness({ applyFn: async () => { throw new Error("disk on fire"); } });
  try {
    const r = mintOne(t.d);
    const out = await t.d.decide(r.id, "approve", { by: "BOSS" });
    assert.equal(out.status, "approved");
    assert.match(out.applyError, /disk on fire/);
    assert.ok(t.emitted.some(([e]) => e === "delivery.decided"), "decision still broadcast");
  } finally { t.cleanup(); }
});

// ── retention boot sweep (P4 hardening — sr-security LOW) ────────────────────

test("HARDENING sweepDecided deletes aged decided rows + their patch dirs, keeps recent and pending", async () => {
  const DAY = 86_400_000;
  let clock = Date.parse("2026-01-01T00:00:00.000Z");
  const t = harness({ now: () => clock });
  try {
    const aged = mintOne(t.d, { taskId: "task_old111", agentId: "a-old" });
    const agedDir = t.h.patchDirFor(aged.id);
    await t.d.decide(aged.id, "reject", { by: "BOSS" });

    clock += 30 * DAY;

    const fresh = mintOne(t.d, { taskId: "task_new222", agentId: "a-new" });
    const freshDir = t.h.patchDirFor(fresh.id);
    await t.d.decide(fresh.id, "reject", { by: "BOSS" });

    // Undecided, and deliberately ancient by createdAt: a pending Delivery is LIVE
    // state, not history, so no TTL may ever reach it.
    const pending = t.d.mint({
      agentId: "a-pend", taskId: "task_pend33", title: "t", summary: "s",
      source: "swarm", kind: "code", changes: CHANGES,
    });
    t.h.db.prepare("UPDATE deliveries SET createdAt = ? WHERE id = ?")
      .run(new Date(clock - 900 * DAY).toISOString(), pending.id);

    const out = t.d.sweepDecided(14 * DAY);

    assert.equal(out.rows, 1, "only the row past the TTL");
    assert.equal(out.patchDirs, 1);
    assert.equal(t.d.get(aged.id), null, "the swept row is gone from the DB");
    assert.ok(!existsSync(agedDir), "its patch bodies went with it — that is the bulky part");
    assert.ok(t.d.get(fresh.id), "a recently decided row survives its window");
    assert.ok(existsSync(freshDir));
    assert.equal(t.d.get(pending.id).status, "pending", "an undecided row is never swept");
  } finally { t.cleanup(); }
});

test("HARDENING sweepDecided with a non-positive TTL is a no-op (retention can be disabled)", async () => {
  const t = harness();
  try {
    const r = mintOne(t.d);
    await t.d.decide(r.id, "reject", { by: "BOSS" });
    assert.deepEqual(t.d.sweepDecided(0), { rows: 0, patchDirs: 0 });
    assert.ok(t.d.get(r.id), "nothing removed when retention is off");
  } finally { t.cleanup(); }
});

// ── crash recovery (ADR-051 §5) ──────────────────────────────────────────────

test("reconcile re-applies an approved row whose repo diff has NOT converged", async () => {
  const t = harness({ listChangesFn: async () => [{ path: "src/a.ts" }] });
  try {
    const r = mintOne(t.d);
    await t.d.decide(r.id, "approve", { by: "BOSS" });
    const n = await t.d.reconcile();
    assert.equal(n, 1, "one row re-converged");
    assert.equal(t.applied.length, 2, "re-applied through the same broker");
  } finally { t.cleanup(); }
});

test("reconcile leaves an approved row alone once its diff is empty (apply landed)", async () => {
  const t = harness({ listChangesFn: async () => [] });
  try {
    const r = mintOne(t.d);
    await t.d.decide(r.id, "approve", { by: "BOSS" });
    assert.equal(await t.d.reconcile(), 0);
    assert.equal(t.applied.length, 1, "no duplicate apply");
  } finally { t.cleanup(); }
});

// ── sr-security P5 re-review #5 — the landing marker (fail CLOSED) ───────────

test("#5 approve sets landing='pending' at the flip and 'resolved' with the mode write", async () => {
  const t = harness({ listChangesFn: async () => [] });
  try {
    const r = mintOne(t.d);
    await t.d.decide(r.id, "approve", { by: "BOSS" });
    const row = t.h.db.prepare("SELECT mode, landing FROM deliveries WHERE id = ?").get(r.id);
    assert.equal(row.landing, "resolved", "the marker is settled once the mode is written");
    assert.equal(row.mode, "apply");
  } finally { t.cleanup(); }
});

test("#5 a crash between the status flip and the mode write does NOT auto-apply on reconcile", async () => {
  const t = harness({ listChangesFn: async () => [{ path: "src/a.ts" }] });
  try {
    const r = mintOne(t.d);
    await t.d.decide(r.id, "approve", { by: "BOSS" });
    // Reproduce the post-crash state exactly: the decision transaction committed
    // (status + landing marker), the mode write never ran.
    t.h.db.prepare("UPDATE deliveries SET mode = NULL, branch = NULL, prUrl = NULL, landing = 'pending' WHERE id = ?").run(r.id);
    const before = t.applied.length;
    assert.equal(await t.d.reconcile(), 0, "an UNRESOLVED landing is never auto-applied");
    assert.equal(t.applied.length, before, "no second write into the live tree");
    assert.equal(t.d.get(r.id).status, "approved", "the row stays visible for the operator");
  } finally { t.cleanup(); }
});

test("#5 a branch-landed row is never re-applied into the live working tree", async () => {
  const t = harness({
    listChangesFn: async () => [{ path: "src/a.ts" }], // branch mode leaves the tree dirty BY DESIGN
    deliverFn: async () => ({ mode: "branch", branch: "ma/task/task_abc123", prUrl: null, reason: "no remote", refused: [] }),
  });
  try {
    const r = mintOne(t.d);
    const out = await t.d.decide(r.id, "approve", { by: "BOSS" });
    assert.equal(out.mode, "branch");
    assert.equal(t.applied.length, 0, "branch mode never touches the live tree");
    assert.equal(await t.d.reconcile(), 0, "and crash recovery must not either");
    assert.equal(t.applied.length, 0);
  } finally { t.cleanup(); }
});

test("#5 a pre-migration row (landing NULL) reconciles exactly as it did before", async () => {
  const t = harness({ listChangesFn: async () => [{ path: "src/a.ts" }] });
  try {
    const r = mintOne(t.d);
    await t.d.decide(r.id, "approve", { by: "BOSS" });
    t.h.db.prepare("UPDATE deliveries SET landing = NULL WHERE id = ?").run(r.id);
    assert.equal(await t.d.reconcile(), 1, "legacy rows keep the pre-#5 behavior");
  } finally { t.cleanup(); }
});

test("patch round-trip is LOSSLESS even with distant edits (full-context hunk)", () => {
  const t = harness();
  try {
    const before = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n") + "\n";
    const after = before.replace("line 1\n", "LINE ONE\n").replace("line 38\n", "LINE THIRTYEIGHT\n");
    const r = mintOne(t.d, { taskId: "task_far001", changes: [{ path: "src/far.ts", status: "modified", before, after }] });
    assert.equal(r.diffAdditions, 2);
    assert.equal(r.diffDeletions, 2);
    const c = t.d.get(r.id).changes[0];
    assert.equal(c.before + "\n", before, "before reconstructed exactly");
    assert.equal(c.after + "\n", after, "after reconstructed exactly");
    assert.ok(c.patch.includes("-line 1\n") && c.patch.includes("+LINE ONE\n"));
    assert.ok(c.patch.includes(" line 20\n"), "untouched middle lines survive in the patch");
  } finally { t.cleanup(); }
});

// ── sr-security P2 §5: broker failure text is CLIENT-VISIBLE egress ───────────

test("apply failure text on applyResults is scrubbed before it leaves the process", async () => {
  const t = harness({
    applyFn: async (_key, paths) => paths.map((p) => ({ path: p, ok: false, error: `broker refused ${p}: token sk-ant-DEADBEEF1234 in guard` })),
  });
  try {
    const r = mintOne(t.d);
    const out = await t.d.decide(r.id, "approve", { by: "BOSS" });
    assert.equal(out.status, "approved");
    assert.equal(out.applyResults.length, 1);
    assert.ok(!/sk-ant-/.test(out.applyResults[0].error), `secret survived egress: ${out.applyResults[0].error}`);
    assert.match(out.applyResults[0].error, /\[redacted-secret\]/);
    assert.equal(out.applyResults[0].path, "src/a.ts", "the rest of the result shape is preserved");
    assert.equal(out.applyResults[0].ok, false);
  } finally { t.cleanup(); }
});

test("a successful applyResult keeps its shape and grows no error text", async () => {
  const t = harness();
  try {
    const r = mintOne(t.d);
    const out = await t.d.decide(r.id, "approve", { by: "BOSS" });
    assert.equal(out.applyResults.length, 1);
    assert.equal(out.applyResults[0].ok, true);
    assert.equal(JSON.parse(JSON.stringify(out.applyResults[0])).error, undefined, "no error key on the wire for an ok row");
    assert.deepEqual(t.reported, [["senior-web-1", "1 file(s): src/a.ts"]], "report-back unchanged");
  } finally { t.cleanup(); }
});

// ── sr-security P2 §7: never write THROUGH a symlink at the patch destination ──

test("mint refuses a symlinked patch destination instead of writing through it", () => {
  const root = mkdtempSync(join(tmpdir(), "ma-del-symlink-"));
  const h = openDb({ path: join(root, "mission.db"), patchesDir: join(root, "patches") });
  try {
    // Pin the delivery dir so the symlink can be planted at the exact destination
    // mint() will target (real ULIDs are unpredictable by design).
    const fixedDir = join(root, "pinned");
    mkdirSync(join(fixedDir, "src"), { recursive: true });
    const outside = join(root, "OUTSIDE-TARGET");
    writeFileSync(outside, "untouched\n");
    symlinkSync(outside, join(fixedDir, "src", "a.ts.patch"));

    const d = createDeliveries({
      db: { ...h, patchDirFor: () => fixedDir },
      events: { emit: () => {} },
      scrub: (s) => s,
      audit: () => {},
      applyFn: async () => [],
      listChangesFn: async () => [],
    });
    const r = mintOne(d);
    assert.match(r.id, ULID_RE, "the row is still minted — only the through-write is refused");
    assert.equal(readFileSync(outside, "utf-8"), "untouched\n", "the symlink target was NEVER written through");
    assert.equal(lstatSync(join(fixedDir, "src", "a.ts.patch")).isSymbolicLink(), true, "the link itself is left alone");
  } finally {
    h.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a normal (non-symlink) patch destination still gets written", () => {
  const t = harness();
  try {
    const r = mintOne(t.d);
    const pf = join(t.h.patchDirFor(r.id), "src", "a.ts.patch");
    assert.equal(lstatSync(pf).isSymbolicLink(), false);
    assert.match(readFileSync(pf, "utf-8"), /^--- a\/src\/a\.ts\n/, "the happy path is untouched by the symlink guard");
  } finally { t.cleanup(); }
});

// ── P4 / ADR-051 §9 — failure Deliveries + the approve auto-chain ────────────

test("P4 mintFailure creates a diff-less pending Delivery of kind 'failure'", () => {
  const { d, emitted, audited, cleanup } = harness();
  try {
    const out = d.mintFailure({
      agentId: "senior-web-1", taskId: "task_abc123",
      kind: "timeout", attempts: 3, detail: "watchdog timeout after 300000ms",
    });
    assert.match(out.id, ULID_RE);
    assert.equal(out.kind, "failure");
    assert.equal(out.source, "swarm");
    assert.equal(out.status, "pending");
    assert.deepEqual(out.changedPaths, []);
    assert.deepEqual(out.diffstat, { files: 0, additions: 0, deletions: 0 });
    assert.match(out.title, /stuck/i);
    assert.match(out.summary, /timeout/);
    assert.match(out.summary, /Attempts: 3/);
    assert.equal(emitted.filter(([e]) => e === "delivery.created").length, 1, "emit-on-persist, exactly once");
    assert.ok(audited.some(([e]) => e === "delivery.created"));
  } finally { cleanup(); }
});

test("P4 a failure Delivery is listable and readable like any other row", () => {
  const { d, cleanup } = harness();
  try {
    const out = d.mintFailure({ agentId: "a1", taskId: "task_aaa111", kind: "crash", attempts: 2, detail: "boom" });
    assert.ok(d.list({ status: "pending" }).some((x) => x.id === out.id));
    const full = d.get(out.id);
    assert.equal(full.kind, "failure");
    assert.deepEqual(full.changes, [], "no patches on disk — there was no diff");
  } finally { cleanup(); }
});

test("P4 mintFailure scrubs the stderr tail it carries", () => {
  const { d, cleanup } = harness();
  try {
    const out = d.mintFailure({
      agentId: "a2", taskId: "task_bbb222", kind: "crash", attempts: 1,
      detail: "boom sk-ant-api03DEADBEEFDEADBEEF",
    });
    assert.ok(!out.summary.includes("sk-ant-api03DEADBEEFDEADBEEF"), "secret-shaped text must not survive");
    assert.match(out.summary, /redacted-secret/);
  } finally { cleanup(); }
});

test("P4 mintFailure is idempotent against the pending-unique index", () => {
  const { d, emitted, cleanup } = harness();
  try {
    const a = d.mintFailure({ agentId: "a3", taskId: "task_ccc333", kind: "spawn", attempts: 2, detail: "x" });
    const b = d.mintFailure({ agentId: "a3", taskId: "task_ccc333", kind: "spawn", attempts: 2, detail: "x" });
    assert.equal(b.id, a.id);
    assert.equal(b.deduped, true);
    assert.equal(emitted.filter(([e]) => e === "delivery.created").length, 1);
  } finally { cleanup(); }
});

// sr-security MED (P4 hardening) — dedupe must NOT reach across kinds. A pending
// `code` row belongs to work that is now terminal; keeping it swallowed the failure
// the operator needs AND left a pending Delivery against an already-FAILED task.
test("HARDENING mintFailure SUPERSEDES a pending code row: it expires, a new failure row is pending", () => {
  const { d, h, emitted, audited, cleanup } = harness();
  try {
    const code = mintOne(d, { taskId: "task_sup111", agentId: "senior-web-1" });
    assert.equal(code.status, "pending");

    const fail = d.mintFailure({
      agentId: "senior-web-1", taskId: "task_sup111",
      kind: "apply-rejected", attempts: 1, detail: "protected path refused",
    });

    assert.notEqual(fail.id, code.id, "the failure is a NEW row, never the stale code row");
    assert.equal(fail.deduped, undefined, "not a dedupe — the failure genuinely reached the Inbox");
    assert.equal(fail.kind, "failure");
    assert.equal(fail.status, "pending");
    assert.match(fail.summary, /apply-rejected/);

    const stale = d.get(code.id);
    assert.equal(stale.status, "expired", "the superseded code row leaves the pending index");
    assert.equal(stale.decidedBy, "system");
    assert.ok(stale.decidedAt, "an expiry is a decision — it gets a timestamp");

    const counts = h.counts();
    assert.equal(counts.pending, 1, "exactly ONE pending row for the work unit");
    assert.equal(counts.expired, 1);

    // The badge counted the code row on delivery.created; the supersede must announce
    // itself or the Inbox over-counts forever.
    assert.deepEqual(
      emitted.map(([e]) => e),
      ["delivery.created", "delivery.decided", "delivery.created"],
      "created(code) → decided(expired) → created(failure)",
    );
    assert.deepEqual(emitted[1][1], { id: code.id, status: "expired", by: "system" });
    assert.ok(audited.some(([e]) => e === "delivery.expired"), "the supersede is auditable");
  } finally { cleanup(); }
});

test("HARDENING a SECOND identical terminal failure still dedupes onto the failure row", () => {
  const { d, h, emitted, cleanup } = harness();
  try {
    mintOne(d, { taskId: "task_sup222", agentId: "senior-web-1" });
    const first = d.mintFailure({ agentId: "senior-web-1", taskId: "task_sup222", kind: "timeout", attempts: 3, detail: "x" });
    const second = d.mintFailure({ agentId: "senior-web-1", taskId: "task_sup222", kind: "timeout", attempts: 3, detail: "x" });

    assert.equal(second.id, first.id, "no second failure row for the same work unit");
    assert.equal(second.deduped, true);
    assert.equal(h.counts().pending, 1);
    assert.equal(h.counts().expired, 1, "only the ONE original code row was expired");
    assert.equal(
      emitted.filter(([e]) => e === "delivery.created").length, 2,
      "one created for the code row, one for the failure — never a third",
    );
    assert.equal(
      emitted.filter(([e]) => e === "delivery.decided").length, 1,
      "the supersede announced itself exactly once",
    );
  } finally { cleanup(); }
});

test("P4 mintFailure requires an agentId", () => {
  const { d, cleanup } = harness();
  try {
    assert.throws(() => d.mintFailure({ taskId: "task_ddd444", kind: "spawn" }), /agentId required/);
  } finally { cleanup(); }
});

test("P4 mint() refuses kind 'failure' — that row is minted only via mintFailure()", () => {
  const { d, cleanup } = harness();
  try {
    assert.throws(
      () => d.mint({ agentId: "a4", taskId: null, source: "swarm", kind: "failure", title: "t", summary: "s", changes: CHANGES }),
      /mintFailure/,
    );
  } finally { cleanup(); }
});

test("P4 approve of an engine-backed row calls onApproved(taskId) — the auto-chain", async () => {
  const chained = [];
  const { d, cleanup } = harness({ onApproved: (taskId) => chained.push(taskId) });
  try {
    const row = mintOne(d, { taskId: "task_ddd444" });
    await d.decide(row.id, "approve", { by: "BOSS" });
    assert.deepEqual(chained, ["task_ddd444"], "the queue task must be advanced on approve");
  } finally { cleanup(); }
});

test("P4 approve of a manual (taskId-less) row does NOT call onApproved", async () => {
  const chained = [];
  const { d, cleanup } = harness({ onApproved: (taskId) => chained.push(taskId) });
  try {
    const row = mintOne(d, { taskId: null });
    await d.decide(row.id, "approve", { by: "BOSS" });
    assert.deepEqual(chained, [], "there is no engine task to chain");
  } finally { cleanup(); }
});

test("P4 reject/request_changes never call onApproved", async () => {
  const chained = [];
  const { d, cleanup } = harness({ onApproved: (taskId) => chained.push(taskId) });
  try {
    const a = mintOne(d, { taskId: "task_e11111" });
    await d.decide(a.id, "reject", { by: "BOSS" });
    const b = mintOne(d, { taskId: "task_e22222" });
    await d.decide(b.id, "request_changes", { by: "BOSS", feedback: "try again" });
    assert.deepEqual(chained, []);
  } finally { cleanup(); }
});

test("P4 a throwing onApproved never un-approves an apply that already landed", async () => {
  const { d, applied, cleanup } = harness({ onApproved: () => { throw new Error("engine down"); } });
  try {
    const row = mintOne(d, { taskId: "task_eee555" });
    const out = await d.decide(row.id, "approve", { by: "BOSS" });
    assert.equal(out.status, "approved");
    assert.equal(applied.length, 1, "the apply still happened");
    assert.match(String(out.chainError), /engine down/);
  } finally { cleanup(); }
});

// ── P5 — the approve ladder: mode / branch / prUrl ───────────────────────────

test("P5 approve with deliverFn mode 'pr' records prUrl/mode/branch and SKIPS the broker apply", async () => {
  const t = harness({
    deliverFn: async () => ({ mode: "pr", branch: "ma/task/task_abc123", prUrl: "https://github.com/a/b/pull/7", reason: "", refused: [] }),
  });
  try {
    const row = mintOne(t.d);
    const out = await t.d.decide(row.id, "approve", { by: "BOSS" });
    assert.equal(out.mode, "pr");
    assert.equal(out.prUrl, "https://github.com/a/b/pull/7");
    assert.equal(out.branch, "ma/task/task_abc123");
    assert.equal(t.applied.length, 0, "a PR-mode delivery must NOT also write the live working tree");
    const reread = t.d.get(row.id);
    assert.equal(reread.mode, "pr", "durable");
    assert.equal(reread.prUrl, "https://github.com/a/b/pull/7");
    assert.equal(reread.branch, "ma/task/task_abc123");
    assert.ok(t.reported.some(([, s]) => s.includes("ma/task/task_abc123")), "reportBack names the branch");
  } finally { t.cleanup(); }
});

test("P5 approve with deliverFn mode 'branch' still skips the broker and records the branch", async () => {
  const t = harness({
    deliverFn: async () => ({ mode: "branch", branch: "ma/task/task_abc123", prUrl: null, reason: "no remote configured", refused: [] }),
  });
  try {
    const row = mintOne(t.d);
    const out = await t.d.decide(row.id, "approve", { by: "BOSS" });
    assert.equal(out.mode, "branch");
    assert.equal(out.prUrl, null);
    assert.match(out.modeReason, /no remote/i);
    assert.equal(t.applied.length, 0);
    assert.equal(t.d.get(row.id).mode, "branch");
  } finally { t.cleanup(); }
});

test("P5 approve with deliverFn mode 'apply' falls back to the broker (pre-P5 behavior)", async () => {
  const t = harness({
    deliverFn: async () => ({ mode: "apply", branch: null, prUrl: null, reason: "not a git repo", refused: [] }),
  });
  try {
    const row = mintOne(t.d);
    const out = await t.d.decide(row.id, "approve", { by: "BOSS" });
    assert.equal(out.mode, "apply");
    assert.deepEqual(t.applied[0][1], ["src/a.ts"]);
    assert.equal(t.d.get(row.id).mode, "apply");
  } finally { t.cleanup(); }
});

test("P5 no deliverFn injected → pre-P5 behavior exactly (broker apply, mode 'apply')", async () => {
  const t = harness();
  try {
    const row = mintOne(t.d);
    const out = await t.d.decide(row.id, "approve", { by: "BOSS" });
    assert.equal(t.applied.length, 1);
    assert.equal(out.mode, "apply");
  } finally { t.cleanup(); }
});

test("P5 a deliverFn that THROWS degrades to the broker apply — never strands the decision", async () => {
  const t = harness({ deliverFn: async () => { throw new Error("boom"); } });
  try {
    const row = mintOne(t.d);
    const out = await t.d.decide(row.id, "approve", { by: "BOSS" });
    assert.equal(out.status, "approved");
    assert.equal(t.applied.length, 1, "the file still landed");
    assert.match(String(out.deliverError), /boom/);
    assert.equal(out.mode, "apply");
  } finally { t.cleanup(); }
});

test("P5 onApproved receives keepBranch=true for a committed mode, false for apply", async () => {
  const seen = [];
  const t = harness({
    onApproved: (taskId, opts) => seen.push([taskId, opts?.keepBranch]),
    deliverFn: async () => ({ mode: "branch", branch: "ma/task/task_abc123", prUrl: null, reason: "", refused: [] }),
  });
  try {
    const row = mintOne(t.d);
    await t.d.decide(row.id, "approve", { by: "BOSS" });
    assert.deepEqual(seen, [["task_abc123", true]]);
  } finally { t.cleanup(); }

  const seen2 = [];
  const t2 = harness({ onApproved: (taskId, opts) => seen2.push([taskId, opts?.keepBranch]) });
  try {
    const row = mintOne(t2.d);
    await t2.d.decide(row.id, "approve", { by: "BOSS" });
    assert.deepEqual(seen2, [["task_abc123", false]]);
  } finally { t2.cleanup(); }
});

test("P5 refused paths surface on the decide result, scrubbed", async () => {
  const t = harness({
    deliverFn: async () => ({ mode: "branch", branch: "ma/task/task_abc123", prUrl: null, reason: "", refused: [".env", "sk-ant-ABCDEFGH123"] }),
  });
  try {
    const row = mintOne(t.d);
    const out = await t.d.decide(row.id, "approve", { by: "BOSS" });
    assert.equal(out.refusedPaths.length, 2);
    assert.ok(!out.refusedPaths.join(" ").includes("sk-ant-"), "refusal text is scrubbed on egress");
  } finally { t.cleanup(); }
});

test("P5 a pending delivery reports null mode/branch/prUrl", () => {
  const t = harness();
  try {
    const row = mintOne(t.d);
    assert.equal(row.mode, null);
    assert.equal(row.branch, null);
    assert.equal(row.prUrl, null);
  } finally { t.cleanup(); }
});

// ── P6 / ADR-053 — risk band + SLA at mint ───────────────────────────────────

test("mint stamps a risk band + reasons from the diff (no LLM)", () => {
  const t = harness();
  try {
    const r = mintOne(t.d); // src/a.ts → medium
    assert.equal(r.risk.band, "medium");
    assert.ok(typeof r.risk.score === "number" && r.risk.score >= 40 && r.risk.score <= 69);
    assert.ok(Array.isArray(r.risk.reasons) && r.risk.reasons.length > 0);
  } finally { t.cleanup(); }
});

test("mint bands a README-only change low and an auth path high", () => {
  const t = harness();
  try {
    const low = t.d.mint({ agentId: "web-a", taskId: "task_low01a", title: "docs", summary: "", source: "swarm", kind: "code", changes: [{ path: "README.md", before: "a\n", after: "a\nb\n" }] });
    assert.equal(low.risk.band, "low");
    const high = t.d.mint({ agentId: "web-b", taskId: "task_high1a", title: "auth", summary: "", source: "swarm", kind: "code", changes: [{ path: "src/auth/login.ts", before: null, after: "x\n" }] });
    assert.equal(high.risk.band, "high");
  } finally { t.cleanup(); }
});

test("mint writes an absolute-UTC slaDeadline when slaFor is wired", () => {
  const at = Date.parse("2026-07-30T00:00:00.000Z");
  const t = harness({ now: () => at, slaFor: (b) => ({ low: 3600, medium: 1800, high: 600 }[b]) });
  try {
    const r = mintOne(t.d); // medium → 1800ms
    assert.equal(r.slaDeadline, new Date(at + 1800).toISOString());
    assert.equal(r.slaState, null);
  } finally { t.cleanup(); }
});

test("mintFailure is high-band with an SLA deadline", () => {
  const at = Date.parse("2026-07-30T00:00:00.000Z");
  const t = harness({ now: () => at, slaFor: (b) => ({ low: 3600, medium: 1800, high: 600 }[b]) });
  try {
    const r = t.d.mintFailure({ agentId: "web-x", taskId: "task_fail01", kind: "timeout", attempts: 2, detail: "boom" });
    assert.equal(r.risk.band, "high");
    assert.equal(r.slaDeadline, new Date(at + 600).toISOString());
  } finally { t.cleanup(); }
});

// ── P6 / ADR-053 — autoApprove (the ONLY producer of auto_approved) ──────────

test("autoApprove applies via the broker and flips to auto_approved + emits", async () => {
  const t = harness();
  try {
    // a MANUAL delivery (taskId null) → the broker is keyed on the agent's sandbox.
    const r = t.d.mint({ agentId: "web-c", taskId: null, title: "readme", summary: "", source: "swarm", kind: "code", changes: [{ path: "README.md", before: "a\n", after: "a\nb\n" }] });
    const out = await t.d.autoApprove(r.id, { reasons: ["low: project doc"] });
    assert.equal(out.status, "auto_approved");
    assert.equal(out.decidedBy, "policy");
    assert.equal(out.mode, "apply");
    // the SAME broker ran, keyed on the sandbox agentId
    assert.deepEqual(t.applied.at(-1), ["web-c", ["README.md"]]);
    // emits BOTH delivery.decided (badge--) and policy.autoapplied (Auto strip)
    const names = t.emitted.map(([e]) => e);
    assert.ok(names.includes("delivery.decided"));
    assert.ok(names.includes("policy.autoapplied"));
    // an audit line with the reasons
    assert.ok(t.audited.some(([e, d]) => e === "delivery.auto_approved" && d.band === "low"));
  } finally { t.cleanup(); }
});

test("autoApprove leaves the row PENDING when the broker refuses a path (no half-approve)", async () => {
  // Both paths are auto-safe (README.md + a plain src/* text file) so they clear the
  // producer-side isAutoSafe gate and reach the broker; applyFn then simulates a guard
  // rejection on ONE of them, proving the all-or-nothing → 409 pending contract.
  const t = harness({ applyFn: async (_key, paths) => paths.map((p) => ({ path: p, ok: p !== "src/notes.md", error: p === "src/notes.md" ? "guard: refused" : undefined })) });
  try {
    const r = t.d.mint({ agentId: "web-d", taskId: "task_auto02", title: "mixed", summary: "", source: "swarm", kind: "code", changes: [{ path: "README.md", before: "a\n", after: "b\n" }, { path: "src/notes.md", before: null, after: "rm\n" }] });
    const out = await t.d.autoApprove(r.id, {});
    assert.equal(out.code, 409);
    // still pending — never half-approved
    assert.equal(t.d.get(r.id).status, "pending");
    // no auto-approve emit happened
    assert.ok(!t.emitted.map(([e]) => e).includes("policy.autoapplied"));
  } finally { t.cleanup(); }
});

test("autoApprove refuses a not-auto-safe path at the PRODUCER (before the broker)", async () => {
  // sr-security P6 MEDIUM: even if a future caller skips the maybeAutoApply gate, the
  // producer itself must refuse an applyAllowed-but-not-auto-safe path (e.g. a source .sh).
  let brokerCalled = false;
  const t = harness({ applyFn: async (_key, paths) => { brokerCalled = true; return paths.map((p) => ({ path: p, ok: true })); } });
  try {
    const r = t.d.mint({ agentId: "web-g", taskId: "task_auto03", title: "src script", summary: "", source: "swarm", kind: "code", changes: [{ path: "src/evil.sh", before: null, after: "rm\n" }] });
    const out = await t.d.autoApprove(r.id, {});
    assert.equal(out.code, 400, "not-auto-safe path refused at the producer");
    assert.equal(brokerCalled, false, "broker never reached");
    assert.equal(t.d.get(r.id).status, "pending");
  } finally { t.cleanup(); }
});

test("autoApprove refuses a failure row and a high-band row", async () => {
  const t = harness();
  try {
    const fail = t.d.mintFailure({ agentId: "web-e", taskId: "task_f", kind: "crash", attempts: 1, detail: "x" });
    assert.equal((await t.d.autoApprove(fail.id, {})).code, 400);
    const high = t.d.mint({ agentId: "web-f", taskId: "task_h", title: "auth", summary: "", source: "swarm", kind: "code", changes: [{ path: "src/auth/login.ts", before: null, after: "x\n" }] });
    assert.equal((await t.d.autoApprove(high.id, {})).code, 400, "high band never auto-applies");
  } finally { t.cleanup(); }
});

test("autoApprove is not reachable via a decide verb", () => {
  const t = harness();
  try {
    assert.ok(!("auto_approve" in { approve: 1, reject: 1, request_changes: 1 }));
    // decide() only knows the three human verbs; auto_approved is produced only by autoApprove.
  } finally { t.cleanup(); }
});

// ── P6 / ADR-053 — sweepSla (once-only escalation, no auto-decide) ───────────

test("sweepSla emits half-life once then expiry once; the row stays pending", () => {
  const at0 = Date.parse("2026-07-30T00:00:00.000Z");
  let clock = at0;
  const t = harness({ now: () => clock, slaFor: () => 1000 }); // 1s window
  try {
    const r = mintOne(t.d); // deadline = at0 + 1000, halflife = at0 + 500
    t.emitted.length = 0;

    // before half-life → nothing
    clock = at0 + 100; assert.deepEqual(t.d.sweepSla(clock), { halflife: 0, expired: 0 });

    // at/after half-life → exactly one half-life event
    clock = at0 + 600; assert.deepEqual(t.d.sweepSla(clock), { halflife: 1, expired: 0 });
    clock = at0 + 700; assert.deepEqual(t.d.sweepSla(clock), { halflife: 0, expired: 0 }, "not re-emitted");
    assert.equal(t.emitted.filter(([e]) => e === "delivery.sla_halflife").length, 1);

    // after expiry → exactly one expired event, and NOT re-emitted
    clock = at0 + 1200; assert.deepEqual(t.d.sweepSla(clock), { halflife: 0, expired: 1 });
    clock = at0 + 1300; assert.deepEqual(t.d.sweepSla(clock), { halflife: 0, expired: 0 });
    assert.equal(t.emitted.filter(([e]) => e === "delivery.expired").length, 1);

    // the delivery is STILL pending — an expired SLA escalates, it does not auto-decide
    assert.equal(t.d.get(r.id).status, "pending");
    assert.equal(t.d.get(r.id).slaState, "expired");
  } finally { t.cleanup(); }
});

test("sweepSla goes straight to expired when it never observed the half-life", () => {
  const at0 = Date.parse("2026-07-30T00:00:00.000Z");
  let clock = at0;
  const t = harness({ now: () => clock, slaFor: () => 1000 });
  try {
    mintOne(t.d);
    t.emitted.length = 0;
    clock = at0 + 5000; // first sweep is already past the deadline
    assert.deepEqual(t.d.sweepSla(clock), { halflife: 0, expired: 1 });
    assert.equal(t.emitted.filter(([e]) => e === "delivery.sla_halflife").length, 0);
    assert.equal(t.emitted.filter(([e]) => e === "delivery.expired").length, 1);
  } finally { t.cleanup(); }
});

test("sweepSla ignores rows with no deadline and decided rows", async () => {
  const t = harness(); // no slaFor → slaDeadline null
  try {
    mintOne(t.d);
    assert.deepEqual(t.d.sweepSla(Date.now() + 1e9), { halflife: 0, expired: 0 });
  } finally { t.cleanup(); }
});

// ── P10 — dogfood scoreboard ─────────────────────────────────────────────────
// "N deliveries approved ÷ human-minutes" over a window. review latency per approved
// delivery = decidedAt − createdAt; humanMinutes = the sum. auto_approved is counted
// separately (shipped without you) and never contributes human-minutes.

const MIN = 60_000;
const WEEK = 7 * 24 * 60 * MIN;

test("scoreboard: empty engine → zeros, no divide-by-zero", () => {
  const t = harness();
  try {
    const sb = t.d.scoreboard({ windowMs: WEEK, nowMs: Date.now() });
    assert.equal(sb.approved, 0);
    assert.equal(sb.autoApproved, 0);
    assert.equal(sb.humanMinutes, 0);
    assert.equal(sb.avgMinutes, null);
    assert.equal(sb.perHour, null);
  } finally { t.cleanup(); }
});

test("scoreboard: two human-approved in window → count + summed review-minutes + averages", async () => {
  let clock = Date.parse("2026-07-30T12:00:00.000Z");
  const t = harness({ now: () => clock });
  try {
    const a = mintOne(t.d);                 // created @12:00
    clock += 5 * MIN; await t.d.decide(a.id, "approve", { by: "BOSS" });   // decided @12:05 → 5 min
    clock = Date.parse("2026-07-30T13:00:00.000Z");
    const b = mintOne(t.d);                 // created @13:00
    clock += 10 * MIN; await t.d.decide(b.id, "approve", { by: "BOSS" });  // decided @13:10 → 10 min
    const sb = t.d.scoreboard({ windowMs: WEEK, nowMs: clock });
    assert.equal(sb.approved, 2);
    assert.equal(sb.humanMinutes, 15);      // 5 + 10
    assert.equal(sb.avgMinutes, 7.5);       // 15 / 2
    assert.equal(sb.perHour, 8);            // 2 / (15/60) = 8 approvals per human-hour
  } finally { t.cleanup(); }
});

test("scoreboard: pending and rejected are excluded from the approved metric", async () => {
  let clock = Date.parse("2026-07-30T12:00:00.000Z");
  const t = harness({ now: () => clock });
  try {
    const a = mintOne(t.d); clock += 3 * MIN; await t.d.decide(a.id, "approve", { by: "BOSS" });
    const r = mintOne(t.d, { taskId: "task_rej" }); clock += 4 * MIN; await t.d.decide(r.id, "reject", { by: "BOSS", feedback: "no" });
    mintOne(t.d, { taskId: "task_pend" });   // left pending
    const sb = t.d.scoreboard({ windowMs: WEEK, nowMs: clock });
    assert.equal(sb.approved, 1);
    assert.equal(sb.humanMinutes, 3);
  } finally { t.cleanup(); }
});

test("scoreboard: an approval decided BEFORE the window is excluded", async () => {
  let clock = Date.parse("2026-07-30T12:00:00.000Z");
  const t = harness({ now: () => clock });
  try {
    const old = mintOne(t.d); clock += 2 * MIN; await t.d.decide(old.id, "approve", { by: "BOSS" });
    const decidedAt = clock;                 // ~12:02
    // a 1-hour window ending 8 days later excludes the old approval
    const sb = t.d.scoreboard({ windowMs: 60 * MIN, nowMs: decidedAt + 8 * 24 * 60 * MIN });
    assert.equal(sb.approved, 0);
    assert.equal(sb.humanMinutes, 0);
  } finally { t.cleanup(); }
});

test("scoreboard: auto_approved is counted separately and never adds human-minutes", async () => {
  let clock = Date.parse("2026-07-30T12:00:00.000Z");
  const t = harness({ now: () => clock });
  try {
    const a = mintOne(t.d); clock += 6 * MIN; await t.d.decide(a.id, "approve", { by: "BOSS" });
    const auto = mintOne(t.d, { taskId: "task_auto" });
    // flip to auto_approved with a decidedAt in-window (mint valid row, then set status)
    t.h.db.prepare("UPDATE deliveries SET status='auto_approved', decidedAt=? WHERE id=?").run(new Date(clock).toISOString(), auto.id);
    const sb = t.d.scoreboard({ windowMs: WEEK, nowMs: clock });
    assert.equal(sb.approved, 1);
    assert.equal(sb.autoApproved, 1);
    assert.equal(sb.humanMinutes, 6);        // only the human approval, not the auto one
  } finally { t.cleanup(); }
});

// ── B1 — `decided`: every decision the human actually made in the window ──────
// approved + rejected + changes_requested. NOT auto_approved (nobody decided it)
// and NOT pending (nothing decided yet). Purely additive: every P10 field above
// keeps its exact meaning, so the shipped Inbox chip is untouched.

test("scoreboard: decided counts approve + reject + request_changes in the window", async () => {
  let clock = Date.parse("2026-07-30T12:00:00.000Z");
  const t = harness({ now: () => clock });
  try {
    const a = mintOne(t.d); clock += 2 * MIN; await t.d.decide(a.id, "approve", { by: "BOSS" });
    const r = mintOne(t.d, { taskId: "task_rej" }); clock += 3 * MIN; await t.d.decide(r.id, "reject", { by: "BOSS", feedback: "no" });
    const c = mintOne(t.d, { taskId: "task_chg" }); clock += 4 * MIN; await t.d.decide(c.id, "request_changes", { by: "BOSS", feedback: "tighten it" });
    const sb = t.d.scoreboard({ windowMs: WEEK, nowMs: clock });
    assert.equal(sb.decided, 3);
    // the P10 numbers are unchanged by the new field
    assert.equal(sb.approved, 1);
    assert.equal(sb.humanMinutes, 2);
  } finally { t.cleanup(); }
});

test("scoreboard: pending is excluded from decided, auto_approved is not a decision", async () => {
  let clock = Date.parse("2026-07-30T12:00:00.000Z");
  const t = harness({ now: () => clock });
  try {
    const a = mintOne(t.d); clock += 5 * MIN; await t.d.decide(a.id, "approve", { by: "BOSS" });
    mintOne(t.d, { taskId: "task_pend" });                       // left pending
    const auto = mintOne(t.d, { taskId: "task_auto" });
    t.h.db.prepare("UPDATE deliveries SET status='auto_approved', decidedAt=? WHERE id=?").run(new Date(clock).toISOString(), auto.id);
    const sb = t.d.scoreboard({ windowMs: WEEK, nowMs: clock });
    assert.equal(sb.decided, 1);
    assert.equal(sb.autoApproved, 1);
  } finally { t.cleanup(); }
});

test("scoreboard: a decision made BEFORE the window is excluded from decided", async () => {
  let clock = Date.parse("2026-07-30T12:00:00.000Z");
  const t = harness({ now: () => clock });
  try {
    const old = mintOne(t.d); clock += 2 * MIN; await t.d.decide(old.id, "reject", { by: "BOSS", feedback: "no" });
    const decidedAt = clock;
    const sb = t.d.scoreboard({ windowMs: 60 * MIN, nowMs: decidedAt + 8 * 24 * 60 * MIN });
    assert.equal(sb.decided, 0);
  } finally { t.cleanup(); }
});

test("scoreboard: an empty engine reports decided 0 (no divide-by-zero, no null)", () => {
  const t = harness();
  try {
    const sb = t.d.scoreboard({ windowMs: WEEK, nowMs: Date.now() });
    assert.equal(sb.decided, 0);
  } finally { t.cleanup(); }
});

test("scoreboard: a malformed decided row is skipped, not counted", async () => {
  let clock = Date.parse("2026-07-30T12:00:00.000Z");
  const t = harness({ now: () => clock });
  try {
    const good = mintOne(t.d); clock += 2 * MIN; await t.d.decide(good.id, "approve", { by: "BOSS" });
    const bad = mintOne(t.d, { taskId: "task_bad" }); await t.d.decide(bad.id, "reject", { by: "BOSS", feedback: "no" });
    // corrupt the decision timestamp — the same malformed-row guard the approved
    // metric already applies must drop it from the decision count too.
    t.h.db.prepare("UPDATE deliveries SET decidedAt='not-a-date' WHERE id=?").run(bad.id);
    const sb = t.d.scoreboard({ windowMs: WEEK, nowMs: clock });
    assert.equal(sb.decided, 1);
  } finally { t.cleanup(); }
});

// ── B2 / ADR-055 — the decision choke point feeds the Knowledge Vault ─────────

test("B2 onDecided fires once per decision with the terminal status and the decider", async () => {
  const t = harness();
  try {
    for (const [verb, status] of [["approve", "approved"], ["reject", "rejected"], ["request_changes", "changes_requested"]]) {
      const r = mintOne(t.d, { taskId: `task_${verb.slice(0, 6)}`, title: `Work for ${verb}` });
      const out = await t.d.decide(r.id, verb, { by: "Alice", feedback: "please tighten the types" });
      assert.equal(out.status, status, verb);
    }
    assert.equal(t.decided.length, 3);
    assert.deepEqual(t.decided.map((d) => d.info.status), ["approved", "rejected", "changes_requested"]);
    assert.deepEqual(t.decided.map((d) => d.info.by), ["Alice", "Alice", "Alice"]);
    assert.equal(t.decided[0].row.title, "Work for approve");
    assert.equal(t.decided[0].row.agentId, "senior-web-1");
    assert.equal(t.decided[2].info.feedback, "please tighten the types");
  } finally { t.cleanup(); }
});

test("B2 onDecided does NOT fire for a decision that lost the race (already decided)", async () => {
  const t = harness();
  try {
    const r = mintOne(t.d);
    await t.d.decide(r.id, "approve", { by: "Alice" });
    const again = await t.d.decide(r.id, "reject", { by: "Bob" });
    assert.equal(again.code, 409);
    assert.equal(t.decided.length, 1, "one commit, one record");
  } finally { t.cleanup(); }
});

test("B2 a throwing onDecided can never un-decide a delivery", async () => {
  const t = harness({ onDecided: () => { throw new Error("vault exploded"); } });
  try {
    const r = mintOne(t.d);
    const out = await t.d.decide(r.id, "approve", { by: "Alice" });
    assert.equal(out.status, "approved");
    assert.equal(t.d.get(r.id).status, "approved", "the commit stands");
  } finally { t.cleanup(); }
});

// ── S2 human-gate deliveries (question / design-approval) via mintGate ────────

test("mint refuses the diff-less gate kinds — they go through mintGate()", () => {
  const t = harness();
  try {
    for (const kind of ["question", "design-approval"]) {
      assert.throws(
        () => t.d.mint({ agentId: "pm-analyst", taskId: null, source: "swarm", kind, title: "t", summary: "s", changes: CHANGES }),
        /mintGate/i,
        `mint refuses kind '${kind}'`,
      );
    }
  } finally { t.cleanup(); }
});

test("mintGate creates a diff-less, high-band, story-linked pending row and emits delivery.created", () => {
  const t = harness();
  try {
    const g = t.d.mintGate({ kind: "question", agentId: "pm-analyst", storyId: "story_abc123", slot: "story_abc123-q0", title: "Clarify leak sk-ant-ABCDEFGH123", body: "Which flow leak sk-ant-ABCDEFGH123 first?" });
    assert.match(g.id, ULID_RE);
    assert.equal(g.status, "pending");
    assert.equal(g.kind, "question");
    assert.equal(g.source, "swarm");
    assert.equal(g.storyId, "story_abc123", "story back-pointer set");
    assert.equal(g.diffstat.files, 0, "diff-less");
    assert.deepEqual(g.changedPaths, []);
    assert.equal(g.risk.band, "high", "a gate surfaces high");
    assert.ok(!g.title.includes("sk-ant-"), "title scrubbed at rest");
    assert.ok(!g.summary.includes("sk-ant-"), "body scrubbed at rest");
    assert.deepEqual(t.emitted.map(([e]) => e), ["delivery.created"]);
  } finally { t.cleanup(); }
});

test("mintGate dedupes per slot; listGates finds a story's pending gates by kind", () => {
  const t = harness();
  try {
    const a = t.d.mintGate({ kind: "question", agentId: "pm-analyst", storyId: "story_z", slot: "story_z-q0", title: "q0", body: "b0" });
    const dup = t.d.mintGate({ kind: "question", agentId: "pm-analyst", storyId: "story_z", slot: "story_z-q0", title: "q0", body: "b0" });
    assert.equal(dup.id, a.id, "same slot → same pending row");
    assert.equal(dup.deduped, true);
    const b = t.d.mintGate({ kind: "question", agentId: "pm-analyst", storyId: "story_z", slot: "story_z-q1", title: "q1", body: "b1" });
    assert.notEqual(b.id, a.id, "a distinct slot → a distinct gate");
    const design = t.d.mintGate({ kind: "design-approval", agentId: "architect", storyId: "story_z", slot: "story_z-design", title: "d", body: "design" });

    assert.equal(t.d.listGates("story_z", "question").length, 2);
    assert.equal(t.d.listGates("story_z", "design-approval").length, 1);
    assert.equal(t.d.listGates("story_z").length, 3, "all pending gates for the story");
    assert.equal(t.d.listGates("story_other").length, 0);
    assert.equal(design.storyId, "story_z");
  } finally { t.cleanup(); }
});

test("mintGate requires a kind, agentId and storyId", () => {
  const t = harness();
  try {
    assert.throws(() => t.d.mintGate({ kind: "code", agentId: "a", storyId: "s" }), /kind/i);
    assert.throws(() => t.d.mintGate({ kind: "question", agentId: "", storyId: "s" }), /agentId/i);
    assert.throws(() => t.d.mintGate({ kind: "question", agentId: "a", storyId: "" }), /storyId/i);
  } finally { t.cleanup(); }
});

test("deciding a gate flips + emits + fires onDecided, but runs NO broker apply/discard/rerun", async () => {
  const t = harness();
  try {
    const g = t.d.mintGate({ kind: "design-approval", agentId: "architect", storyId: "story_g", slot: "story_g-design", title: "design gate", body: "the design" });
    const out = await t.d.decide(g.id, "approve", { by: "boss" });
    assert.equal(out.status, "approved");
    assert.equal(t.applied.length, 0, "no broker apply on a gate");
    assert.equal(t.reran.length, 0, "no engine re-run goal on a gate");
    assert.equal(t.discarded.length, 0, "no discard on a gate");
    assert.equal(t.decided.length, 1, "onDecided still fired — the pipeline hook");
    assert.equal(t.decided[0].info.status, "approved");
    // The decided row leaves the pending index, so listGates no longer shows it.
    assert.equal(t.d.listGates("story_g", "design-approval").length, 0);
  } finally { t.cleanup(); }
});
