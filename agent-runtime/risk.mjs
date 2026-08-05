// ADR-053 — Risk router. A PURE, deterministic, table-driven heuristic classifier.
// NO LLM, NO network, NO fs. Given a Delivery's changed paths + diffstat + kind +
// a new-dependency signal, it returns { score 0..100, band, reasons[] }.
//
// SECURITY (ADR-053): this module only READS the diff shape it is handed and returns
// a verdict. It grants no capability. The band it emits GATES auto-apply upstream
// (server maybeAutoApply); a wrong "low" is the dangerous direction, so every rule
// errs toward the HIGHER band — security-critical paths win over doc/test paths, a
// large diff bumps up, a touched dependency manifest floors at medium.
//
// Determinism: same input ⇒ same output, always. The score is a monotone function of
// the reasons; the band is derived from the score's range. No Date, no random.

// Band ordering, lowest first. `rank` compares; `bandOf` inverts.
export const BANDS = Object.freeze(["low", "medium", "high"]);
const rank = (b) => Math.max(0, BANDS.indexOf(b));
const higher = (a, b) => (rank(a) >= rank(b) ? a : b);

// Score envelope per band. A band's score is clamped into [floor, ceil] so the number
// and the label can never disagree, while bumps still move the score within the band.
const ENVELOPE = Object.freeze({
  low: { base: 15, floor: 5, ceil: 39 },
  medium: { base: 50, floor: 40, ceil: 69 },
  high: { base: 82, floor: 70, ceil: 100 },
});

// HIGH — security/exec/supply-chain critical. Checked FIRST: a path in this set is
// HIGH even if it also looks like a doc (e.g. .github/workflows/ci.md), because these
// are the paths where a wrong auto-apply is unrecoverable.
const HIGH_PATTERNS = Object.freeze([
  [/(^|\/)\.env(\.|$|\/)/i, "environment file"],
  [/(^|\/)secrets?(\/|\.|$)/i, "secrets path"],
  [/(^|\/)credentials?(\/|\.|$)/i, "credentials path"],
  [/\.(pem|key|p12|pfx|keystore)$/i, "key material"],
  [/(^|\/)(auth|authentication|login|oauth2?|openid|session|jwt|saml)(\/|\.|s\/)/i, "auth surface"],
  [/(^|\/)(payments?|billing|stripe|paypal|charge|checkout|invoice)(\/|\.|s\/)/i, "payment surface"],
  [/(^|\/)(infra|infrastructure|terraform|k8s|kubernetes|deploy)(\/|$)/i, "infrastructure"],
  [/\.tf$/i, "terraform"],
  [/(^|\/)dockerfile(\.|$)/i, "Dockerfile"],
  [/(^|\/)docker-compose(\.|$)/i, "compose file"],
  [/(^|\/)\.github\//i, "CI workflow (.github)"],
  [/(^|\/)\.gitlab-ci\.yml$/i, "CI config"],
  [/(^|\/)(cloudbuild\.ya?ml|jenkinsfile|\.circleci\/)/i, "CI config"],
  [/(^|\/)migrations?\//i, "database migration"],
]);

// LOW — inherently safe to apply. Checked AFTER high (so a security path never
// downgrades) but BEFORE the medium default.
const LOW_PATTERNS = Object.freeze([
  [/(^|\/)(tests?|__tests__|specs?|e2e)\//i, "tests"],
  [/\.(test|spec)\.[a-z0-9]+$/i, "test file"],
  [/(^|\/)docs?\//i, "docs"],
  [/\.mdx?$/i, "markdown"],
  [/(^|\/)changelog(\.|$)/i, "changelog"],
  [/(^|\/)(readme|license|licence|notice|authors|contributing)(\.|$)/i, "project doc"],
]);

// Dependency manifests — a change here is at LEAST medium (supply-chain adjacent).
const MANIFESTS = Object.freeze([
  /(^|\/)package\.json$/i,
  /(^|\/)pyproject\.toml$/i,
  /(^|\/)requirements[^/]*\.txt$/i,
  /(^|\/)go\.mod$/i,
  /(^|\/)cargo\.toml$/i,
  /(^|\/)gemfile$/i,
  /(^|\/)pom\.xml$/i,
  /(^|\/)build\.gradle(\.kts)?$/i,
]);

// Diff-size thresholds — beyond either, the band is bumped one step up.
export const LARGE_DIFF_LINES = 400;
export const LARGE_DIFF_FILES = 20;

/** Classify ONE path → { band, reason } or null (falls through to the medium default). */
export function bandForPath(path) {
  const p = String(path || "");
  for (const [re, reason] of HIGH_PATTERNS) if (re.test(p)) return { band: "high", reason: `high: ${reason}` };
  for (const [re, reason] of LOW_PATTERNS) if (re.test(p)) return { band: "low", reason: `low: ${reason}` };
  return null; // caller applies the medium default (any other code path)
}

const isManifest = (p) => MANIFESTS.some((re) => re.test(String(p || "")));

/**
 * Detect an ADDED dependency from a change set. For package.json we do a real
 * key-diff of the dependency blocks; for the other manifests (non-JSON, varied
 * grammars) we fall back to "the manifest gained non-blank/comment lines" — which
 * over-flags a version bump as a new dep, i.e. it errs toward MEDIUM (the safe way).
 * Pure; accepts the same {path,before,after} shape mint() already holds.
 */
export function detectNewDependency(changes) {
  for (const c of Array.isArray(changes) ? changes : []) {
    if (!isManifest(c?.path)) continue;
    const before = c?.before ?? null;
    const after = c?.after ?? "";
    if (/(^|\/)package\.json$/i.test(String(c.path))) {
      try {
        const b = before ? JSON.parse(before) : {};
        const a = JSON.parse(after);
        const blocks = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
        for (const k of blocks) {
          const bk = b[k] && typeof b[k] === "object" ? b[k] : {};
          const ak = a[k] && typeof a[k] === "object" ? a[k] : {};
          for (const dep of Object.keys(ak)) if (!(dep in bk)) return true; // a new key appeared
        }
        continue; // parsed cleanly, no new key → not a new dep
      } catch {
        return true; // unparseable manifest change → refuse to assume it is safe
      }
    }
    // Non-JSON manifest: added non-blank, non-comment lines ⇒ treat as a new dep.
    const nonTrivial = (s) =>
      String(s || "")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#") && !l.startsWith("//")).length;
    if (nonTrivial(after) > nonTrivial(before)) return true;
  }
  return false;
}

/**
 * The classifier. Inputs (all optional except what mint supplies):
 *   changedPaths : string[]   — the delivery's paths
 *   additions/deletions : number — diffstat
 *   files        : number     — file count (defaults to changedPaths.length)
 *   kind         : delivery kind — 'failure' has its OWN band (high)
 *   newDependency: boolean     — from detectNewDependency()
 * Returns { score:0..100, band:'low'|'medium'|'high', reasons:string[] }.
 */
// Story-Pipeline S2/S5 — the human-gate kinds. Like `failure`, they carry NO diff and ALWAYS
// need a person: a `question` is a pm-analyst clarify the BOSS must answer, a
// `design-approval` is the architect design gate the BOSS decides, and a `release-approval` is
// the release-accept gate the BOSS decides before a deploy executes. Their "band" here is not
// code-danger — it is needs-you URGENCY: high means they surface in the High-risk filter and
// draw the fastest SLA window, so a gate is never quietly buried. They never auto-apply
// (autoApprove refuses non-'code'/failure and every high band), so a high band grants nothing.
const GATE_KINDS = Object.freeze(new Set(["question", "design-approval", "release-approval"]));

export function classify(input = {}) {
  const reasons = [];

  // A stuck-agent failure has no diff to apply and always needs a human — its own band.
  if (input.kind === "failure") {
    return { score: ENVELOPE.high.ceil, band: "high", reasons: ["high: agent failure — needs attention"] };
  }
  // A human gate (question / design-approval) — diff-less, always needs you. See GATE_KINDS.
  if (GATE_KINDS.has(input.kind)) {
    return { score: ENVELOPE.high.ceil, band: "high", reasons: [`high: ${input.kind} — needs your decision`] };
  }

  const paths = Array.isArray(input.changedPaths) ? input.changedPaths : [];
  let band = "low";
  const seen = new Set();
  let highPaths = 0;
  for (const p of paths) {
    const verdict = bandForPath(p) || { band: "medium", reason: "medium: source path" };
    if (verdict.band === "high") highPaths++;
    if (!seen.has(verdict.reason)) { seen.add(verdict.reason); reasons.push(verdict.reason); }
    band = higher(band, verdict.band);
  }
  if (!paths.length) reasons.push("no changed paths");

  // New dependency ⇒ at least medium.
  if (input.newDependency) {
    band = higher(band, "medium");
    reasons.push("new dependency added");
  }

  // Diff-size bump — a very large change is riskier than its paths alone imply.
  const additions = Number(input.additions) || 0;
  const deletions = Number(input.deletions) || 0;
  const files = Number.isFinite(Number(input.files)) ? Number(input.files) : paths.length;
  const totalLines = additions + deletions;
  const large = totalLines > LARGE_DIFF_LINES || files > LARGE_DIFF_FILES;
  if (large && band !== "high") {
    band = BANDS[Math.min(BANDS.length - 1, rank(band) + 1)];
    reasons.push(`large diff (${totalLines} lines, ${files} files)`);
  }

  // Score: band envelope + within-band bumps, clamped so number and label agree.
  const env = ENVELOPE[band];
  let score = env.base;
  if (input.newDependency) score += 8;
  if (large) score += 6;
  if (highPaths > 1) score += Math.min(10, (highPaths - 1) * 4);
  score = Math.max(env.floor, Math.min(env.ceil, score));

  return { score, band, reasons };
}
