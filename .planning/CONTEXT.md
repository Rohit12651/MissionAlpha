# Context — Ruflo Adoption Program

## What MissionAlpha is (unchanged)
Agent Inbox: agent output → Delivery → risk band → policy → human decision → broker → worktree → commit → `gh pr create`. Runtime `agent-runtime/` (Node 20 ESM, 127.0.0.1:3005, SQLite WAL, SSE bus). UI React 19 + Vite (:3004). P0–P9 shipped; 210 unit / 765 runtime / 28 vendor tests green is the baseline contract.

## What this program adds
Ruflo's four durable ideas, rebuilt natively: lifecycle hooks, cadence workers, tier routing, learning/memory loop — plus security hardening and self-audit. Evidence base: ruflo daemon proven broken on macOS (`os.freemem()` guard, 5/5 workers deferred); its router is a 62-line regex; its HNSW claims self-walked-back. Adopt patterns, never implementations, never dependencies.

## Security laws (bind every task, every phase)
1. **Every write goes through `broker.applyChanges`** — including Tier-1 codemods. No new path to the repo, ever.
2. **All retrieved / ingested / worker content is UNTRUSTED** — fenced as data before entering any prompt (pipeline.mjs convention).
3. **Worker-minted Deliveries: capped per day, forced `low` band, never auto-apply.**
4. **Trust scores add friction only** — external triple-gate floor immovable.
5. **Hooks are internal modules** — never operator-configurable shell commands. Config may toggle hooks on/off; it may never define what they execute.

## Engineering conventions (from repo, hold them)
- Pure modules with injected seams (`dispatchFn`, stores) — tests run without live models (mock backend).
- Header comments state invariants; tests pin them. New modules follow this.
- Scrub chain owned by server (`secret-scrub.mjs`); never add a second SECRET_RE.
- Closed enums + fail-closed on invalid config (quality.mjs pattern).
- File perms 0600 for data; null-proto maps for operator-keyed stores.
- No dollars in UI (usage = tokens + context %); `spend.mjs` owns the metered exception.

## Baseline defect (fix in Phase 1, Task 0)
Engine blocked since Aug 16: "no active account". `tech-lead` heartbeat BLOCKED, 5 consecutive spawn failures. Root: no active account configured after the multi-provider migration. Runtime tests use mock backend so suites stay green — the live path is what's broken. Doctor (E5) must catch this class; Task 0 verifies current suites green and documents the account-activation requirement for live runs (activation itself needs BOSS credentials — cannot be done autonomously; surface it, don't fake it).

## Requirement IDs (map pins → REQ ids)
- R1 hooks · R2 cadence · R3 tier-routing · R4 doctor(E5)
- R5 learning-loop · R6 vault-retrieval · R7 cross-model-review · R8 skill-budget(E6)
- R9 metaharness · R10 trust(E1) · R11 pii-scrub(E2) · R12 injection-heuristics(E4)
- R13 encryption(E3) · R14 anti-drift(E8) · R15 graph-ranking(E7)

## Non-goals (rejected forever)
ruflo install · `npx:*`-class permissions · SONA/MoE/EWC++ · federation/WireGuard · byzantine/raft consensus.

## Operating mandates from BOSS (2026-08-18)
- No commits until told. Full autonomy otherwise ("in charge while I sleep").
- Nothing left disconnected; continuous operation without human intervention between decisions.
- Missing pieces: add with own judgment, disclose in phase SUMMARY.
- Token discipline: headroom wrap active, caveman output, codeburn check at session end; context exhaustion → continue in fresh session from .planning state (these files ARE the handoff).
- Build model Opus 5 (caveman); per-phase independent verification pass on Fable 5.
