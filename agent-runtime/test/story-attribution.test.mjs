// SESSION 14 (option A) — WHO handed WHAT to WHOM, recorded rather than inferred.
//
// story_log has carried `by_agent` / `to_agent` since the Phase-3 handback work, and the
// wire projection already emits them when present. They were populated ONLY for rejects;
// every FORWARD transition left them null. So the operator's Timeline could say
// "plan-drafted" but never "tech-lead handed the plan to sr-backend".
//
// The tempting fix was to infer the seat in the UI from a stage→agent lookup table. This
// session was about a system that reported things which were not true, so: record it.
//
// The load-bearing rule here is the one session 13b paid 17 tests for — an OPTIONAL signal
// must default to the historical behaviour. `advance()` / `update()` called WITHOUT
// attribution must be byte-identical to before, which ATTR-3 pins.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../db.mjs";
import { createStories } from "../stories.mjs";

const SECRET_RE = /sk-ant-[A-Za-z0-9_-]{6,}/g;
const scrub = (s) => (typeof s === "string" ? s.replace(SECRET_RE, "[redacted-secret]") : s);

function harness() {
  const root = mkdtempSync(join(tmpdir(), "ma-attr-"));
  const h = openDb({ path: join(root, "data", "mission.db"), patchesDir: join(root, "patches") });
  const stories = createStories({ db: h.db, scrub, emit: () => {} });
  return { stories, cleanup: () => { h.close(); rmSync(root, { recursive: true, force: true }); } };
}

const lastLog = (stories, id) => stories.getLog(id).slice(-1)[0];

// ── ATTR-1 — a forward advance records the handoff ───────────────────────────
test("ATTR-1: advance records byAgent and toAgent on the transition row", () => {
  const t = harness();
  try {
    const s = t.stories.createStory({ title: "Dark mode", idea: "toggle" });
    t.stories.advance(s.id, { event: "requirements-drafted", ref: "vault:req-1", byAgent: "pm-analyst", toAgent: "architect" });
    const row = lastLog(t.stories, s.id);
    assert.equal(row.event, "requirements-drafted");
    assert.equal(row.byAgent, "pm-analyst", "who did the work");
    assert.equal(row.toAgent, "architect", "who picks it up next");
  } finally { t.cleanup(); }
});

// ── ATTR-2 — an artifact landing (update) records its author ─────────────────
test("ATTR-2: update records byAgent on the row it appends", () => {
  const t = harness();
  try {
    const s = t.stories.createStory({ title: "CSV export", idea: "export orders" });
    t.stories.update(s.id, { event: "design-drafted", ref: "vault:design-1", byAgent: "architect" });
    const row = lastLog(t.stories, s.id);
    assert.equal(row.event, "design-drafted");
    assert.equal(row.byAgent, "architect");
  } finally { t.cleanup(); }
});

// ── ATTR-3 — REGRESSION: no attribution ⇒ exactly today's behaviour ──────────
test("ATTR-3: advance/update WITHOUT attribution stay byte-identical (no null noise)", () => {
  const t = harness();
  try {
    const s = t.stories.createStory({ title: "Push", idea: "notify" });
    t.stories.advance(s.id, { event: "advance", ref: "vault:x" });
    t.stories.update(s.id, { event: "plain-update" });
    for (const row of t.stories.getLog(s.id)) {
      assert.ok(!("byAgent" in row), "an unattributed row must not carry a byAgent key at all");
      assert.ok(!("toAgent" in row), "…nor a toAgent key — the UI must not render 'null → null'");
    }
  } finally { t.cleanup(); }
});

// ── ATTR-4 — attribution is bounded and scrubbed at rest ────────────────────
test("ATTR-4: a hostile or oversized agent id is capped and scrubbed, never stored raw", () => {
  const t = harness();
  try {
    const s = t.stories.createStory({ title: "Bounds", idea: "check" });
    const huge = "a".repeat(500);
    t.stories.advance(s.id, { event: "advance", byAgent: huge, toAgent: "sk-ant-deadbeefcafe" });
    const row = lastLog(t.stories, s.id);
    assert.ok(row.byAgent.length <= 64, `agent id capped, got ${row.byAgent.length}`);
    assert.ok(!/sk-ant-deadbeefcafe/.test(row.toAgent), "a secret-shaped id is scrubbed at rest");
  } finally { t.cleanup(); }
});

// ── ATTR-5 — the handback path still works (nothing regressed) ──────────────
test("ATTR-5: reject still records its own byAgent/toAgent/evidence", () => {
  const t = harness();
  try {
    const s = t.stories.createStory({ title: "Rework", idea: "bounce" });
    t.stories.advance(s.id, {}); // idea → requirements
    t.stories.reject(s.id, { toStage: "idea", reason: "needs rethink", byAgent: "architect", toAgent: "pm-analyst", evidence: ["spec is ambiguous"] });
    const row = lastLog(t.stories, s.id);
    assert.equal(row.byAgent, "architect");
    assert.equal(row.toAgent, "pm-analyst");
    assert.deepEqual(row.evidence, ["spec is ambiguous"]);
  } finally { t.cleanup(); }
});
