// SESSION 14 (option A) — the stage driver records the seat that actually ran.
//
// Pins that the ATTRIBUTION on a forward transition comes from the DRIVER (which knows
// which agent it dispatched) rather than from a lookup table in the UI. If the driver ever
// dispatches a seat other than the stage's nominal owner, the thread shows the seat that
// ran — not the one a table says should have.
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

const scrub = (s) => s;

function harness(dispatchFn) {
  const root = mkdtempSync(join(tmpdir(), "ma-pipeattr-"));
  const h = openDb({ path: join(root, "data", "mission.db"), patchesDir: join(root, "patches") });
  const events = { emit: () => {} };
  const stories = createStories({ db: h.db, scrub, emit: () => {} });
  const vault = createVault({ db: h, root: join(root, "vault"), events, scrub });
  vault.createVenture({ id: "waahyu", name: "Waahyu" });
  let pipeline;
  const deliveries = createDeliveries({ db: h, events, scrub, onDecided: (r, i) => pipeline?.onGateDecided(r, i) });
  const goals = [];
  pipeline = createPipeline({
    stories, deliveries, vault, dispatchFn, scrub, vaultVenture: "waahyu",
    enqueueGoal: (a) => { const goalId = `goal_${goals.length}`; goals.push({ goalId, ...a }); return { goalId, firstTaskId: `t${goals.length}` }; },
  });
  return { stories, deliveries, vault, pipeline, goals, cleanup: () => { h.close(); rmSync(root, { recursive: true, force: true }); } };
}

const rowFor = (stories, id, event) => stories.getLog(id).find((r) => r.event === event);

// ── PATTR-1 — requirements → design carries both ends of the handoff ─────────
test("PATTR-1: the requirements handoff names pm-analyst and the architect who receives it", async () => {
  const t = harness(async (ctx) => ({ text: `# ${ctx.stage} artifact`, questions: [] }));
  try {
    const s = t.stories.createStory({ title: "Dark mode", idea: "toggle" });
    // NOTE: a bare advance() logs event "advance" — the SAME name the pipeline's own
    // requirements→design advance uses. A .find() on "advance" then matches THIS setup row
    // and the assertion passes/fails for the wrong reason. Name it so the two are distinct.
    t.stories.advance(s.id, { event: "start" }); // idea → requirements
    await t.pipeline.enterStage(s.id, "requirements");

    const drafted = rowFor(t.stories, s.id, "requirements-drafted");
    assert.ok(drafted, "PRECONDITION: the requirements artifact landed");
    assert.equal(drafted.byAgent, "pm-analyst", "the seat that produced the spec");

    const adv = t.stories.getLog(s.id).find((r) => r.event === "advance");
    assert.ok(adv, "PRECONDITION: it advanced");
    assert.equal(adv.byAgent, "pm-analyst", "who handed it on");
    assert.equal(adv.toAgent, "architect", "who picks it up");
  } finally { t.cleanup(); }
});

// ── PATTR-2 — the design artifact names the architect ───────────────────────
test("PATTR-2: the design artifact row names the architect", async () => {
  const t = harness(async (ctx) => ({ text: `# ${ctx.stage} artifact`, questions: [] }));
  try {
    const s = t.stories.createStory({ title: "CSV", idea: "export" });
    t.stories.advance(s.id, {});
    await t.pipeline.enterStage(s.id, "requirements"); // cascades into design
    const d = rowFor(t.stories, s.id, "design-drafted");
    assert.ok(d, "PRECONDITION: design ran");
    assert.equal(d.byAgent, "architect");
  } finally { t.cleanup(); }
});

// ── PATTR-3 — a FAILED stage still names who was trying ────────────────────
test("PATTR-3: a failed stage records the seat that could not deliver", async () => {
  const t = harness(async () => ({ ok: false, error: "engine unreachable" }));
  try {
    const s = t.stories.createStory({ title: "Broken", idea: "dead engine" });
    t.stories.advance(s.id, {});
    await t.pipeline.enterStage(s.id, "requirements");
    const f = rowFor(t.stories, s.id, "requirements-failed");
    assert.ok(f, "PRECONDITION: the failure was logged");
    assert.equal(f.byAgent, "pm-analyst", "the operator can see WHICH seat is stuck");
  } finally { t.cleanup(); }
});
