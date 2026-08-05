// P7 / ADR-054 — GitHub adapter. gh is MOCKED via an injected runner (no network, no
// real PR is ever touched); the store is a throwaway tmp DB. Proves: poll mints from
// `gh pr list`+`gh pr diff`, idempotency, decide-verb → gh argv mapping, two-way state
// sync (PR merged externally → delivery reconciled), and adapter-status on gh-not-authed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../db.mjs";
import { createDeliveries } from "../deliveries.mjs";
import { createGithubAdapter, searchQueryFor, repoFromUrl, parsePrDiff } from "../adapters/github.mjs";

const scrub = (t) => (typeof t === "string" ? t.replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, "[redacted-secret]") : t);

function bootDeliveries() {
  const root = mkdtempSync(join(tmpdir(), "ma-p7-gh-"));
  const db = openDb({ path: join(root, "m.db"), patchesDir: join(root, "patches") });
  const deliveries = createDeliveries({ db, events: { emit: () => {} }, audit: () => {}, scrub, slaFor: () => 3_600_000 });
  return { root, deliveries, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// A configurable gh mock that records every argv line.
function ghMock(state = {}) {
  const calls = [];
  const run = (bin, args) => {
    calls.push({ bin, argv: args, line: args.join(" ") });
    if (bin !== "gh") return Promise.resolve({ ok: false, stdout: "", stderr: "not gh" });
    const [a0, a1] = args;
    if (a0 === "pr" && a1 === "list") {
      if (state.listErr) return Promise.resolve({ ok: false, stdout: "", stderr: state.listErr });
      return Promise.resolve({ ok: true, stdout: JSON.stringify(state.prs || []), stderr: "" });
    }
    if (a0 === "pr" && a1 === "diff") return Promise.resolve({ ok: true, stdout: state.diff ?? DIFF, stderr: "" });
    if (a0 === "pr" && a1 === "review") return Promise.resolve({ ok: state.reviewOk !== false, stdout: "", stderr: state.reviewOk === false ? "denied" : "" });
    if (a0 === "pr" && a1 === "merge") return Promise.resolve({ ok: state.mergeOk !== false, stdout: "", stderr: "" });
    if (a0 === "pr" && a1 === "close") return Promise.resolve({ ok: state.closeOk !== false, stdout: "", stderr: "" });
    return Promise.resolve({ ok: false, stdout: "", stderr: "unhandled " + args.join(" ") });
  };
  return { run, calls };
}

const DIFF = [
  "diff --git a/src/x.ts b/src/x.ts",
  "index 111..222 100644",
  "--- a/src/x.ts",
  "+++ b/src/x.ts",
  "@@ -1,2 +1,2 @@",
  " keep",
  "-old",
  "+new",
  "diff --git a/docs/readme.md b/docs/readme.md",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/docs/readme.md",
  "@@ -0,0 +1 @@",
  "+hello",
].join("\n");

const openPr = (over = {}) => ({ number: 42, title: "Add validation", author: { login: "cursor[bot]" }, headRefName: "cursor/fix", headRefOid: "sha42", url: "https://github.com/acme/app/pull/42", updatedAt: "2026-07-30T00:00:00Z", state: "OPEN", isDraft: false, mergedAt: null, ...over });

// ── pure helpers ──────────────────────────────────────────────────────────────
test("parsePrDiff splits a multi-file diff into clean per-file patches with stats", () => {
  const files = parsePrDiff(DIFF);
  assert.equal(files.length, 2);
  assert.equal(files[0].path, "src/x.ts");
  assert.deepEqual([files[0].additions, files[0].deletions], [1, 1]);
  assert.ok(!files[0].patch.includes("diff --git"), "header noise stripped");
  assert.ok(files[0].patch.startsWith("--- a/src/x.ts"));
  assert.equal(files[1].path, "docs/readme.md");
  assert.equal(files[1].status, "new");
  assert.deepEqual([files[1].additions, files[1].deletions], [1, 0]);
});

test("searchQueryFor OR-joins app/<bot> and <bot>; repoFromUrl parses github PR urls", () => {
  assert.equal(searchQueryFor(["cursor"]), "author:app/cursor OR author:cursor");
  assert.equal(searchQueryFor(["app/devin"]), "author:app/devin");
  assert.equal(repoFromUrl("https://github.com/acme/app/pull/42"), "acme/app");
  assert.equal(repoFromUrl("https://evil.example/acme/app/pull/1"), "");
});

// ── poll → mint ────────────────────────────────────────────────────────────────
test("poll mints a source=github-pr delivery from gh pr list + gh pr diff, and is idempotent", async () => {
  const { deliveries, cleanup } = bootDeliveries();
  const gh = ghMock({ prs: [openPr()] });
  const ad = createGithubAdapter({ deliveries, runner: gh, enabled: true, config: { botAuthors: ["cursor"], repo: "acme/app", pollIntervalMs: 60000 } });
  try {
    const r1 = await ad.poll();
    assert.equal(r1.minted, 1);
    const rows = deliveries.list({});
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, "github-pr");
    assert.equal(rows[0].externalKey, "ghpr:acme/app#42@sha42");
    assert.equal(rows[0].diffstat.files, 2);
    // list argv carried the search + repo + state all
    assert.ok(gh.calls.some((c) => c.line.includes("pr list") && c.line.includes("--search") && c.line.includes("--repo acme/app") && c.line.includes("--state all")));
    // second poll — same PR@sha → no new mint (idempotent)
    const r2 = await ad.poll();
    assert.equal(r2.minted, 0);
    assert.equal(deliveries.list({}).length, 1);
  } finally { cleanup(); }
});

// ── decide-verb → gh argv ───────────────────────────────────────────────────────
test("decideExternal maps verbs to gh argv (approve / request-changes -b / close -c)", async () => {
  const { deliveries, cleanup } = bootDeliveries();
  const gh = ghMock({});
  const ad = createGithubAdapter({ deliveries, runner: gh, enabled: true, config: { botAuthors: ["x"], repo: "acme/app" } });
  try {
    const meta = { repo: "acme/app", prNumber: 42, url: "https://github.com/acme/app/pull/42" };
    const ap = await ad.decideExternal({ verb: "approve", meta });
    assert.equal(ap.ok, true); assert.equal(ap.action, "approved");
    assert.ok(gh.calls.some((c) => c.line === "pr review 42 --repo acme/app --approve"));

    const rc = await ad.decideExternal({ verb: "request_changes", meta, feedback: "tighten the types" });
    assert.equal(rc.ok, true);
    const rcCall = gh.calls.find((c) => c.line.includes("--request-changes"));
    assert.deepEqual(rcCall.argv, ["pr", "review", "42", "--repo", "acme/app", "--request-changes", "-b", "tighten the types"]);

    const rj = await ad.decideExternal({ verb: "reject", meta, feedback: "not now" });
    assert.equal(rj.ok, true); assert.equal(rj.action, "closed");
    const rjCall = gh.calls.find((c) => c.line.includes("pr close"));
    assert.deepEqual(rjCall.argv, ["pr", "close", "42", "--repo", "acme/app", "-c", "not now"]);
  } finally { cleanup(); }
});

test("decideExternal default does NOT merge (mergeOnApprove OFF); a gh failure returns ok:false", async () => {
  const { deliveries, cleanup } = bootDeliveries();
  const gh = ghMock({ reviewOk: false });
  const ad = createGithubAdapter({ deliveries, runner: gh, enabled: true, config: { botAuthors: ["x"] } });
  try {
    const r = await ad.decideExternal({ verb: "approve", meta: { prNumber: 1 } });
    assert.equal(r.ok, false);
    assert.ok(!gh.calls.some((c) => c.line.includes("pr merge")), "no merge attempted");
  } finally { cleanup(); }
});

// ── two-way state sync ──────────────────────────────────────────────────────────
test("a PR merged directly on GitHub reconciles the matching pending delivery to approved", async () => {
  const { deliveries, cleanup } = bootDeliveries();
  const state = { prs: [openPr()] };
  const gh = ghMock(state);
  const ad = createGithubAdapter({ deliveries, runner: gh, enabled: true, config: { botAuthors: ["cursor"], repo: "acme/app" } });
  try {
    await ad.poll();
    assert.equal(deliveries.list({ status: "pending" }).length, 1);
    // the PR is now MERGED on GitHub
    state.prs = [openPr({ state: "MERGED", mergedAt: "2026-07-30T01:00:00Z", isDraft: false })];
    const r = await ad.poll();
    assert.equal(r.reconciled, 1);
    assert.equal(deliveries.list({ status: "pending" }).length, 0);
    assert.equal(deliveries.list({ status: "approved" }).length, 1);
  } finally { cleanup(); }
});

// ── adapter status surfaces failures, never a silent vanish ─────────────────────
test("a logged-out gh surfaces status state 'gh-not-authed' instead of crashing", async () => {
  const { deliveries, cleanup } = bootDeliveries();
  const gh = ghMock({ listErr: "gh auth status: not logged in" });
  const ad = createGithubAdapter({ deliveries, runner: gh, enabled: true, config: { botAuthors: ["x"] } });
  try {
    const r = await ad.poll();
    assert.equal(r.minted, 0);
    assert.match(r.error, /not logged in/);
    const st = ad.status();
    assert.equal(st.state, "gh-not-authed");
    assert.equal(st.authenticated, false);
    assert.equal(st.enabled, true);
  } finally { cleanup(); }
});

test("an untrusted PR title carrying a secret shape is scrubbed in the minted row", async () => {
  const { deliveries, cleanup } = bootDeliveries();
  const gh = ghMock({ prs: [openPr({ title: "fix leak ghp_ABCDEFGHIJKLMNOPQRSTUVWX123456" })] });
  const ad = createGithubAdapter({ deliveries, runner: gh, enabled: true, config: { botAuthors: ["cursor"], repo: "acme/app" } });
  try {
    await ad.poll();
    const row = deliveries.list({})[0];
    assert.ok(!/ghp_[A-Za-z0-9]{20,}/.test(row.title), "token redacted from the untrusted title");
  } finally { cleanup(); }
});
