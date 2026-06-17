# Threat Model — Agent Factory (credential broker + real posting + BOSS-triggered agent creation)

**Author:** senior-security-engineer · **Status:** HARD GATE · **Date:** 2026-06-17

Grounded in `agent-runtime/server.mjs`: runtime token in tmpfile (0600, outside repo), `hostOk`/`originOk`/`tokenOk` (constant-time), `MAX_INFLIGHT=4`, `SECRET_RE` egress scrub, `applyAllowed` path validation, F2b sandbox-outside-repo + `/apply` broker, `childEnv` secret strip.

## Trust boundaries
- **A (BOSS ↔ runtime):** crossed only by `x-runtime-token` + loopback `Host`/`Origin`. Extended to all `/factory/*` mutating endpoints.
- **B (runtime ↔ Claude child):** Claude output is UNTRUSTED. It may PROPOSE, never EXECUTE. Secrets never cross into B.
- **C (runtime ↔ external platform):** the ONLY place a raw secret is decrypted — in-memory, request-scoped, never persisted/logged/streamed.

## T1 — Credential Exfiltration (Info Disclosure / LLM06) — HIGH/CRITICAL, residual LOW
Leak paths and controls: secret in Claude context (broker API exposes **connId only**; no endpoint returns a raw secret; validator rejects secret-shaped persona); secret in SSE (extended `SECRET_RE_EXT` scrub on every token); secret in logs/audit (audit stores event metadata only, never the secret; `connect` explicitly does not log the secret); secret in agent fs read-scope (encrypted store in tmp `RUNTIME_TOKEN_DIR`, outside `REPO_ROOT`+`SANDBOX_ROOT`, never seeded); secret in child env (`childEnv` strips `*_KEY/_SECRET/_TOKEN/PASSWORD/APIKEY`); secret echoed by model (no broker-read tool + scrub is last line).
Storage: `AES-256-GCM(plaintext, KEK, random 96-bit IV)`; KEK from `BROKER_KEY` env or a 0600 `.broker-key` file in the tmp runtime dir. Plaintext lives only on the stack during one outbound post.
Extended egress scrub adds: bearer tokens, `access_token/refresh_token/client_secret/api_key` shapes, Google `ya29.`, Meta `EAA`, Slack `xox*`, JWT.

## T2 — Prompt Injection → Unauthorized Post (EoP/Tampering / LLM01) — HIGH/HIGH, residual LOW
The model CANNOT execute a post. `/factory/post/preview` is read-only (mints a single-use `confirmToken` bound to a content hash, ≤120s TTL). `/factory/post/execute` requires `x-runtime-token` + loopback + a fresh matching `confirmToken` that the BOSS produces by confirming the F3 gate. No agent has a tool that reaches execute. Worst case of a successful injection = a dry-run proposal the BOSS rejects. UI shows post status from the audit log, not model text.

## T3 — Agent-Creation / Spec Abuse (EoP / LLM07) — MEDIUM/HIGH, residual LOW
`validateSpec` enforces: `id` `^[a-z][a-z0-9-]{2,48}$`, not reserved (16 built-ins + boss), not duplicate; `role`/`title` ≤80, control/metachar stripped; `persona` ≤6000, ≥20, control+``` stripped, **rejected if it matches a secret shape**; `tools` ⊆ {Read,Write,Run} (Bash/exec not representable); `skills` ⊆ frozen catalog; `integrations` ⊆ {twitter,linkedin} and only valid when a matching posting skill is present; `createdBy` forced to "BOSS". Creation is token+host gated → no agent self-creation (children carry no token).

## T4 — Over-Posting / Abuse (DoS) — MEDIUM/MEDIUM, residual LOW
`MAX_INFLIGHT=4` bounds children. Per-account rolling-24h cap (twitter 25, linkedin 15) → 429. `confirmToken` single-use, ≤120s, content-hash-bound (replay or content swap → reject).

## T5 — Impersonation / Audit (Repudiation) — MEDIUM/MEDIUM, residual LOW
Append-only audit log outside the repo (`factory-audit.log` in tmp runtime dir), one record per `agent.create`/`agent.delete`/`conn.create`/`conn.delete`/`post.execute`/`post.ratelimited` with who/what/when/connId + content length (never raw content/secret). Written before success is returned.

## T6 — connId Confused Deputy (EoP) — MEDIUM/HIGH, residual LOW
`connId` is an opaque random handle (`conn_`+random). A created agent may only post through a connId whose platform is in that agent's `integrations`; otherwise 403. Revocation (delete connection) is honored at post time (getConn fails → unknown connId).

## MUST-PASS CHECKLIST (Phase 8 verifies adversarially — BLOCK on any fail)
- **T1:** sentinel-secret grep across `/factory/agents`, `/changes`, SSE, audit = 0 hits · AES-256-GCM w/ authTag · store outside repo+sandbox, never seeded · child env clean.
- **T2:** no LLM→execute path · "post now" injection yields ≤ dry-run, 0 unconfirmed `post.execute` rows · execute without confirmToken → 4xx.
- **T3:** Bash/exec tool→reject · path-y/reserved/dup id→reject · oversized persona→reject · dispatch/``` in persona→neutralized · secret-shaped persona→reject · non-catalog skill/integration→reject · createdBy forced BOSS · tokenless create→401.
- **T4:** per-account cap→429 · confirmToken single-use/expiry/hash-bound enforced.
- **T5:** every execute+create/delete → audit record before success · no raw secret in log.
- **T6:** cross-platform connId post→403 · revoked connId→blocked.
- **Regression:** host/origin/token on `/factory/*` · sandbox+applyAllowed+CONFIG_GUARD intact · 16 agents + F2b + auth loop unbroken · tsc+lint clean.
