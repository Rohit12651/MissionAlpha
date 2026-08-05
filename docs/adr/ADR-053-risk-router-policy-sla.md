# ADR-053 — Risk Router · Per-band Policy · SLA (anti-approval-fatigue routing)

- **Status:** ACCEPTED — IMPLEMENTED (as-built). Written retroactively 2026-07-30 in P10 to pay the ADR-053 documentation debt that P6 deferred (program plan §5.6). The decision itself shipped in **P6** — `agent-runtime/risk.mjs` and `agent-runtime/policy.mjs` already carry `// ADR-053` headers in code.
- **Date:** 2026-07-30 (as-built record; implementation dated to P6, same day)
- **Slug:** `risk-router-policy-sla`
- **Plan:** Agent Inbox Program **P6 — Risk router · policy · SLA** (`docs/superpowers/plans/2026-07-30-agent-inbox-program-plan.md`; also `2026-07-30-inbox-P6.md`)
- **Deciders:** architect, senior-backend-1 (owner), **senior-security-engineer (BLOCKING — auto-apply path)**
- **Builds on:** ADR-029 (auto-apply policy — `isAutoSafe`/`applyAllowed`/`APPLY_DENY`, unchanged and only ever subtracted from), ADR-051 (Delivery row — `riskScore`/`riskBand`/`riskReasons`/`slaDeadline` reserved-nullable columns, now populated at mint), ADR-052 (`policy.autoapplied` event)

## Context

ADR-051 minted the Delivery but left `riskScore`/`riskBand`/`slaDeadline` NULL and blocked any write of `status='auto_approved'` "until ADR-053 ships with its own security sign-off." P6 is that ship. The goal (master-spec M4) is anti-approval-fatigue: classify every Delivery, let a BOSS-editable policy decide auto-approve (low) vs human (med) vs typed-confirm (high), and let SLA timers escalate — without ever letting the auto-apply path become a bypass of the broker's existing guards.

## Decision

### 1. Risk router — pure, deterministic, table-driven (`risk.mjs`)

`classify({changedPaths, diffstat, kind, newDependency})` → `{score 0..100, band, reasons[]}`. **No LLM, no network, no fs** — same input always yields the same output (no `Date`, no random). Bands are `["low","medium","high"]`; the score is clamped into a per-band `ENVELOPE` (low 5–39, medium 40–69, high 70–100) so the number and the label can never disagree.

Every rule **errs toward the higher band** because a wrong "low" is the only dangerous direction (it gates auto-apply upstream). `HIGH_PATTERNS` (checked first) cover `.env`, `secrets`/`credentials`, key material (`.pem/.key/.p12/.pfx`), auth/session/jwt/oauth surfaces, payment/billing surfaces, infra/terraform/k8s/deploy, Dockerfiles, `.github`/`.gitlab-ci`/`cloudbuild`/`Jenkinsfile` CI configs, and DB migrations — **all regexes are `/i` case-insensitive**. `LOW_PATTERNS` (tests, docs, markdown, changelog, project docs) apply only after HIGH so a security path never downgrades; everything else defaults to MEDIUM. A touched dependency manifest floors at MEDIUM; a large diff bumps up.

### 2. Per-band policy — deny-by-default (`policy.mjs`, `createBandPolicy`)

`routeFor(delivery)` maps band → friction verb: `auto_approve` / `notify` / `human` / `typed_confirm`. **Auto-approve is OFF by default**: `DEFAULT_BANDS = {low:'notify', medium:'human', high:'typed_confirm'}`. The BOSS edits `factory/policy.json` in Settings (plain JSON — no HMAC, because it can never widen `applyAllowed`/`CONFIG_GUARD`/`APPLY_DENY`); a bad/corrupt file falls back to the stricter `SAFE_BANDS = {low:'human', medium:'human', high:'typed_confirm'}`. `routeFor()` returning `'auto_approve'` is the **only** signal upstream `maybeAutoApply` reads.

An **always-human deny-list** (`DEFAULT_DENYLIST`, path globs) overrides band → human regardless of policy, and the built-in floor is **unioned in and un-removable** (an operator deny-list adds to it, never replaces it). `typed_confirm` stays `typed_confirm` even if it also hits a deny glob (most-restrictive wins). `isAutoSafe` re-asserts `applyAllowed` by construction, so the policy can only ever *subtract* from what the broker already permits.

### 3. SLA — absolute UTC deadlines, escalate on half-life / expiry

`DEFAULT_SLA_MS = {low: 86_400_000, medium: 28_800_000, high: 3_600_000}` (24h / 8h / 1h; overridable via `RUNTIME_SLA_LOW_MS`/`RUNTIME_SLA_MED_MS`/`RUNTIME_SLA_HIGH_MS`). Deadlines are stored absolute (no server-tick drift; UI renders the countdown). A sweep (`RUNTIME_SLA_SWEEP_MS`) re-notifies exactly once at half-life and, on expiry, sets the row to `expired` + emits an escalation event on the bus.

## As-built (2026-07-30)

Shipped in **P6** as designed. `risk.mjs` (classifier) and `policy.mjs` (`createBandPolicy` + deny-list floor + SLA constants) are live; the router runs at Delivery mint so `riskBand` attaches to an already-minted row (ADR-051 §4). `auto_approved` is now reachable — but only for `source='swarm'` LOW deliveries under an explicitly-opted-in policy, with an audit line + `policy.autoapplied` event on every auto-apply. Auto-approve remains **OFF unless the BOSS turns it on per band**. Tests: `agent-runtime/test/risk.test.mjs` (table-driven classification matrix), `band-policy.test.mjs` (policy precedence + deny-list), `policy.test.mjs`.

**Deviation / hardening vs proposal:** the first P6 security round found a **HIGH — `policy.mjs` `globToRe` compiled the deny globs case-SENSITIVE on a case-insensitive filesystem** (same defect class as the P5 CRIT), so `src/Secret/x` could slip a `src/secret/**` deny. Fixed: deny matching is now case-insensitive (comment in `policy.mjs` records that over-blocking on a case-sensitive FS is the safe direction). A MED (producer-side `isAutoSafe` re-assert) was also closed. Re-signed **SECURITY_APPROVED** (P6 gates: unit 192, runtime 674, vendor 28).

## Security invariants

| Invariant | Enforcement |
|---|---|
| Router grants no capability | `risk.mjs` only reads the diff shape it is handed and returns a verdict; it never touches fs/net/broker |
| Auto-apply can never widen the broker gate | `isAutoSafe(p) ⟹ applyAllowed(p)` by construction; policy only subtracts |
| Deny-list cannot be bypassed or removed | built-in `DEFAULT_DENYLIST` unioned + un-removable; case-insensitive match (over-blocks, never under-blocks) |
| Wrong-band is fail-safe | every classifier rule errs to the higher band; bad policy file → `SAFE_BANDS` |
| Every auto-apply is audited | audit line + `policy.autoapplied` event with reasons on each one |

## Open questions

- **OQ-053.1:** the operator-tunable deny-list UI (PolicyEditor) is F3-confirm-gated and reloads live; whether to expose per-band SLA overrides in the same surface (currently env-only) is deferred.
