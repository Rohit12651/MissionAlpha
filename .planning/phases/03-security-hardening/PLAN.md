---
phase: 3
name: Security Hardening
requirements: [R9, R10, R11, R12]
depends_on: [1, 2]  # sequential-only: 3.5/2.5 both touch ReviewPane.tsx, 1.6/3.5 both touch DeliveryCard.tsx
files_modified:
  - agent-runtime/metaharness.mjs (new)
  - agent-runtime/adapters/trust.mjs (new)
  - agent-runtime/adapters/github.mjs
  - agent-runtime/adapters/claude-sessions.mjs
  - agent-runtime/secret-scrub.mjs (PII detectors module alongside)
  - agent-runtime/pii-detect.mjs (new)
  - agent-runtime/inject-detect.mjs (new)
  - server.mjs (routes + SSE)
  - src/components/bos/ (metaharness tile)
  - src/components/inbox/DeliveryCard.tsx (trust + injection chips)
autonomous: true
commit_policy: NO COMMITS until BOSS says
---

<objective>
Harden exactly the surfaces Phases 1–2 widened. Config surface self-grades and snapshots; external adapters carry behavioral trust scores that only ADD friction; every egress payload gets typed PII detection; inbound content gets injection-shape flags that inform the human. The autonomy earned in 1–2 becomes autonomy you can trust.
</objective>

<skills mandatory="true">
- security-review + claude-code-security-review posture — THE phase skill; every task is security-sensitive; block on CRITICAL, fix HIGH before gate
- sp-test-driven-development · sp-verification-before-completion — every task; detector work is fixture-suite-first
- code-reviewer agent — per task
- gstack `/cso` (security check) + `/qa` + `/review`
- hallmark → impeccable → taste-skill — Task 3.5 chips/tile
- mem-search — prior sr-security findings (case-folding class, role-gate class) before writing containment-adjacent code
- caveman + headroom + codeburn — session ops
- Fable 5 — independent phase verification (Task 3.6)
</skills>

<tasks>

<task id="3.1" name="R9 — metaharness self-grade" tdd="true">
Files: agent-runtime/metaharness.mjs (new), server.mjs (`GET /runtime/selfgrade`), vault.mjs (snapshot records).
Action: Pure grader over the config surface: factory/*.json (registry, quality, deploy, station-perms, cadence), policy file, adapters file, MCP grants, deny-list coverage. Rubric (documented, closed): deny-by-default intact, deny-list unshrunk vs built-in floor, quality bins ⊆ ALLOWED_BINS, no auto-apply above low, adapter triple-gate flags on, guard thresholds sane, 0600 perms on data files. Score 0–100 + findings[{check, severity, detail, fix}]. Snapshot to vault on change (stable id per day — idempotent). Grade recomputed on config-file mtime change + on demand. Emits `selfgrade.changed` SSE frame. Grader is READ-ONLY — it never fixes, only reports (human decides, always).
Verify: `metaharness.test.mjs` — deliberately weakened fixtures (shrunk deny-list, added bin, auto-apply medium) each drop score and mint the right finding; unchanged config = stable score + no duplicate snapshots.
Done when: weakening station-perms.json visibly drops the live score and names the regression.
</task>

<task id="3.2" name="R10 — adapter trust scoring" tdd="true">
Files: agent-runtime/adapters/trust.mjs (new), adapters/github.mjs, adapters/claude-sessions.mjs, deliveries.mjs (trust stamp).
Action: Per-adapter-source score: `0.4·successRate + 0.2·uptime + 0.2·threatClean + 0.2·integrity` — inputs from observed history (decisions on that source's deliveries, adapter poll health, threat events, sync consistency). Threat input is an INJECTED SEAM (`threatFeed`) — 3.4's inject-detect wires into it later this phase; 3.2's tests drive it with fixtures, so 3.2 stands alone (no forward dependency at build time). Upgrades require N=10 observation minimum; downgrade instant on any threat hit. LAW 4 structural: score maps ONLY to added friction {none, note, typed-confirm-earlier}; the external triple-gate floor is not referenced by, and unreachable from, this module — pinned by test. Score persisted (null-proto store, 0600), stamped read-only onto external Delivery rows. History window 90d rolling.
Verify: `trust.test.mjs` — cold source = lowest tier; 10 approvals raise; single injection-flag hit drops instantly; no code path from trust value to any gate-bypass (grep + test assert the decide path ignores trust for floor checks).
Done when: two adapters with different histories show different scores; scores only ever tighten UX.
</task>

<task id="3.3" name="R11 — typed PII detection on egress" tdd="true">
Files: agent-runtime/pii-detect.mjs (new), secret-scrub.mjs (composition point — scrub chain still server-owned, ONE chain).
Action: Typed detectors: email, E.164/US phone, street-address heuristic, IP, credit-card (Luhn), SSN-shape. Composed INTO the existing egress scrub chain (never a second parallel chain — B2 law): per-destination policy {export: REDACT typed, sse/ui: PASS+count, audit-export: REDACT}. Each redaction tagged `[PII:type]` for downstream honesty. Detector suite is fixture-first: corpus of true/false positives per type committed as test fixtures (false-positive budget documented: <2% on fixture corpus).
Verify: `pii-detect.test.mjs` — per-type fixture pass; Luhn rejects non-CC digit runs; composition test proves single-chain (a payload passes scrub exactly once); audit export shows redactions, internal SSE unchanged.
Done when: audit/CSV export provably redacts typed PII; internal flows untouched; FP rate within budget on corpus.
</task>

<task id="3.4" name="R12 — injection-shape heuristics on ingest" tdd="true">
Files: agent-runtime/inject-detect.mjs (new), adapters/github.mjs, adapters/claude-sessions.mjs, risk.mjs (band bump input), deliveries.mjs.
Action: Detector over inbound external text (PR title/body, session text): closed pattern set — instruction-override shapes ("ignore previous/above instructions" family), tool-call mimicry (function-call JSON shapes), fence-escape attempts, hidden-text markers (zero-width runs, HTML comments with directives). Output {hits[{pattern, span}], score}. Wiring: hits → flag stored on Delivery + risk classifier input that can only RAISE band (monotonic — pinned). Never auto-reject, never strip content (human sees original with flags — informed, not filtered). Feeds trust.mjs threat input. Emits flag in `delivery.created` frame.
Verify: `inject-detect.test.mjs` — fixture corpus: known-injection samples hit, benign PRs ("this fixes the ignore-case bug") documented-tolerable FP behavior; band bump monotonic (never lowers); flags visible in inbox list route payload.
Done when: crafted malicious PR body arrives flagged + band-bumped, content intact, human informed.
</task>

<task id="3.5" name="Wire UI — trust/injection chips + self-grade tile" ui="true">
Files: src/components/inbox/DeliveryCard.tsx, src/components/bos/StatTiles.tsx or new SelfGradeTile, ReviewPane (flag spans highlighted).
Action: hallmark → impeccable → taste-skill. DeliveryCard: trust tier chip on external deliveries (source + tier, tooltip = component scores); injection flag chip (count, rust accent, existing semantic color system). ReviewPane: flagged spans highlighted in body render. PII wiring (R11 "PASS+count"): PII-count note on the audit-export dialog + per-delivery PII chip when count>0 — the count must render somewhere or R11 is half-wired. Cockpit: self-grade tile (score + delta arrow + top finding), opens findings list. Existing tokens, dark+light, 1280/390.
Verify: render tests for chip/tile logic; visual pass; a11y: chips have accessible labels.
Done when: a flagged external Delivery is visually unmistakable; score is one glance away.
</task>

<task id="3.6" name="Phase gate — CSO + Fable 5 verification">
Files: .planning/phases/03-security-hardening/VERIFICATION.md.
Action: Full regression + new suites. gstack `/cso` + `/qa`. security-review over the phase diff PLUS adversarial fixture replay (injection corpus through full ingest→inbox path live). code-reviewer agent. Fable 5 independent pass — must include one attempt to smuggle a gate-bypass via trust score and one crafted-config metaharness evasion; both must fail. VERIFICATION.md evidence per R9–R12. NO COMMIT.
Verify: all gates green; adversarial attempts documented-failed.
Done when: R9–R12 evidenced; Law 4 audit clean.
</task>

</tasks>

<success_criteria>
- Self-grade live, snapshots on change, drops on deliberate weakening (demonstrated).
- Trust visible on external cards; monotonic friction-only (audited + pinned by test).
- Typed PII redaction on exports within FP budget; single scrub chain preserved.
- Injection flags on crafted fixtures end-to-end live; band bumps monotonic.
- All prior suites green; no regression; no CRITICAL/HIGH open.
</success_criteria>
