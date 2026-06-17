# ADR-019 — Dynamic Agent Registry

**Status:** Accepted · **Date:** 2026-06-17 · **Author:** architect

## Context
The runtime had a hardcoded `systemFor(id)` (boss→CEO prompt, else caveman). Agent Factory needs BOSS-created agents to persist and become first-class: chat/dispatch/run-able + visible on the board.

## Decision
**Spec schema (JSON):**
`{ id, role, title, persona, skills:[skillId], tools:[Read|Write|Run], integrations:[platformId], createdBy:"BOSS", createdAt }`
- `id`: `^[a-z][a-z0-9-]{2,48}$`, unique vs the 16 built-ins + existing registry.
- `persona`: the agent's system prompt (≤6000, ≥20 chars), control/``` stripped, secret-shape rejected.
- `tools`: subset of `{Read,Write,Run}` — **Bash/exec is not representable**.
- `skills`/`integrations`: catalog-constrained (see `factory.mjs SKILL_CATALOG` / `PLATFORMS`); an integration requires a matching posting skill.

**Persistence:** persona → `.claude/agents/<id>.md` (committed frontmatter + body); index → `factory/registry.json` (committed array). On startup the runtime `loadRegistry()`s; `systemFor(id)` returns a created agent's authored persona (+ caveman bus mandate + tool note); built-in agents are unchanged. A best-effort heartbeat seeds a BROADCAST row so the agent shows on the live board.

**Endpoints (agent-runtime :3005, vite-proxied via `/factory`, token+host+origin gated for mutations):**
`POST /factory/create {spec}` → validate → write `.md` + registry + announce → created. `GET /factory/agents` → registry (persona elided to a 240-char preview). `DELETE /factory/:id` → drop from registry.

## Consequences
Created agents survive restart and reuse the whole runtime/F2b/Boss-console machinery. The validator is the single security choke point for creation (ADR-021 + threat model).

## Alternatives
Storing personas only in registry.json (rejected — `.md` keeps them human-editable + git-reviewable). A DB (rejected — over-engineered for a local command tower).
