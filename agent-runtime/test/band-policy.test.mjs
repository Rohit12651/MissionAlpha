// ADR-053 — per-band policy (P6). factory/policy.json routing, deny-list precedence,
// fail-closed on a bad file, SLA windows. Pure + file-level; no HTTP.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createBandPolicy, DEFAULT_SLA_MS, MAX_LIMITS } from "../policy.mjs";

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

// CORRECTED IN PHASE 2 TASK 2.2, not preserved. This test used to assert auto-approval
// from a band and a path list ALONE. That WAS the specification of the gap the phase
// closes: a size nobody measured is not a small size, and unattended auto-approval on an
// unmeasured diff is the failure mode the whole task exists to prevent. The routing
// contract now requires the caller to state the size; the unmeasured case is pinned as
// `human` in "AN UNKNOWN SIZE IS NOT A SMALL SIZE" below.
test("low=auto_approve routes a clean, MEASURED, in-bounds low delivery to auto_approve", () => {
  const { file, cleanup } = withFile({ bands: { low: "auto_approve", medium: "human", high: "typed_confirm" } });
  try {
    const p = createBandPolicy({ file });
    assert.equal(p.routeFor({ band: "low", changedPaths: ["README.md"], fileCount: 1, changedLines: 4 }), "auto_approve");
    assert.equal(p.explainRoute({ band: "low", changedPaths: ["README.md"], fileCount: 1, changedLines: 4 }), null);
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

// ── PHASE 2 TASK 2.2 — AUTO-APPROVE, REAL AND BOUNDED ───────────────────────
//
// What "bounded" has to mean before a swarm may land code with nobody watching:
//   • a RISK BAND ceiling — already structural (medium/high cannot be auto_approve),
//   • a DIFF-SIZE ceiling — a low-risk 400-line rewrite of forty files is still a change
//     no one read, and "low risk" is a classifier's opinion, not a size,
//   • a PATH ALLOWLIST — deny-by-default, so an unforeseen path is refused rather than
//     permitted. The pre-existing deny-list is the opposite polarity: it can only refuse
//     what someone thought to name.
// Every one of these can only ever REMOVE auto-approval. None can relax human or
// typed_confirm — a tightening knob that can loosen is not a tightening knob.

const AUTO = { bands: { low: "auto_approve", medium: "human", high: "typed_confirm" } };

test("DIFF-SIZE CEILING: a low-risk diff over the file ceiling is not auto-approved", () => {
  const { file, cleanup } = withFile({ ...AUTO, limits: { maxFiles: 3, maxLines: 400 } });
  try {
    const p = createBandPolicy({ file });
    const within = { band: "low", changedPaths: ["src/a.ts", "src/b.ts"], fileCount: 2, changedLines: 20 };
    assert.equal(p.routeFor(within), "auto_approve");
    assert.equal(p.routeFor({ ...within, changedPaths: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"], fileCount: 4 }), "human");
  } finally { cleanup(); }
});

test("DIFF-SIZE CEILING: the line ceiling binds independently of the file count", () => {
  const { file, cleanup } = withFile({ ...AUTO, limits: { maxFiles: 20, maxLines: 50 } });
  try {
    const p = createBandPolicy({ file });
    assert.equal(p.routeFor({ band: "low", changedPaths: ["src/a.ts"], fileCount: 1, changedLines: 49 }), "auto_approve");
    assert.equal(p.routeFor({ band: "low", changedPaths: ["src/a.ts"], fileCount: 1, changedLines: 51 }), "human");
  } finally { cleanup(); }
});

test("AN UNKNOWN SIZE IS NOT A SMALL SIZE — a missing measurement blocks auto-approve", () => {
  // The caller failed to measure, so nothing has been shown to be under the ceiling.
  // Treating "unmeasured" as "fine" is exactly how a cap becomes decoration.
  const { file, cleanup } = withFile({ ...AUTO, limits: { maxFiles: 5, maxLines: 100 } });
  try {
    const p = createBandPolicy({ file });
    assert.equal(p.routeFor({ band: "low", changedPaths: ["src/a.ts"] }), "human");
    assert.equal(p.routeFor({ band: "low", changedPaths: ["src/a.ts"], fileCount: 1, changedLines: null }), "human");
    assert.equal(p.routeFor({ band: "low", changedPaths: ["src/a.ts"], fileCount: 1, changedLines: 3 }), "auto_approve");
  } finally { cleanup(); }
});

test("PATH ALLOWLIST is deny-by-default: one unlisted path holds the whole diff", () => {
  const { file, cleanup } = withFile({ ...AUTO, allowList: ["src/**"], limits: { maxFiles: 10, maxLines: 500 } });
  try {
    const p = createBandPolicy({ file });
    const size = { fileCount: 2, changedLines: 10 };
    assert.equal(p.routeFor({ band: "low", changedPaths: ["src/a.ts", "src/b.ts"], ...size }), "auto_approve");
    // docs/ was never allowed. All-or-nothing: one unlisted path holds the lot, the same
    // rule ADR-029's classifier already applies to a risky path.
    assert.equal(p.routeFor({ band: "low", changedPaths: ["src/a.ts", "docs/x.md"], ...size }), "human");
  } finally { cleanup(); }
});

test("AN EMPTY ALLOWLIST ALLOWS NOTHING — it is not a wildcard", () => {
  const { file, cleanup } = withFile({ ...AUTO, allowList: [], limits: { maxFiles: 10, maxLines: 500 } });
  try {
    const p = createBandPolicy({ file });
    assert.equal(p.routeFor({ band: "low", changedPaths: ["src/a.ts"], fileCount: 1, changedLines: 1 }), "human");
  } finally { cleanup(); }
});

test("an EMPTY DIFF is never auto-approved — there is nothing to have reviewed", () => {
  const { file, cleanup } = withFile({ ...AUTO, limits: { maxFiles: 10, maxLines: 500 } });
  try {
    const p = createBandPolicy({ file });
    assert.equal(p.routeFor({ band: "low", changedPaths: [], fileCount: 0, changedLines: 0 }), "human");
  } finally { cleanup(); }
});

test("the ceilings and the allowlist only ever TIGHTEN — high stays typed_confirm", () => {
  const { file, cleanup } = withFile({ ...AUTO, allowList: ["src/**"], limits: { maxFiles: 1, maxLines: 1 } });
  try {
    const p = createBandPolicy({ file });
    // A huge, unlisted, high-risk diff must not be relaxed from typed_confirm to human by
    // any of the new gates — they subtract permission, they never add friction downward.
    assert.equal(p.routeFor({ band: "high", changedPaths: ["infra/x.tf"], fileCount: 99, changedLines: 9999 }), "typed_confirm");
    assert.equal(p.routeFor({ band: "medium", changedPaths: ["infra/x.tf"], fileCount: 99, changedLines: 9999 }), "human");
  } finally { cleanup(); }
});

test("DEFAULTS with no limits/allowList in the file are conservative, not permissive", () => {
  const { file, cleanup } = withFile(AUTO); // bands only — no limits, no allowList
  try {
    const p = createBandPolicy({ file });
    const raw = p.raw();
    assert.ok(raw.limits.maxFiles > 0 && raw.limits.maxLines > 0, "a default ceiling must exist");
    assert.ok(raw.allowList.length > 0, "a default allowlist must exist");
    // The built-in allowlist is the ADR-029 SAFE set: plain src/* text plus README.
    assert.equal(p.routeFor({ band: "low", changedPaths: ["src/a.ts"], fileCount: 1, changedLines: 5 }), "auto_approve");
    assert.equal(p.routeFor({ band: "low", changedPaths: ["scripts/deploy.sh"], fileCount: 1, changedLines: 5 }), "human");
  } finally { cleanup(); }
});

test("a MALFORMED limits/allowList block fails CLOSED, it does not fall back to permissive", () => {
  const { file, cleanup } = withFile({ ...AUTO, limits: { maxFiles: -1 }, allowList: [42] });
  try {
    const p = createBandPolicy({ file });
    assert.equal(p.valid(), false);
    assert.equal(p.routeFor({ band: "low", changedPaths: ["src/a.ts"], fileCount: 1, changedLines: 1 }), "human");
  } finally { cleanup(); }
});

test("save() REJECTS a limits/allowList that would widen the gate past its bounds", () => {
  const { file, cleanup } = withFile(undefined);
  try {
    const p = createBandPolicy({ file });
    assert.throws(() => p.save({ bands: AUTO.bands, limits: { maxFiles: 0, maxLines: 10 } }), /maxFiles/);
    assert.throws(() => p.save({ bands: AUTO.bands, allowList: ["src/**", 7] }), /allowList/);
    // A rejected save never touches disk — the policy can only move between valid states.
    assert.equal(p.behaviorFor("low"), "notify");
    const saved = p.save({ bands: AUTO.bands, allowList: ["src/**"], limits: { maxFiles: 4, maxLines: 120 } });
    assert.equal(saved.limits.maxFiles, 4);
    assert.deepEqual(saved.allowList, ["src/**"]);
  } finally { cleanup(); }
});

// Code review (MEDIUM, fixed) — the ceiling on the CEILING is enforced by the SERVER.
// `positiveInt` rejected 0 and negatives but accepted 999_999_999, so a POST to
// /runtime/policy could store a limit no real diff can reach: an unbounded auto-approve
// wearing the costume of a bounded one, while the editor went on advertising 50/2000.
// A client-side clamp is a hint. The number the control claims to allow must be the number
// it does allow.
test("a limit ABOVE the hard maximum is refused by save() and fails the file closed on load", () => {
  const { file, cleanup } = withFile(undefined);
  try {
    const p = createBandPolicy({ file });
    assert.throws(() => p.save({ bands: AUTO.bands, limits: { maxFiles: 999_999_999, maxLines: 10 } }), /maxFiles/);
    assert.throws(() => p.save({ bands: AUTO.bands, limits: { maxFiles: 4, maxLines: 999_999_999 } }), /maxLines/);
    // The exact boundary is allowed — an off-by-one here would make the advertised maximum
    // unusable, which is its own kind of dishonest control.
    const saved = p.save({ bands: AUTO.bands, limits: { maxFiles: MAX_LIMITS.maxFiles, maxLines: MAX_LIMITS.maxLines } });
    assert.equal(saved.limits.maxFiles, MAX_LIMITS.maxFiles);
  } finally { cleanup(); }
});

test("a HAND-EDITED file with an over-max limit fails closed to all-human, not to the max", () => {
  // Clamping silently would let someone write 999999999, read back a working policy, and
  // never learn their intent was overridden. A malformed bound is a malformed policy.
  const { file, cleanup } = withFile({ ...AUTO, limits: { maxFiles: 999_999_999, maxLines: 300 } });
  try {
    const p = createBandPolicy({ file });
    assert.equal(p.valid(), false);
    assert.equal(p.routeFor({ band: "low", changedPaths: ["src/a.ts"], fileCount: 1, changedLines: 1 }), "human");
  } finally { cleanup(); }
});
