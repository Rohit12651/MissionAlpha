// Phase 6 / 6.5 — "an explicit tier is never overridden".
//
// LIVE FAILURE 2026-09-02: a story-build task was enqueued at tier `sonnet` (pipeline.mjs
// passes it explicitly). Its brief is four sentences; the THIRD one says "Add a short JSDoc
// comment." That matched CHEAP_INTENTS `add-comment`, classifyTier returned tier 1, and
// server.mjs downgraded the spawn to `haiku`. The requested model was not the model that ran.
//
// TWO independent causes, and BOTH are fixed here:
//
//   (1) THE ROUTER COULD NOT SEE THE REQUEST. classifyTier took only the task text, so an
//       explicit choice had nothing to say. It now takes { requestedTier } and returns it
//       BEFORE any regex runs.
//
//   (2) THE INTENT TABLE READ A PARAGRAPH AS AN INSTRUCTION. The intent rows are written for
//       a one-line ask ("add a jsdoc comment to foo"). Run against a multi-sentence brief they
//       match on a SUBORDINATE clause and classify the whole task by it. The intent regexes
//       now run ONLY on a single line of ≤140 chars. FORCE_FULL is NOT gated that way — a
//       sensitive-domain row must keep firing at every length, because its job is to refuse,
//       never to cheapen.
//
// Cause (1) alone would have left every brief that MENTIONS a comment mis-tiered whenever the
// caller omitted a tier; cause (2) alone would have left the router free to override a human.
//
// The engine half is here too: `tier` has defaulted to "sonnet" in enqueueGoal since ADR-024,
// which makes an explicit "sonnet" byte-identical to an omitted one on the wire. `requestedTier`
// is the missing distinction — the caller's value, or null. server.mjs is the third half and is
// NOT touched by this task (see the contract in the delivery report).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyTier, modelForTier, CHEAP_INTENTS, TIERS } from "../router-tier.mjs";
import { createQueue } from "../queue.mjs";
import { createEngine } from "../engine.mjs";

// The brief from the incident, VERBATIM. Four sentences, multi-line, >140 chars.
const INCIDENT_BRIEF = [
  "Create src/lib/clamp.ts exporting a single named function `clamp(n: number, min: number, max: number): number`.",
  "Rules: if min > max, swap them; if n is NaN return min; otherwise return Math.min(max, Math.max(min, n)).",
  "Add a short JSDoc comment.",
  "No default export, no other exports, no imports.",
].join("\n");

// ── the premise (PES addendum #9: prove the probe before believing the result) ──────────
// If this ever stops holding, every assertion below is testing nothing.

test("PREMISE: the brief really does match the `add-comment` cheap row — that IS the defect", () => {
  const row = CHEAP_INTENTS.find((r) => r.intent === "add-comment");
  assert.ok(row, "the add-comment row still exists");
  assert.ok(row.re.test(INCIDENT_BRIEF), "the regex still matches the brief; only the GATE changed");
  assert.ok(INCIDENT_BRIEF.includes("\n"), "the brief is multi-line");
  assert.ok(INCIDENT_BRIEF.length > 140, `brief is ${INCIDENT_BRIEF.length} chars`);
});

// ── (1) an explicit tier wins, before any regex ─────────────────────────────────────────

test("EXPLICIT-1: the incident brief requested at `sonnet` routes to sonnet, not haiku", () => {
  const r = classifyTier(INCIDENT_BRIEF, { requestedTier: "sonnet" });
  assert.equal(r.tier, TIERS.FULL);
  assert.equal(modelForTier(r.tier), "sonnet", "the requested model is the model that runs");
  assert.equal(r.requestedTier, "sonnet", "the NAME is echoed back — a caller never re-derives it");
  assert.equal(r.intent, null, "no intent was consulted");
  assert.equal(r.reason, "explicit tier requested");
});

test("EXPLICIT-2: an explicit tier wins DOWNWARD too — the router never second-guesses a human", () => {
  const r = classifyTier(INCIDENT_BRIEF, { requestedTier: "haiku" });
  assert.equal(r.tier, TIERS.CHEAP);
  assert.equal(r.requestedTier, "haiku");
});

test("EXPLICIT-3: `opus` is a valid tier name; it is never cheap and the NAME survives", () => {
  const r = classifyTier("add a jsdoc comment to foo", { requestedTier: "opus" });
  assert.equal(r.tier, TIERS.FULL, "opus is at least full-model");
  assert.equal(r.requestedTier, "opus", "modelForTier(FULL) is 'sonnet' — the caller MUST use this field");
});

test("EXPLICIT-4: an INVALID or absent requestedTier falls through to normal classification", () => {
  for (const bad of [null, undefined, "", "gpt-5", "SONNET", 42, {}, [], "toString", "constructor", "__proto__"]) {
    const r = classifyTier("add a jsdoc comment to foo", { requestedTier: bad });
    assert.equal(r.tier, TIERS.CHEAP, `requestedTier=${JSON.stringify(bad)} must NOT short-circuit`);
    assert.equal(r.intent, "add-comment");
  }
  assert.equal(classifyTier("add a jsdoc comment to foo").tier, TIERS.CHEAP, "no options object at all");
  assert.equal(classifyTier("add a jsdoc comment to foo", null).tier, TIERS.CHEAP, "null options object");
});

// ── (2) the intent tables only read a one-line ask ──────────────────────────────────────

test("ONELINE-1: with NO requested tier the same brief is FULL — a paragraph is not an intent", () => {
  const r = classifyTier(INCIDENT_BRIEF);
  assert.equal(r.tier, TIERS.FULL, "multi-line ⇒ the intent regexes never run");
  assert.equal(r.intent, null);
  assert.doesNotMatch(r.reason, /mechanical intent/, "must NOT be reasoned as add-comment");
});

test("ONELINE-2: a genuine one-line ask is still cheap — the fix did not disable tier 1", () => {
  const r = classifyTier("add a jsdoc comment to foo");
  assert.equal(r.tier, TIERS.CHEAP);
  assert.equal(r.intent, "add-comment");
  assert.equal(modelForTier(r.tier), "haiku");
});

test("ONELINE-3: a one-line ask LONGER than 140 chars is full — the bound is real", () => {
  const short = "add a jsdoc comment to foo";
  const long = `${short} ${"x".repeat(141 - short.length)}`;
  assert.equal(long.length, 142);
  assert.equal(classifyTier(short).tier, TIERS.CHEAP);
  assert.equal(classifyTier(long).tier, TIERS.FULL, "141+ chars ⇒ not a one-line ask");
  assert.equal(classifyTier(`${short} ${"x".repeat(140 - short.length - 1)}`).tier, TIERS.CHEAP, "exactly 140 is still cheap");
});

test("ONELINE-4: surrounding whitespace/newlines do not smuggle a one-liner past the gate", () => {
  assert.equal(classifyTier("  add a jsdoc comment to foo\n").tier, TIERS.CHEAP, "trailing newline is trimmed away");
  assert.equal(classifyTier("do the thing\nadd a jsdoc comment to foo").tier, TIERS.FULL, "two REAL lines");
  assert.equal(classifyTier("do the thing\radd a jsdoc comment to foo").tier, TIERS.FULL, "a bare CR is a line break too");
});

test("ONELINE-5: the tier-0 codemod table is gated the same way (a codemod runs UNATTENDED)", () => {
  assert.equal(classifyTier("remove all console.log statements from the utils file").tier, TIERS.CODEMOD);
  assert.equal(
    classifyTier("Rewrite the reporting pipeline end to end.\nRemove all console.log statements from the utils file.").tier,
    TIERS.FULL,
    "a paragraph must never authorise an unattended AST rewrite",
  );
});

// ── FORCE_FULL is NOT gated by length ───────────────────────────────────────────────────

test("SENSITIVE-1: a sensitive one-liner is FULL by the sensitive-domain row, not by luck", () => {
  const r = classifyTier("rotate the auth token secret");
  assert.equal(r.tier, TIERS.FULL);
  assert.match(r.reason, /sensitive-domain/);
});

test("SENSITIVE-2: a sensitive row fires on a LONG multi-line brief too", () => {
  const r = classifyTier(`${INCIDENT_BRIEF}\nWhile you are there, refresh the auth token handling.`);
  assert.equal(r.tier, TIERS.FULL);
  assert.match(r.reason, /sensitive-domain/, "FORCE_FULL must not be silenced by the one-line gate");
});

test("SENSITIVE-3: the sensitive-domain FLOOR clamps an explicit CHEAP request up to FULL", () => {
  // Closed in the orchestrator pass of Phase 6: an explicit tier may RAISE the model, never
  // lower it below the FORCE_FULL floor. A haiku request on an auth task gets FULL, and the
  // reason names both facts so the operator sees why their request was not honoured.
  const r = classifyTier("rotate the auth token secret", { requestedTier: "haiku" });
  assert.equal(r.tier, TIERS.FULL, "sensitive floor wins over an explicit cheap request");
  assert.match(r.reason, /sensitive-domain/);
  assert.match(r.reason, /explicit 'haiku' raised/);
  assert.equal(r.requestedTier, "haiku", "the request is still recorded");
});

test("SENSITIVE-4: an explicit tier at or above the floor is honoured on a sensitive task", () => {
  const r = classifyTier("rotate the auth token secret", { requestedTier: "opus" });
  assert.equal(r.tier, TIERS.FULL);
  assert.equal(r.reason, "explicit tier requested");
  assert.equal(r.requestedTier, "opus");
});

// ── the engine half: requestedTier is the caller's value, or null ───────────────────────

let root;
const buildEngine = () => {
  root = mkdtempSync(join(tmpdir(), "ma-tier-"));
  const queue = createQueue({ dir: join(root, "store"), maxPerAgent: 4 });
  const goalsDir = join(root, "store", "goals");
  const engine = createEngine({ queue, scheduler: { tick() {} }, goalsDir, now: () => 1_700_000_000_000 });
  return { engine, queue, goalsDir };
};
const cleanup = () => { try { rmSync(root, { recursive: true, force: true }); } catch { /* */ } };

test("ENGINE-1: an EXPLICIT tier is recorded as requestedTier on the plan and the task", (t) => {
  t.after(cleanup);
  const { engine, queue, goalsDir } = buildEngine();
  const r = engine.enqueueGoal({ agentId: "senior-web-1", tier: "sonnet", steps: [INCIDENT_BRIEF] });
  const task = queue.get(r.firstTaskId);
  assert.equal(task.requestedTier, "sonnet", "the caller asked for sonnet and the record says so");
  assert.equal(task.tier, "sonnet", "the legacy field is unchanged (backward compatible)");
  const plan = JSON.parse(readFileSync(join(goalsDir, `${r.goalId}.json`), "utf-8"));
  assert.equal(plan.requestedTier, "sonnet", "persisted in the goal JSON — survives a restart");
});

test("ENGINE-2: an OMITTED tier records requestedTier null — distinct from the default", (t) => {
  t.after(cleanup);
  const { engine, queue, goalsDir } = buildEngine();
  const r = engine.enqueueGoal({ agentId: "senior-web-1", steps: ["do the thing"] });
  const task = queue.get(r.firstTaskId);
  assert.equal(task.requestedTier, null, "nobody chose — null, NOT 'sonnet'");
  assert.equal(task.tier, "sonnet", "the DEFAULT_TIER fallback still fills `tier`");
  assert.equal(JSON.parse(readFileSync(join(goalsDir, `${r.goalId}.json`), "utf-8")).requestedTier, null);
});

test("ENGINE-3: the value is PERSISTED on disk, not just in the index", (t) => {
  t.after(cleanup);
  const { engine, queue } = buildEngine();
  const r = engine.enqueueGoal({ agentId: "a", tier: "haiku", steps: ["s"] });
  const onDisk = JSON.parse(readFileSync(join(root, "store", "tasks", `${r.firstTaskId}.json`), "utf-8"));
  assert.equal(onDisk.requestedTier, "haiku", "a restart rebuilds the index from THIS file");
  assert.equal(queue.get(r.firstTaskId).requestedTier, "haiku");
});

test("ENGINE-4: an unknown tier name is recorded as null, never echoed onto the record", (t) => {
  t.after(cleanup);
  const { engine, queue } = buildEngine();
  for (const bad of ["gpt-5", "", 42, {}, "  sonnet  "]) {
    const r = engine.enqueueGoal({ agentId: "a", tier: bad, steps: [`step ${JSON.stringify(bad)}`] });
    assert.equal(queue.get(r.firstTaskId).requestedTier, null, `tier=${JSON.stringify(bad)} is not a request`);
  }
});

test("ENGINE-5: every CHAINED step carries requestedTier too — not just step 0", (t) => {
  t.after(cleanup);
  const { engine, queue } = buildEngine();
  const r = engine.enqueueGoal({ agentId: "a", tier: "sonnet", steps: ["step one", "step two"] });
  // Drive the chain the way the approve path does: step 0 held → operator applied → step 1.
  queue.update(r.firstTaskId, { status: "held" });
  engine.onOperatorApplied(r.firstTaskId);
  const step1 = queue.all().find((x) => (x.stepIndex ?? 0) === 1);
  assert.ok(step1, "step 1 was enqueued");
  assert.equal(step1.requestedTier, "sonnet", "the chained step must not lose the request");
});
