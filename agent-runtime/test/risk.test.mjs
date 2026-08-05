// ADR-053 — risk classifier. Pure, deterministic, table-driven. No DB, no HTTP.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, bandForPath, detectNewDependency, BANDS, LARGE_DIFF_LINES } from "../risk.mjs";

const band = (paths, over = {}) => classify({ changedPaths: paths, ...over }).band;

// ── the classification matrix (≥25 cases) ────────────────────────────────────
const MATRIX = [
  // path                                   expected band   note
  [["src/pages/Home.tsx"], "medium", "plain src → medium"],
  [["services/order/main.py"], "medium", "services → medium"],
  [["src/lib/util.ts", "src/lib/helper.ts"], "medium", "multiple src → medium"],
  [["tests/unit/foo.test.ts"], "low", "tests dir → low"],
  [["src/lib/foo.test.ts"], "low", "test file suffix → low"],
  [["docs/guide.md"], "low", "docs → low"],
  [["README.md"], "low", "readme → low"],
  [["CHANGELOG.md"], "low", "changelog → low"],
  [["LICENSE"], "low", "license → low"],
  [["src/notes.md"], "low", "markdown in src → low"],
  [[".env"], "high", ".env → high"],
  [[".env.production"], "high", ".env.* → high"],
  [["config/secrets/db.json"], "high", "secrets path → high"],
  [["deploy/tls/server.key"], "high", "key material → high"],
  [["src/auth/login.ts"], "high", "auth surface → high"],
  [["services/payments/charge.py"], "high", "payment surface → high"],
  [["infrastructure/main.tf"], "high", "terraform → high"],
  [["Dockerfile"], "high", "Dockerfile → high"],
  [["docker-compose.yml"], "high", "compose → high"],
  [[".github/workflows/ci.yml"], "high", ".github CI → high"],
  [["cloudbuild.yaml"], "high", "cloudbuild → high"],
  [["services/order/migrations/001_init.sql"], "high", "migration → high"],
  [[".github/workflows/deploy.md"], "high", "high beats low (.github .md)"],
  [["src/app.ts", ".env"], "high", "one high path lifts the whole set"],
  [["docs/a.md", "tests/b.test.ts", "README.md"], "low", "all-low stays low"],
  [["src/x.ts", "docs/y.md"], "medium", "med + low → medium (max wins)"],
];

for (const [paths, expected, note] of MATRIX) {
  test(`classify: ${note}`, () => {
    assert.equal(band(paths), expected, `${JSON.stringify(paths)} → ${expected}`);
  });
}

// ── band → score envelope agreement ──────────────────────────────────────────
test("score always sits inside its band's envelope", () => {
  const cases = [
    [["README.md"], "low", 5, 39],
    [["src/x.ts"], "medium", 40, 69],
    [[".env"], "high", 70, 100],
  ];
  for (const [paths, b, lo, hi] of cases) {
    const r = classify({ changedPaths: paths });
    assert.equal(r.band, b);
    assert.ok(r.score >= lo && r.score <= hi, `${b} score ${r.score} in [${lo},${hi}]`);
  }
});

// ── kind='failure' has its own band ──────────────────────────────────────────
test("kind='failure' → high regardless of paths", () => {
  const r = classify({ changedPaths: [], kind: "failure" });
  assert.equal(r.band, "high");
  assert.match(r.reasons.join(" "), /agent failure/);
});

// ── S2/S5 human-gate kinds have their own (needs-you) band ───────────────────
test("kind='question', 'design-approval' and 'release-approval' → high (needs your decision), regardless of paths", () => {
  for (const kind of ["question", "design-approval", "release-approval"]) {
    const r = classify({ changedPaths: [], kind });
    assert.equal(r.band, "high", `${kind} → high`);
    assert.match(r.reasons.join(" "), /needs your decision/);
  }
});

// ── new-dependency detector floors at medium ─────────────────────────────────
test("new dependency lifts low → medium", () => {
  const r = classify({ changedPaths: ["docs/a.md"], newDependency: true });
  assert.equal(r.band, "medium");
  assert.match(r.reasons.join(" "), /new dependency/);
});

test("detectNewDependency: package.json new key = true, version bump = false", () => {
  const added = detectNewDependency([{ path: "package.json", before: '{"dependencies":{"a":"1.0.0"}}', after: '{"dependencies":{"a":"1.0.0","b":"2.0.0"}}' }]);
  assert.equal(added, true);
  const bumped = detectNewDependency([{ path: "package.json", before: '{"dependencies":{"a":"1.0.0"}}', after: '{"dependencies":{"a":"1.1.0"}}' }]);
  assert.equal(bumped, false);
});

test("detectNewDependency: unparseable package.json fails toward true", () => {
  assert.equal(detectNewDependency([{ path: "package.json", before: "{", after: "not json" }]), true);
});

test("detectNewDependency: requirements.txt added line = true", () => {
  assert.equal(detectNewDependency([{ path: "requirements.txt", before: "flask==2.0\n", after: "flask==2.0\nredis==4.0\n" }]), true);
  assert.equal(detectNewDependency([{ path: "go.mod", before: "module x\n", after: "module x\n" }]), false);
});

// ── diff-size bump ───────────────────────────────────────────────────────────
test("a large diff bumps the band up one step", () => {
  const small = classify({ changedPaths: ["src/x.ts"], additions: 3, deletions: 1 });
  assert.equal(small.band, "medium");
  const big = classify({ changedPaths: ["src/x.ts"], additions: LARGE_DIFF_LINES + 1, deletions: 0 });
  assert.equal(big.band, "high", "big src diff → high");
  assert.match(big.reasons.join(" "), /large diff/);
});

test("large diff never pushes past high", () => {
  const r = classify({ changedPaths: [".env"], additions: 9999, deletions: 9999 });
  assert.equal(r.band, "high");
});

// ── determinism ──────────────────────────────────────────────────────────────
test("classify is deterministic for the same input", () => {
  const input = { changedPaths: ["src/a.ts", "src/b.ts"], additions: 10, deletions: 2, kind: "code" };
  assert.deepEqual(classify(input), classify(input));
});

test("bandForPath returns null for a plain medium path", () => {
  assert.equal(bandForPath("src/whatever.ts"), null);
  assert.equal(bandForPath(".env").band, "high");
  assert.equal(bandForPath("docs/x.md").band, "low");
});

test("BANDS ordering is low<medium<high", () => {
  assert.deepEqual(BANDS, ["low", "medium", "high"]);
});
