// ADR-053 — per-band policy (P6). factory/policy.json routing, deny-list precedence,
// fail-closed on a bad file, SLA windows. Pure + file-level; no HTTP.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createBandPolicy, DEFAULT_SLA_MS } from "../policy.mjs";

function withFile(contents) {
  const root = mkdtempSync(join(tmpdir(), "ma-pol-"));
  const file = join(root, "policy.json");
  if (contents !== undefined) writeFileSync(file, typeof contents === "string" ? contents : JSON.stringify(contents));
  return { file, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("no file → conservative default: auto OFF everywhere", () => {
  const { file, cleanup } = withFile(undefined);
  try {
    const p = createBandPolicy({ file });
    assert.equal(p.valid(), true);
    assert.equal(p.behaviorFor("low"), "notify");
    assert.equal(p.behaviorFor("medium"), "human");
    assert.equal(p.behaviorFor("high"), "typed_confirm");
    assert.equal(p.routeFor({ band: "low", changedPaths: ["src/x.md"] }), "notify");
  } finally { cleanup(); }
});

test("low=auto_approve routes a clean low delivery to auto_approve", () => {
  const { file, cleanup } = withFile({ bands: { low: "auto_approve", medium: "human", high: "typed_confirm" } });
  try {
    const p = createBandPolicy({ file });
    assert.equal(p.routeFor({ band: "low", changedPaths: ["README.md"] }), "auto_approve");
  } finally { cleanup(); }
});

test("DENY-LIST beats band: a deny path forces human even at low+auto", () => {
  const { file, cleanup } = withFile({
    bands: { low: "auto_approve", medium: "human", high: "typed_confirm" },
    denyList: ["**/.env", "**/secrets/**", ".github/**"],
  });
  try {
    const p = createBandPolicy({ file });
    assert.equal(p.routeFor({ band: "low", changedPaths: ["src/a.ts", ".env"] }), "human", ".env forces human");
    assert.equal(p.routeFor({ band: "low", changedPaths: ["config/secrets/db.json"] }), "human");
    assert.equal(p.routeFor({ band: "low", changedPaths: [".github/workflows/ci.yml"] }), "human");
    assert.equal(p.denyHit([".env"]), true);
    assert.equal(p.denyHit(["src/ok.ts"]), false);
  } finally { cleanup(); }
});

test("deny-list only tightens: typed_confirm stays typed_confirm under a deny hit", () => {
  const { file, cleanup } = withFile({
    bands: { low: "auto_approve", medium: "human", high: "typed_confirm" },
    denyList: ["**/*.pem"],
  });
  try {
    const p = createBandPolicy({ file });
    assert.equal(p.routeFor({ band: "high", changedPaths: ["deploy/x.pem"] }), "typed_confirm");
  } finally { cleanup(); }
});

test("parse error → fail closed to all-human, valid()=false", () => {
  const { file, cleanup } = withFile("{ this is not json");
  try {
    const p = createBandPolicy({ file, log: () => {} });
    assert.equal(p.valid(), false);
    assert.equal(p.behaviorFor("low"), "human");
    assert.equal(p.behaviorFor("medium"), "human");
    assert.equal(p.behaviorFor("high"), "typed_confirm");
    assert.equal(p.routeFor({ band: "low", changedPaths: ["README.md"] }), "human", "no auto after a bad file");
  } finally { cleanup(); }
});

test("schema violation (low=bogus) → fail closed", () => {
  const { file, cleanup } = withFile({ bands: { low: "yolo", medium: "human", high: "typed_confirm" } });
  try {
    const p = createBandPolicy({ file, log: () => {} });
    assert.equal(p.valid(), false);
    assert.equal(p.behaviorFor("low"), "human");
  } finally { cleanup(); }
});

test("medium can never be auto_approve (schema rejects it → fail closed)", () => {
  const { file, cleanup } = withFile({ bands: { low: "notify", medium: "auto_approve", high: "typed_confirm" } });
  try {
    const p = createBandPolicy({ file, log: () => {} });
    assert.equal(p.valid(), false);
  } finally { cleanup(); }
});

test("high can never be auto_approve (schema rejects it)", () => {
  const { file, cleanup } = withFile({ bands: { low: "notify", medium: "human", high: "auto_approve" } });
  try {
    assert.equal(createBandPolicy({ file, log: () => {} }).valid(), false);
  } finally { cleanup(); }
});

test("SLA windows: defaults, and per-band override from the file", () => {
  const { file, cleanup } = withFile({ bands: { low: "notify", medium: "human", high: "typed_confirm" }, sla: { high: 1000 } });
  try {
    const p = createBandPolicy({ file });
    assert.equal(p.slaFor("high"), 1000, "override honored");
    assert.equal(p.slaFor("low"), DEFAULT_SLA_MS.low, "unset band keeps default");
  } finally { cleanup(); }
});

test("save() validates before writing then reloads live (no restart)", () => {
  const { file, cleanup } = withFile(undefined);
  try {
    const p = createBandPolicy({ file });
    p.save({ bands: { low: "auto_approve", medium: "human", high: "typed_confirm" }, denyList: ["**/.env"] });
    assert.equal(p.behaviorFor("low"), "auto_approve", "in-memory updated after save");
    // a fresh instance reads the same file → durable
    const p2 = createBandPolicy({ file });
    assert.equal(p2.behaviorFor("low"), "auto_approve");
    // a rejected write never touches disk
    assert.throws(() => p.save({ bands: { low: "bad", medium: "human", high: "human" } }), /invalid bands/);
    assert.equal(createBandPolicy({ file }).behaviorFor("low"), "auto_approve", "disk unchanged after rejected save");
  } finally { cleanup(); }
});

test("glob deny matches nested and dotfile paths", () => {
  const { file, cleanup } = withFile({
    bands: { low: "auto_approve", medium: "human", high: "typed_confirm" },
    denyList: ["**/secrets/**", "**/*.key", "infra/**"],
  });
  try {
    const p = createBandPolicy({ file });
    assert.equal(p.denyHit(["a/b/secrets/c.txt"]), true);
    assert.equal(p.denyHit(["tls/server.key"]), true);
    assert.equal(p.denyHit(["infra/main.tf"]), true);
    assert.equal(p.denyHit(["src/index.ts"]), false);
  } finally { cleanup(); }
});

// ── sr-security P6 blocker regression: deny-list is case-INSENSITIVE ────────────
test("DENY-LIST is case-insensitive (APFS/NTFS) — a case variant cannot evade a custom deny", () => {
  const { file, cleanup } = withFile({
    bands: { low: "auto_approve", medium: "human", high: "typed_confirm" },
    denyList: ["src/secret-notes/**"],
  });
  try {
    const p = createBandPolicy({ file });
    // exact case → human
    assert.equal(p.routeFor({ band: "low", changedPaths: ["src/secret-notes/plan.md"] }), "human");
    // MIXED case (the bypass) → still human, not auto_approve
    assert.equal(p.routeFor({ band: "low", changedPaths: ["src/Secret-Notes/plan.md"] }), "human", "case variant must still hit the deny");
    assert.equal(p.routeFor({ band: "low", changedPaths: ["SRC/SECRET-NOTES/plan.md"] }), "human");
  } finally { cleanup(); }
});

test("DENY-LIST built-in floor is UN-removable: explicit denyList:[] still denies .env", () => {
  const { file, cleanup } = withFile({
    bands: { low: "auto_approve", medium: "human", high: "typed_confirm" },
    denyList: [],
  });
  try {
    const p = createBandPolicy({ file });
    assert.equal(p.valid(), true);
    // .env would be HIGH via the classifier anyway, but the deny-list floor must hold on its own.
    assert.equal(p.routeFor({ band: "low", changedPaths: [".env"] }), "human", "empty denyList must not clear the built-in floor");
    assert.equal(p.routeFor({ band: "low", changedPaths: [".GITHUB/workflows/ci.yml"] }), "human", "floor is case-insensitive too");
  } finally { cleanup(); }
});

test("DENY-LIST: operator globs are ADDED to the floor, not replacing it", () => {
  const { file, cleanup } = withFile({
    bands: { low: "auto_approve", medium: "human", high: "typed_confirm" },
    denyList: ["docs/private/**"],
  });
  try {
    const p = createBandPolicy({ file });
    assert.equal(p.routeFor({ band: "low", changedPaths: ["docs/private/x.md"] }), "human", "operator glob honored");
    assert.equal(p.routeFor({ band: "low", changedPaths: [".env"] }), "human", "floor still present alongside operator globs");
  } finally { cleanup(); }
});
