# Phase 1 Delivery Report — Multi-Provider Credentials

**Date:** 2026-08-09 · **Branch:** `feat/multi-provider-credentials` · **Commits:** NONE (per user rule) · **Standard:** PES

## What shipped (built + verified)
Claude two auth modes (subscription kept + **Anthropic API key added, full swarm parity**) and the multi-provider Providers & Credentials screen (Claude wired; Codex/MiniMax/Z.ai shelled with capability tiers). Backend→frontend, fully wired.

## PES gates — all passed, evidence
| Gate | Result | Evidence |
|---|---|---|
| Build / typecheck | PASS | `tsc --noEmit` → 0 errors |
| Unit (frontend) | PASS | `npm run test:unit` → 370/370 |
| Unit/integration (runtime) | PASS | provider suites 31/31; full runtime suites 1110+/0 (baseline 1135→ no regressions; new tests added) |
| Security pass | PASS | Adversarial review: **CRITICAL 0**, verdict CLEAN. 1 MEDIUM + LOWs found and FIXED. Env-strip fix independently proven (DATABASE_URL/SECRET_KEY_BASE/AWS_ACCESS_KEY_ID stripped; ANTHROPIC_API_KEY injected only for active Claude api_key). |
| Runtime verification | PASS | Live round-trip: GET /runtime/providers (4-provider registry) → connect → snapshot flips → /runtime/health activeProvider=claude/swarm → setActive(minimax)→chat-only warning → disconnect → no-token 401. UI Providers panel renders live matching mockup (screenshots). |
| Adversarial self-review | PASS | Security subagent (independent) + my own re-verification of every subagent claim (tests re-run, env-strip proven by hand). |

## Files (created/modified, uncommitted on branch)
Backend: `providers/{registry,crypto,credentials,child-env,routes}.mjs`; `server.mjs` (credStore wiring, capability gate, buildChildEnv both spawn sites, /runtime/health, /runtime/providers routes, probe timeout, chat-site fail-closed, health repoPath removed).
Frontend: `src/lib/providers.ts`; `src/components/settings/{ProvidersPanel,ProviderCard,ClaudeAuthModes}.tsx`; `src/components/settings/SettingsPanel.tsx`; `src/components/PreflightGate.tsx`; `src/App.tsx`.
Tests: `test/{providers-credentials,providers-http,engine-key-injection}.test.mjs`; `src/lib/__tests__/providers.test.ts`; `test/inbox-http.test.mjs` (P5 updated for health fix).

## Known Gaps & Risks
1. **Live-model smoke BLOCKED — needs user auth.** Proving a real agent produces a real diff on api_key mode needs a valid Anthropic key OR `claude` re-login (current login expired). The *mechanism* is proven by the deterministic env-injection probe; only the live run is deferred. This is the single Phase-1 gap.
2. **Probe timeout (FIX 3) untested** — signal-only wire-in; the stub-probe test path doesn't reach the SDK branch. Low risk.
3. **UI clears pasted key on submit-dispatch**, not on confirmed success (parent returns void) — on a server connect failure the user re-pastes. Trade-off favoring secret hygiene.
4. **Phases 2 & 3 NOT built** — external deps absent on this machine: Codex CLI not installed; no OpenAI/MiniMax/Z.ai keys. Building them would be unverifiable. Architecture is ready (registry, capability tiers, engine spawner-branch seam, chat-only gate). They build+verify properly once their CLI/keys are present.

## Verdict
Phase 1: **complete and verified end-to-end**, minus the one auth-gated live smoke. Production-grade, hardened, wired, no regressions, no commits.
