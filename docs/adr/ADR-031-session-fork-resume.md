# ADR-031 — Chat-Thread Fork & Resume (persisted conversation threads — NOT board-history)

- **Status:** PROPOSED
- **Date:** 2026-06-18
- **Slug:** `session-fork-resume`
- **Plan:** S2 chat-first cockpit — gap #12 (fork/resume). `docs/ceo/workspace-plan.md`
- **Deciders:** architect, senior-backend (thread endpoints), senior-web (ThreadRail wiring + App hydration), senior-security-engineer (HARD gate: thread endpoints leak conversation), ceo
- **Related:** ADR-023 (chat-first shell, thread persistence §3B), ADR-030 (usage rollup surfaced by these endpoints), ADR-022 (tier on the thread record)

## Context

"**Session**" here means a **chat THREAD** — the per-agent / per-Boss conversation persisted at `agent-runtime/threads/<id>.json` (ADR-023 §3B). This is **NOT** `SessionsBrowser.tsx`, which is board-history (Track A / Cycle 2). `SessionsBrowser` is untouched by this ADR.

Two gaps today:

- **Resume is impossible.** `App.tsx` (L146) keeps `const [threadMsgs, setThreadMsgs] = useState<Record<string, Msg[]>>({})` — an in-memory record keyed by threadId that starts EMPTY every page load. The server persists threads to disk (`persistThread` ~L170, `loadThreads` ~L151) and re-hydrates them into its OWN in-memory Map on restart — but there is NO endpoint for the client to READ a persisted thread back. So a reload / new browser shows empty chats even though the server has the history. Resume cannot work without a read endpoint.
- **Fork does not exist.** There is no way to branch a conversation at a point and explore an alternative without destroying the original. BOSS wants to fork the strategic Boss thread mid-conversation.

GROUND TRUTH (cite):
- `threads` Map (~L143), `persistThread` (~L170) writes `{ id, tier, messages, updatedAt }` (+ `usage` rollup per ADR-030), `loadThreads` (~L151), `threadSafeId` (~L147, `[^a-z0-9_-] → _`, slice 64), `threadFile` (~L148, `join(THREADS_DIR, …)` — no caller path segment), `THREAD_KEEP` (~L145, last-N=40), `THREAD_MAX_BYTES` (~L146, 256 KiB).
- Auth family: `tokenOk` (~L110), `originOk` (~L122), `hostOk` (~L129, global ~L655). `needsAuth` regex (~L794) gates `/runtime/:id/(changes|apply|run)`.
- The route `:id` regex is `[a-z0-9_-]{1,64}` (~L748, ~L794).
- `randomBytes` (~L19) already imported — used for the fork hex suffix.
- ChatPane SSE/`POST /chat` (~L175) sends `{message, model:tier}`; ThreadRail (`src/components/workspace/ThreadRail.tsx`) lists threads.

The S1 engine (ADR-024..029) uses per-task git worktrees. A **chat-thread fork is NOT a worktree operation** — it is a cheap thread-RECORD copy. Worktrees only matter if a fork must also branch in-flight engine work, which is **out of scope for S2 chat fork** (noted below).

## Decision

Add three auth-gated thread endpoints (list / read / fork). Resume = client reads a persisted thread and hydrates it into `App.tsx` `threadMsgs`. Fork = server-minted copy of a thread record (optionally truncated), into a new thread id.

### 1. New endpoints (auth-gated — same token+origin+host family as `/changes`)

**`GET /runtime/threads` → thread index (scrubbed).**

```jsonc
// 200
{ "threads": [
  { "id": "boss", "tier": "sonnet", "messageCount": 24,
    "updatedAt": "2026-06-18T…Z",
    "usage": { "turns": 12, "totalInputTokens": 14820, "totalOutputTokens": 3072,
               "lastContextPct": 0.0346, "lastTier": "sonnet" } }  // ADR-030 rollup, scrubbed
] }
```
Lists every persisted thread (from the in-memory Map / `threads/` dir). NO message bodies — just metadata + the usage rollup. Powers ThreadRail (resume targets + per-thread usage badge).

**`GET /runtime/:id/thread` → full thread (resume hydration).**

```jsonc
// 200 — :id validated by the existing [a-z0-9_-]{1,64} route regex
{ "id": "boss", "tier": "sonnet",
  "messages": [ { "role": "user", "content": "…" }, { "role": "assistant", "content": "…" } ],
  "usage": { /* ADR-030 rollup */ } }
// 404 { "error": "thread not found" }  — unknown / never-persisted id
```
Returns the persisted messages (capped at `THREAD_KEEP`, already trimmed on disk) so the client can hydrate `threadMsgs[id]` instead of starting empty. Every `content` egress-`scrub`bed.

**`POST /runtime/:id/fork {upTo?} → { id }` (server-minted new thread).**

```jsonc
// request — :id = SOURCE thread (route regex validated); body:
{ "upTo": 12 }   // optional: fork only the first N messages (branch point). absent → whole thread.
// 200
{ "id": "boss__fork_a3f9c1" }   // NEW server-minted id; client switches to it
// 404 { "error": "thread not found" } if source missing
// 400 { "error": "invalid upTo" } if upTo present and not a non-negative int
```

Fork semantics:
- Load the SOURCE thread (must exist → else 404).
- `slice(0, upTo)` if `upTo` is a valid int in `[0, messages.length]` (clamp); else the whole (already-`THREAD_KEEP`-trimmed) message list.
- Mint a NEW id: `` `${threadSafeId(sourceId)}__fork_${randomBytes(3).toString("hex")}` `` — a 6-hex suffix, collision-safe, **server-minted (never raw client input)**, re-`threadSafeId`'d so the final id still matches `[a-z0-9_-]{1,64}` (the `__fork_<hex>` shape is within the charset; total length re-clamped to 64).
- Copy the record: new `{ id: forkId, tier: source.tier, messages: forked, updatedAt: now, usage: source.usage }` (the usage rollup carries over so the forked thread shows the inherited footprint; ADR-030). Re-apply `THREAD_KEEP` + `THREAD_MAX_BYTES` via the existing `persistThread` path.
- `threads.set(forkId, forked)` + `persistThread(forkId, forked, source.tier)`. Return `{ id: forkId }`.
- **Thread-record copy ONLY.** No git worktree, no engine task. A fork does not branch in-flight engine work — that is out of scope for S2 chat fork (a future ADR could couple a chat fork to a worktree branch via the ADR-026 model if needed; explicitly NOT now).

### 2. Auth — extend the `needsAuth` family

These endpoints leak conversation content (read) and create state (fork) → they MUST be gated exactly like `/changes`. Extend the `needsAuth` regex (~L794) and add a sibling check for the collection-level `GET /runtime/threads` (which has no `:id`):

```js
// thread fork/resume endpoints join the gated family (token + origin; host enforced globally ~L655):
const needsAuth =
  /^\/runtime\/[a-z0-9_-]{1,64}\/(changes|apply|run|thread|fork)$/i.test(url.pathname) ||
  url.pathname === "/runtime/threads";
if (needsAuth && (!originOk(req) || !tokenOk(req))) { /* 401 — unchanged */ }
```

The client already sends `x-runtime-token` on the authenticated fetches (ChatPane `/changes` at ~L135). ThreadRail's new fetches reuse the same token header.

### 3. Resume wiring (client)

- ThreadRail calls `GET /runtime/threads` (token header) to list resume targets + usage badges.
- On selecting a persisted thread, fetch `GET /runtime/:id/thread` and `setThreadMsgs(prev => ({ ...prev, [id]: messages }))` in `App.tsx` (L146) — hydrating instead of starting empty. The active thread's tier (ADR-022) + usage (ADR-030) hydrate from the same response.
- Subsequent turns POST `/chat` as today; the server already appends to the SAME persisted thread.

### 4. Fork wiring (client)

- A fork button (ChatPane header / ThreadRail context action) `POST /runtime/:id/fork` with optional `upTo` (the index of a chosen message, or omitted for "fork at latest").
- On `{ id }`, ThreadRail adds the new thread and `App.tsx` switches the active thread to it (and hydrates via `GET /runtime/:id/thread`, or seeds `threadMsgs[forkId]` directly from the local copy). The original thread is untouched.

### 5. Idempotency / safety bounds

- **Id sanitization:** reuse `threadSafeId` for the source filename AND for the minted fork id (post-mint re-sanitize) → no path traversal; `threadFile` (~L148) already injects no caller path segment.
- **Bounded message count:** forked copy passes through the existing `THREAD_KEEP` (40) trim in `persistThread`.
- **Byte cap:** forked copy passes through `THREAD_MAX_BYTES` (256 KiB) — the existing oversize branch (~L172) re-trims; carry the `usage` rollup through that branch.
- **Collision-safe:** 6-hex suffix from `randomBytes(3)`; a re-fork of the same source gets a fresh suffix → distinct id. (A 2^24 birthday collision against the small thread set is negligible; if `threadFile(forkId)` somehow exists, the write simply overwrites an identical-prefix record — acceptable, but practically unreachable.)
- **Fork is non-mutating to source:** source record is read, never written, during fork.

### 6. Observability

- `GET /runtime/threads` doubles as the read model for ADR-030's per-thread usage badge and for any health view of thread count / sizes.
- Log fork events (`forked <sourceId> → <forkId> (<n> msgs)`) at info — auditable branch history without storing PII beyond what's already on disk.

## Security invariant (sr-security HARD gate)

**INVARIANT: thread endpoints expose conversation content and create persisted state — they MUST be token+origin+host gated; `:id` is regex-validated; the fork id is SERVER-minted (never raw client input); content is egress-scrubbed; no path traversal is possible.**

- All three endpoints join the `needsAuth` family (§2) → token + origin + global host gate. Unauthenticated → 401, no read, no write.
- `:id` for read/fork is validated by the existing route `[a-z0-9_-]{1,64}` regex BEFORE any file access; `threadFile` derives the path through `threadSafeId` with no caller-controlled path segment → no `../` traversal.
- The fork id is `threadSafeId(source) + "__fork_" + hex` — entirely server-constructed; the client supplies only the SOURCE `:id` (regex-gated) and an integer `upTo`. A client cannot dictate the new id or write outside `threads/`.
- `upTo` is coerced to a non-negative int and clamped to `[0, messages.length]` → cannot over-read, cannot index out of range, cannot be a string path.
- Every `content` in the read/list responses passes the existing egress `scrub` (~L268) — same scrub the SSE token channel uses.
- Reuses ADR-023 §3 store posture (writes only under `THREADS_DIR` via `threadSafeId`, gitignored, never seeded into a sandbox) — extended, never relaxed.

| Attack / failure | Vector | Mitigation |
|---|---|---|
| Conversation exfiltration | unauth `GET /runtime/:id/thread` from another local process / rebound page | token + origin + host gate (`needsAuth` family); 401 without token |
| Path traversal on read | `GET /runtime/..%2f..%2fetc%2fpasswd/thread` | route `[a-z0-9_-]{1,64}` regex rejects; `threadSafeId` strips; `threadFile` adds no caller path segment |
| Client-dictated fork id (overwrite arbitrary thread) | `POST …/fork` with a chosen target id | fork id is server-minted (`__fork_<hex>`); client supplies only the gated source `:id` |
| Fork id collision / overwrite | repeated forks | `randomBytes(3)` hex suffix per fork → distinct ids; source never overwritten (read-only on fork) |
| Oversized fork (disk abuse) | fork a thread near the byte cap | `THREAD_KEEP` + `THREAD_MAX_BYTES` re-applied via `persistThread` oversize branch |
| `upTo` injection / OOB | `upTo:"../"` or huge int | coerced to non-negative int, clamped to `[0, len]`; non-int → 400 |
| DNS-rebinding | rebound page calls thread endpoints | global `hostOk` (~L655) + `originOk` — same as `/changes` |
| Secret leak in thread body | a thread captured a secret-shaped string | egress `scrub` on every `content` in read/list responses |

sr-security S2 sign-off condition (BLOCKING): confirm (a) all three endpoints reject without token+origin (and host); (b) `:id` regex-validated and `threadFile` traversal-safe; (c) fork id is server-minted; (d) `upTo` bounded; (e) `scrub` runs on returned content. Reuses the F2b/S1 posture; relaxes nothing.

## Consequences

**Positive** — resume finally works (the server already persists; this is the missing read path); fork enables safe exploration of alternative conversation branches; cheap (record copy, no worktree/engine cost); small blast radius (3 endpoints + `needsAuth` regex extension + ThreadRail/App wiring); reuses every existing primitive (`threadSafeId`, `threadFile`, `persistThread`, `THREAD_KEEP`, `THREAD_MAX_BYTES`, the auth family, the usage rollup).

**Negative / accepted** — forked threads accumulate on disk (bounded per file; a future prune/delete endpoint is out of scope — Open Question 3); a fork inherits the source's `THREAD_KEEP`-trimmed history, not the full original (acceptable — the on-disk source is already trimmed); chat-fork does not branch in-flight engine work (explicit non-goal); `App.tsx` gains hydration logic (modest, additive, no shell reflow — ADR-023 S2 ratification).

## Rollback

- Endpoints are additive + read-mostly. Remove the three route handlers + revert the `needsAuth` regex → server reverts to ADR-023 behavior (persist + server-side hydrate only). Forked `threads/*.json` files are gitignored and can be deleted with no repo trace. Client reverts to empty `threadMsgs` on load (status quo). No data-contract break: the `usage` field (ADR-030) is additive and ignored by the old code path.

## Alternatives rejected

1. **Fork via git worktree (S1 model)** — a chat fork is a record copy; spinning a worktree is heavy and conflates conversation branching with engine work isolation. Worktrees are reserved for in-flight engine tasks (ADR-026); not here.
2. **Client-supplied fork id** — lets the client name/overwrite any thread file → an integrity + traversal surface. Server mints the id; client supplies only the gated source `:id`.
3. **Resume by replaying the SSE / re-running turns** — wasteful and non-deterministic; the messages are already on disk. Just read them.
4. **Reuse `SessionsBrowser` for chat resume** — `SessionsBrowser` is board-history (Track A), a different data model; conflating the two would couple unrelated subsystems. Leave it alone.
5. **No auth on the read endpoint ("it's just my chat")** — conversation content + a local-process / DNS-rebinding threat model means it MUST be gated exactly like `/changes`. No exception.
