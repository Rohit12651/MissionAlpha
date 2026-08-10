# Multi-Provider Credentials & Auth Modes — Design Spec

**Status:** Approved (design + mockup) · **Date:** 2026-08-09 · **App:** MissonAlpha (agent-runtime + Vite/React cockpit)

---

## 1. Problem

MissonAlpha's runtime authenticates the model exactly one way: the local `claude` CLI's
subscription login. When that login expires, chat dies, the autonomous engine cannot spawn,
and every scheduled task mints a "stuck — spawn/empty-diff" failure. The user wants a **second
option** — bring your own API key — without removing subscription login, and a **provider
screen** (Claude, ChatGPT·Codex, MiniMax, Z.ai) matching the MissionControlHQ reference.

## 2. Goal

Add a workspace-level **Providers & Credentials** surface. Keep Claude subscription login.
Add Claude **API-key** auth mode with FULL swarm parity. Architect for multiple providers with
honest **capability tiers**. Everything wired backend→frontend; nothing left disconnected.

## 3. Key technical fact (load-bearing)

The autonomous write-loop (`engineDispatch`, `agent-runtime/server.mjs:1200+`) **spawns the
`claude` CLI** as a subprocess (`--allowed-tools`, worktrees, `--permission-mode acceptEdits`).
That CLI harness is what produces real code deliveries. The `"api"` backend
(`new Anthropic({apiKey})`) is a text-only path and cannot run the write-loop — which is why
`server.mjs:1205` rejects it.

**BUT** the `claude` CLI natively runs on EITHER a subscription login OR `ANTHROPIC_API_KEY`.
Line 1231 currently **strips** `ANTHROPIC_API_KEY` from the CLI child env (forcing subscription).
The unlock: when the active Claude credential is api-key mode, **inject** the key into the
spawned CLI instead of stripping it. API keys then get full swarm parity — chat AND the
autonomous engine — with no new agent loop.

## 4. Architecture

### 4.1 Provider registry (static, runtime)
`agent-runtime/providers/registry.mjs` — frozen list. Each: `id, label, authMethod, capability, wired`.

| id | label | authMethod | capability | wired v1 |
|---|---|---|---|---|
| `claude` | Claude | `subscription` \| `api_key` | `swarm` | ✅ |
| `openai-codex` | ChatGPT · Codex | `device_code` | `swarm` | phase 2 |
| `minimax` | MiniMax | `oauth` | `chat_only` | phase 3 |
| `zai` | Z.ai | `api_key` | `chat_only` | phase 3 |

### 4.2 Credential store
`agent-runtime/providers/credentials.mjs` — persists `credentials.json` under `TOKEN_DIR`
(0600 file, 0700 dir, asserted OUTSIDE `REPO_ROOT` — reuses existing security invariant so a
read-mode agent with `cwd=REPO_ROOT` can never read it).

Record shape:
```
{
  activeProviderId: "claude",
  providers: {
    claude: { accountId, label, identifier, authMethod: "subscription"|"api_key",
              status: "connected"|"disconnected", addedAt, hasSecret: bool }
  }
}
```
API-key secrets are stored **encrypted** (AES-256-GCM) in a sibling `credentials.enc` keyed by a
machine-local key file `cred.key` (0600, generated once in `TOKEN_DIR`). `credentials.json` holds
only metadata + `hasSecret`, never the plaintext. Subscription mode stores **no secret**.

### 4.3 Engine change (surgical core)
`agent-runtime/server.mjs`:
- Replace the global `BACKEND` gate at `:1205` with a per-provider capability check
  (`providerCapability(activeProviderId) === "swarm"` → proceed; `chat_only` → structured
  "switch to a swarm-capable provider" result, never a crash).
- In the CLI child-env builder (`:1229-1233`), keep stripping ALL `*_KEY/_SECRET/_TOKEN`
  **except**: when active Claude credential is `api_key`, inject `ANTHROPIC_API_KEY = <decrypted key>`.
- Chat spawn path uses the same rule.

### 4.4 Runtime API (loopback + token + Host-gated, mirrors `/inbox`)
- `GET  /runtime/providers` → registry + per-provider status + `activeProviderId`.
- `POST /runtime/providers/:id/connect` → `{ authMethod, secret? }`; validates api_key via 1-token
  probe before persisting; returns status (never echoes secret).
- `POST /runtime/providers/:id/replace` → swap secret.
- `POST /runtime/providers/:id/disconnect` → delete credential + secret.
- `POST /runtime/providers/active` → `{ providerId }`; sets active; warns if `chat_only`.

### 4.5 UI
`src/components/settings/ProvidersPanel.tsx` (+ children) — Settings → "Providers":
- "✓ Credentials synced across all agents" banner (when ≥1 connected).
- Card per provider: icon, label, capability badge (**Full swarm** / **Chat only**), auth sublabel,
  `+ Add account`, connected row (status dot, `id:account`, identifier, Replace / Disconnect).
- Claude card: two-mode chooser (Subscription selected by default; API key → masked paste field +
  Verify & save). Others: "Coming soon" (phase 2/3), Add disabled.
- Talks to runtime via existing `runtimeBase` fetch helpers (token+SSE already wired).

### 4.6 Preflight
`src/components/PreflightGate.tsx` + its runtime readiness producer: block only when NO provider is
connected (neither subscription-usable nor a stored api_key). If an api_key credential exists →
cockpit renders. Setup message updated to mention both options.

## 5. Capability tiers (honest)
`swarm` = runs the autonomous engine (file edits/git/tests → real deliveries).
`chat_only` = replies/drafting only; the write-loop stays paused with a clear banner. Setting a
`chat_only` provider active warns before it pauses the engine.

## 6. Security
- Secrets: AES-256-GCM at rest, 0600, outside REPO_ROOT, never logged (redaction already at
  `server.mjs:860/1231`, `factory.mjs:403`, `pr.mjs:49` — extend to new code paths).
- Key injected ONLY into the specific model subprocess, never the generic child env.
- User pastes their OWN key into their OWN local app over loopback — allowed. Field masked.
- Probe validation uses a 1-token request; on failure, nothing is persisted.

## 7. Non-goals (v1 / phase 1)
- No real OpenAI/MiniMax/Z.ai wiring (shells only).
- No multi-provider LLM router beyond the registry + capability gate.
- No cloud sync of credentials (local-first, per existing architecture).

## 8. Phasing
- **Phase 1 (this spec's core):** store + engine key-passthrough + Claude two modes + 4-card UI +
  endpoints + preflight. Solves the immediate problem AND ships the multi-provider screen.
- **Phase 2:** OpenAI Codex provider (spawn Codex CLI) — full swarm.
- **Phase 3:** MiniMax + Z.ai chat-capable (SDK chat path).

## 9. Known blocker (disclosed)
Live end-to-end verification of a REAL agent run needs working auth — either the user re-logs
`claude`, or supplies an Anthropic API key. Neither is available to the builder. Mitigation: all
logic is unit/runtime-tested with a **deterministic env-injection probe** (assert key present in
child env under api_key mode, absent under subscription) that proves correctness with NO live model.
The final live-swarm smoke test is the one step gated on user-supplied auth.
