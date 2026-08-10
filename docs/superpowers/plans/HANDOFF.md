# HANDOFF — Multi-Provider Credentials build (resume point)

**Updated:** 2026-08-09 · **Branch:** `feat/multi-provider-credentials` (from `helmMission`) · **NO COMMITS yet (user rule).**

## ⚠️ PIVOT (user correction — this supersedes the original hardcoded-provider design)
User rejected the hardcoded 4-provider phased design. REQUIREMENT NOW:
- **Generic "+ Add Account"** — add UNLIMITED accounts of ANY LLM type (claude/openai/minimax/zai/custom), each with its own token. Nothing hardcoded.
- **Its own LEFT-SIDEBAR TAB "Accounts"** — NOT inside Settings.
- Removed my wrong `wired:false` 400 block.
- Honest: Claude accounts run the swarm engine; other types stored-and-ready (engine executes only via `claude` CLI today).

**Backend DONE + VERIFIED (multi-account):** registry.mjs=PROVIDER_TYPES catalog; credentials.mjs=`accounts.json`{accounts[],activeAccountId}+per-account sealed secrets; child-env.buildChildEnv(env,{activeSecret,activeProviderType}) injects ANTHROPIC_API_KEY only for active claude; routes.mjs generic REST `/runtime/accounts` (GET/POST, POST :id/secret, DELETE :id, POST active). 39 provider tests, typecheck 0, live curl smoke clean (unlimited accounts, custom+baseUrl, chat_only warning, secret never leaks, 0600). OLD /runtime/providers/* connect routes DELETED (GET alias kept).
**Frontend DONE + VERIFIED LIVE:** Accounts BOS tab (BosPage union + BOS_NAV + App render slot + KeyRound icon), full-page AccountsPage + generic Add-Account form, src/lib/accounts.ts, ProvidersPanel removed from Settings, PreflightGate→accounts. typecheck 0, unit 371/371. Live-proven in browser: added `my-minimax` w/ token → 2 ACCOUNTS; bad OpenAI key probe-rejected; secrets never plaintext; delete → clean.
**Security DONE:** review CRITICAL 0 CLEAN; MEDIUM SSRF (openai/custom baseUrl probe fetch) + LOWs FIXED (url-guard.mjs private-IP blocklist + redirect:manual; atomic 0600 writes; identifier cap). Provider+url-guard suites 49/49, full runtime 1128/0, typecheck 0. SSRF blocked, proven by test + by hand.

## STATUS (2026-08-10): multi-account + OpenAI-compatible CHAT working, verified live. NO COMMITS.
Report: `docs/superpowers/plans/ACCOUNTS-DELIVERY-REPORT.md`.

### DONE + VERIFIED since last update
- **OpenAI-compatible chat adapter** — `agent-runtime/providers/adapters/openai-compat.mjs` (`streamChat`, `resolveEndpoint`, `pickChatBackend`). Chat route `/runtime/:agentId/chat` branches: active account capability!==swarm + providerType∈{custom,openai,minimax,zai} + hasSecret + baseUrl → adapter (`adapterReply` in server.mjs ~1003, emits SSE meta/token/usage/done, key via getActiveSecret, SSRF-guarded, AbortController /stop). Else → Claude CLI path UNCHANGED. Suites: openai-compat 7/7, chat-routing-http 3/3, providers 24/24+21/21, unit 372/372, runtime 1208/0, typecheck 0.
- **`model` field** — store+route accept `model` (≤128, custom/openai only); UI Add-Account form shows MODEL field for custom/openai (src/components/bos/AccountsPage.tsx), sent in addAccount body (src/lib/accounts.ts).
- **LIVE-PROVEN (my curl, restarted runtime):** custom acct w/ baseUrl+model → chat emits `mode:"api"` (adapter, not cli) → reaches OpenRouter (egress WORKS, /models 200) → sends `Authorization: Bearer <key>` correctly (identical to manual curl; dummy key → OpenRouter "Missing Authentication header" = its response to bad-format key, NOT our bug). Real `sk-or-v1-…` key + valid model → real reply.
- OpenRouter free NVIDIA ids: `nvidia/nemotron-3-ultra-550b-a55b:free`, `nvidia/nemotron-nano-9b-v2:free`, etc. Base URL `https://openrouter.ai/api/v1/chat/completions`.

### KEY FACTS for the running app
- Runtime :3006 (RUNTIME_TOKEN_DIR=/var/folders/l1/…/missionalpha-runtime-dev, token=$DIR/.runtime-token, RUNTIME_PORT=3006 in agent-runtime/.env). UI :3004 (launch.json `missionalpha-dev`). **RESTART the runtime after any agent-runtime/*.mjs edit — a stale process serves old code (this bit us: model:None + mode:cli until restart).**
- Claude accounts = api_key needs a real Anthropic `sk-ant-…` (probe hits Anthropic; wrong-key → 401 invalid x-api-key, correctly not saved). OpenRouter key ≠ Anthropic key → must go in a **Custom** account, not Claude.

### OPEN THREADS (user-gated / next)
1. **Edit-account feature NOT built (real gap).** The "no model set — edit the account" message promises an edit path that doesn't exist; user must delete+re-add to set model/re-key. Build: PATCH/update endpoint (set model, replace secret) + Edit action per account row. Also fix that message wording. TDD+security+verify.
2. **Chat live confirmation** — user finishing: re-add NVIDIA as Custom (baseUrl+model+real OpenRouter key) → Set active → Chat → real reply. If 401=key, 404=model id, timeout=net.
3. **Commit** — on user "commit": conventional commit branch `feat/multi-provider-credentials` + open PR.
4. **Claude swarm live smoke** — needs real `sk-ant-…` or `claude` re-login (engine runs Claude-CLI only).
5. **Phase 2/3** — Codex CLI (not installed) + other-provider execution beyond chat.

### RULES (unchanged): no commit until user says; don't break current; everything wired; TDD→security→verify each change; Opus builds/Fable verifies/caveman+headroom+codeburn; CLAUDE.md skills every phase.

## Read first
- Plan: `docs/superpowers/plans/2026-08-09-multi-provider-credentials.md`
- Spec: `docs/superpowers/specs/2026-08-09-multi-provider-credentials-design.md`
- This file. Don't re-derive — pick up at "NEXT".

## Environment facts (don't rediscover)
- Node v26. `better-sqlite3@13.0.3` (fixed earlier — ABI break was the original outage).
- Runtime dev port **3006** (`agent-runtime/.env` RUNTIME_PORT=3006 + RUNTIME_TOKEN_DIR=/var/folders/l1/ndwcjhx13hzg0bpvdtk5xvkh0000gn/T/missionalpha-runtime-dev). UI dev port **3004** (launch.json `missionalpha-dev` = zsh -lc cd MissonAlpha && npm run dev).
- Runtime token: `$RUNTIME_TOKEN_DIR/.runtime-token`. Endpoints loopback+token+Host-gated like `/inbox`.
- **Claude CLI login EXPIRED** → live-model runs 401. This feature (api_key mode) is the fix. Live smoke (plan Task 12.4) is the ONLY step gated on user auth (re-login OR real key).

## DONE + VERIFIED (independently, not just self-reported)
- **Phase 0** baseline: typecheck 0, runtime suite green.
- **Phase 1 Tasks 1-6 (backend):** registry.mjs, crypto.mjs (AES-256-GCM), credentials.mjs (createStore), child-env.mjs (`buildChildEnv(processEnv,{activeSecret,activeId})`), routes.mjs; server.mjs modified (credStore boot wiring, :1205 replaced with per-provider capability gate + preserved mock-backend refusal, buildChildEnv at both spawn sites, /runtime/health += activeProvider/activeCapability, /runtime/providers routes mounted under needsAuth+Host gate). **28/28 new unit tests pass. Full regression 1173/1173.**
- **Phase 1 Tasks 7-10 (UI+preflight):** src/lib/providers.ts (+__tests__), ProviderCard.tsx, ClaudeAuthModes.tsx, ProvidersPanel.tsx (into SettingsPanel modal, between WorkspaceSection & PolicyEditor), PreflightGate.tsx (auth OK = subscription OR stored api_key; client-side override since electron/preflight.js can't see the encrypted store). **typecheck 0, test:unit 370/370, eslint clean.**
- **Live E2E proven (no model needed):** restarted runtime (loads new routes) → `GET /runtime/providers` serves 4-provider registry → connect(subscription)→snapshot flips→`/runtime/health.activeProvider=claude,swarm`→setActive(minimax)→chat-only warning→disconnect clean→no-token=401. UI: Providers panel renders live matching mockup (Claude two-mode chooser, FULL SWARM/CHAT ONLY badges, all 4 cards, Coming soon phase 2/3). Screenshots captured.

## PHASE 1 = COMPLETE + VERIFIED (security-hardened)
- Security review: CRITICAL 0, CLEAN. MEDIUM (env-strip breadth) + LOWs FIXED + independently re-verified (DATABASE_URL/SECRET_KEY_BASE/AWS_ACCESS_KEY_ID stripped; ANTHROPIC_API_KEY injected only for active claude api_key). Provider suites 31/31, unit 370/370, runtime no-regress, typecheck 0.
- Delivery report: `docs/superpowers/plans/PHASE1-DELIVERY-REPORT.md`.
- Only Phase-1 gap: live-model smoke (Task 12.4) BLOCKED on user auth (re-login `claude` OR real Anthropic key).

## BLOCKED — Phase 2 & 3 (external deps absent on this machine)
- **Codex CLI NOT installed**; no OpenAI/MiniMax/Z.ai keys in env. Cannot build+verify to standard.
- Do NOT build blind (unverifiable = PES violation). Architecture is READY (registry, capability tiers, engine spawner-branch seam at the `claude` spawn, chat-only gate).
- **To unblock Phase 2:** install OpenAI Codex CLI + OpenAI auth → then: registry `openai-codex.wired=true`, device-code store shape, engine spawner branch keyed on activeProvider (spawn codex vs claude), device-code connect flow, Codex card active. TDD + security-review + Fable verify.
- **To unblock Phase 3:** MiniMax + Z.ai keys → chat SDK adapter under `providers/adapters/`, engine stays paused via existing CHAT_ONLY gate + UI banner, cards active Chat-only.

## NEXT
- If user supplies Anthropic key/re-login → run Task 12.4 live smoke (one scheduled task → expect real diff, not stuck-failure).
- If user installs Codex CLI + keys → Phase 2, then Phase 3.
- When user says commit → commit branch (conventional message), open PR.

## Rules (unchanged)
- No commit until user says so. Don't break current functionality (re-run baseline each phase). Everything wired. Every phase: TDD → security → code-review → verify → delivery report. Skills per CLAUDE.md. Opus builds / Fable verifies / caveman+headroom+codeburn.
