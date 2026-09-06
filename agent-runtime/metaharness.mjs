// Phase 3 / R9 — METAHARNESS. A score for the security posture of this install's own
// configuration surface.
//
// THE PROBLEM IT SOLVES: MissionAlpha's guarantees live in config — the band policy, the
// deny-list, the quality-gate binary allow-list, per-station permissions, MCP grants.
// Every one of those is editable, and a weakening edit is SILENT. There is no moment
// where the system says "you just made yourself less safe." Config drift is how a
// carefully-built posture quietly becomes a permissive one over months, and nobody can
// point at the commit where it happened. This grades the surface and snapshots it, so
// drift is visible as a number that went down.
//
// READ-ONLY, ALWAYS. It never repairs. A tool that silently fixes config hides the drift
// that caused the problem, and the operator learns nothing. Every finding carries a `fix`
// the human applies deliberately. Same law as doctor.
//
// SCORING IS DELIBERATELY BLUNT. Weighted deductions off 100, closed rubric, no curve. A
// score that moves for reasons nobody can explain is a vanity metric; every point lost
// here maps to exactly one named finding with a severity and a remedy.
//
// PURE. Config is passed IN. No file reads, no globals — the caller (server.mjs / doctor)
// supplies live objects, tests supply fixtures.

/** Severity → points deducted. A closed table; there is no partial credit. */
export const SEVERITY_WEIGHT = Object.freeze({ critical: 40, high: 20, medium: 10, low: 4 });

/**
 * The floor the built-in deny-list must always cover. Shrinking it is a CRITICAL.
 *
 * THESE ARE READ FROM policy.mjs DEFAULT_DENYLIST, not invented. An earlier revision of
 * this list asserted `package.json`, `node_modules` and `settings.json` — none of which
 * the deny-list has ever carried, because they are defended by DIFFERENT layers:
 *   • package.json script edits → CONFIG_GUARD in broker.mjs
 *   • node_modules and anything else → DEFAULT_ALLOWLIST is deny-by-default (`src/**`,
 *     `README.md`), so an unlisted path cannot auto-apply regardless of the deny-list.
 * That mistake made a healthy install score 46/D with a CRITICAL. A grader that cries
 * wolf is worse than no grader — it trains the operator to ignore the number. The floor
 * must mirror the real built-in set and nothing else.
 */
export const REQUIRED_DENY_FLOOR = Object.freeze([
  ".env", "secrets", "credentials", ".pem", ".key",
]);

/** Binaries a quality config may name. Mirrors quality.mjs ALLOWED_BINS. */
export const EXPECTED_BINS = Object.freeze(new Set([
  "node", "npm", "npx", "pnpm", "yarn",
  "python", "python3", "pytest",
  "go", "cargo",
  "jest", "vitest", "playwright",
]));

function finding(id, severity, detail, fix) {
  return { id, severity, detail, fix };
}

/**
 * grade(surface) → { score, grade, findings[], checked }
 *
 * `surface` is a plain object of already-read config:
 *   policy      { bands:{low,medium,high}, denyList[], allowList[], limits:{maxFiles,maxLines} }
 *   quality     { testCmd[], e2eCmd, timeoutMs }
 *   stationPerms{ [agentId]: mode }
 *   mcpGrants   { [agentId]: [connectorId] }
 *   hooks       [{ event, enabled, handlers[] }]
 *   encryption  { enabled }
 *   adapters    { github:{enabled}, claudeCode:{enabled} }
 *
 * Any absent section is SKIPPED, not assumed good — `checked` reports what was actually
 * graded so a partial surface cannot masquerade as a clean bill of health.
 */
export function grade(surfaceInput = {}) {
  // A default parameter only fires for `undefined`, NEVER for `null` — so `grade(null)`
  // would sail past the default and throw on the first property read. Same JS trap that
  // bit a test harness in this program. Normalise explicitly.
  const surface = (surfaceInput && typeof surfaceInput === "object" && !Array.isArray(surfaceInput))
    ? surfaceInput : {};
  const findings = [];
  const checked = [];

  // ── band policy ────────────────────────────────────────────────────────────
  if (surface.policy && typeof surface.policy === "object") {
    checked.push("policy");
    const p = surface.policy;
    const bands = p.bands || {};

    // high must NEVER auto-approve. This is the single most load-bearing setting here.
    if (bands.high === "auto_approve") {
      findings.push(finding("high-auto-approve", "critical",
        "band 'high' is set to auto_approve — the highest-risk changes would reach the repo with no human decision",
        "Set the high band to 'human' in factory/policy.json. High must never auto-apply."));
    }
    if (bands.medium === "auto_approve") {
      findings.push(finding("medium-auto-approve", "high",
        "band 'medium' auto-approves — medium-risk diffs land without review",
        "Set the medium band to 'human' or 'notify' unless you have a specific reason."));
    }

    // deny-list floor. An operator may ADD to it; they must never be able to shrink it
    // below the built-in floor.
    const deny = Array.isArray(p.denyList) ? p.denyList.map(String) : [];
    const missing = REQUIRED_DENY_FLOOR.filter((f) => !deny.some((d) => d.includes(f)));
    if (missing.length) {
      findings.push(finding("deny-floor-shrunk", "critical",
        `deny-list no longer covers: ${missing.join(", ")} — sensitive paths could auto-apply`,
        "Restore the built-in deny floor. The runtime's floor is un-removable by design; a gap here means it was bypassed."));
    }

    // An empty allow-list means deny-by-default is doing all the work; a '**' allow-list
    // means it is doing none.
    const allow = Array.isArray(p.allowList) ? p.allowList.map(String) : [];
    if (allow.includes("**") || allow.includes("*")) {
      findings.push(finding("allowlist-wildcard", "critical",
        "auto-apply allow-list is '**' — every path in the repo is auto-appliable",
        "Narrow the allow-list to the directories that genuinely need it (default: src/**, README.md)."));
    }

    const limits = p.limits || {};
    if (Number(limits.maxFiles) > 50 || Number(limits.maxLines) > 2000) {
      findings.push(finding("limits-above-ceiling", "high",
        `auto-apply size ceiling raised beyond the documented maximum (files=${limits.maxFiles}, lines=${limits.maxLines})`,
        "Lower maxFiles to <= 50 and maxLines to <= 2000."));
    }
  }

  // ── quality gate ───────────────────────────────────────────────────────────
  if (surface.quality && typeof surface.quality === "object") {
    checked.push("quality");
    const q = surface.quality;
    for (const [label, cmd] of [["testCmd", q.testCmd], ["e2eCmd", q.e2eCmd]]) {
      if (!cmd) continue;
      if (!Array.isArray(cmd)) {
        findings.push(finding(`${label}-not-argv`, "critical",
          `${label} is not an argv ARRAY — a shell string here is arbitrary command execution`,
          `Express ${label} as an array, e.g. ["npm","test"]. quality.mjs runs with shell:false.`));
        continue;
      }
      const bin = String(cmd[0] || "");
      if (bin && !EXPECTED_BINS.has(bin)) {
        findings.push(finding(`${label}-bin-not-allowed`, "critical",
          `${label} names '${bin}', which is outside the test-runner allow-list`,
          `Use an allow-listed runner. Adding a binary is a reviewed code change, never a config edit.`));
      }
      if (bin.includes("/") || bin.includes("\\")) {
        findings.push(finding(`${label}-bin-path`, "critical",
          `${label} binary '${bin}' contains a path separator — it can never be allow-listed`,
          "Name a bare binary resolved from PATH."));
      }
    }
    if (q.testCmd == null) {
      findings.push(finding("no-test-gate", "medium",
        "no testCmd configured — the build gate cannot verify anything before a Delivery is minted",
        "Set testCmd in factory/quality.json (default: [\"node\",\"--test\"])."));
    }
  }

  // ── station permissions ────────────────────────────────────────────────────
  if (surface.stationPerms && typeof surface.stationPerms === "object") {
    checked.push("stationPerms");
    const wide = Object.entries(surface.stationPerms)
      .filter(([, mode]) => String(mode) === "bypassPermissions" || String(mode) === "acceptEdits");
    if (wide.length) {
      findings.push(finding("station-perm-wide", "high",
        `${wide.length} station(s) run with a permissive interactive mode: ${wide.map(([a]) => a).join(", ")}`,
        "Reset those stations to the default prompting mode unless a specific task needs otherwise."));
    }
  }

  // ── MCP grants ─────────────────────────────────────────────────────────────
  if (surface.mcpGrants && typeof surface.mcpGrants === "object") {
    checked.push("mcpGrants");
    const granted = Object.entries(surface.mcpGrants).filter(([, list]) => Array.isArray(list) && list.length);
    if (granted.length > 5) {
      findings.push(finding("mcp-grants-broad", "medium",
        `${granted.length} stations hold MCP connector grants — default-deny is eroding`,
        "Revoke grants from stations that no longer need them."));
    }
  }

  // ── lifecycle hooks ────────────────────────────────────────────────────────
  if (Array.isArray(surface.hooks)) {
    checked.push("hooks");
    const off = surface.hooks.filter((h) => !h.enabled);
    if (off.length === surface.hooks.length && surface.hooks.length) {
      findings.push(finding("hooks-all-disabled", "high",
        "every lifecycle hook event is disabled — nothing inspects or can stop a run",
        "Unset the RUNTIME_HOOK_* env vars."));
    } else if (off.length) {
      findings.push(finding("hooks-partly-disabled", "low",
        `${off.length} hook event(s) disabled: ${off.map((h) => h.event).join(", ")}`,
        "Re-enable unless deliberately turned off for a specific run."));
    }
  }

  // ── encryption at rest ─────────────────────────────────────────────────────
  if (surface.encryption && typeof surface.encryption === "object") {
    checked.push("encryption");
    if (!surface.encryption.enabled) {
      findings.push(finding("no-encryption-at-rest", "low",
        "Delivery store and vault are plaintext on disk (0600 only)",
        "Enable encryption at rest if this machine leaves your control."));
    }
  }

  const deducted = findings.reduce((s, f) => s + (SEVERITY_WEIGHT[f.severity] || 0), 0);
  const score = Math.max(0, 100 - deducted);
  return {
    score,
    grade: score >= 90 ? "A" : score >= 75 ? "B" : score >= 60 ? "C" : score >= 40 ? "D" : "F",
    findings: findings.sort((a, b) => SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity]),
    checked,
    worst: findings.length ? findings[0].severity : null,
  };
}

/**
 * Compare two grades. Returns the DELTA plus which findings are new and which cleared —
 * the actual point of snapshotting. A score that moved without a named cause is noise.
 */
export function diffGrades(before, after) {
  const b = new Set((before?.findings || []).map((f) => f.id));
  const a = new Set((after?.findings || []).map((f) => f.id));
  return {
    delta: (after?.score ?? 0) - (before?.score ?? 0),
    appeared: [...a].filter((id) => !b.has(id)),
    cleared: [...b].filter((id) => !a.has(id)),
  };
}

/** Compact shape for the SSE frame + cockpit tile. No config values, only identity. */
export function gradeSummary(g) {
  if (!g) return null;
  return { score: g.score, grade: g.grade, findings: g.findings.length, worst: g.worst, checked: g.checked.length };
}
