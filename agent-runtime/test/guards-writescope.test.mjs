// Phase 7 · task 7.2 — writeScope enforced in guards.applyAllowed, per the TASK's seat.
//
// THIS IS THE REAL CONTROL. `--allowed-tools` (task 7.3) shapes what a model is offered;
// THIS decides what can land on the operator's tree. Every assertion below is about a
// boolean returned by the predicate, never about source text.
//
// THE ONE INVARIANT THAT MATTERS MOST — writeScope SUBTRACTS, NEVER ADDS:
//   ∀ path, ∀ seat:  applyAllowed(path, {seat}) ⟹ applyAllowed(path)
// WS-SUBSET below proves it over a corpus that includes every CORE_GUARD file, the
// APPLY_DENY shapes, traversal, and out-of-seed paths. If a future edit ever lets a seat
// widen the floor, that test goes red before anything ships.
import { test } from "node:test";
import assert from "node:assert/strict";

import { applyAllowed, CORE_GUARD, SEED_DIRS } from "../guards.mjs";
import { createRoster, coreGuardProbePaths } from "../roster.mjs";

const seedFile = new URL("../roster.json", import.meta.url).pathname;
const SKILLS = new Set(["repo-read", "research-brief", "ui", "api", "db", "test", "notifications"]);
const roster = createRoster({ file: seedFile, validSkills: SKILLS, seedDirs: SEED_DIRS });

// The REAL seats. pipeline.mjs ALLOWED_PLAN_SEATS is {sr-backend, sr-frontend} and the qa
// stage dispatches `qa`, so these are the three ids the narrowing can actually reach.
const FRONTEND = roster.get("sr-frontend");
const QA = roster.get("qa");
const BACKEND = roster.get("sr-backend");
const MANAGER = roster.get("tech-lead");

// A corpus wide enough that "it subtracts" is a claim about behaviour, not a wish.
const CORPUS = [
  "src/components/X.tsx", "src/components/x.css", "src/lib/x.ts", "src/lib/__tests__/x.test.ts",
  "src/index.css", "public/logo.svg", "public/index.html", "public/evil.mjs",
  "agent-runtime/engine.mjs", "agent-runtime/db.mjs", "agent-runtime/migrations/001.sql",
  "docs/notes.md", "README.md", "package.json",
  "node_modules/x/index.js", "../escape.ts", "/etc/passwd", ".env", ".env.local",
  "agent-runtime/.env.local", "agent-runtime/data/mission.db", "agent-runtime/roster.json",
  ...coreGuardProbePaths(),
];

// ── the seat narrowing ───────────────────────────────────────────────────────
test("WS-1: sr-frontend owns src/** and is refused everything outside it", () => {
  assert.equal(applyAllowed("src/components/X.tsx", { seat: FRONTEND }), true);
  assert.equal(applyAllowed("src/components/x.css", { seat: FRONTEND }), true);
  assert.equal(applyAllowed("agent-runtime/engine.mjs", { seat: FRONTEND }), false,
    "the runtime is sr-backend's; the frontend seat must be refused there");
  assert.equal(applyAllowed("docs/notes.md", { seat: FRONTEND }), false);
  assert.equal(applyAllowed("public/logo.svg", { seat: FRONTEND }), false);
});

test("WS-2: qa may write tests and NOT product code", () => {
  assert.equal(applyAllowed("src/lib/__tests__/foo.test.ts", { seat: QA }), true);
  assert.equal(applyAllowed("agent-runtime/test/x.test.mjs", { seat: QA }), true);
  assert.equal(applyAllowed("src/lib/foo.ts", { seat: QA }), false);
});

test("WS-3: sr-backend may write src/lib and agent-runtime, not the component tree", () => {
  assert.equal(applyAllowed("src/lib/x.ts", { seat: BACKEND }), true);
  assert.equal(applyAllowed("agent-runtime/engine.mjs", { seat: BACKEND }), true);
  assert.equal(applyAllowed("src/components/X.tsx", { seat: BACKEND }), false);
});

test("WS-4: a worker with an EMPTY writeScope writes nothing at all", () => {
  const noScope = { ...FRONTEND, writeScope: [] };
  for (const p of CORPUS) {
    assert.equal(applyAllowed(p, { seat: noScope }), false, `empty scope must refuse ${p}`);
  }
});

// ── the floor still wins, for every seat ─────────────────────────────────────
test("WS-5: CORE_GUARD refuses every guarded path for EVERY seat", () => {
  for (const seat of [FRONTEND, QA, BACKEND, MANAGER, null, undefined]) {
    for (const p of coreGuardProbePaths()) {
      assert.equal(applyAllowed(p, { seat }), false,
        `${p} must be refused for seat ${seat?.id ?? "(none)"}`);
    }
  }
});

test("WS-6: roster.json is CORE_GUARD — the roster can never edit the roster", () => {
  assert.equal(CORE_GUARD.test("agent-runtime/roster.json"), true,
    "roster.json must be in CORE_GUARD: it decides what every seat may write");
  for (const seat of [FRONTEND, BACKEND, MANAGER, null]) {
    assert.equal(applyAllowed("agent-runtime/roster.json", { seat }), false);
  }
});

test("WS-7: sr-backend holds agent-runtime/** and is STILL refused guards.mjs", () => {
  assert.ok(BACKEND.writeScope.includes("agent-runtime/**"), "premise: the glob really does span it");
  assert.equal(applyAllowed("agent-runtime/guards.mjs", { seat: BACKEND }), false,
    "the floor is checked BEFORE writeScope — a broad glob cannot reach a guarded file");
});

// ── THE LEGACY RULE ──────────────────────────────────────────────────────────
test("WS-8: single-argument applyAllowed is byte-for-byte today's behaviour", () => {
  // pr.mjs, patch-edit.mjs and policy.mjs all call it this way and must not change.
  assert.equal(applyAllowed("src/a.ts"), true);
  assert.equal(applyAllowed("src/lib/x.ts"), true);
  assert.equal(applyAllowed("agent-runtime/engine.mjs"), true);
  assert.equal(applyAllowed("agent-runtime/guards.mjs"), false);
  assert.equal(applyAllowed("node_modules/x/i.js"), false);
  assert.equal(applyAllowed("../escape.ts"), false);
});

test("WS-9: an absent / unresolvable seat behaves exactly like the single-arg call", () => {
  for (const opts of [undefined, {}, { seat: null }, { seat: undefined }]) {
    for (const p of CORPUS) {
      assert.equal(applyAllowed(p, opts), applyAllowed(p),
        `opts=${JSON.stringify(opts)} must not change the verdict for ${p}`);
    }
  }
});

test("WS-10: a NON-WORKER seat does not narrow — station/factory agents are unaffected", () => {
  // Manager/HR/CEO and any factory agent enqueued via POST /runtime/engine/enqueue keep
  // today's scope. Narrowing applies ONLY to role:"worker".
  for (const seat of [MANAGER, roster.get("ceo"), roster.get("reviewer"), roster.get("sre")]) {
    for (const p of CORPUS) {
      assert.equal(applyAllowed(p, { seat }), applyAllowed(p),
        `role ${seat.role} must not be narrowed (${p})`);
    }
  }
});

test("WS-11: a seat-shaped object with an unknown role does not narrow either", () => {
  const odd = { id: "x", name: "X", seat: "x", role: "wizard", skills: [], writeScope: [], tools: [] };
  for (const p of CORPUS) assert.equal(applyAllowed(p, { seat: odd }), applyAllowed(p));
});

// ── the invariant ────────────────────────────────────────────────────────────
test("WS-SUBSET: writeScope can only ever SUBTRACT — no seat widens the floor", () => {
  const seats = [FRONTEND, QA, BACKEND, MANAGER, roster.get("ceo"), roster.get("reviewer"),
    { ...FRONTEND, writeScope: ["**"] }, { ...FRONTEND, writeScope: ["**/*"] }];
  for (const seat of seats) {
    for (const p of CORPUS) {
      if (applyAllowed(p, { seat })) {
        assert.equal(applyAllowed(p), true,
          `seat ${seat.id} WIDENED the floor at ${p} — writeScope must only subtract`);
      }
    }
  }
});
