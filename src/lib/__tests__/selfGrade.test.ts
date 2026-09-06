// Phase 3 (UI) — R9 metaharness self-grade in the cockpit.
//
// The runtime has graded its own configuration since session 7 and emitted
// `selfgrade.changed` since session 8. Nothing rendered either. A posture score nobody
// sees cannot influence a decision, which makes it decoration.
//
// The load-bearing group is CAUSE-*. The module's own lesson, learned the hard way when it
// scored a healthy install 46/D on a phantom finding: a number that moves without a named
// cause is noise, and a grader that cries wolf trains the operator to ignore it. So the
// tile never shows a delta on its own — a delta is only ever rendered next to what caused it.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  gradeTone,
  deltaDirection,
  topFinding,
  partialCoverage,
  type SelfGrade,
} from "../selfGrade.ts";

const grade = (over: Partial<SelfGrade> = {}): SelfGrade => ({
  score: 96,
  grade: "A",
  findings: [{ id: "no-encryption-at-rest", severity: "low", detail: "plaintext on disk", fix: "Enable it." }],
  checked: ["policy", "quality", "stationPerms", "mcpGrants", "hooks", "encryption"],
  worst: "low",
  ...over,
});

test("TONE-1: the grade letter drives tone, not the raw score", () => {
  assert.equal(gradeTone(grade({ grade: "A" })), "ok");
  assert.equal(gradeTone(grade({ grade: "B" })), "ok");
  assert.equal(gradeTone(grade({ grade: "C" })), "warn");
  assert.equal(gradeTone(grade({ grade: "D" })), "error");
  assert.equal(gradeTone(grade({ grade: "F" })), "error");
});

test("TONE-2: an absent or malformed grade is toneless, never a default pass", () => {
  for (const bad of [null, undefined, {}, { grade: "Z" }]) {
    assert.equal(gradeTone(bad as unknown as SelfGrade), "none", `${JSON.stringify(bad)}`);
  }
});

test("CAUSE-1: a delta with NO named cause is not rendered", () => {
  // The whole point of diffGrades is that a score which moved reports WHY. A bare arrow is
  // the noise this module's own header refuses.
  assert.equal(deltaDirection({ delta: -4, appeared: [], cleared: [] }), null);
});

test("CAUSE-2: a drop with a named cause renders DOWN", () => {
  const d = deltaDirection({ delta: -20, appeared: ["medium-auto-approve"], cleared: [] });
  assert.equal(d?.direction, "down");
  assert.equal(d?.tone, "error");
  assert.equal(d?.cause, "medium-auto-approve");
});

test("CAUSE-3: a recovery with a cleared finding renders UP", () => {
  const d = deltaDirection({ delta: 20, appeared: [], cleared: ["medium-auto-approve"] });
  assert.equal(d?.direction, "up");
  assert.equal(d?.tone, "ok");
  assert.equal(d?.cause, "medium-auto-approve");
});

test("CAUSE-4: zero delta renders nothing even when findings churned", () => {
  assert.equal(deltaDirection({ delta: 0, appeared: ["a"], cleared: ["b"] }), null);
});

test("CAUSE-5: an absent frame renders nothing", () => {
  assert.equal(deltaDirection(null), null);
  assert.equal(deltaDirection(undefined), null);
  assert.equal(deltaDirection({} as never), null);
});

test("FINDING-1: the worst finding is first — grade() already sorts by severity weight", () => {
  const g = grade({
    findings: [
      { id: "high-auto-approve", severity: "critical", detail: "worst", fix: "f" },
      { id: "no-encryption-at-rest", severity: "low", detail: "least", fix: "f" },
    ],
  });
  assert.equal(topFinding(g)?.id, "high-auto-approve");
});

test("FINDING-2: a clean grade has no top finding", () => {
  assert.equal(topFinding(grade({ findings: [] })), null);
  assert.equal(topFinding(null), null);
});

test("PARTIAL-1: an ungraded section is REPORTED, never scored as clean", () => {
  // The design detail that paid off immediately: factory/policy.json is empty on this
  // install, so `policy` was not graded — and the report said so instead of counting an
  // ungraded section as passing. A partial surface must not read as a clean bill of health.
  const p = partialCoverage(grade({ checked: ["quality", "hooks"] }));
  assert.ok(p);
  assert.ok(p.includes("2"), `expected the graded count in: ${p}`);
});

test("PARTIAL-2: full coverage reports nothing — silence is the correct render", () => {
  assert.equal(partialCoverage(grade()), null);
});

test("PARTIAL-3: a malformed grade never throws", () => {
  assert.equal(partialCoverage(null), null);
  assert.equal(partialCoverage({ checked: "nope" } as unknown as SelfGrade), null);
});
