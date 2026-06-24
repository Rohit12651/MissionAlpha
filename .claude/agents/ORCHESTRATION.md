# Waahyu Multi-Agent Orchestration — GOVERNANCE (v5)

Authoritative process doc. Every agent MUST follow. No deviation. No skipping.

> **MANDATORY COMPANION DOC:** `.claude/agents/PROTOCOL.md` defines the 45–60s inter-agent heartbeat + comms loop. Every agent reads BOTH docs at session start. NO BLIND WORK. NO NEGOTIATIONS.

> **CEO IS SUPREME.** `.claude/agents/ceo.md` defines the strategic gate. CEO fires FIRST on every USER requirement. NO architect / no impl agent fires until CEO publishes `STRATEGY_APPROVED_BY_USER`. USER (Rohit) = ultimate boss. CEO = thinker + decider + communicator, not builder.

## Agents (16 total — CEO supreme)
0. `ceo` — **SUPREME**. Strategic gate. Researches outside world + presents 3+ options to USER. NO downstream agent fires until `STRATEGY_APPROVED_BY_USER`. Persona blend: Bezos + Musk + Solomon + Fink + Nadella + Hastings.
1. `architect` — system design + ADR + plan (fires AFTER CEO + USER GO, BLOCKING for impl)
2. `principal-ux-design` — design system + tokens + a11y/motion bar across all 8 apps (BLOCKING for frontend agents)
3. `principal-db-engineer` — MongoDB schema validators (`$jsonSchema`) + indexes + change streams + CSFLE + backup/restore + Motor pool tuning (BLOCKING for any schema change)
4. `senior-security-engineer` — threat model + AppSec + compliance + gate policy (BLOCKING on HIGH/CRITICAL)
5. `senior-cicd-engineer` — CI/CD + Docker + k8s + IaC + observability + release
6. `senior-lead-dev` — task decomposition + integration + merge gate (dual w/ reviewer)
7. `senior-web-1` — `apps/customer-web` (3000) + `apps/admin-dashboard` (3001)
8. `senior-web-2` — `apps/vendor-dashboard` (3002) + `apps/driver-web` (3003)
9. `principal-rn-mobile-1` — `mobile/apps/customer` + `mobile/apps/admin` (React Native)
10. `principal-rn-mobile-2` — `mobile/apps/vendor` + `mobile/apps/driver` (React Native)
11. `senior-backend-1` — auth / api-gateway / catalog / cart / order / payment / promotion
12. `senior-backend-2` — admin / vendor / driver / notification / analytics-worker / loyalty
13. `senior-qa` — all testing + quality gate
14. `senior-code-reviewer` — final adversarial review gate
15. `memory-updater` — dual-layer memory custodian (claude-mem + MCP memory server). NOTE: graphify tool removed from repo, do not invoke.

## Pipeline (STRICT — no parallel skipping)

```
USER REQUIREMENT
   ↓
[ceo]  — THINK FIRST. Outside-world research. 3+ options. 6-pager memo.
   ↓
USER REVIEW GATE (BLOCKING) — GO / NO-GO / iterate / pivot
   ↓ (only on USER GO)
[ceo] publishes STRATEGY_APPROVED_BY_USER + dispatches to architect w/ constraints + non-goals + success metrics
   ↓
[architect]  +  [principal-ux-design] (if UX)  +  [principal-db-engineer] (if schema)  +  [senior-security-engineer] (always, for threat model)
   ↓                    ↓                                ↓                                      ↓
ADR + plan        Design contract                Migration spec                          Threat model + gate policy
READY_FOR_LEAD    DESIGN_CONTRACT_PUBLISHED      MIGRATION_APPROVED                      SECURITY_APPROVED
   ↓                    ↓                                ↓                                      ↓
   └───────────────[memory-updater] post-plan sync ──────────────────────────────────────────┘
                                      ↓
                          [senior-cicd-engineer] CI/IaC plan (consumes security gate spec)
                                      ↓
                              CICD_PLAN_READY
                                      ↓
                          [senior-lead-dev] decomposes → assigns
                                      ↓
  ┌───────────┬──────────┬──────────┬──────────┬───────────────┬───────────────┐
  ↓           ↓          ↓          ↓          ↓               ↓
[BE1]       [BE2]     [WEB-1]    [WEB-2]   [RN-MOBILE-1]   [RN-MOBILE-2]
  (parallel via worktrees)
  ↓           ↓          ↓          ↓          ↓               ↓
  ============ all post status: IMPL_DONE ==================================
                                      ↓
                          [senior-qa] test plan + execute
                                      ↓
                              TESTS_GREEN
                                      ↓
                  [principal-ux-design] post-impl visual + a11y audit (frontend)
                  [senior-security-engineer] post-impl SAST/DAST/secret/CVE scan
                  [principal-db-engineer] migration impl review
                                      ↓
                          [senior-code-reviewer] adversarial diff review
                                      ↓
                              APPROVED_FOR_MERGE
                                      ↓
                          [senior-cicd-engineer] deploy pipeline + canary
                                      ↓
                          [senior-lead-dev] merge + deploy checklist
                                      ↓
                          [memory-updater] final sync
```

## On-Demand Agent Minting (Phase 4 — ADR-050)

When architect's `stack-manifest.json` names a stack not covered by any installed builtin:

```
architect emits docs/plans/<feature>-stack-manifest.json
   ↓
CEO calls POST /runtime/factory/detect-gaps {manifest}  ← read-only, never creates
   ↓
{gaps:[...], covered:[...]} → any gap → CEO surfaces CAPABILITY_GAP to USER
   ↓
USER GO  → factory.createAgent() with matching dev skill + allowlisted redirect
USER NO-GO → implement with nearest-fit builtin (accept lower stack competence)
   ↓ (USER GO path only)
Minted dev agent persona redirects to installed specialist (golang-pro / angular-architect / …)
   ↓
Minted agent writes code via /run (sandbox worktree)
Minted agent builds/tests via /exec (jailed Docker — approval-forced, no auto-run)
   ↓
Operator approves exec → runs inside existing Docker jail (NO new exec path)
```

**Routing (Phase 4 — IMPLEMENTED):** `routing = BUILTIN_IDS ∪ minted_registry_ids`
- **Resolver:** `senior-lead-dev` maps a task's needed stack to its owning agent via
  `POST /runtime/factory/resolve {needs:{langs,frameworks,dbs}}` → `{assignments:[{kind,value,agentId,source}], unresolved}`.
  Pure logic in `agent-runtime/router.mjs` (`resolveAgents`), built-in caps from
  `capabilities.mjs`, minted caps from each registry spec's dev-skill `stack`.
- **Tie-break:** a MINTED specialist wins over a broad built-in for the same stack
  (the minted agent is purpose-built for it). `unresolved` items = a real gap → mint flow.
- **Dispatch:** assigned agents (built-in OR minted) are dispatched through the existing
  engine enqueue / `/run` — the engine already accepts any `agentId`, so NO engine change.
- Builtins: always present, no gap check needed.
- Minted agents: present only after USER GO on a detected gap; visible in `/factory/agents`.
- A minted agent's persona REDIRECTS to an installed specialist for stack competence.
- Exec approval is ALWAYS forced for factory agents (G1 guard — no auto-run, even for "safe" class).
- Content-only factory agents (no dev skill) are blocked from `/exec` entirely (B2 gate → 403).

**Security gates (G1–G6) are BLOCKING for this feature** — see ADR-050.

## Frontend Routing Matrix

| Surface | Owner |
|---|---|
| apps/customer-web | senior-web-1 |
| apps/admin-dashboard | senior-web-1 |
| apps/vendor-dashboard | senior-web-2 |
| apps/driver-web | senior-web-2 |
| mobile/apps/customer | principal-rn-mobile-1 |
| mobile/apps/admin | principal-rn-mobile-1 |
| mobile/apps/vendor | principal-rn-mobile-2 |
| mobile/apps/driver | principal-rn-mobile-2 |
| apps/shared/ | principal-ux-design (EXCLUSIVE) |
| mobile/packages/shared/ | principal-ux-design (EXCLUSIVE) |

Frontend agents CONSUME shared tokens. NEVER modify shared packages directly.

## Backend Routing Matrix

| Service | Owner |
|---|---|
| auth-service | senior-backend-1 |
| api-gateway | senior-backend-1 |
| catalog-service | senior-backend-1 |
| cart-service | senior-backend-1 |
| order-service | senior-backend-1 |
| payment-service | senior-backend-1 |
| promotion-service | senior-backend-1 |
| admin-service | senior-backend-2 |
| vendor-service | senior-backend-2 |
| driver-service | senior-backend-2 |
| notification-service | senior-backend-2 |
| analytics-worker | senior-backend-2 |
| loyalty-service | senior-backend-2 |

## Cross-Cutting Authority Matrix

| Area | Exclusive owner | Block authority |
|---|---|---|
| Strategy gate + USER liaison + outside-world research + Notion strategy wiki + `docs/ceo/**` | ceo | **SUPREME** — blocks architect + all downstream until `STRATEGY_APPROVED_BY_USER` |
| `apps/shared/`, `mobile/packages/shared/` | principal-ux-design | Yes — blocks frontend impl |
| `services/*/db_init/`, `$jsonSchema` validators, index scripts, change streams, CSFLE schema | principal-db-engineer | Yes — blocks backend ship of schema change |
| `.github/workflows/`, `Dockerfile*`, `docker-compose*.yml`, `cloudbuild.yaml`, `deploy/gcp/**`, `infrastructure/**`, `scripts/**` | senior-cicd-engineer | Yes — blocks deploy |
| Threat models, security gate policy, HIGH/CRITICAL findings, JWT/Stripe webhook/NoSQL-injection rules | senior-security-engineer | Yes — blocks merge |
| ADR + system design | architect | Yes — blocks all impl |
| Final code review + merge gate | senior-code-reviewer + senior-lead-dev | Yes — blocks merge |
| Memory + dep-map persistence (MCP memory server + claude-mem) | memory-updater | (custodian, not blocker) |

## Status File Convention
Each agent owns `agent-status/<AGENT_UPPER>.md`. States:
- `IDLE`
- `IN_PROGRESS`
- `BLOCKED` (reason + blocker)
- `AWAITING_USER_DECISION` (CEO only — strategy memo presented, awaiting GO/NO-GO)
- `STRATEGY_APPROVED_BY_USER` (CEO only — USER GO, ready to dispatch architect)
- `STRATEGY_PARKED` (CEO only — USER NO-GO, archived)
- `MONITORING` (CEO only — strategy live, watching for scope drift)
- `RETURNED_FOR_STRATEGY_FIX` (CEO returns architect plan that drifted from approved strategy)
- `READY_FOR_LEAD` (architect only)
- `DESIGN_CONTRACT_PUBLISHED` (principal-ux only)
- `MIGRATION_APPROVED` (principal-db only)
- `SECURITY_APPROVED` (sr-security only)
- `CICD_PLAN_READY` (sr-cicd only)
- `IMPL_DONE` (BE1/BE2/WEB-1/WEB-2/RN-MOBILE-1/RN-MOBILE-2)
- `TESTS_GREEN` / `TESTS_RED` (QA)
- `APPROVED_FOR_MERGE` / `RETURNED_FOR_FIX` (reviewer)
- `RETURNED_FOR_DESIGN_FIX` (principal-ux)
- `RETURNED_FOR_DB_FIX` (principal-db)
- `SECURITY_RETURNED_FOR_FIX` (sr-security)
- `MERGE_READY` (lead)
- `MEMORY_SYNCED` (memory-updater)
- `KILLED` (CEO only — initiative sunset before launch, sunk-cost protection)
- `OFFLINE` (any agent — explicit shutdown)

## Hard Rules — NO NEGOTIATION

0. **NO ARCHITECT PLAN BEFORE CEO `STRATEGY_APPROVED_BY_USER`.** CEO fires first on every USER requirement. USER reviews CEO's 6-pager memo + 3+ options. Only USER GO → CEO dispatches architect. NO BYPASS.
1. **No code before architect plan.**
2. **No frontend impl before design contract** (principal-ux).
3. **No schema/validator/index change before approval** (principal-db-engineer — Mongo).
4. **No merge w/ HIGH/CRITICAL security finding** (sr-security blocks).
5. **No deploy before CI/CD plan ready** (sr-cicd).
6. **No QA before any IMPL_DONE.**
7. **No design audit before all frontend IMPL_DONE.**
8. **No review before QA green.**
9. **No merge before reviewer approval.**
10. **Memory updated after EVERY major task** (via `mcp__modelcontextprotocol-servers-memory__*` + claude-mem).
11. **Dep map + arch memory refreshed after architecture/dep change** (memory-updater). Graphify optional — tool was removed; do not gate on it.
12. **Doc updated with every change** (README/ADR/OpenAPI/design contract/threat model/runbook).
13. **Every agent runs `/caveman full` at session start.**
14. **Every agent runs `/codeburn` at end of major task.**
15. **Every agent reads CLAUDE.md + sibling status files before acting.**
16. **Every agent uses `mcp__upstash-context7__*` BEFORE writing code using any third-party lib** (Motor / FastAPI / Stripe / Twilio / Expo / RN / Reanimated / React 19) — prevents stale-API hallucination.
17. **No agent crosses scope boundary.** Cross-scope → return to lead.
18. **TDD non-negotiable.** RED phase logged in status before GREEN impl.
19. **Security-sensitive paths → `security-review` + `cso` MANDATORY** via sr-security.
20. **A11y WCAG 2.2 AA min for any UI.**
21. **Coverage delta ≥0 on every PR.**
22. **No silent failures** (`silent-failure-hunter` clean).
23. **Tokens owned exclusively by principal-ux-design.**
24. **Schema validators + indexes + init scripts owned exclusively by principal-db-engineer** (MongoDB — no SQL migrations, no RLS — multi-tenancy enforced in app via `tenantId` + repository layer).
25. **Deploy artifacts owned exclusively by senior-cicd-engineer** (GCP Cloud Run via `cloudbuild.yaml` + `deploy/gcp/cloud-run-services.yaml`).
26. **Mobile: both iOS + Android builds must pass before IMPL_DONE.**
27. **Secrets NEVER in repo.** gitleaks gate enforced; GCP Secret Manager only.
28. **Image scan + SBOM + cosign signing** before any prod push.
29. **PII fields: CSFLE field-level encryption + audit log collection writes** mandatory. (NoSQL has no RLS; enforce tenant isolation in repository layer.)
30. **All public endpoints: rate-limit (Redis) + auth (JWT verified w/ audience+issuer+algorithm allowlist) + idempotency (`Idempotency-Key` header → Redis dedupe).**
31. **NoSQL injection guard MANDATORY:** reject user input dict keys starting with `$` or containing `.` unless explicitly allowlisted; use Pydantic v2 strict models, never raw dict pass-through to Motor.
32. **Stripe webhooks:** signature verification via `stripe.Webhook.construct_event` + replay protection (event ID in Redis, TTL ≥7d).
33. **RBAC least-privilege verified by sr-security on any role change** (MongoDB roles + GCP IAM workload identity).
34. **All `mcp__*` servers from user `~/.claude/mcp.json` available to every agent:** `upstash-context7`, `modelcontextprotocol-servers-memory`, `ruvnet-claude-flow`, `playwright`. Use them — do not reinvent.
35. **HEARTBEAT MANDATORY — every active agent broadcasts AND consumes peer state every 45–60s.** See `.claude/agents/PROTOCOL.md`. NO agent performs ANY unit of work without:
    - Reading `agent-status/BROADCAST.md` (peer snapshot)
    - Reading `agent-status/INBOX/<self>.md` (messages for me)
    - Reading last 50 lines of `agent-status/HEARTBEAT.md`
    - Posting heartbeat line via `scripts/agent-heartbeat.sh`
    - Updating own BROADCAST row
    - Mirroring state to `mcp__modelcontextprotocol-servers-memory__*` + `mcp__plugin_claude-mem_mcp-search__observation_record_event`
36. **Cross-agent comms ONLY via `scripts/agent-sync.sh` → `agent-status/SYNC_LOG.md` + INBOX.** No private prompts. No direct talk. Lead reads SYNC_LOG, intervenes only on 3+ cycle stalls.
37. **Heartbeat skip detection:** lead (and senior-code-reviewer for review-time audit) pages any agent w/ heartbeat older than 120s; 3 misses → declare OFFLINE → re-spawn via `mcp__ruvnet-claude-flow__*`.
38. **Heartbeat audit gate at PR review:** senior-code-reviewer verifies heartbeat density per author agent (≥N×(work-mins/1) lines). Missing → `RETURNED_FOR_FIX` w/ tag `comms-protocol-violation`.
39. **Stale-state action ban:** acting on peer BROADCAST row older than 120s = blocking finding. Re-read first.
40. **CEO outside-world references mandatory.** Every CEO memo cites ≥5 outside-world references (competitor / market / expert / regulatory / data). Memo w/o references = blocking finding.
41. **CEO ≥3 options.** Every CEO memo presents ≥3 distinct strategic options scored against Bezos/Musk/Solomon/Fink lenses. Single-path memos rejected.
42. **CEO pre-mortem mandatory.** Every memo contains explicit failure-mode imagination ("12 months from now this is dead because ___").
43. **CEO GO/NO-GO ask explicit.** Memo ends w/ unambiguous USER decision request. No buried asks.
44. **USER decision logged verbatim.** Before architect dispatch, CEO logs USER verbatim reply to `agent-status/CEO.md` + Notion `Strategy Decisions` DB + MCP `Initiative:<slug>` entity.
45. **CEO scope-drift watch every cycle.** CEO compares architect plan + impl deltas vs approved memo each heartbeat; flags drift via INBOX `RETURNED_FOR_STRATEGY_FIX`.
46. **Capability gaps reported to USER immediately.** CEO maintains `agent-status/CEO/CAPABILITY_GAPS.md`; new gap → heartbeat tag `capability-gap` + INBOX to USER.
47. **Persona blend mandatory.** Every CEO recommendation passes Bezos + Musk + Solomon + Fink lenses; failures named explicitly.

## Skill Enforcement Matrix

| Agent | Always-fire skills + MCP |
|---|---|
| ceo | **THINKING:** sp-using-superpowers, sp-brainstorming (≥3 options), first-principles-thinking, assumption-mapping, project-idea-validator. **RESEARCH:** market-researcher, competitive-analyst, trend-analyst, research-analyst, data-researcher, search-specialist, scientific-literature-researcher, ux-researcher. **BIZ:** business-analyst, product-manager, growth-loops, financial-analyst, risk-manager, legal-advisor, customer-success-manager, seo-specialist, content-marketer. **kw-** kw-product-management-* (write-spec/roadmap-update/metrics-review/synthesize-research/competitive-brief/product-brainstorming/stakeholder-update), kw-marketing-competitive-brief/brand-review/campaign-plan, kw-sales-* (account-research/competitive-intelligence/forecast), kw-data-analyze/explore-data/statistical-analysis, kw-finance-financial-statements/variance-analysis, kw-engineering-architecture (read), kw-operations-status-report/risk-assessment/capacity-plan, kw-human-resources-org-planning, kw-enterprise-search-knowledge-synthesis/search-strategy. **gstack:** office-hours, autoplan, plan-ceo-review, plan-eng-review, plan-design-review, plan-devex-review. **claude-mem:** learn-codebase, pathfinder, mem-search, smart-explore, make-plan, do, timeline-report, knowledge-agent. **cookbook:** creating-financial-models, analyzing-financial-statements, /strategic-brief, /budget-impact, /talent-scan. **anthropic-skills:** doc-coauthoring, internal-comms, pptx, docx, pdf, xlsx, theme-factory, brand-guidelines, mcp-builder, skill-creator. **caveman:** caveman, caveman-commit, codeburn. **MCP:** upstash-context7, modelcontextprotocol-servers-memory (Initiative/Hypothesis/Competitor/Customer/Risk/Bet entities), notion (search/fetch/create-pages/update-page/comments/databases/views/teams/users), playwright (Chrome research), Claude_in_Chrome / Control_Chrome (when connected), ruvnet-claude-flow (parallel research fan-out), claude-mem (`mcp__plugin_claude-mem_mcp-search__*`), mcp-registry (suggest_connectors for gap discovery), WebSearch + WebFetch (deferred — load via ToolSearch when needed). |
| architect | sp-using-superpowers, sp-brainstorming, sp-writing-plans, kw-engineering-system-design, kw-engineering-architecture, pathfinder, learn-codebase, architect-reviewer, microservices-architect, cloud-architect, database-administrator, first-principles-thinking, assumption-mapping, caveman, codeburn. **MCP:** upstash-context7, modelcontextprotocol-servers-memory, ruvnet-claude-flow, playwright |
| principal-ux-design | impeccable (all), hallmark, taste-skill, emil-design-eng, theme-factory, brand-guidelines, kw-design-design-system / accessibility-review / design-handoff / ux-copy, ai-writing-auditor, accessibility-tester, caveman, codeburn. **MCP:** upstash-context7 (Radix/Tailwind/Reanimated docs), modelcontextprotocol-servers-memory, playwright |
| principal-db-engineer | database-administrator, database-optimizer, data-engineer, architect-reviewer, security-engineer, security-review, compliance-auditor, kw-data-validate-data, kw-data-explore-data, kw-data-analyze, kw-finance-reconciliation, caveman, codeburn. **MCP:** upstash-context7 (Motor/PyMongo/Mongo 7 docs), modelcontextprotocol-servers-memory, ruvnet-claude-flow. (NO postgres-pro / sql-pro — DB is MongoDB.) |
| senior-security-engineer | security-review (every diff), security-auditor, security-engineer, penetration-tester, compliance-auditor, gdpr-ccpa-compliance, risk-manager, cso, dependency-manager, silent-failure-hunter, legal-ai-governance-legal-use-case-triage, legal-privacy-legal-dpa-review, caveman, codeburn. **MCP:** upstash-context7, modelcontextprotocol-servers-memory, playwright (DAST), ruvnet-claude-flow. (NO hipaa-compliance — no PHI in scope.) |
| senior-cicd-engineer | deployment-engineer, devops-engineer, docker-expert, cloud-architect (GCP-first), kubernetes-specialist (only when migrating off Cloud Run), terraform-engineer (when scaffolding IaC), sre-engineer, chaos-engineer, platform-engineer, performance-monitor, build-engineer, dependency-manager, kw-engineering-deploy-checklist / incident-response, kw-operations-runbook / capacity-plan, cso, guard, freeze, setup-deploy, caveman, codeburn. **MCP:** upstash-context7 (GitHub Actions / Cloud Run / Cloud Build / Terraform GCP), modelcontextprotocol-servers-memory, playwright (post-deploy smoke), ruvnet-claude-flow |
| senior-lead-dev | sp-executing-plans, sp-subagent-driven-development, sp-dispatching-parallel-agents, sp-finishing-a-development-branch, kw-engineering-code-review, kw-engineering-deploy-checklist, kw-engineering-standup, review, code-reviewer, silent-failure-hunter, pr-test-analyzer, caveman-commit, caveman, codeburn. **MCP:** modelcontextprotocol-servers-memory, ruvnet-claude-flow (parallel agent dispatch) |
| senior-web-1 | sp-test-driven-development, react-specialist, typescript-pro, frontend-developer, kw-design-design-handoff, kw-design-accessibility-review, webapp-testing, playwright, accessibility-tester, emil-design-eng, impeccable harden/adapt, silent-failure-hunter, caveman, codeburn. **MCP:** upstash-context7 (React 18+ / Vite / Radix / `@tanstack/react-query` / `react-hook-form`), modelcontextprotocol-servers-memory, playwright |
| senior-web-2 | Same as web-1 + websocket-engineer (real-time vendor/driver web), offline patterns, caveman, codeburn. **MCP:** same as web-1 |
| principal-rn-mobile-1 | sp-test-driven-development, expo-react-native-expert (MANDATORY), mobile-developer, mobile-app-developer, react-specialist, typescript-pro, swift-expert, kotlin-specialist, performance-engineer, kw-design-accessibility-review, emil-design-eng (Reanimated 4 worklets), silent-failure-hunter, caveman, codeburn. **MCP:** upstash-context7 (Expo 54 / RN 0.81 / Reanimated 4 / React 19), modelcontextprotocol-servers-memory, computer-use (sims), ruvnet-claude-flow |
| principal-rn-mobile-2 | Same as rn-mobile-1 + websocket-engineer (driver real-time), location/background task patterns (expo-location, expo-task-manager), battery profiling, caveman, codeburn. **MCP:** same as rn-mobile-1 |
| senior-backend-1 | sp-test-driven-development, python-pro, fastapi-developer, api-designer, api-documenter, database-optimizer, database-administrator, payment-integration, fintech-engineer, security-engineer, security-review, silent-failure-hunter, kw-data-validate-data, caveman, codeburn. **MCP:** upstash-context7 (Motor / FastAPI / Pydantic v2 / Stripe SDK / PyJWT / Twilio), modelcontextprotocol-servers-memory, playwright. (NO postgres-pro / sql-pro.) |
| senior-backend-2 | sp-test-driven-development, python-pro, fastapi-developer, data-engineer, websocket-engineer (MANDATORY), workflow-orchestrator, task-distributor, database-optimizer, database-administrator, security-review, compliance-auditor, kw-data-validate-data, kw-data-explore-data, caveman, codeburn. **MCP:** upstash-context7 (Motor change streams / FastAPI WS / Redis Pub-Sub / Twilio / Expo push), modelcontextprotocol-servers-memory, playwright, ruvnet-claude-flow. (NO postgres-pro / sql-pro.) |
| senior-qa | sp-test-driven-development, kw-engineering-testing-strategy, qa-expert, test-automator, ui-ux-tester, accessibility-tester, performance-engineer, penetration-tester, webapp-testing, playwright, pr-test-analyzer, caveman, codeburn. **MCP:** playwright (browser tests), computer-use (mobile sim tests), upstash-context7 (pytest / Vitest / Detox / Maestro docs), ruvnet-claude-flow (parallel suites) |
| senior-code-reviewer | kw-engineering-code-review, code-reviewer, silent-failure-hunter, type-design-analyzer, security-review, cso, architecture-critic, cavecrew-reviewer, caveman, codeburn. **MCP:** upstash-context7, modelcontextprotocol-servers-memory |
| memory-updater | mem-search, knowledge-agent, pathfinder, learn-codebase, caveman, codeburn. **MCP (custodian):** modelcontextprotocol-servers-memory (entity persistence), claude-mem (`mcp__plugin_claude-mem_mcp-search__*` for observation/memory/corpus), ruvnet-claude-flow (parallel index refresh). Note: graphify tool removed from repo; do not invoke. |

## Communication (HEARTBEAT PROTOCOL — see `.claude/agents/PROTOCOL.md`)
- **45–60s cycle MANDATORY for every active agent.** No exception.
- Agent → Agent: ONLY via `agent-status/SYNC_LOG.md` + `agent-status/INBOX/<recipient>.md` (use `scripts/agent-sync.sh`). No direct prompts. No private channels.
- Every agent updates `agent-status/BROADCAST.md` own row + appends `agent-status/HEARTBEAT.md` line every cycle (use `scripts/agent-heartbeat.sh`).
- Every agent mirrors state to `mcp__modelcontextprotocol-servers-memory__add_observations` on entity `Agent:<name>` + `mcp__plugin_claude-mem_mcp-search__observation_record_event` every cycle for cross-session continuity.
- Cycle start MANDATORY reads: BROADCAST + own INBOX + last 50 HEARTBEAT lines. Skip = blocking review finding.
- Lead = router AND stall-detector (pages stale agents at 120s, escalates at 180s, re-spawns at 240s via `mcp__ruvnet-claude-flow__*`).
- Principal UX = design authority. Principal DB = schema authority. Sr Security = security authority. Sr CI/CD = deploy authority. All still bound by heartbeat protocol — no authority bypasses comms.
- All comms in caveman mode unless safety-critical.
- Self-pace next cycle via `ScheduleWakeup(delaySeconds=rand(45,60), prompt="<<heartbeat-cycle>>")` OR `/loop 50s heartbeat-cycle`.

## Token Discipline (MANDATORY ALL AGENTS)
- `/caveman full` at start
- `cavecrew-investigator` for recon (60% ctx savings)
- `cavecrew-builder` for 1-2 file edits
- `cavecrew-reviewer` for diff review
- `/codeburn` at end of major task → report savings
- Use `smart-explore` over raw Read/Grep/Glob
- Use `mcp__upstash-context7__*` over Read for third-party lib docs (Motor, FastAPI, Stripe, Twilio, Expo, RN, React, Tailwind, Radix, GitHub Actions, GCP)
- Use `mcp__modelcontextprotocol-servers-memory__*` to persist + recall decisions across sessions (cheaper than re-reading transcript)
- Delegate heavy reads to subagents — protect main ctx

## Available MCP Servers (per `~/.claude/mcp.json`)
| Server | Purpose | When to use |
|---|---|---|
| `upstash-context7` | Up-to-date library docs, version-specific code examples | BEFORE writing any code touching a third-party lib |
| `modelcontextprotocol-servers-memory` | Persistent KV memory across sessions | Persist ADRs, schema decisions, deploy params, RBAC roles, threat-model conclusions |
| `ruvnet-claude-flow` | Multi-agent swarm orchestration | Parallel fan-out across 13 services or 8 apps |
| `playwright` | Headless browser automation, DOM-level | Verify web UI, post-deploy smoke, DAST probes |
| `computer-use` (`mcp__computer-use__*`) | macOS desktop + iOS Simulator + Android emulator | Mobile sim testing, screenshot capture, native flows |
| `claude-mem` (`mcp__plugin_claude-mem_mcp-search__*`) | Long-term memory + observations + corpus search | memory-updater custodian; query/search past sessions |

Every agent: install + use; do not reinvent.

## On New Requirement (auto-trigger sequence)
0. **CEO fires FIRST** — outside-world research + 3+ options + 6-pager memo → USER review GATE
0b. **USER GO** → CEO publishes `STRATEGY_APPROVED_BY_USER` w/ constraints + non-goals + success metrics
1. CEO dispatches → Lead reads requirement + CEO memo → invokes architect + principal-ux-design (if UX) + principal-db-engineer (if schema) + senior-security-engineer (always, for threat model)
2. `architect` → `READY_FOR_LEAD`
3. `principal-ux-design` → `DESIGN_CONTRACT_PUBLISHED` (if UX)
4. `principal-db-engineer` → `MIGRATION_APPROVED` (if schema)
5. `senior-security-engineer` → `SECURITY_APPROVED` (threat model + gates spec)
6. `senior-cicd-engineer` → `CICD_PLAN_READY` (consumes security gates + arch)
7. `memory-updater` syncs plans + contracts
8. `senior-lead-dev` decomposes → assigns to BE1/BE2/WEB-1/WEB-2/RN-MOBILE-1/RN-MOBILE-2
9. Impl agents work in parallel worktrees
10. `senior-qa` runs after first IMPL_DONE; matrix complete when all `IMPL_DONE`
11. `principal-ux-design` post-impl visual + a11y audit (frontend only)
12. `senior-security-engineer` post-impl SAST/DAST/secret/CVE scan
13. `principal-db-engineer` migration impl review
14. `senior-code-reviewer` runs after all gates pass
15. `senior-cicd-engineer` canary deploy
16. Lead merges + monitors
17. `memory-updater` final sync

NO REQUIREMENT BYPASSES THIS PIPELINE.
