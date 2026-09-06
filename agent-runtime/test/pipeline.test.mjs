// Story-Pipeline S2 — the STAGE DRIVER (pipeline.mjs), proven pure over the real stores with
// a DETERMINISTIC injected dispatch (no live model), exactly the way engine.test.mjs proves
// the loop engine. Pins the S2 contract:
//   • requirements → clarify questions → question gates + waiting-you + NO advance
//   • answer all → re-run requirements → spec → advance into design → design-approval gate
//   • requirements with no questions → auto-advance straight into the design gate
//   • design approve → advance to plan; request-changes → re-run design + fresh gate
//   • idempotent re-entry: no double dispatch / double mint
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

// Deterministic dispatch: requirements raises ONE question until it has an answered one, then
// yields a spec; design always yields a design doc. `askOnce:false` makes requirements yield a
// spec immediately (the no-questions path).
function makeDispatch(calls, { ask = true } = {}) {
  return async (ctx) => {
    calls.push({ stage: ctx.stage, agentId: ctx.agentId, feedback: ctx.feedback, answered: ctx.answers.questions.filter((q) => q && q.a).length });
    if (ctx.stage === "requirements") {
      const answered = ctx.answers.questions.filter((q) => q && q.a);
      if (ask && !answered.length) {
        return { text: `# Requirements draft — ${ctx.story.title}`, questions: ["Which flow ships first?"] };
      }
      return { text: `# Requirement spec — ${ctx.story.title}\n\nresolved: ${answered.length}`, questions: [] };
    }
    if (ctx.stage === "design") {
      return { text: `# Design — ${ctx.story.title}${ctx.feedback ? `\n\nnotes: ${ctx.feedback}` : ""}`, questions: [] };
    }
    if (ctx.stage === "plan") {
      return {
        text: `# Plan — ${ctx.story.title}`,
        plan: [
          { seat: "sr-backend", steps: ["build backend", "test backend"] },
          { seat: "sr-frontend", steps: ["build ui"] },
          { seat: "ceo", steps: ["seize control"] }, // a DISALLOWED seat — must be dropped
        ],
      };
    }
    return { text: `# ${ctx.stage}`, questions: [] };
  };
}

function harness(over = {}) {
  const root = mkdtempSync(join(tmpdir(), "ma-pipeline-"));
  const h = openDb({ path: join(root, "data", "mission.db"), patchesDir: join(root, "patches") });
  const emitted = [];
  const events = { emit: (e, p) => emitted.push([e, p]) };
  const stories = createStories({ db: h.db, scrub, emit: (n, d) => events.emit(n, d) });
  const vault = createVault({ db: h, root: join(root, "vault"), events, scrub });
  vault.createVenture({ id: "waahyu", name: "Waahyu" });
  let pipeline;
  const deliveries = createDeliveries({
    db: h, events, scrub,
    // Route every committed gate decision back to the pipeline, exactly as the server wires it.
    onDecided: (row, info) => { if (pipeline) pipeline.onGateDecided(row, info); },
  });
  const calls = [];
  const dispatchFn = over.dispatchFn || makeDispatch(calls, over);
  // S3 — a fake goal enqueuer captures what the tech-lead decompose would spawn (seat + steps +
  // storyId), the same shape engine.enqueueGoal returns. Only wired when a test asks for it.
  const goals = [];
  const enqueueGoal = over.enqueueGoal === null ? undefined
    : (over.enqueueGoal || ((args) => { const goalId = `goal_${goals.length}`; goals.push({ goalId, ...args }); return { goalId, firstTaskId: `task_${goals.length}` }; }));
  // S16 — the appliable scope is INJECTED (server.mjs passes guards.SEED_DIRS). The harness
  // states it explicitly so the file-scope header under test is the repo's real one.
  pipeline = createPipeline({ stories, deliveries, vault, dispatchFn, scrub, vaultVenture: "waahyu", enqueueGoal, seedDirs: ["src", "public", "agent-runtime", "docs"] });
  const cleanup = () => { h.close(); rmSync(root, { recursive: true, force: true }); };
  return { root, h, stories, deliveries, vault, pipeline, emitted, calls, goals, cleanup };
}

// Create a story and walk it to `requirements` (idea → requirements), the pipeline entry.
function storyInRequirements(t, title = "Add referral bonus", idea = "reward inviters") {
  const s = t.stories.createStory({ title, idea });
  t.stories.advance(s.id, {}); // idea → requirements
  return s.id;
}

// ── requirements with questions ──────────────────────────────────────────────
test("requirements with clarify questions mints question gates, parks waiting-you, does not advance", async () => {
  const t = harness();
  try {
    const id = storyInRequirements(t);
    const r = await t.pipeline.enterStage(id, "requirements");
    assert.equal(r.status, "waiting-you");
    assert.equal(r.questions.length, 1);
    const story = t.stories.getStory(id);
    assert.equal(story.stage, "requirements", "no advance while a question is open");
    assert.equal(story.status, "waiting-you");
    assert.ok(story.spec && story.spec.startsWith("vault:"), "requirement draft landed a spec ref");
    const gates = t.deliveries.listGates(id, "question");
    assert.equal(gates.length, 1);
    assert.equal(gates[0].kind, "question");
    assert.equal(gates[0].storyId, id, "gate carries the story back-pointer");
    assert.equal(gates[0].risk.band, "high", "a gate surfaces high (needs-you)");
    assert.equal(gates[0].diffstat.files, 0, "diff-less");
  } finally { t.cleanup(); }
});

// ── answer the question → re-run → advance into design ───────────────────────
test("answering every question re-runs requirements, advances into design, and lands a design gate", async () => {
  const t = harness();
  try {
    const id = storyInRequirements(t);
    await t.pipeline.enterStage(id, "requirements");
    const qGate = t.deliveries.listGates(id, "question")[0];

    const ans = await t.pipeline.answerQuestion(id, { deliveryId: qGate.id, answer: "the checkout flow", by: "boss" });
    assert.equal(ans.status, "active");
    assert.equal(ans.remaining, 0);

    const story = t.stories.getStory(id);
    assert.equal(story.stage, "design", "auto-advanced past requirements once the spec was clean");
    assert.equal(story.status, "waiting-you", "parked on the design gate");
    assert.ok(story.designRef && story.designRef.startsWith("vault:"));
    assert.equal(t.deliveries.listGates(id, "question").length, 0, "the question gate is resolved");
    const design = t.deliveries.listGates(id, "design-approval");
    assert.equal(design.length, 1, "a design-approval gate is pending");
    // The re-run pm-analyst saw the answer (proving answers feed forward).
    const rerunCall = t.calls.find((c) => c.stage === "requirements" && c.answered === 1);
    assert.ok(rerunCall, "requirements re-ran with the answer in context");
  } finally { t.cleanup(); }
});

// ── bad answer inputs ─────────────────────────────────────────────────────────
test("answer rejects an unknown delivery (404), an empty answer (400), and the wrong story state (409)", async () => {
  const t = harness();
  try {
    const id = storyInRequirements(t);
    await t.pipeline.enterStage(id, "requirements");
    const qGate = t.deliveries.listGates(id, "question")[0];

    assert.equal((await t.pipeline.answerQuestion(id, { deliveryId: "nope", answer: "x" })).code, 404);
    assert.equal((await t.pipeline.answerQuestion(id, { deliveryId: qGate.id, answer: "   " })).code, 400);
    assert.equal((await t.pipeline.answerQuestion("story_missing", { deliveryId: qGate.id, answer: "x" })).code, 404);

    // Once resolved, a second answer to the same gate is a generic 404 (never re-reflected).
    await t.pipeline.answerQuestion(id, { deliveryId: qGate.id, answer: "the checkout flow" });
    assert.equal((await t.pipeline.answerQuestion(id, { deliveryId: qGate.id, answer: "again" })).code, 409, "story left requirements — no question awaits");
  } finally { t.cleanup(); }
});

// ── S3: design approve → tech-lead decompose → per-seat goals → advance to build ─────
test("approving the design gate decomposes the plan into per-seat goals and advances into build", async () => {
  const t = harness();
  try {
    const id = storyInRequirements(t);
    await t.pipeline.enterStage(id, "requirements");
    const qGate = t.deliveries.listGates(id, "question")[0];
    await t.pipeline.answerQuestion(id, { deliveryId: qGate.id, answer: "checkout" });
    const dGate = t.deliveries.listGates(id, "design-approval")[0];

    const out = await t.deliveries.decide(dGate.id, "approve", { by: "boss" });
    assert.equal(out.status, "approved");
    // onGateDecided awaits the decompose; give the floating promise a tick to settle.
    await new Promise((r) => setTimeout(r, 20));

    const story = t.stories.getStory(id);
    assert.equal(story.stage, "build", "decompose advanced the story from plan into build");
    assert.equal(story.status, "active");

    // One engine goal per ALLOWED seat, tagged with the storyId; the disallowed 'ceo' is dropped.
    assert.equal(t.goals.length, 2, "one goal per allowed seat (ceo dropped)");
    const seats = t.goals.map((g) => g.agentId).sort();
    assert.deepEqual(seats, ["sr-backend", "sr-frontend"]);
    assert.ok(t.goals.every((g) => g.storyId === id), "every goal carries the storyId");
    const backend = t.goals.find((g) => g.agentId === "sr-backend");
    assert.equal(backend.steps.length, 2, "the seat's steps are threaded");
    assert.ok(backend.steps[0].includes("file-scope"), "step 0 carries a file-scope hint");
    // S16 REGRESSION. The header used to be invented per seat and named `services/**` — a
    // directory of a different repo, absent here and outside SEED_DIRS. Live, that header was
    // stamped onto a step whose own text said "CREATE new file src/lib/buildHealth.ts", so the
    // seat was handed two contradictory scopes by its own harness.
    assert.ok(!backend.steps[0].includes("services"), "no invented services/** scope");
    assert.ok(backend.steps[0].includes("src/**"), "step 0 names the real appliable roots");
    assert.ok(backend.steps[0].includes("agent-runtime/**"), "the widened scope is included");
    // The scope is a property of the REPO, not the seat: both seats are told the same thing.
    const frontend = t.goals.find((g) => g.agentId === "sr-frontend");
    const header = (s0) => s0.slice(0, s0.indexOf("]") + 1);
    assert.equal(header(backend.steps[0]), header(frontend.steps[0]), "one scope for every seat");

    // A plan artifact landed in the vault + the story log (event plan-drafted).
    const log = t.stories.getLog(id);
    assert.ok(log.some((r) => r.event === "plan-drafted"), "plan-drafted logged");
  } finally { t.cleanup(); }
});

// ── S3: a degenerate decompose (no valid seats) parks at plan, spawns nothing ─────────
test("a decompose with no allowed seats parks the story at plan and spawns no goals", async () => {
  const dispatchFn = async (ctx) => {
    if (ctx.stage === "requirements") return { text: "# spec", questions: [] };
    if (ctx.stage === "design") return { text: "# design", questions: [] };
    if (ctx.stage === "plan") return { text: "# plan", plan: [{ seat: "ceo", steps: ["hack"] }] };
    return { text: "#", questions: [] };
  };
  const t = harness({ dispatchFn });
  try {
    const id = storyInRequirements(t);
    await t.pipeline.enterStage(id, "requirements"); // no questions → design gate
    const dGate = t.deliveries.listGates(id, "design-approval")[0];
    await t.deliveries.decide(dGate.id, "approve", { by: "boss" });
    await new Promise((r) => setTimeout(r, 20));
    const story = t.stories.getStory(id);
    assert.equal(story.stage, "plan", "no valid goals → stays at plan, no dead build");
    assert.equal(t.goals.length, 0, "nothing spawned");
  } finally { t.cleanup(); }
});

// ── S3: plan stage is inert without an enqueueGoal seam (pre-S3 harness behaviour) ────
test("without an enqueueGoal seam the plan stage is a clean no-op (story stays at plan)", async () => {
  const t = harness({ enqueueGoal: null });
  try {
    const id = storyInRequirements(t);
    await t.pipeline.enterStage(id, "requirements");
    const qGate = t.deliveries.listGates(id, "question")[0];
    await t.pipeline.answerQuestion(id, { deliveryId: qGate.id, answer: "checkout" });
    const dGate = t.deliveries.listGates(id, "design-approval")[0];
    await t.deliveries.decide(dGate.id, "approve", { by: "boss" });
    await new Promise((r) => setTimeout(r, 20));
    const story = t.stories.getStory(id);
    assert.equal(story.stage, "plan", "no engine wired → story simply rests at plan");
  } finally { t.cleanup(); }
});

// ── design request-changes → re-run + fresh gate ─────────────────────────────
test("requesting changes on the design gate re-runs design with feedback and lands a fresh gate", async () => {
  const t = harness();
  try {
    const id = storyInRequirements(t);
    await t.pipeline.enterStage(id, "requirements");
    const qGate = t.deliveries.listGates(id, "question")[0];
    await t.pipeline.answerQuestion(id, { deliveryId: qGate.id, answer: "checkout" });
    const dGate1 = t.deliveries.listGates(id, "design-approval")[0];

    await t.deliveries.decide(dGate1.id, "request_changes", { by: "boss", feedback: "use a queue, not a cron" });
    // onGateDecided re-runs design asynchronously; give the microtask a tick.
    await new Promise((r) => setTimeout(r, 20));

    const story = t.stories.getStory(id);
    assert.equal(story.stage, "design", "stays on design during rework");
    assert.equal(story.status, "waiting-you");
    const gates = t.deliveries.listGates(id, "design-approval");
    assert.equal(gates.length, 1, "exactly one pending design gate (the old one is decided)");
    assert.notEqual(gates[0].id, dGate1.id, "a fresh gate, not the decided one");
    const rerun = t.calls.find((c) => c.stage === "design" && c.feedback && c.feedback.includes("queue"));
    assert.ok(rerun, "design re-ran with the feedback in context");
  } finally { t.cleanup(); }
});

// ── no-question requirements → auto-advance straight into design ─────────────
test("requirements with no questions advances straight into the design gate", async () => {
  const t = harness({ ask: false });
  try {
    const id = storyInRequirements(t);
    const r = await t.pipeline.enterStage(id, "requirements");
    assert.equal(r.status, "waiting-you");
    const story = t.stories.getStory(id);
    assert.equal(story.stage, "design", "auto-advanced with no clarify round");
    assert.ok(story.spec && story.spec.startsWith("vault:"));
    assert.equal(t.deliveries.listGates(id, "design-approval").length, 1);
  } finally { t.cleanup(); }
});

// ── idempotency ───────────────────────────────────────────────────────────────
test("re-entering a stage with an open gate does not double-dispatch or double-mint", async () => {
  const t = harness();
  try {
    const id = storyInRequirements(t);
    await t.pipeline.enterStage(id, "requirements");
    const before = t.calls.length;
    const again = await t.pipeline.enterStage(id, "requirements");
    assert.equal(again.deduped, true);
    assert.equal(t.calls.length, before, "no second dispatch");
    assert.equal(t.deliveries.listGates(id, "question").length, 1, "no second question gate");
  } finally { t.cleanup(); }
});

test("onStageEntered no-ops for a stage the pipeline does not drive", async () => {
  const t = harness();
  try {
    const id = storyInRequirements(t);
    const r = await t.pipeline.onStageEntered(id, "plan");
    assert.equal(r.skipped, true);
    assert.equal(t.calls.length, 0);
  } finally { t.cleanup(); }
});

// ── artifact scrub (prompt-injection surface — a secret never lands at rest) ──
test("a secret in an agent artifact is scrubbed before it reaches the vault or a gate", async () => {
  const dispatchFn = async (ctx) => ({
    text: `# Design leaking sk-ant-ABCDEFGH123456 here`,
    questions: ctx.stage === "requirements" ? [] : undefined,
  });
  const t = harness({ dispatchFn });
  try {
    const id = storyInRequirements(t);
    await t.pipeline.enterStage(id, "requirements"); // no questions → advances into design
    const dGate = t.deliveries.listGates(id, "design-approval")[0];
    assert.ok(dGate, "design gate minted");
    assert.ok(!dGate.summary.includes("sk-ant-"), "gate body scrubbed at rest");
    assert.ok(!dGate.title.includes("sk-ant-"));
  } finally { t.cleanup(); }
});
