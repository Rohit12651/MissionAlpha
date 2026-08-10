# Delivery Report — Generic Multi-Account LLM Credentials (supersedes PHASE1)

**Date:** 2026-08-09 · **Branch:** `feat/multi-provider-credentials` · **Commits:** NONE (user rule) · **Standard:** PES

## What was asked (correction)
Keep Claude subscription login. Add a working **"+ Add Account"** to add **unlimited accounts of any LLM** with their tokens. **Its own left-sidebar tab**, not in Settings. No hardcoded provider list. (Superseded the earlier hardcoded 4-provider phased design.)

## What shipped (built + verified live)
- **Backend:** generic multi-account store — `accounts.json` (0600, atomic write) + per-account AES-256-GCM sealed secrets in `credentials.enc`; `PROVIDER_TYPES` catalog (claude/openai/minimax/zai/custom) as a PICKER, not a fixed list; unlimited accounts, multiples per type. Generic REST: `GET/POST /runtime/accounts`, `POST /runtime/accounts/:id/secret`, `DELETE /runtime/accounts/:id`, `POST /runtime/accounts/active`. Engine injects `ANTHROPIC_API_KEY` only for an active **Claude** api_key account; other types stored-and-ready (engine executes via Claude only). Capability gate returns CHAT_ONLY for non-swarm active accounts. The wrongly-added `wired:false` block was **removed**.
- **Frontend:** new **Accounts** left-nav tab (own BOS surface, `BosPage` union + `App` render slot + KeyRound icon), full-page `AccountsPage` with generic **+ Add Account** form (provider pills, label, Subscription/API-key toggle, masked token, base-URL for custom, identifier), account list with capability badge / Set active / Remove, honest chat-only note. Old ProvidersPanel-in-Settings deleted.

## PES gates — all passed, evidence
| Gate | Result |
|---|---|
| typecheck | `tsc --noEmit` 0 |
| unit (frontend) | 371/371 |
| provider+url-guard suites | 49/49 |
| full runtime suite | 1128/0 (no regressions) |
| security review | CRITICAL 0, CLEAN. MEDIUM SSRF (openai/custom baseUrl) + LOWs FIXED + independently re-verified (isBlockedIp: 169.254.169.254/127/10/192.168/::1/fc00 blocked; 1.1.1.1/8.8.8.8 allowed) |
| runtime verification (live) | Accounts tab renders; **+ Add Account added `my-minimax` with a token → 2 ACCOUNTS**; bad OpenAI key probe-rejected (nothing saved); grep of store files for pasted tokens = 0; API bodies carry no secret; delete → clean. Screenshots captured. |
| adversarial self-review | 5 independent subagent passes (build×2, security×2, fixes) + my own re-run/re-proof of every claim |

## Security posture (verified)
Secrets AES-256-GCM sealed per account.id, files 0600 (atomic write, re-tightened on load), under TOKEN_DIR outside REPO_ROOT, never in response/snapshot/logs/plaintext. Probe-before-persist for probe-capable types; SSRF-guarded server-side probe fetch (private-IP/loopback/link-local blocklist + `redirect:"manual"`). Key injected only into the active Claude subprocess. Inputs bounded (label/identifier ≤ caps, providerType ∈ presets, uuid ids, http(s) baseUrl).

## Known Gaps & Risks
1. **Engine executes via Claude only.** OpenAI/MiniMax/Z.ai/Custom accounts are stored-and-ready (encrypted) but do not yet DRIVE the swarm — needs their CLI/SDK integration (Codex CLI not installed; no such keys present). Labeled honestly in the UI, not faked.
2. **Live-model smoke still blocked on user auth** — a Claude account driving a real agent needs `claude` re-login OR a valid Anthropic key. The add-account/store/UI path is fully proven; only the live agent run is gated.
3. **DNS-rebinding TOCTOU** on the probe fetch (resolve-then-fetch) — primary literal-IP vector fully closed; rebinding mitigation (pin-vetted-IP) out of scope, noted.
4. **No commits** — awaiting user's go.

## Verdict
Correction **complete, verified end-to-end, security-hardened**. Production-grade for what it does (add/manage encrypted LLM accounts; Claude runs the swarm). Ready to commit on the user's word.
