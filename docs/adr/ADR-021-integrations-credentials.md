# ADR-021 — Integrations + Credential Broker (real external posting)

**Status:** Accepted · **Date:** 2026-06-17 · **Author:** architect (+ sr-security gate)

## Context
Created agents can hold real social-posting skills (Twitter/X + LinkedIn first). This is the risk center: real outward side effects + live credentials. Claude must never see a raw credential, and no post may happen without BOSS confirmation.

## Decision
**Credential broker.** The BOSS connects an account by sending its token/OAuth credential to `POST /factory/connect {platform, handle, secret}` (token+host gated) — from his own browser, never from Claude. The secret is encrypted immediately (AES-256-GCM; KEK from `BROKER_KEY` env or a 0600 `.broker-key` in the tmp runtime dir, **outside the repo**) and stored in `connections.json` (tmp, 0600). It is referenced everywhere else by an opaque `connId`. `GET /factory/connections` and the registry only ever return `{connId, platform, handle}` — never the secret. The raw secret's lifetime is: the connect request body → encrypt; and, at post time, a single decrypt-on-the-stack handed to the platform. Never logged, streamed, seeded into a sandbox, or placed in a child env.

**Posting layer.** `POST /factory/post/preview {agentId, connId, content}` is read-only: it returns exactly what WOULD post (platform, handle, content, char count, rate state) and mints a single-use `confirmToken` bound to a hash of the content (≤120s TTL). The UI shows this as the per-post approval modal (F3-style). On BOSS confirm, `POST /factory/post/execute {…, confirmToken}` (token+host gated) re-validates, checks the per-account rolling-24h cap, then posts — via composio MCP (`composio-twitter-automation`/`-linkedin-`) when `COMPOSIO_API_KEY` is set, else a clearly-marked **simulated** post (nothing leaves the box; never a fabricated network call). Every execute is audited. A created agent may only post through a connId whose platform is in that agent's `integrations` (connId confused-deputy guard).

## Consequences
Real posting is possible and safe-by-construction: BOSS-gated, dry-run-first, rate-capped, audited, with credentials architecturally out of Claude's reach. Real network posting requires composio setup; until then the flow runs end-to-end in simulated mode.
