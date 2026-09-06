import { test } from "node:test";
import assert from "node:assert/strict";
import {
  INBOX_FILTERS,
  matchesFilter,
  pendingCount,
  riskLabel,
  riskTone,
  diffstatLabel,
  decidePath,
  isPending,
  avatarFor,
  decidedLabel,
  listQuery,
  isApproveBlocked,
  isFailure,
  TYPED_CONFIRM,
  type Delivery,
  needsTypedConfirm,
} from "../inboxClient.ts";

const D = (over: Partial<Delivery> = {}): Delivery => ({
  id: "01J000000000000000000000AA",
  agentId: "senior-web-1",
  taskId: null,
  title: "t",
  summary: "",
  source: "swarm",
  kind: "code",
  diffstat: { files: 1, additions: 10, deletions: 2 },
  diffFiles: 1,
  diffAdditions: 10,
  diffDeletions: 2,
  changedPaths: ["a.ts"],
  risk: { score: null, band: null, reasons: [] },
  status: "pending",
  slaDeadline: null,
  createdAt: "2026-07-30T00:00:00.000Z",
  decidedAt: null,
  decidedBy: null,
  feedback: null,
  auditRef: "delivery:x",
  ...over,
});

// ── filters (the mockup's five pills) ────────────────────────────────────────
test("filter list is the mockup's five, in order", () => {
  assert.deepEqual(INBOX_FILTERS, ["All", "High risk", "My swarm", "External", "Failures"]);
});

test("All matches everything", () => {
  assert.equal(matchesFilter(D(), "All"), true);
  assert.equal(matchesFilter(D({ source: "github-pr" }), "All"), true);
  assert.equal(matchesFilter(D({ status: "approved" }), "All"), true);
});

test("High risk matches only band=high (unrated is NOT high)", () => {
  assert.equal(matchesFilter(D({ risk: { score: 90, band: "high", reasons: [] } }), "High risk"), true);
  assert.equal(matchesFilter(D({ risk: { score: 10, band: "low", reasons: [] } }), "High risk"), false);
  assert.equal(matchesFilter(D(), "High risk"), false);
});

test("My swarm = source swarm; External = everything else", () => {
  assert.equal(matchesFilter(D({ source: "swarm" }), "My swarm"), true);
  assert.equal(matchesFilter(D({ source: "github-pr" }), "My swarm"), false);
  assert.equal(matchesFilter(D({ source: "github-pr" }), "External"), true);
  assert.equal(matchesFilter(D({ source: "claude-code" }), "External"), true);
  assert.equal(matchesFilter(D({ source: "swarm" }), "External"), false);
});

test("Failures = a Delivery with no changed paths (P4 failure-delivery shape)", () => {
  assert.equal(matchesFilter(D({ changedPaths: [], diffFiles: 0 }), "Failures"), true);
  assert.equal(matchesFilter(D(), "Failures"), false);
});

test("an unknown filter string never hides anything (fail open, never blank)", () => {
  assert.equal(matchesFilter(D(), "Nonsense" as never), true);
});

// ── badge math ───────────────────────────────────────────────────────────────
test("badge math counts only pending", () => {
  assert.equal(pendingCount([D(), D({ status: "approved" }), D({ status: "rejected" }), D()]), 2);
  assert.equal(pendingCount([]), 0);
});

test("isPending is false for every terminal status", () => {
  for (const s of ["approved", "rejected", "changes_requested", "auto_approved"] as const) {
    assert.equal(isPending(D({ status: s })), false);
  }
  assert.equal(isPending(D()), true);
});

// ── honest risk rendering (P6/ADR-053 owns the real bands) ───────────────────
test("null risk band renders 'unrated', never an invented band", () => {
  assert.equal(riskLabel(null), "unrated");
  assert.equal(riskTone(null), "muted");
});

test("risk labels + tones for the three real bands", () => {
  assert.equal(riskLabel("high"), "high risk");
  assert.equal(riskTone("high"), "red");
  assert.equal(riskLabel("medium"), "medium");
  assert.equal(riskTone("medium"), "amber");
  assert.equal(riskLabel("low"), "low risk");
  assert.equal(riskTone("low"), "green");
});

// ── diffstat ─────────────────────────────────────────────────────────────────
test("diffstat label is singular/plural correct and uses real numbers", () => {
  assert.deepEqual(diffstatLabel(D()), { files: "1 file", add: "+10", del: "−2" });
  assert.deepEqual(diffstatLabel(D({ diffstat: { files: 3, additions: 0, deletions: 0 } })), {
    files: "3 files",
    add: "+0",
    del: "−0",
  });
  assert.deepEqual(diffstatLabel(D({ diffstat: { files: 0, additions: 0, deletions: 0 } })), {
    files: "no files",
    add: "+0",
    del: "−0",
  });
});

// ── routes ───────────────────────────────────────────────────────────────────
test("decidePath maps verbs to the P2 routes and url-encodes the id", () => {
  assert.equal(decidePath("01J1", "approve"), "/inbox/01J1/approve");
  assert.equal(decidePath("01J1", "reject"), "/inbox/01J1/reject");
  assert.equal(decidePath("01J1", "request_changes"), "/inbox/01J1/request-changes");
  assert.equal(decidePath("a/b", "approve"), "/inbox/a%2Fb/approve");
});

test("listQuery builds a clamped, encoded query string", () => {
  assert.equal(listQuery({}), "/inbox");
  assert.equal(listQuery({ status: "pending" }), "/inbox?status=pending");
  assert.equal(listQuery({ status: "pending", limit: 20 }), "/inbox?status=pending&limit=20");
  assert.equal(listQuery({ agentId: "a b" }), "/inbox?agentId=a%20b");
  // server clamps to [1,200]; the client never sends something the server will silently reshape
  assert.equal(listQuery({ limit: 9999 }), "/inbox?limit=200");
  assert.equal(listQuery({ limit: 0 }), "/inbox?limit=1");
});

// ── typed-APPLY gate (P6 wires the band; the GATE must already work) ────────
test("the confirmation literal is APPLY", () => {
  assert.equal(TYPED_CONFIRM, "APPLY");
});

test("high risk locks Approve until APPLY is typed exactly", () => {
  assert.equal(isApproveBlocked("high", ""), true);
  assert.equal(isApproveBlocked("high", "app"), true);
  assert.equal(isApproveBlocked("high", "apply"), true, "case-sensitive on purpose");
  assert.equal(isApproveBlocked("high", "APPLY "), true, "trailing space is not the literal");
  assert.equal(isApproveBlocked("high", " APPLY"), true, "leading space is not the literal");
  assert.equal(isApproveBlocked("high", "APPLY"), false);
});

test("every non-high band (including the P2-era null) leaves Approve unlocked", () => {
  for (const b of ["low", "medium", null] as const) {
    assert.equal(isApproveBlocked(b, ""), false);
  }
});

// ── presentational helpers ───────────────────────────────────────────────────
test("avatarFor derives up to 2 uppercase initials from an agent id", () => {
  assert.equal(avatarFor("senior-web-1"), "S1");
  assert.equal(avatarFor("ceo"), "CE");
  assert.equal(avatarFor("cursor-agent"), "CA");
  assert.equal(avatarFor(""), "??");
});

test("decidedLabel names each terminal status in the operator's words", () => {
  assert.equal(decidedLabel("approved"), "approved · applied");
  assert.equal(decidedLabel("rejected"), "rejected");
  assert.equal(decidedLabel("changes_requested"), "changes requested");
  assert.equal(decidedLabel("auto_approved"), "auto-approved");
  assert.equal(decidedLabel("pending"), "pending");
});

// ── P4: failure Deliveries ──────────────────────────────────────────────────
test("P4 the Failures filter matches a kind==='failure' Delivery", () => {
  const d = D({ kind: "failure", changedPaths: [], diffstat: { files: 0, additions: 0, deletions: 0 } });
  assert.equal(matchesFilter(d, "Failures"), true);
  assert.equal(matchesFilter(d, "All"), true);
});

test("P4 the Failures filter still matches any diff-less Delivery", () => {
  assert.equal(matchesFilter(D({ changedPaths: [] }), "Failures"), true);
});

test("P4 the Failures filter does NOT match a normal code Delivery", () => {
  assert.equal(matchesFilter(D({ kind: "code", changedPaths: ["a.ts"] }), "Failures"), false);
});

test("P4 a failure Delivery is still 'My swarm' (the runtime minted it)", () => {
  assert.equal(matchesFilter(D({ kind: "failure", changedPaths: [], source: "swarm" }), "My swarm"), true);
});

test("P4 isFailure identifies the failure row", () => {
  assert.equal(isFailure(D({ kind: "failure", changedPaths: [] })), true);
  assert.equal(isFailure(D({ kind: "code", changedPaths: [] })), true, "diff-less fallback for pre-P4 rows");
  assert.equal(isFailure(D({ kind: "code", changedPaths: ["a.ts"] })), false);
});

test("P4 diffstatLabel reads honestly on a failure row", () => {
  const l = diffstatLabel(D({ kind: "failure", changedPaths: [], diffstat: { files: 0, additions: 0, deletions: 0 } }));
  assert.equal(l.files, "no files");
});

// ── P7: source identity + read-only + external filter (ADR-054) ──────────────
import {
  sourceLabel,
  sourceTone,
  isReadOnly,
  isReadOnlySource,
  adapterStateTone,
  ADAPTER_STATE_LABEL,
} from "../inboxClient.ts";

test("P7 sourceLabel + sourceTone map each source to its own identity", () => {
  assert.equal(sourceLabel("github-pr"), "GitHub PR");
  assert.equal(sourceLabel("claude-code"), "Claude Code");
  assert.equal(sourceLabel("swarm"), "swarm");
  assert.equal(sourceTone("github-pr"), "brass");
  assert.equal(sourceTone("claude-code"), "grey");
  assert.equal(sourceTone("swarm"), "muted");
});

test("P7 claude-code is read-only; github-pr and swarm are not", () => {
  assert.equal(isReadOnlySource("claude-code"), true);
  assert.equal(isReadOnlySource("github-pr"), false);
  assert.equal(isReadOnly(D({ source: "claude-code" })), true);
  assert.equal(isReadOnly(D({ source: "github-pr" })), false);
  assert.equal(isReadOnly(D({ source: "swarm" })), false);
});

test("P7 the External filter matches BOTH github-pr and claude-code, not swarm", () => {
  assert.equal(matchesFilter(D({ source: "github-pr" }), "External"), true);
  assert.equal(matchesFilter(D({ source: "claude-code" }), "External"), true);
  assert.equal(matchesFilter(D({ source: "swarm" }), "External"), false);
  assert.equal(matchesFilter(D({ source: "github-pr" }), "My swarm"), false);
});

test("P7 adapter status tones + labels", () => {
  assert.equal(adapterStateTone("running"), "green");
  assert.equal(adapterStateTone("gh-not-authed"), "amber");
  assert.equal(adapterStateTone("error"), "red");
  assert.equal(adapterStateTone("disabled"), "muted");
  assert.equal(ADAPTER_STATE_LABEL["gh-not-authed"], "gh not authenticated");
});

// ── The typed-confirm gate must match the field that renders it ──────────────────
//
// Found by driving the live product: a `design-approval` gate is banded HIGH by the risk
// router, and ReviewPane renders the typed-confirm input only when `isHigh && !failure &&
// !gate` — but computed `approveBlocked` from the band ALONE. So on a high-band GATE the
// Approve button sat permanently disabled with a tooltip telling the operator to type
// APPLY into a field that was not on the page. The story sat at `waiting-you` and the only
// way through was curl. The render condition is the specification; the disabled state had
// drifted from it, so the predicate now takes the same inputs.
//
// A gate is diff-less by construction (mintGate writes 0 files), which is exactly why its
// author exempted it: the typed confirmation exists to slow down a high-risk APPLY, and
// approving a gate applies nothing.
test("isApproveBlocked: a high-risk DIFF still demands the typed confirmation", () => {
  assert.equal(isApproveBlocked("high", ""), true);
  assert.equal(isApproveBlocked("high", "nope"), true, "a wrong word is not a confirmation");
  assert.equal(isApproveBlocked("high", TYPED_CONFIRM), false);
  assert.equal(isApproveBlocked("medium", ""), false);
  assert.equal(isApproveBlocked("low", ""), false);
});

test("isApproveBlocked: a high-band DESIGN gate is approvable — it writes nothing", () => {
  assert.equal(isApproveBlocked("high", "", { designGate: true }), false);
  assert.equal(isApproveBlocked("high", "", { failure: true }), false);
  // …and the diff case is unchanged by the option object being absent.
  assert.equal(isApproveBlocked("high", "", {}), true);
});

test("isApproveBlocked: a RELEASE gate KEEPS the confirmation — approving it deploys", () => {
  // The dead-end fix must not become a licence to remove friction from the one gate whose
  // approval has a consequence outside the repo. A release gate is diff-less too, and that
  // is exactly why reasoning from "carries no diff" alone would have been wrong.
  assert.equal(isApproveBlocked("high", "", {}), true);
  assert.equal(isApproveBlocked("high", TYPED_CONFIRM, {}), false);
});

test("needsTypedConfirm: the field's condition, and it does not vanish once the word is typed", () => {
  assert.equal(needsTypedConfirm("high", {}), true, "a high-risk diff always shows the field");
  assert.equal(needsTypedConfirm("high", { designGate: true }), false);
  assert.equal(needsTypedConfirm("high", { failure: true }), false);
  assert.equal(needsTypedConfirm("medium", {}), false);
  // The field stays rendered after the word is typed; only the BUTTON changes state.
  assert.equal(needsTypedConfirm("high", {}), true);
  assert.equal(isApproveBlocked("high", TYPED_CONFIRM, {}), false);
});
