# Plan — Agent Factory (BOSS spawns AI-authored agents w/ real-posting skills)

**Slug:** `agent-factory`
**Author:** CEO + architect
**Status:** PLAN — AWAITING_USER_DECISION
**Date:** 2026-06-17
**Mode:** caveman (bus + this doc)

## BOSS decisions (locked, NO NEGOTIATION)
1. Skills = **real external posting** (not draft-only).
2. New agents **persist** (survive restart).
3. **Path B** — AI-authored (Claude writes the agent from NL). Manual form = later.
4. New agents run on **same runtime/subscription + F2b sandbox**.

## Goal
BOSS types need → Claude (`agent-creator`) authors full agent spec → BOSS reviews → agent
registered + live on board → chat/dispatch/run-able. Agent can hold **skills incl. real social
posting** on multiple accounts, every external post **BOSS-gated**.

## HARD security constraints (baked in — non-negotiable)
- Claude NEVER sees/enters credentials/API keys/passwords. Creds via BOSS's own OAuth/password-mgr
  in his browser; stored by a credential broker; runtime references token IDs, never raw secrets.
- Real post = irreversible outward action → **per-post BOSS confirm gate** (F3-style). No auto-post.
- Multi-account posting = real side effects → rate-limited, audited, dry-run preview first.

---

## AGENT ROSTER — who does what (NO NEGOTIATION)

| Agent | Owns |
|---|---|
| **ceo** | strategy gate, scope/non-goals, per-phase GO |
| **architect** | ADRs: agent-registry, spec schema, creation pipeline, integration+credential architecture |
| **principal-ux-design** | UX contract + design tokens for factory flow (consumes impeccable/emil/gstack) |
| **senior-web-1** | UI: Create-Agent flow (describe→review spec→confirm) + agent gallery |
| **senior-web-2** | UI: skill catalog picker, credential-connect UI, per-post approval modal |
| **senior-backend-1** | dynamic agent registry + per-agent system prompt + persistence |
| **senior-backend-2** | `agent-creator` (NL→spec) + integration/posting layer (composio/MCP) |
| **senior-security-engineer** | threat model: credential broker, external-post guardrails, agent-creation abuse, prompt-injection→post |
| **senior-cicd-engineer** | integration config, secrets storage wiring, env |
| **senior-qa** | e2e + adversarial tests |
| **memory-updater** | persist decisions, registry schema |

### Design skills (mandatory, applied in Phase 2 + 7)
- `impeccable` (craft + audit) · `emil-design-eng` (motion: modals, gallery enter, approval gate) ·
  `hallmark`/`taste-skill` (anti-slop structure) · `gstack design-review` (critique pass) ·
  `ui-designer` + `frontend-developer` agents for component build. OKLCH tokens, a11y, reduced-motion,
  mobile floors — all enforced.

---

## PHASES (detailed)

### PHASE 0 — CEO gate
- Owner: ceo. State → AWAITING_USER_DECISION → STRATEGY_APPROVED on BOSS GO.
- Non-goals: no manual-form path yet (Path A later); no auto-post w/o BOSS confirm; Claude never
  handles raw creds; no agent self-creating agents (BOSS-only trigger).
- Exit: BOSS GO.

### PHASE 1 — architect: ADRs + contracts (BLOCKS all)
- `ADR-019-agent-registry.md`: dynamic roster. Agent spec schema (JSON):
  `{id, role, title, persona (system prompt), skills:[skillId], tools:[Read|Write|Run], integrations:[connId], createdBy:"BOSS", createdAt}`.
  Persistence: write `.claude/agents/<id>.md` (persona) + append `agent-status/registry.json` +
  seed a BROADCAST.md row so it shows on board. Runtime loads persona per-agent (replace hardcoded
  systemFor).
- `ADR-020-agent-creator.md`: NL→spec pipeline. BOSS prompt → claude run (a meta "agent-creator"
  system prompt) → emits spec JSON (fenced) → BOSS reviews → POST /factory/create.
- `ADR-021-integrations-credentials.md`: real-posting architecture. Credential broker (OAuth/token
  per platform, stored encrypted, referenced by connId). Posting layer = composio MCP (twitter,
  linkedin, etc) OR direct platform APIs. Every post → dry-run preview → BOSS confirm → execute →
  audit. Rate limits + per-account caps.
- Exit: ADRs approved; schema frozen; sr-security signs off on cred architecture BEFORE impl.

### PHASE 2 — principal-ux + design skills: UX contract
- Run `impeccable shape` + `gstack design-review` + `emil-design-eng` for motion.
- Design 4 surfaces (OKLCH tokens, dark/light, a11y, reduced-motion, mobile 320–768):
  1. **Create-Agent flow** — describe-box ("what should this agent do?") → loading (Claude authoring)
     → **spec review card** (role, persona preview, skills chips, tools, integrations) → edit/confirm.
  2. **Agent gallery** — grid of all agents (existing + created), role badges, skill chips, status.
  3. **Skill catalog** — browsable skills (expertise + tools + integrations) w/ descriptions.
  4. **Per-post approval modal** — platform, account, content preview, "Post to N accounts?" confirm
     (reuse PermissionGate, gold/CEO accent, emil ease-out).
- Hand off design contract (tokens + component specs) to senior-web-1/2.
- Exit: design approved (gstack critique pass + impeccable audit).

### PHASE 3 — senior-backend-1: dynamic registry
- `agent-runtime` (or vite middleware): `POST /factory/create {spec}` (token+host gated) →
  validate spec → write `.claude/agents/<id>.md` + append `registry.json` + add BROADCAST row →
  return created agent.
- `GET /factory/agents` → list registry. `DELETE /factory/:id` (BOSS-gated) → remove.
- Runtime: per-agent persona — `systemFor(id)` loads from registry/`.md` (created agents use their
  authored persona; built-in agents unchanged). Validate id uniqueness + safe charset.
- Exit: curl create → agent in registry + BROADCAST + addressable by /chat /run.

### PHASE 4 — senior-backend-2: agent-creator (NL→spec)
- `POST /factory/author {description}` → runs claude (cli) w/ AGENT_CREATOR_SYSTEM prompt →
  streams reasoning → emits a ```spec JSON block. Parse → return spec for BOSS review (NOT
  auto-created — BOSS confirms via /factory/create).
- AGENT_CREATOR_SYSTEM: "Given BOSS need, output an agent spec: pick role/title, write a sharp
  persona system-prompt, select skills from the catalog, minimal tools, required integrations.
  Caveman the persona's bus-comms mandate."
- Exit: curl author "marketing agent…" → valid spec JSON w/ sensible skills.

### PHASE 5 — senior-backend-2 + senior-cicd: integrations + credential broker (REAL POSTING)
- Credential broker: BOSS connects an account via **OAuth in his browser** (or pastes token into a
  secure field that goes to the broker, never to Claude/logs). Store encrypted (keychain/secret
  store), reference by connId. Runtime + agents see only connId, never the secret.
- Posting layer: composio MCP (`composio-twitter-automation`, `-linkedin-`, etc) or platform APIs,
  keyed by connId. `POST /factory/post {agentId, connId, content, accounts[]}` → **dry-run preview**
  → returns what WOULD post → BOSS confirms → execute → audit each post. Rate-limit + per-account cap.
- Exit: dry-run preview works; a single gated test post to ONE sandbox/test account succeeds + audited.

### PHASE 6 — senior-security-engineer: threat model + guardrails (HARD GATE)
- STRIDE + OWASP-LLM on: credential exfiltration (agent reads creds → BLOCK; creds never in agent
  scope/scrub/env, same posture as runtime token), prompt-injection→unauthorized post (every post
  BOSS-gated, agent can only PROPOSE), agent-creation abuse (only BOSS triggers; spec validated;
  no exec/tool escalation beyond catalog), over-posting (rate caps), impersonation (audit who/what).
- BLOCK authority: no raw credential ever reaches Claude/logs/stream; no auto-post; injection can't
  bypass the post gate.
- Exit: sign-off; adversarial tests pass (Phase 8).

### PHASE 7 — senior-web-1 + senior-web-2: UI build (design skills applied)
- web-1: Create-Agent flow + agent gallery (BossConsole "＋ New Agent" / a Factory panel).
- web-2: skill catalog picker, credential-connect UI (OAuth button / secure token field), per-post
  approval modal (PermissionGate variant).
- Apply emil motion (modal/gallery/spec-card transitions), impeccable polish, gstack review.
- Wire to /factory/* endpoints w/ runtime token. Created agents appear in gallery + board live.
- Exit: BOSS describes agent → reviews spec → confirms → agent live; connect account → gated post.

### PHASE 8 — senior-qa: e2e + adversarial
- e2e: BOSS "marketing agent multi-account" → author → spec → create → agent on board → chat/run it
  → it drafts a post → dry-run preview → BOSS confirm → (test account) post → audited.
- Adversarial: agent tries to read creds → blocked; injection "post without asking" → still gated;
  spec with exec tool / bad id → rejected; over-post → rate-capped; created persona injection.
- Regression: existing 16 agents + Cycle1/2 + F2b + auth loop unbroken.
- Exit: TESTS_GREEN + tsc + lint + sr-security sign-off.

### PHASE 9 — memory-updater + CEO retro
- Persist registry schema, ADRs, cred-broker pattern to memory. CEO retro: agents created, posts
  made, false-post rate, cred incidents (target 0).

---

## Dependency order
```
P0 ceo → P1 architect ADRs (+sr-sec cred signoff) → P2 ux/design
  → P3 registry ∥ P4 agent-creator → P5 integrations+creds → P6 sr-security gate
  → P7 UI build → P8 QA → P9 memory
```
Critical path: ADRs → registry → creator → integrations → UI → QA.

## Acceptance (DONE when)
- [ ] BOSS describes need → Claude authors spec → BOSS reviews/edits → confirms → agent persisted
      (.md + registry) + live on board + chat/dispatch/run-able.
- [ ] Agent can hold real-posting skills; connect real account via BOSS OAuth (Claude never sees creds).
- [ ] Every external post: dry-run preview → BOSS confirm → execute → audited. NO auto-post.
- [ ] Credential broker: no raw secret in Claude context / logs / stream / agent scope.
- [ ] Spec/agent-creation validated + abuse-guarded; injection can't post or exfiltrate.
- [ ] Modern UI (impeccable/emil/gstack-reviewed): create flow, gallery, skill catalog, approval modal.
- [ ] tsc + lint + TESTS_GREEN + sr-security sign-off. Existing swarm unbroken.

## Non-goals
- Manual-form agent creation (Path A) — later.
- Agents creating agents (BOSS-only).
- Auto-posting without BOSS confirm — never.
- Claude entering credentials — never (architecturally impossible by design).

## CEO note
Two hard parts: (1) **credential broker + real posting** = the risk center → sr-security gates it,
BOSS-OAuth only, per-post confirm. (2) **agent-creator quality** = specs must be sharp/safe → catalog-
constrained. Everything else reuses the registry + runtime + F2b + Boss console already built.

**ASK BOSS:** GO? Which platforms first (Twitter/X, LinkedIn, …)? Use composio integrations (needs
its API key/setup) or direct platform APIs?
