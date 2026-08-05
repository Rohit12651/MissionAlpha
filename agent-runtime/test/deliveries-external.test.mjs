// P7 / ADR-054 — external ingestion at the store level: mintExternal (idempotency,
// scrub, risk), source-dispatched decide (github-pr → externalDecideFn gh-first,
// claude-code → read-only 403), reconcileExternal (two-way state sync), and the
// hard invariant that an external delivery can NEVER auto-apply.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../db.mjs";
import { createDeliveries } from "../deliveries.mjs";

// A scrub that mimics the server's: strips a gh-token shape, leaves the rest.
const scrub = (t) => (typeof t === "string" ? t.replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, "[redacted-secret]") : t);

function boot(extra = {}) {
  const root = mkdtempSync(join(tmpdir(), "ma-p7-ext-"));
  const db = openDb({ path: join(root, "m.db"), patchesDir: join(root, "patches") });
  const events = [];
  const audits = [];
  const deliveries = createDeliveries({
    db,
    events: { emit: (n, d) => events.push({ n, d }) },
    audit: (n, d) => audits.push({ n, d }),
    scrub,
    slaFor: () => 3_600_000,
    applyFn: async () => { throw new Error("broker MUST NOT be reached for an external delivery"); },
    ...extra,
  });
  return { root, db, deliveries, events, audits, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const patch = "--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-old\n+new\n";

test("mintExternal mints a github-pr row: risk classified, patch on disk, delivery.created emitted", () => {
  const { deliveries, events, cleanup } = boot();
  try {
    const d = deliveries.mintExternal({
      source: "github-pr", agentId: "cursor[bot]", externalKey: "ghpr:acme/app#42@sha1",
      title: "Add validation", summary: "PR body",
      changes: [{ path: "src/x.ts", patch, additions: 1, deletions: 1 }],
      externalMeta: { repo: "acme/app", prNumber: 42, url: "https://github.com/acme/app/pull/42" },
    });
    assert.equal(d.source, "github-pr");
    assert.equal(d.status, "pending");
    assert.equal(d.risk.band, "medium", "src/* path ⇒ medium");
    assert.equal(d.externalKey, "ghpr:acme/app#42@sha1");
    assert.deepEqual(d.externalMeta, { repo: "acme/app", prNumber: 42, url: "https://github.com/acme/app/pull/42" });
    assert.ok(events.some((e) => e.n === "delivery.created"));
    const detail = deliveries.get(d.id);
    assert.equal(detail.changes.length, 1);
    assert.ok(detail.changes[0].patch.includes("+new"));
  } finally { cleanup(); }
});

test("mintExternal is idempotent by externalKey — same PR@sha never mints twice", () => {
  const { deliveries, cleanup } = boot();
  try {
    const a = deliveries.mintExternal({ source: "github-pr", agentId: "b", externalKey: "k1", changes: [{ path: "src/x.ts", patch, additions: 1, deletions: 1 }] });
    const b = deliveries.mintExternal({ source: "github-pr", agentId: "b", externalKey: "k1", changes: [{ path: "src/x.ts", patch, additions: 1, deletions: 1 }] });
    assert.equal(b.deduped, true);
    assert.equal(a.id, b.id);
    assert.equal(deliveries.list({}).length, 1);
  } finally { cleanup(); }
});

test("two pending PRs from the SAME bot author do NOT collide (distinct externalKey)", () => {
  const { deliveries, cleanup } = boot();
  try {
    const a = deliveries.mintExternal({ source: "github-pr", agentId: "dependabot", externalKey: "ghpr:o/r#1@s", changes: [{ path: "src/a.ts", patch, additions: 1, deletions: 1 }] });
    const b = deliveries.mintExternal({ source: "github-pr", agentId: "dependabot", externalKey: "ghpr:o/r#2@s", changes: [{ path: "src/b.ts", patch, additions: 1, deletions: 1 }] });
    assert.notEqual(a.id, b.id);
    assert.ok(!a.deduped && !b.deduped, "neither is a dedupe — the old pending-key would have collapsed them");
    assert.equal(deliveries.list({ status: "pending" }).length, 2);
  } finally { cleanup(); }
});

test("mintExternal scrubs a secret shape and strips control chars from untrusted title/summary", () => {
  const { deliveries, cleanup } = boot();
  try {
    const d = deliveries.mintExternal({
      source: "github-pr", agentId: "bot", externalKey: "k-scrub",
      title: "leak ghp_ABCDEFGHIJKLMNOPQRSTUVWX123456 here\x07",
      summary: "body ghp_ABCDEFGHIJKLMNOPQRSTUVWX123456\x00tail",
      changes: [{ path: "src/x.ts", patch, additions: 1, deletions: 1 }],
    });
    assert.ok(!/ghp_[A-Za-z0-9]{20,}/.test(d.title), "token redacted in title");
    assert.ok(!/ghp_[A-Za-z0-9]{20,}/.test(d.summary), "token redacted in summary");
    assert.ok(!/[\x00-\x08]/.test(d.title + d.summary), "control chars stripped"); // eslint-disable-line no-control-regex
  } finally { cleanup(); }
});

test("decide on a github-pr routes to externalDecideFn (gh-first) and flips ONLY on ok", async () => {
  const calls = [];
  const { deliveries, events, cleanup } = boot({
    externalDecideFn: async (a) => { calls.push(a); return { ok: true, action: "approved", url: "https://github.com/acme/app/pull/42" }; },
  });
  try {
    const d = deliveries.mintExternal({ source: "github-pr", agentId: "bot", externalKey: "k-app", changes: [{ path: "src/x.ts", patch, additions: 1, deletions: 1 }], externalMeta: { repo: "acme/app", prNumber: 42 } });
    const r = await deliveries.decide(d.id, "approve", { by: "BOSS" });
    assert.equal(r.status, "approved");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].verb, "approve");
    assert.deepEqual(calls[0].meta, { repo: "acme/app", prNumber: 42 });
    assert.ok(events.some((e) => e.n === "delivery.decided" && e.d.status === "approved"));
  } finally { cleanup(); }
});

test("decide on a github-pr leaves the row PENDING when gh fails (never fabricate an approve)", async () => {
  const { deliveries, cleanup } = boot({ externalDecideFn: async () => ({ ok: false, error: "gh: not authenticated" }) });
  try {
    const d = deliveries.mintExternal({ source: "github-pr", agentId: "bot", externalKey: "k-fail", changes: [{ path: "src/x.ts", patch, additions: 1, deletions: 1 }], externalMeta: { prNumber: 7 } });
    const r = await deliveries.decide(d.id, "approve", { by: "BOSS" });
    assert.equal(r.code, 502);
    assert.match(r.error, /not authenticated/);
    assert.equal(deliveries.get(d.id).status, "pending", "gh failure must not flip the row");
  } finally { cleanup(); }
});

test("decide on a claude-code delivery is refused 403 (read-only)", async () => {
  const { deliveries, cleanup } = boot();
  try {
    const d = deliveries.mintExternal({ source: "claude-code", agentId: "sess1", externalKey: "cc:sess1", title: "local session", changes: [{ path: "/Users/x/repo/a.ts" }] });
    const r = await deliveries.decide(d.id, "approve", { by: "BOSS" });
    assert.equal(r.code, 403);
    assert.match(r.error, /read-only/);
    assert.equal(deliveries.get(d.id).status, "pending");
  } finally { cleanup(); }
});

test("autoApprove hard-refuses any external source — external deliveries never auto-apply", async () => {
  const { deliveries, cleanup } = boot();
  try {
    const gh = deliveries.mintExternal({ source: "github-pr", agentId: "bot", externalKey: "k-auto", changes: [{ path: "src/x.ts", patch, additions: 1, deletions: 1 }] });
    const rg = await deliveries.autoApprove(gh.id, { decidedBy: "policy" });
    assert.equal(rg.code, 400);
    assert.match(rg.error, /external deliveries never auto-apply/);
    assert.equal(deliveries.get(gh.id).status, "pending");
  } finally { cleanup(); }
});

test("reconcileExternal flips a pending github-pr on external merge/close; refuses non-github + decided", () => {
  const { deliveries, events, cleanup } = boot();
  try {
    const d = deliveries.mintExternal({ source: "github-pr", agentId: "bot", externalKey: "k-rec", changes: [{ path: "src/x.ts", patch, additions: 1, deletions: 1 }], externalMeta: { prNumber: 9 } });
    const r = deliveries.reconcileExternal(d.id, { status: "approved", by: "github", reason: "merged on GitHub" });
    assert.equal(r.status, "approved");
    assert.equal(r.decidedBy, "github");
    assert.ok(events.some((e) => e.n === "delivery.decided" && e.d.status === "approved"));
    // already decided → 409
    assert.equal(deliveries.reconcileExternal(d.id, { status: "rejected" }).code, 409);
    // a swarm row is not reconcilable this way
    const cc = deliveries.mintExternal({ source: "claude-code", agentId: "s", externalKey: "cc:s", changes: [] });
    assert.equal(deliveries.reconcileExternal(cc.id, { status: "approved" }).code, 400);
  } finally { cleanup(); }
});

test("listExternalPending + findByExternalKey surface external rows for the adapter", () => {
  const { deliveries, cleanup } = boot();
  try {
    deliveries.mintExternal({ source: "github-pr", agentId: "bot", externalKey: "k-list", changes: [{ path: "src/x.ts", patch, additions: 1, deletions: 1 }], externalMeta: { repo: "o/r", prNumber: 3 } });
    const pend = deliveries.listExternalPending("github-pr");
    assert.equal(pend.length, 1);
    assert.equal(pend[0].externalMeta.prNumber, 3);
    assert.equal(deliveries.findByExternalKey("k-list").externalKey, "k-list");
    assert.equal(deliveries.findByExternalKey("nope"), null);
  } finally { cleanup(); }
});

test("mintExternal rejects a github-pr with no changes; allows a claude-code with zero files", () => {
  const { deliveries, cleanup } = boot();
  try {
    assert.throws(() => deliveries.mintExternal({ source: "github-pr", agentId: "b", externalKey: "k-empty", changes: [] }), /at least one changed file/);
    const cc = deliveries.mintExternal({ source: "claude-code", agentId: "s2", externalKey: "cc:s2", title: "chat only", changes: [] });
    assert.equal(cc.source, "claude-code");
    assert.equal(cc.diffFiles, 0);
  } finally { cleanup(); }
});

// sr-security P7 LOW regression: an attacker-named PR file path is scrubbed on store + egress.
test("mintExternal scrubs a secret-shaped / control-char changedPath (M5 no unscrubbed field)", () => {
  const t = boot();
  try {
    const d = t.deliveries.mintExternal({
      source: "github-pr",
      agentId: "cursor",
      externalKey: "ghpr:o/r#9@sha",
      externalMeta: { repo: "o/r", prNumber: 9, url: "https://github.com/o/r/pull/9" },
      changes: [{ path: "src/ghp_ABCDEFGHIJ0123456789KLMNOP.ts", patch: "--- a\n+++ b\n", additions: 1, deletions: 0 }],
    });
    const row = t.deliveries.get(d.id);
    const joined = JSON.stringify(row.changedPaths);
    assert.ok(!/ghp_[A-Za-z0-9]{20,}/.test(joined), "secret-shaped path must be scrubbed in the stored row");
    assert.ok(joined.includes("[redacted-secret]"), "scrub token present");
  } finally { t.cleanup(); }
});
