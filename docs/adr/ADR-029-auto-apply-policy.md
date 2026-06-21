# ADR-029 — Auto-Apply Policy (per-agent trust engine — RELAX who triggers, NEVER widen what's allowed)

- **Status:** PROPOSED
- **Date:** 2026-06-18
- **Slug:** `auto-apply-policy`
- **Plan:** STAGE 1 — Extend the Engine (gap #3 auto-apply policy)
- **Deciders:** architect, senior-backend-1 (owner), **senior-security-engineer (HARD gate — BLOCKING)**
- **Plugs into:** ADR-024 (GATING→APPLIED|HELD decision), F2b broker (`server.mjs` L401/420/469/80) — UNCHANGED

## Context

ADR-024's `GATING` state needs a policy to decide, per step: **auto-apply now** (engine calls `applyChanges`) **or hold for operator confirm** (`HELD`). Today everything is implicitly "hold" — the operator manually `POST /apply` (L771) every diff. That is the safe default and S1 must not silently change it.

GAP #3: a **per-agent trust policy** that can let *safe* changes auto-apply (zero clicks — the BOSS acceptance criterion) while *risky* changes always hold. The danger is obvious: a careless policy becomes a guard-relaxation vector. So this ADR's central rule is structural and absolute.

**HARD INVARIANT (BOSS + sr-security, NON-NEGOTIABLE):**
> The policy can ONLY ever relax the *apply trigger* (auto vs operator) for **plain safe source files**. It can NEVER widen what `applyAllowed` (L401) / `CONFIG_GUARD` (L420) / `APPLY_DENY` (L80) permit. Anything exec/config-relevant — anything `CONFIG_GUARD`-protected, anything matching `APPLY_DENY`, `package.json`, `*.config.*`, `scripts/` — is **ALWAYS gated to operator confirm**, regardless of policy level. Policy decides *who clicks*, the broker decides *what's allowed*; the broker still re-validates every path on the apply call either way.

Default = **manual** → no behavior change unless explicitly opted in.

## Decision

### 1. New module — `agent-runtime/policy.mjs` (decision only; never an apply path)

```
ADDED   : agent-runtime/policy.mjs        — per-agent policy + auto-eligibility classifier
ADDED   : agent-runtime/engine-store/policy.json  — per-agent policy levels (signed, §6)
REUSED  : applyChanges (server L469)      — the ONLY write path; auto + manual converge here
REUSED  : applyAllowed (L401) / CONFIG_GUARD (L420) / APPLY_DENY (L80)  — re-run on every apply, UNCHANGED
REUSED  : ADR-024 GATING state            — calls policy.decide(); routes to APPLIED or HELD
```

`policy.mjs` returns a boolean decision; it **never writes a file**. The auto-apply branch and the operator-confirm branch both call the **same** `applyChanges` (ADR-024's convergence invariant), so the broker's re-validation runs identically. Policy is a *gate on the trigger before* the broker — it can only ever make the broker run *automatically*; it can never skip it or change its verdict.

### 2. Policy levels (per agent)

```
manual     — DEFAULT. Every diff holds for operator confirm. (today's behavior)
auto-safe  — auto-apply ONLY diffs where EVERY changed path passes the SAFE classifier (§3);
             ANY risky path in the diff → the WHOLE diff holds (all-or-nothing).
never      — never auto-apply; always hold (stricter than manual is moot, but explicit for
             high-risk agents / a kill-switch).
```

Per-agent: `{ "senior-web-1": "auto-safe", "default": "manual" }`. Unknown/unset agent → `default` → `manual`. There is **no** `auto-all` / `auto-config` level — it does not exist by construction, so no level can ever auto-apply a guarded path.

### 3. The SAFE classifier (defines "plain safe source file")

A path is **auto-eligible** ONLY if ALL hold (deny-by-default — anything not provably safe is risky):

```js
// pseudocode — policy.mjs isAutoSafe(relPath). Runs IN ADDITION TO applyAllowed, never instead.
function isAutoSafe(relPath) {
  if (!applyAllowed(relPath)) return false;          // (a) must already pass the broker's L401 gate
  const relNorm = relative(REPO_ROOT, resolve(REPO_ROOT, relPath));
  if (CONFIG_GUARD[relNorm]) return false;            // (b) any CONFIG_GUARD file (package.json) → risky
  if (APPLY_DENY.test(relNorm)) return false;         // (c) belt-and-suspenders (applyAllowed already checks)
  const top = relNorm.split(sep)[0];
  if (top === "scripts") return false;                // (d) exec dir → risky (also not in SEED_DIRS anyway)
  if (/\.config\./i.test(relNorm)) return false;      // (e) *.config.* → risky
  if (/\.(sh|bash|mjs|cjs|js)$/i.test(relNorm)) return false; // (f) exec-capable extensions → risky in S1
  if (/(^|\/)package\.json$/i.test(relNorm)) return false;    // (g) explicit
  // SAFE: plain source text under src/ — e.g. .tsx/.ts/.css/.json(non-pkg)/.md
  return top === "src" || relNorm === "README.md";
}
```

- **All-or-nothing per diff:** the engine auto-applies a step **only if `isAutoSafe(p)` is true for EVERY path `p` in the diff.** One risky path → the entire diff holds for operator confirm. No partial auto-apply (prevents a safe `.tsx` riding alongside a risky `package.json` in one auto-applied batch).
- The classifier is a **second, narrower gate layered on top of** `applyAllowed` — it can only ever *subtract* from what the broker allows, never add. `isAutoSafe ⟹ applyAllowed` by construction (line (a)).
- `.mjs/.js` are classified **risky** in S1 even under `src/` (they are exec-capable; auto-applying executable source is a step too far while the loop is young). Revisit in a later stage if needed — but only by *tightening review*, never by widening the classifier silently.

### 4. The GATING decision (ADR-024)

```
GATING(step, diff):
  level = policy.levelFor(step.agentId)            // default 'manual'
  if level == 'auto-safe' AND diff.every(isAutoSafe):
      → APPLIED  (engine calls applyChanges — broker STILL re-validates every path)
  else:
      → HELD     (operator must POST /apply — broker re-validates every path)
```

Even in the `APPLIED` (auto) branch, `applyChanges` (L469) runs `applyAllowed` + `CONFIG_GUARD` + symlink/realpath on every path. If a guard fires there (e.g. a TOCTOU race made a path unsafe between classify and apply), the apply returns `{ok:false}` and the step → `FAILED(apply-rejected)` → escalation (ADR-028 §4). The classifier is never trusted as the final word — the broker is.

### 5. Default = manual (no behavior change)

Ship with `policy.json` = `{ "default": "manual" }` and no per-agent overrides. The loop behaves exactly as today (everything holds) until the operator explicitly sets an agent to `auto-safe`. This makes the feature opt-in and reversible (set back to `manual`/`never` instantly).

### 6. Policy integrity — signed config (sr-security HARD requirement)

`engine-store/policy.json` is the trust source; tampering it (e.g. malware flips an agent to a non-existent `auto-all`) must be detected:

- The file carries an **HMAC** over its content using `RUNTIME_TOKEN` (the same secret minted at L94, stored `0o600` outside the repo L98–102): `{ "policy": {...}, "sig": "<hmac-sha256>" }`.
- `policy.mjs` verifies the HMAC on load; **mismatch or missing sig → fail closed to `manual` for every agent** (most restrictive), and emit a BLOCKED bus event (ADR-028 §6). A tampered policy can therefore only ever make the system *safer* (everything holds), never widen auto-apply.
- Writes to `policy.json` go through a single authenticated route `POST /runtime/engine/policy` (`needsAuth` family L754 — token+host+origin) which re-mints the HMAC server-side. No other writer is trusted.
- **Unknown level → fail closed to `manual`.** Even if a signed policy somehow named `auto-config`, the level enum has no such member → treated as `manual`. The classifier (§3) is the ultimate backstop regardless of level.

## Security invariant (senior-security-engineer — HARD gate, BLOCKING)

**INVARIANT: policy can RELAX only the apply *trigger* (auto vs operator), and only for paths that are BOTH `applyAllowed` AND `isAutoSafe` (plain `src/*` text / README). It can NEVER widen `applyAllowed`/`CONFIG_GUARD`/`APPLY_DENY`. Exec/config paths ALWAYS hold. The broker re-validates every path on every apply, auto or manual. Tampered/unknown policy fails closed to manual.**

| Attack | Vector | Mitigation |
|---|---|---|
| Policy bypass of broker | auto-apply path skips `applyChanges` | auto + manual converge on the SAME `applyChanges` (L469) — policy gates the trigger, never the broker |
| Guard relaxation via policy | a level auto-applies a `CONFIG_GUARD`/`APPLY_DENY` path | no such level exists (no `auto-all`); `isAutoSafe` excludes them (§3 b/c/d/e/g); broker still re-validates |
| "Safe-looking" but risky path | `src/x.config.tsx`, `src/run.sh`, `src/loader.mjs` | classifier denies `*.config.*` (e), `.sh/.mjs/.js` (f), scripts (d) even under `src/`; deny-by-default |
| Mixed-diff smuggling | risky file batched with a safe one in one auto-apply | all-or-nothing per diff (§3) — one risky path holds the WHOLE diff |
| Policy file tampering | malware edits `policy.json` to widen | HMAC over `RUNTIME_TOKEN`; mismatch → fail closed to manual + BLOCKED event (§6) |
| Unknown/forged level | signed file names `auto-config` | enum has no such member → fail closed to manual (§6); classifier backstops |
| TOCTOU (path safe at classify, unsafe at apply) | symlink/content swapped between classify and apply | broker re-runs `applyAllowed`+symlink+realpath at apply (L496–510); failure → FAILED(apply-rejected) (ADR-028) |
| Silent enablement | feature on by default | default = manual; opt-in only; instantly reversible (§5) |

**sr-security HARD sign-off conditions (BLOCKING):** confirm (a) no policy level can auto-apply a `CONFIG_GUARD`/`APPLY_DENY`/`package.json`/`*.config.*`/`scripts/` path — verified by the classifier excluding them AND by the broker re-validating; (b) `isAutoSafe ⟹ applyAllowed` (auto-eligible is a strict subset); (c) auto and manual apply call the identical `applyChanges`; (d) tampered/missing/unknown policy fails closed to manual; (e) default ships as manual. This ADR may not merge without sr-security sign-off.

## Consequences

**Positive** — safe `src/*` edits auto-apply (the zero-click acceptance criterion) while every exec/config change still holds; opt-in, reversible, signed; the broker remains the single, unchanged choke point; tampering only ever makes the system safer.

**Negative / accepted** — `.mjs/.js`/`*.config.*`/`scripts/` always hold even when an edit is benign (accepted — exec-capable source is operator-reviewed in S1). The all-or-nothing rule means one risky file in a multi-file step blocks the safe files too (accepted — prevents smuggling; operator can apply the safe subset manually). HMAC adds a verify step on policy load (trivial).

**Observability** — each `GATING` decision logs `{agentId, level, autoEligible, heldReason}` to the run record (ADR-024 §7); BLOCKED event on policy-sig failure.

## Alternatives rejected

1. **Per-path allowlist that policy can extend** — turns policy into a guard-widening surface; the exact thing the invariant forbids. The classifier can only subtract from `applyAllowed`.
2. **`auto-all` / trust-the-agent level** — a single config flip auto-applies `package.json`/`scripts`. Does not exist by construction. No.
3. **Auto-apply per-file (apply the safe ones, hold the risky ones in a mixed diff)** — enables smuggling a risky file's *context* and complicates chain semantics; all-or-nothing per diff is safer.
4. **Unsigned policy file** — local tamper silently widens auto-apply. HMAC + fail-closed required.
5. **On-by-default auto-safe** — silent behavior change, violates "no behavior change unless opted in". Default manual.

## Open questions (need BOSS / security decision before build)

- **OQ-029.1 (BOSS):** which agents (if any) ship pre-set to `auto-safe`, or do all start `manual` and the BOSS opts in per agent after watching the loop? Recommend all-manual until proven.
- **OQ-029.2 (security):** keep `.mjs/.js` under `src/` as **risky/always-hold** in S1 (recommended), or allow auto-safe for non-entrypoint `src/**/*.tsx|ts|css` only and hard-deny all `.mjs/.js`? Either way exec-capable stays gated — confirm the extension list with sr-security.
- **OQ-029.3 (security):** HMAC over `RUNTIME_TOKEN` (rotates each runtime restart → policy must be re-signed on restart) vs a dedicated stable policy-signing key. Token-based is simpler but forces re-sign on restart (fail-closed to manual until re-signed — arguably a feature). Confirm.
