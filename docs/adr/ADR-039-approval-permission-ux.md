# ADR-039 — Approval & Permission UX (per-tool-call approval over the broker)

- **Status:** PROPOSED
- **Date:** 2026-06-18
- **Slug:** `approval-permission-ux`
- **Plan:** Stage 3.5 — Full Tool Loop + Approval UX (gap #30)
- **Deciders:** architect, senior-security-engineer (**HARD gate — co-leads, BLOCKING**), senior-backend-1, ceo
- **Build order:** **FOURTH (last).** Routes + UX layer on top of ADR-038 `tool-broker.mjs`, which requires ADR-037 `sandbox.mjs` + a green escape suite first.
- **Related:** ADR-038 (the broker behind these routes), ADR-037 (the jail), ADR-029/`policy.mjs` (per-agent trust — extended, never weakened), `server.mjs` auth (`tokenOk`/`originOk`/`hostOk`/`needsAuth`, SSE `scrub`), `factory.audit` (reused)

## SECURITY LAW (stated verbatim in all three ADRs — ADR-037/038/039)

> **A git worktree is NOT a security boundary.** Same uid, same fs, same network as the host. An agent with `Bash` in a worktree can read `~/.ssh`, `rm -rf` the host, or exfiltrate over the network. **Approval prompts stop ACCIDENTS, not malice or prompt-injection.** **THEREFORE the execution boundary MUST be a real OS-level sandbox (Docker container, ADR-037).** The worktree stays ONLY for git/diff/apply. ALL execution is jailed in the container. **NO direct exec on the host, EVER, even with approval.**

**Corollary for THIS ADR:** approval is a usability + accident-prevention layer in front of the jail. It is NOT the security boundary and must never be presented or trusted as one. A "deny" must hard-stop; an "allow" still runs only inside the jail (ADR-037), never on the host. FORBIDDEN (ADR-038) is never offered for approval.

## Context

ADR-037 gives the jail; ADR-038 gives the broker that classifies a command and runs SAFE immediately but returns SENSITIVE as **pending approval**. This ADR is the operator-facing surface that resolves a pending approval, streams the running command's output, and audits everything. It is the human in the loop for accidents/prompt-injection: a clear preview of *what is about to run, with what capabilities (incl. network), in what scope* — allow-once / allow-for-session / deny.

The runtime already has a hardened auth posture we reuse verbatim: `hostOk` (loopback Host allowlist, enforced globally except `/health`, `server.mjs` L793), `originOk` (cross-origin reject, L130), `tokenOk` (constant-time token, L118), and a `needsAuth` route family (L933). New routes join that family. SSE already `scrub`s every emitted token (L346/L376).

## Decision

Add auth-gated routes (token+origin+host) that drive `tool-broker.mjs` (ADR-038), plus a chat-embedded approval UX and a bounded session-scope approval memory. No new auth mechanism — reuse the existing one.

### 1. Routes (ADDED — join the `needsAuth` family; host+origin+token enforced)

```
POST /runtime/:id/exec
  body: { command: string, network?: boolean }
  → broker.classify(command); then:
    FORBIDDEN  → 200 { ok:false, class:"FORBIDDEN", reason }            (never runs, audited tool.reject)
    SAFE       → broker.execTool runs in jail now → 200 { ok:true, class:"SAFE", callId, exitCode, … }
    SENSITIVE  → mint a server-side pending approval:
                 200 { pending:true, callId, class:"SENSITIVE", network, preview:{command(scrubbed), capabilities, scope:"/work (worktree)"} }
  :id = agentId (safeId-validated, same char class as existing routes).

POST /runtime/exec/:callId/approve
  body: { scope: "once" | "session" | "deny" }
  → resolves the pending approval bound to callId for the authed caller:
    "deny"    → 200 { ok:false, denied:true }   (audited; pending dropped; nothing runs)
    "once"    → broker.execTool(agentId, command, { approval:{decision:"allow", scope:"once", network, callId} })
    "session" → record (agentId, command-class[, command]) in bounded session memory (§3),
                then execTool as above. Future identical-class calls this session auto-allow (still jailed).
  Network: a network-requiring SENSITIVE command's approval ALSO carries the network grant
    ONLY if the operator approved with network shown (§2). No silent network.

GET  /runtime/exec/:callId/stream            (SSE)
  → live stdout/stderr of the running command, EACH CHUNK passed through `scrub` before write
    (same scrub as L346/L376). Emits: event:stdout / event:stderr / event:exit {exitCode,timedOut,killed}.
  → auth: token+origin+host (SSE auth via the same needsAuth gate; token in header/first-party).

POST /runtime/exec/:callId/kill
  → sandbox.kill(callId) (ADR-037) + AbortSignal abort. 200 { ok:true, killed:true }. Audited.

GET  /runtime/:id/exec/approvals             (optional, ops view)
  → bounded list of pending + recent approvals for the agent (scrubbed previews) for the UI panel.
```

All five are in the `needsAuth` set (L933) → `if (needsAuth && (!originOk(req) || !tokenOk(req))) → 401` (L936), and `hostOk` already gates globally (L793). `:id`/`:callId` validated to `[a-z0-9_-]` (same as `safeId`).

### 2. UX (chat-embedded approval card)

When `/exec` returns `pending`, the chat renders an **approval card**:

- **Command preview** — the exact command, scrubbed (`scrub`), monospace, no truncation of the security-relevant head (length-capped with explicit marker).
- **Declared capabilities** — explicit chips: `writes worktree`, and — when applicable — a prominent **`NETWORK EGRESS`** chip (red). Network is NEVER implied; if the command needs egress it is shown and must be part of the same allow decision.
- **Scope** — "runs inside an isolated sandbox container over this task's worktree (`/work`); the host filesystem and the live repo are NOT reachable; changes still go through Apply." This communicates that approval ≠ host access (per the Corollary).
- **Actions** — `Allow once` · `Allow for session` · `Deny`. Deny is the default-focused/safe action. FORBIDDEN commands never produce a card — they return a rejection notice.

Once running: the card flips to a **live stream** (SSE `/stream`) of scrubbed stdout/stderr with an `exit` line, plus a **Kill** button (`/kill`). Reduced-motion respected; the stream is append-only and capped.

### 3. Session-scope approval memory (bounded)

`allow-for-session` records `(agentId, command-class-signature)` — and optionally the normalized command — in an in-memory, **bounded** map keyed by the operator session, with:

- **Bound:** max N entries per agent (LRU-evicted) + a TTL; cleared on runtime restart (in-memory, like threads' transient state). Never persisted to disk as a standing grant.
- **Scope is narrow:** a session grant auto-allows future SENSITIVE commands of the *same recorded shape* for that agent this session — it does **NOT** widen to other agents, does **NOT** cover network unless network was in the original grant, and does **NOT** ever touch FORBIDDEN (FORBIDDEN is re-checked on every call regardless of any grant).
- Extends ADR-029 trust **additively and reversibly** — it can only ever let an already-classified-SENSITIVE command skip the click; it can never reclassify FORBIDDEN or auto-grant network. Per the ADR-038 §3 ratchet, there is no auto-exec trust level.

### 4. Audit (reuse factory append-only log)

Every approval decision and every executed command is audited via `factory.audit` (`factory.mjs` L651):

```
audit("approval.request", { agentId, callId, class, network, preview:<scrubbed,capped> });
audit("approval.decide",  { agentId, callId, scope:"once"|"session"|"deny", network });
audit("approval.session", { agentId, classSignature });        // when a session grant is recorded
audit("tool.exec", …)  / audit("tool.reject", …)               // from ADR-038 (the actual run)
```

Secrets/raw output never logged (consistent with `factory.mjs` posture — content hashed/omitted). The SSE stream is transient and scrubbed; it is not the audit record.

### 5. Reuse map (cite)

- **Auth:** `tokenOk` (L118), `originOk` (L130), `hostOk` (L793 global), `needsAuth` family (L933) — UNCHANGED, routes join it.
- **SSE scrub:** `scrub` (L346) on every chunk (as L376 does for chat tokens).
- **Broker:** `tool-broker.mjs` `classify`/`execTool` (ADR-038).
- **Jail + kill:** `sandbox.mjs` `runInSandbox`/`kill` (ADR-037).
- **Trust:** `policy.mjs` `levelFor` (ADR-029) — read for context; never weakened.
- **Audit:** `factory.audit`/`readAudit` (`factory.mjs` L651/L659).
- **Concurrency:** shared `MAX_INFLIGHT` via the existing slot helpers (L709–710) — exec borrows the same budget.

## Security invariant (sr-security HARD gate — BLOCKING)

**INVARIANT: a SENSITIVE command runs ONLY after a server-minted approval bound to its callId is resolved "allow" by an authenticated, same-origin, loopback-host caller; FORBIDDEN is never offered; network is granted ONLY when shown and explicitly approved; a "deny" hard-stops; every request/decision/run is audited; the running command's stream is scrubbed; and approval never promotes execution out of the ADR-037 jail.**

### attack → mitigation

| Attack | Vector | Mitigation |
|---|---|---|
| Approval bypass | client posts `execTool` with a fabricated `approval.allow` | only the server route mints/holds the pending approval keyed by callId; `execTool` honors a **server-issued** approval for that callId, not a client-supplied flag (ADR-038 §"approval bypass"). |
| Replay | re-POST an old `/approve` for a consumed callId | callId is single-use: pending entry is removed on first resolve/run/expire; a stale callId → 404/`already resolved`. |
| Cross-agent approval | approve callId on agent A, reuse for agent B | callId is bound to `(agentId)` at mint; `/approve` and `execTool` re-check the binding; mismatch → reject. |
| Forbidden auto-allowed | trick the card into showing a FORBIDDEN cmd as approvable | FORBIDDEN is rejected at `/exec` before any card is minted (ADR-038 checks FORBIDDEN first); no pending approval is ever created for it; re-checked on session-grant path too. |
| Network granted silently | SENSITIVE+network approved as if local-only | network is a distinct shown capability; the approval records `network` and `execTool` passes `network:true` ONLY if the resolved approval carried it; default `--network none`. |
| CSRF / DNS-rebind | malicious page drives the routes | `hostOk` (loopback Host) + `originOk` (origin allowlist) + `tokenOk` (token) on every route — the existing hardened gate, unchanged. |
| Session-grant over-reach | one grant silently covers everything | session memory is bounded (LRU+TTL), per-agent, per-class-signature, no network unless originally granted, never FORBIDDEN, cleared on restart. |
| Secret leak via stream | command prints a secret to stdout | every SSE chunk `scrub`bed before write (L346); output byte-capped; stream transient, not persisted. |
| Runaway command | approved cmd hangs/loops | `/kill` route → `sandbox.kill(callId)` + AbortSignal; per-call timeout (ADR-037) backstops; container `--rm` reaped. |

## Consequences

**Positive** — a clear human-in-the-loop for accidents/prompt-injection without pretending to be the boundary; reuses the entire existing auth + scrub + audit stack; network is impossible to grant invisibly; live stream + kill give the operator real control; session scope reduces click-fatigue without standing risk.

**Negative / accepted** — `allow-for-session` is a usability/risk trade — bounded, narrow, and reversible, but it does skip the click for same-shape commands (accepted; never covers network/FORBIDDEN). SSE auth for browsers relies on the existing first-party token posture. Approval is explicitly NOT a security guarantee (the jail is) — must be communicated so operators don't over-trust "allow".

**Observability** — the audit events above feed the ops approvals view (`/exec/approvals`) and `readAudit`; `GET /runtime/health` exec readiness from ADR-037/038.

## Alternatives rejected

1. **No approval — auto-run everything SAFE/SENSITIVE in the jail** — removes the accident/prompt-injection brake; gap #30 explicitly wants the approval UX. NO.
2. **Approval as the boundary (no sandbox)** — the rejected naive shape; approval stops accidents not malice. NO (SECURITY LAW).
3. **Persisted standing grants on disk** — a durable over-grant + tamper surface; session-only in-memory grants instead.
4. **One global allow toggle** — coarse, no per-command/per-capability/per-agent granularity; rejected.
5. **Auto-grant network with the command approval** — hides the most dangerous capability; network is a separate shown grant.

## sr-security HARD sign-off conditions (BLOCKING)

- (a) All five routes are in the `needsAuth` family (token+origin+host); `:id`/`:callId` validated.
- (b) Pending approvals are server-minted, callId-single-use, agent-bound; `execTool` trusts only a server-issued approval (no client allow flag).
- (c) FORBIDDEN never yields an approval card; network shown as an explicit capability and granted only when approved.
- (d) `deny` hard-stops; `once` runs one jailed call; `session` is bounded/per-agent/per-class/no-network-unless-granted/never-FORBIDDEN/cleared-on-restart.
- (e) SSE stream `scrub`bed per chunk + capped; `/kill` wired to `sandbox.kill` + AbortSignal.
- (f) Every request/decide/exec/reject audited via `factory.audit`.
- (g) Builds ONLY on a shipped ADR-038 broker, which builds ONLY on a shipped ADR-037 sandbox with a green escape suite.
