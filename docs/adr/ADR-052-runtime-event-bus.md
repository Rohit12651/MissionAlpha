# ADR-052 — Runtime Event Bus (`GET /runtime/events`, SSE — push-driven Inbox, zero manual refresh)

- **Status:** ACCEPTED — IMPLEMENTED (as-built 2026-07-30, shipped in P2; PRECONDITION-052.1 RESOLVED in P9)
- **Date:** 2026-07-30
- **Slug:** `runtime-event-bus`
- **Plan:** Agent Inbox Program **P2** (`docs/superpowers/plans/2026-07-30-agent-inbox-program-plan.md` §2 Real-time Wiring Contract)
- **Deciders:** architect, senior-backend-1 (owner), **senior-security-engineer (HARD gate — new always-on transport)**
- **Builds on:** ADR-051 (Delivery engine — the event emitters), `server.mjs` auth gates (`tokenOk`/`originOk`/`hostOk`, L189-211)

## Context

Program plan §2 mandates one bus: "UI subscribes ONCE; nothing in the UI ever needs a manual refresh; nothing in the runtime waits for a human except a decision." Today the UI polls `GET /api/state.json` every 2s (P0 drift note: the runtime already serves this itself via `live-state.mjs`, health reports `engine`+`queue` counters). That poll is **not removed** — program plan §2: "existing 2s state.json poll stays as fallback (never removed — decoupled watcher principle)."

Event catalog (verbatim, program plan §2):

```
event: delivery.created    data: Delivery              → badge++, list insert, native notification
event: delivery.decided    data: {id,status,by}         → badge--, card state, board DONE, feed line
event: task.queued|started|retried|failed|done           → queue panel, station note
event: agent.state         data: {id,state,task}         → roster dots, kanban card glide
event: usage.tick          data: {agentId,tokens,ctx}     → usage meter
event: policy.autoapplied  data: {id,reasons}             → auto section + audit
```

**Amendment 2026-07-30 — `task.done`.** The catalog above originally had no success-terminal name, so a task reaching DONE left the queue with no frame and `QueueStrip` learned of it only from its 400ms debounced re-truth fetch. `task.done` was added (program plan §2 amendment, approved by Fable in BOSS's absence during the P4 hardening pass): emitted from `queue.update()` on the `→ done` transition, same emit-on-persist rule as `task.failed`, same 7-scalar `wire()` payload, guarded on the previous status so it fires exactly once. The catalog remains CLOSED — this is the only addition.

**Hard boundary:** this ADR adds a read-only fan-out transport. It creates no new capability to mutate anything — every event is a notification of a write ADR-051 (or ADR-024/027/028/029/053) already made through its own gated route.

## Decision

### 1. SSE vs WebSocket

| Option | Verdict | Why |
|---|---|---|
| **SSE (`GET /runtime/events`, `text/event-stream`)** | **CHOSEN** | Every catalog event is server→client only — no event in §2's list needs a client→server push (decisions go through the existing `POST /inbox/:id/approve` etc., ADR-051, not over the bus); `EventSource` auto-reconnects and replays via `Last-Event-ID` natively (§4); plain HTTP response, proxies through vite's existing dev proxy with no upgrade-header handshake (the same proxy class the P0 drift note already fixed for 7 other targets) |
| WebSocket | REJECTED | Needs its own reconnect/heartbeat logic (EventSource gives this free); the upgrade handshake sits awkwardly against the per-HTTP-request `needsAuth` gate model every other route uses; bidirectional capability is unused surface for zero benefit here |

### 2. Event catalog + emit-on-persist atomicity

The event list above is the full v1 catalog — no additions, no renames. **Rule: the same function that writes the DB emits the event — no dual paths.** `deliveries.mint()` (ADR-051 §4) calls `events.emit('delivery.created', row)` immediately after its own INSERT; a decide-handler calls `events.emit('delivery.decided', {...})` immediately after its status-flip transaction. Rejected alternative: a poller watching `events_log`/`deliveries` for changes — adds latency, and is exactly the "dual path" the program plan forbids (the write and the notify could disagree if the watcher lags or crashes between them).

### 3. Last-Event-ID replay — backed by `events_log` (ADR-051 §2)

`EventSource` sends `Last-Event-ID` automatically on reconnect. On a new connection, the handler:

1. Reads `req.headers["last-event-id"]` (if present).
2. Queries `SELECT * FROM events_log WHERE seq > ? ORDER BY seq` and writes those as backlog SSE frames (`id: <seq>` set on every frame so the client always has a fresh watermark).
3. Switches to live tail — same `events.emit()` call sites as #2, now also writing this response.

**Cap + prune:** keep the newer of **5000 rows** or **7 days**; prune runs once at boot (alongside `engine.reconcile()`, `server.mjs`) and on a simple modulo counter of new inserts (avoids a second timer) — `DELETE FROM events_log WHERE seq < (maxSeq - 5000) OR createdAt < (now - 7d)`.

**Replay cap + backpressure (hardened 2026-07-30):** a single reconnect replays at most **500** frames, not the full 5000-row log — no one disconnect legitimately misses more, and the client re-reads authoritative state on every (re)open (`onResync`), so a short replay is a latency detail, never a correctness one. The replay loop also honours `res.write() === false`: it stops and resumes on `'drain'`, instead of buffering the remainder of the batch in node's heap for exactly the client least able to drain it.

### 4. Heartbeat

A `: ping\n\n` comment frame every **25s** — under the common 30s proxy/LB idle timeout, standard `EventSource` keepalive convention — both keeps the connection alive through any intermediary and lets the server detect a half-open socket via the next write's error.

### 5. Client registry + cleanup

An in-process `Map<connId, ServerResponse>` (single Node process — no cross-process fan-out, no Redis; consistent with the local-first invariant). `req.on("close", ...)` removes the entry, mirroring the existing `inflight` cleanup pattern (`server.mjs:962`, `res.on("close")`). A small connection cap (`RUNTIME_MAX_SSE_CLIENTS`, default modest — this is a loopback single-operator tool, not a public server) guards against runaway tab-leak scenarios; SSE connections do **not** consume the `MAX_INFLIGHT` budget (ADR-024 §6) — they never spawn a `claude` child.

### 6. Auth mechanism — the central decision

`tokenOk` reads the `x-runtime-token` request **header** (`server.mjs:189-197`). Browser `EventSource` cannot set custom request headers — there is no way to send that header on the SSE `GET`. This is the actual problem this ADR must solve, not a hypothetical one.

| Option | Verdict | Why |
|---|---|---|
| Token as a query param (`?token=...`) | **REJECTED** | Leaks into server/proxy access logs and browser history; violates this repo's own "never egress the token" posture (`server.mjs:438` strips the token from scrub output on the way OUT — putting it in a URL puts it in cleartext on the way IN); the value is the same long-lived secret as every other route's token, so a leaked query string compromises everything, forever, not just this stream |
| Cookie-based session | REJECTED | The runtime has no login/session primitive today (token-file-per-boot only); introducing cookies is a second auth model — that's ADR-039 (approval-permission-ux) territory, far larger than this ADR |
| No auth on the GET, rely on `hostOk`/loopback only | REJECTED | `hostOk`/`originOk` alone don't stop a malicious page already open in the user's own browser (the DNS-rebinding threat model `server.mjs`'s comments already name) from opening `GET /runtime/events` and reading every Delivery's content merely by knowing the fixed local port — no different from why every other route needs the token, not just host/origin |
| **Short-lived signed ticket** | **CHOSEN** | See below |

**Chosen pattern:** `POST /runtime/events/ticket` sits in the existing `needsAuth` set (token+host+origin gated, identical to `/apply`). It mints `ticket = randomBytes(24).toString("hex")` and stores `{ticket, expiresAt: now+30_000, consumed: false}` in an in-process `Map` (same generation pattern already used for `RUNTIME_TOKEN` itself, `server.mjs:154`). The client immediately opens `new EventSource('/runtime/events?ticket=' + ticket)`. The SSE handler validates: ticket exists, `!consumed`, `now < expiresAt`, `timingSafeEqual` compare — then marks it consumed **before** writing SSE headers, so a race can't double-spend it. `hostOk`/`originOk` still apply to the GET itself (those headers ARE sent automatically by `EventSource`, unlike `x-runtime-token`) — the ticket only replaces the piece `EventSource` structurally cannot provide.

This shrinks the exposure window from "the master token, forever, in a URL" to "an unguessable 24-byte value, one use, 30 seconds." A captured ticket (log scrape, browser history, shoulder-surf) is worthless after the first connect or after 30s.

### 7. Scrub before emit

`events.emit()` runs every payload through the SAME `scrub()`/`SECRET_RE` (`server.mjs:426-438`) used for chat and Delivery egress (ADR-051 §7) — one shared call site, not a second implementation living in `events.mjs`.

### 8. Poll fallback stays — decoupled watcher principle

`GET /api/state.json` (`live-state.mjs`) is **unchanged and unconditional**. This ADR's only obligation toward it: never gate or remove that route behind SSE health. UI-side reconnect/fallback behavior (`useRuntimeEvents.ts`) is P3 frontend scope, not decided here.

## Preconditions (the scope this design is only valid inside)

> **PRECONDITION-052.1 — RESOLVED 2026-07-30 (P9, `docs/superpowers/plans/2026-07-30-inbox-P9.md`; sr-security to confirm).**
> P9 landed the second seat and resolved this precondition by **choosing option (a) of the two the "Required before any of those ship" paragraph offered: the single-tenant model, made enforceable** — rather than per-event ownership scoping. The runtime is declared **single-tenant**: all authenticated seats are one team sharing one Inbox, so every seat legitimately sees every Delivery frame (exactly as they all see `GET /inbox`). The boundary that P9 adds is not *between* seats but *around* the stream: the events **ticket** (`POST /runtime/events/ticket`), and therefore `GET /runtime/events`, can now be minted **only by an authenticated principal** — when auth is active (≥2 accounts, `users.mjs`) the ticket route requires a valid session (any role; a viewer legitimately watches), and solo (0/1 account) stays token-only exactly as before. So an **unauthenticated** second party cannot open the stream at all and can never receive another seat's frames. The authz-matrix proof the paragraph below demanded is met in its single-tenant form: `agent-runtime/test/auth-http.test.mjs` asserts *token-only ticket-mint → 401 when auth is active, valid-session → 201*. Per-event ownership scoping (the option (b) path below) remains the required design **if and when** Deliveries ever become assignee-private (P9 assignment is advisory, not private) or a per-agent ACL ships — those triggers are unchanged. The original analysis is preserved below for that future.

**PRECONDITION-052.1 — SSE has NO per-client scoping.** Neither fan-out nor replay filters by subscriber. `events.emit()` writes the same frame to **every** connected client, and a `Last-Event-ID` reconnect replays rows straight out of `events_log` with no ownership predicate — the only bound is the replay cap. There is no notion of "whose event this is" anywhere in `events.mjs`, because there is no notion of a user anywhere in the runtime.

This is **acceptable, and only acceptable, while both of the following hold:**

1. **Single principal** — exactly one human operates this runtime, and every agent acts on that one person's behalf. Every event is already that person's own data, so broadcasting it to their own tabs discloses nothing.
2. **Loopback-only** — the server binds `127.0.0.1`, and the only path to a stream is `hostOk`/`originOk` **plus** a single-use ticket mintable only by a caller that already holds the master token (§6). A remote party cannot subscribe at all.

**It becomes a BLOCKER the moment either stops holding.** Concretely:

| Trigger | What breaks |
|---|---|
| **P9 — second seat** (`users.mjs`, roles, assignment) | Two principals, one undifferentiated stream: user B's `EventSource` receives user A's `delivery.created` payloads — title, summary, changed paths, task text — and B's reconnect replays A's history out of `events_log`. Role checks on `POST /inbox/:id/approve` are irrelevant here; the bus bypasses them entirely because it was never a decision surface. |
| **Per-agent ACLs** (an agent or an integration subscribing on its own behalf) | Same failure one level down: a scoped agent would receive every other agent's Deliveries, defeating the scoping it was given. |
| **Any non-loopback bind / remote or multi-machine access** | Precondition 2 is gone; the ticket becomes the only boundary, and it was sized for a local single-operator tool. |

**Required before any of those ship** (not after): an ownership/visibility column on the event at emit time, an ownership predicate on the fan-out loop **and** on the replay query (both — filtering only one leaks the other), and an authz-matrix test proving a second principal's stream never carries the first's frames. Cross-referenced from the P9 phase of the program plan, which carries this as an in-phase blocker rather than a follow-up.

## Security invariants

| Attack | Vector | Mitigation |
|---|---|---|
| Token leaked via query string | long-lived master token in a URL forever | Rejected outright (§6); ticket is the only credential ever in a query string, and it is short-lived + single-use |
| Ticket replay | captured ticket reused after first connect | `consumed` flag set atomically before SSE headers are written (§6) |
| Ticket brute-force | guessing a valid ticket before it expires | 24 random bytes (same entropy class as `RUNTIME_TOKEN`), 30s window |
| Malicious loopback page opens the stream | DNS-rebinding / same-machine malicious tab | `hostOk`+`originOk` still gate the GET (§6); ticket-mint POST is fully token-gated, so a page with no token can never obtain one |
| Egress carries a secret | Delivery/task payload contains a token-shaped string | Same `scrub()` as every other egress path (§7) |
| Connection exhaustion | many tabs/pages open SSE streams | `RUNTIME_MAX_SSE_CLIENTS` cap (§5); does not touch `MAX_INFLIGHT` (SSE spawns nothing) |
| `events_log` unbounded growth | long-running instance never restarted | 5000-row / 7-day prune sweep (§3) |

## Consequences

**Positive** — every catalog event reaches the UI in one push, badge/board/feed/meter update with no polling latency for the events that matter most (Delivery arrival, decision); replay makes a brief disconnect invisible to the user; the ticket pattern closes the token-in-URL gap without inventing a second full auth system.

**Negative / accepted** — a new in-process ticket `Map` and connection registry to keep correct; SSE is one more moving part in `server.mjs`; the ticket's 30s TTL means a client that stalls between mint and connect must re-mint (acceptable — mint→connect is a single synchronous browser call, not a human-paced gap).

## Alternatives rejected

1. **WebSocket** — rejected in full (§1); no bidirectional need in the v1 catalog.
2. **DB-polling watcher instead of emit-on-persist** — rejected (§2): reintroduces the exact dual-path risk the program plan's wiring contract forbids.
3. **Token in query string** — rejected (§6): permanent secret in logs/history.
4. **No SSE auth, loopback-only trust** — rejected (§6): doesn't defend against the DNS-rebinding/malicious-tab model this codebase already designs against everywhere else.
5. **Redis/external pub-sub for fan-out** — unnecessary for a single-process, single-machine, local-first tool; an in-process registry (§5) is simpler and matches every other piece of runtime state in this repo.

## Open questions

- **OQ-052.1 (security):** should ticket-mint rate itself be throttled? The mint route is already fully token-gated (only a caller who already has the master secret can mint), so a ticket adds convenience, not a new trust boundary — current recommendation is no extra throttle beyond the connection cap (§5), revisit if abuse is observed.

## As-built (2026-07-30)

Shipped in **P2** as the single push transport for the Inbox; `agent-runtime/events.mjs` holds the SSE broadcaster (in-process `Map` client registry, 25s heartbeat, `events_log`-backed `Last-Event-ID` replay with the 500-frame cap + `drain` backpressure of §3, egress `scrub()`). Auth landed **exactly as the single-use signed-ticket design of §6** — `POST /runtime/events/ticket` (token+host+origin gated) mints a 24-byte, 30s, one-use ticket, consumed atomically before headers write. The 2s `state.json` poll stays as the untouched fallback. UI subscribes once via `src/lib/useRuntimeEvents.ts`. Tests: `agent-runtime/test/events.test.mjs`, `auth-http.test.mjs`.

**Catalog as-built:** the v1 catalog shipped closed, plus the disclosed **`task.done` amendment** (P4) — added to `EVENT_NAMES`, `RUNTIME_EVENT_NAMES`, and this ADR §2 together, with both catalog-equality tests asserting the new list. `usage.tick` began actually emitting in P8. No other name added or renamed.

**PRECONDITION-052.1 — RESOLVED in P9** (see the Preconditions block above, updated in place). Resolution chose the single-tenant model made enforceable rather than per-event ownership scoping: all authenticated seats are one team sharing one Inbox, and when auth is active (≥2 accounts, `users.mjs`) the events ticket can be minted **only by a valid session** — proven by `agent-runtime/test/auth-http.test.mjs` (token-only ticket-mint → 401 when auth active; valid session → 201). Solo (0/1 account) stays token-only, unchanged. Per-event ownership scoping remains the required design only if Deliveries ever become assignee-private or a per-agent ACL ships (both still future — P9 assignment is advisory).

**Security:** P4 sr-security SECURITY_APPROVED (1 MED + 4 LOW hardened); P9 sr-security ran 3 rounds and signed off with 052.1 explicitly covered. No deviation from the chosen transport, auth, or scrub design.

## Amendment B2 (2026-07-30) — the five Business-OS names

The catalog is CLOSED, which is exactly why this amendment adds **five names at once** rather than one per phase. Each widening of a closed wire contract is a chance to desync three artefacts that must agree byte-for-byte — `EVENT_NAMES` (`agent-runtime/events.mjs`), `RUNTIME_EVENT_NAMES` (`src/lib/useRuntimeEvents.ts`), and the two catalog-equality tests that pin them together (`agent-runtime/test/events.test.mjs`, `src/lib/__tests__/useRuntimeEvents.test.ts`). Registering the Business-OS set once means B4, B6 and B7 ship their emitters against a catalog that is already correct, and the contract changes exactly **once** for the whole program.

| Name | Phase | Status | Payload | Consumer |
|---|---|---|---|---|
| `vault.written` | **B2** | **LIVE** | `{id, node, venture, agent}` | Vault page record list, `RECORDS READ` on the Command deck |
| `workflow.run` | B4 (cadence) | RESERVED | — | — |
| `lead.moved` | B6 (pipeline) | RESERVED | — | — |
| `content.changed` | B6 (content) | RESERVED | — | — |
| `output.created` | B7 (outputs) | RESERVED | — | — |

**What RESERVED means, precisely.** `emit()` accepts the name and `parseEvent()` will not drop it — and **no caller emits it and no component renders off it**. That is a disclosed gap, not a stub: nothing in the UI reads these four, so nothing displays a fabricated number while they are dormant. The B2 catalog-equality tests assert the full seventeen-name list, so a name added later without the matching client + ADR edit fails both suites.

**`vault.written` obeys every existing invariant.** It is emitted from `vault.mjs write()` — the same function that writes the record — under the **emit-on-persist** rule of §2, so there is no watcher and no dual path. It runs through the same shared `scrub()` as every other payload (§7). The payload is **identity only**: id, node, venture, author. No title, no body, no excerpt. That is deliberate and follows directly from PRECONDITION-052.1's single-tenant resolution — a frame reaches *every* connected seat, so the record's content stays behind the auth-gated `GET /runtime/vault/record`, which the reader must be authorised for. The bus says *that* a record exists; it never says *what is in it*.

**No change** to the transport, the ticket auth, the replay contract, the connection cap, or the prune policy. This amendment adds names to a Set — nothing else.
