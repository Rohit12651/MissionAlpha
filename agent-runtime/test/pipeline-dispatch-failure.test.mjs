// SESSION 14 — the stage driver must NEVER launder a FAILED dispatch into an artifact.
//
// THE BUG THIS FILE EXISTS FOR (observed live, 2026-08-23): with the Claude CLI's OAuth
// expired, `claude -p` writes its auth error to stdout as the `result` string, sets
// `is_error:true`, and EXITS 0. pipelineDispatch resolved with that error text, and
// enterStage — which had no notion of a failed dispatch, only of a thrown one — wrote
// "Failed to authenticate. API Error: 401 …" into the Vault as the REQUIREMENT SPEC,
// stamped it on story.spec, auto-advanced into design, ran design against the same dead
// engine, and minted a design-approval GATE asking a human to approve an auth error.
//
// Two stories reached a human decision surface carrying a 99-character auth error as
// their entire engineering artifact. Nothing anywhere said a word.
//
// The contract these tests pin:
//   • ok:false            → the stage FAILS. No artifact, no advance, no gate.
//   • empty text          → the stage FAILS. An empty artifact is not an artifact.
//   • ok ABSENT           → SUCCESS, byte-identically to pre-fix. (Session 13b cost 17
//                           tests by making an absent value mean "refuse"; an optional
//                           signal must default to the historical behaviour.)
//   • a failure is VISIBLE — one diff-less Delivery naming the reason — and DEDUPED, so a
//     wedged stage cannot mint a row per retry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../db.mjs";
import { createStories } from "../stories.mjs";
import { createDeliveries } from "../deliveries.mjs";
import { createVault } from "../vault.mjs";
import { createPipeline } from "../pipeline.mjs";

const SECRET_RE = /sk-ant-[A-Za-z0-9_-]{6,}/g;
const scrub = (s) => (typeof s === "string" ? s.replace(SECRET_RE, "[redacted-secret]") : s);

// The EXACT string the live CLI returned on this machine, and the exact result frame
// shape it rode in on. Recorded verbatim so a future reader can see what was being
// written into the Vault as an engineering document.
const REAL_OAUTH_ERROR =
  "Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.";

function harness(dispatchFn) {
  const root = mkdtempSync(join(tmpdir(), "ma-pipefail-"));
  const h = openDb({ path: join(root, "data", "mission.db"), patchesDir: join(root, "patches") });
  const emitted = [];
  const events = { emit: (e, p) => emitted.push([e, p]) };
  const stories = createStories({ db: h.db, scrub, emit: (n, d) => events.emit(n, d) });
  const vault = createVault({ db: h, root: join(root, "vault"), events, scrub });
  vault.createVenture({ id: "waahyu", name: "Waahyu" });
  let pipeline;
  const deliveries = createDeliveries({
    db: h, events, scrub,
    onDecided: (row, info) => { if (pipeline) pipeline.onGateDecided(row, info); },
  });
  pipeline = createPipeline({ stories, deliveries, vault, dispatchFn, scrub, vaultVenture: "waahyu" });
  const cleanup = () => { h.close(); rmSync(root, { recursive: true, force: true }); };
  return { root, h, stories, deliveries, vault, pipeline, emitted, cleanup };
}

function storyInRequirements(t, title = "Dark mode toggle", idea = "Add dark theme switch") {
  const s = t.stories.createStory({ title, idea });
  t.stories.advance(s.id, {}); // idea → requirements
  return s.id;
}

// ── FAIL-1 — the exact live failure: a refused dispatch never becomes a spec ──
test("FAIL-1: a failed dispatch does not land an artifact, advance, or mint a gate", async () => {
  const t = harness(async () => ({ ok: false, error: REAL_OAUTH_ERROR, text: REAL_OAUTH_ERROR }));
  try {
    const id = storyInRequirements(t);
    const r = await t.pipeline.enterStage(id, "requirements");

    assert.equal(r.failed, true, "the stage reports failure to its caller");
    assert.match(String(r.error), /OAuth access token has expired/, "the reason is carried, not swallowed");

    const story = t.stories.getStory(id);
    assert.equal(story.stage, "requirements", "a failed stage NEVER advances");
    assert.equal(story.status, "blocked", "the story is parked blocked, not left silently active");
    assert.equal(story.spec, null, "the auth error was NOT stamped as the requirement spec");
    assert.equal(story.designRef, null, "design never ran");

    assert.equal(t.deliveries.listGates(id, "design-approval").length, 0, "no human was asked to approve an auth error");
    assert.equal(t.deliveries.listGates(id, "question").length, 0, "no question gate either");
  } finally { t.cleanup(); }
});

// ── FAIL-2 — the failure is VISIBLE, and it names the cause ──────────────────
test("FAIL-2: a failed stage mints exactly one diff-less failure Delivery naming the reason", async () => {
  const t = harness(async () => ({ ok: false, error: REAL_OAUTH_ERROR }));
  try {
    const id = storyInRequirements(t);
    await t.pipeline.enterStage(id, "requirements");

    const rows = t.deliveries.list({}).filter((d) => d.kind === "failure");
    assert.equal(rows.length, 1, "exactly one failure row");
    const row = rows[0];
    assert.equal(row.diffstat.files, 0, "diff-less — Law 3: an approve of this can carry no paths");
    const full = t.deliveries.get(row.id);
    const hay = `${full.title} ${full.summary || ""} ${full.body || ""}`;
    assert.match(hay, /OAuth access token has expired/, "the operator is told WHY, not just that something broke");
  } finally { t.cleanup(); }
});

// ── FAIL-3 — a wedged stage cannot mint a row per retry ──────────────────────
test("FAIL-3: re-entering a failed stage does not mint a second failure row", async () => {
  let calls = 0;
  const t = harness(async () => { calls++; return { ok: false, error: REAL_OAUTH_ERROR }; });
  try {
    const id = storyInRequirements(t);
    await t.pipeline.enterStage(id, "requirements");
    await t.pipeline.enterStage(id, "requirements");
    await t.pipeline.enterStage(id, "requirements");
    assert.equal(calls, 3, "PRECONDITION: the dispatch really was attempted three times");
    const rows = t.deliveries.list({}).filter((d) => d.kind === "failure");
    assert.equal(rows.length, 1, "three failures, one row — not a row per retry");
  } finally { t.cleanup(); }
});

// ── FAIL-4 — nothing reaches the Vault ───────────────────────────────────────
test("FAIL-4: a failed stage writes NO vault artifact", async () => {
  const t = harness(async () => ({ ok: false, error: REAL_OAUTH_ERROR, text: REAL_OAUTH_ERROR }));
  try {
    const id = storyInRequirements(t);
    await t.pipeline.enterStage(id, "requirements");
    // The stable per-(stage,story) record id the driver would have written.
    const rid = `req-${id.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`.slice(0, 64);
    const rec = t.vault.getRecord ? t.vault.getRecord(rid) : null;
    assert.ok(!rec, "the auth error never became a Vault record");
    // Belt and braces: no vault.written frame for this story at all.
    const wrote = t.emitted.filter(([n]) => n === "vault.written");
    assert.equal(wrote.length, 0, "no artifact was announced");
  } finally { t.cleanup(); }
});

// ── FAIL-5 — an EMPTY artifact is a failure, not an empty document ───────────
test("FAIL-5: a dispatch that returns empty text fails the stage instead of landing an empty spec", async () => {
  const t = harness(async () => ({ text: "", questions: [] }));
  try {
    const id = storyInRequirements(t);
    const r = await t.pipeline.enterStage(id, "requirements");
    assert.equal(r.failed, true, "an empty artifact is not an artifact");
    const story = t.stories.getStory(id);
    assert.equal(story.stage, "requirements", "no advance on an empty document");
    assert.equal(story.spec, null, "no empty spec ref stamped");
  } finally { t.cleanup(); }
});

// ── FAIL-6 — REGRESSION: an ABSENT `ok` still means success ──────────────────
// Session 13b's lesson, encoded. Every existing caller and every existing test returns
// { text, questions } with no `ok` field. If absent read as "failed", the whole pipeline
// would refuse to run and dozens of green tests would go red for a reason unrelated to
// what they test. An optional failure signal MUST default to the historical behaviour.
test("FAIL-6: a dispatch with NO ok field is treated as success (unchanged behaviour)", async () => {
  const t = harness(async (ctx) => ({ text: `# Requirement spec — ${ctx.story.title}`, questions: [] }));
  try {
    const id = storyInRequirements(t);
    const r = await t.pipeline.enterStage(id, "requirements");
    assert.notEqual(r.failed, true, "no `ok` field must NOT be read as a failure");
    const story = t.stories.getStory(id);
    assert.equal(story.stage, "design", "the story advanced exactly as it always did");
    assert.ok(story.spec && story.spec.startsWith("vault:"), "the spec landed");
    assert.equal(t.deliveries.listGates(id, "design-approval").length, 1, "the design gate minted as before");
  } finally { t.cleanup(); }
});

// ── FAIL-7 — an explicit ok:true is honoured ─────────────────────────────────
test("FAIL-7: an explicit ok:true dispatch advances normally", async () => {
  const t = harness(async (ctx) => ({ ok: true, text: `# Spec — ${ctx.story.title}`, questions: [] }));
  try {
    const id = storyInRequirements(t);
    await t.pipeline.enterStage(id, "requirements");
    assert.equal(t.stories.getStory(id).stage, "design");
  } finally { t.cleanup(); }
});

// ── FAIL-8 — a failure at DESIGN leaves the approved requirements intact ─────
// The blast radius of a dead engine must be one stage, never a rollback of earlier work.
test("FAIL-8: a design-stage failure keeps the requirement spec and parks at design", async () => {
  let stage = 0;
  const t = harness(async (ctx) => {
    stage++;
    if (ctx.stage === "requirements") return { text: "# Real spec", questions: [] };
    return { ok: false, error: REAL_OAUTH_ERROR };
  });
  try {
    const id = storyInRequirements(t);
    await t.pipeline.enterStage(id, "requirements"); // succeeds, advances, then design fails
    assert.ok(stage >= 2, "PRECONDITION: design really was attempted");
    const story = t.stories.getStory(id);
    assert.equal(story.stage, "design", "parked at the stage that failed");
    assert.equal(story.status, "blocked");
    assert.ok(story.spec && story.spec.startsWith("vault:"), "the GOOD requirement spec survives");
    assert.equal(story.designRef, null, "no design ref from a failed design");
    assert.equal(t.deliveries.listGates(id, "design-approval").length, 0, "no gate on a failed design");
  } finally { t.cleanup(); }
});
