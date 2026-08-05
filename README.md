# MissionAlpha — The Agent Inbox

**One inbox for every AI agent's work.** MissionAlpha turns finished agent output —
from its own agent swarm, from external vendor agents (Cursor / Codex / Devin, which all
deliver as GitHub PRs), and from local Claude Code sessions — into a single reviewable
stream of **Deliveries**. Each Delivery is risk-classified, routed by a BOSS-editable
policy, decided by a human (or auto-applied when explicitly allowed), and shipped as a
real branch/PR. Agents queue, run, retry and self-heal on their own; **the human only
appears at the decision.**

It runs local-first as a Vite web app plus a small Node runtime, and ships as an Electron
desktop app. No cloud dependency for the core loop.

> **Status:** feature-complete through P9; **P10 (dogfood + ship-grade hardening) in
> progress.** Some capabilities require local setup — see [Requires setup](#requires-setup).

---

## What it is

- **A queue of decisions, not a dashboard.** Every completed agent run mints a `Delivery`
  (title, summary, diffstat, changed paths, risk band, SLA). You approve, request changes,
  or reject.
- **Risk-routed.** A pure, deterministic classifier scores each Delivery `low` / `medium` /
  `high`; policy decides the friction (auto-approve / notify / human / typed-confirm).
- **Human-approved, then shipped as a PR.** Approve runs the proven broker →
  git-worktree → commit → `gh pr create` ladder (falls back to a local branch when there
  is no remote).
- **Autonomous between decisions.** A durable queue dispatches tasks (per-agent serial,
  cross-agent parallel up to `MAX_INFLIGHT`), auto-retries transient failures, mints a
  "agent stuck — needs you" failure Delivery on exhaustion, and auto-chains the next task
  on approval. Queue local N tasks and walk away.
- **Universal ingestion.** Bot-authored GitHub PRs and local Claude Code sessions appear
  as Deliveries beside swarm work in the same Inbox.
- **Push-driven.** The whole UI subscribes once to a server-sent-events bus; badge, board,
  feed, review pane and usage meter update with no manual refresh. A 2s poll stays as a
  decoupled fallback.

---

## Architecture

```
                         MissionAlpha (Electron / browser)
 ┌───────────────────────────────────────────────────────────────────────┐
 │  React 19 + Vite 5 (:3004)                                             │
 │    Inbox · Board · Review pane · Queue strip · Usage meter · Settings  │
 │        │  subscribes ONCE (SSE)         ▲  approve / reject / changes  │
 └────────┼──────────────────────────────  │ ───────────────────────────┘
          │  GET /runtime/events (SSE)      │  POST /inbox/:id/approve …
          ▼   (single-use ticket)           │  (token + host + origin gated)
 ┌───────────────────────────────────────────────────────────────────────┐
 │  agent-runtime — Node 20 (:3005, loopback 127.0.0.1)                   │
 │    deliveries.mjs · db.mjs (SQLite/WAL) · events.mjs (SSE bus)         │
 │    queue.mjs · scheduler.mjs · self-heal.mjs   (autonomy)              │
 │    risk.mjs · policy.mjs        (risk band + per-band policy + SLA)    │
 │    worktree.mjs · pr.mjs · workspace.mjs        (branches + PRs)       │
 │    adapters/github.mjs · claude-sessions.mjs    (universal ingestion)  │
 │    users.mjs (roles/sessions) · usage.mjs · broker.mjs (repo writes)  │
 └───────────────────────────────────────────────────────────────────────┘
          │ approve → broker.applyChanges → git worktree → commit → gh pr create
          ▼
     Target git repo  (any repo you point it at; MissionAlpha itself by default)
```

- **Delivery is the core object.** SQLite (`better-sqlite3`, WAL) is the queryable store;
  patch bodies live on disk under `data/patches/<id>/`, not in the DB. See
  [ADR-051](docs/adr/ADR-051-delivery-engine.md).
- **The bus** (`GET /runtime/events`, SSE) fans out `delivery.created` / `delivery.decided`
  / `task.*` / `agent.state` / `usage.tick` / `policy.autoapplied`. Auth is a single-use,
  30-second signed ticket (browser `EventSource` cannot send the token header). See
  [ADR-052](docs/adr/ADR-052-runtime-event-bus.md).
- **Approve never bypasses the broker.** A repo write happens only through the unchanged
  `applyChanges` path; a Delivery reaching `approved` alone writes nothing.
- **Ports:** app `:3004`, runtime `:3005`. (A dev/verify lane may run a second runtime on
  `:3006` via `RUNTIME_PORT` — do not confuse it with a second service.)

The pre-Inbox **cockpit** (swarm board, chat, globe) still exists and stays byte-identical
when the Inbox feature flag is off — it is the kill-switch, not a rewrite.

---

## Running it

**Prerequisites:** Node 20+ (tested on Node 22), npm. `gh` and a Claude auth path are
optional — see [Requires setup](#requires-setup).

```bash
cp .env.example .env      # defaults are self-contained; edit only if you pin a repo/db
npm install
```

### Web dev (two processes)

```bash
# terminal 1 — the app
npm run dev               # Vite on http://localhost:3004

# terminal 2 — the runtime
node agent-runtime/server.mjs      # listens on 127.0.0.1:3005
#   backend auto-selects: cli (Claude subscription, default) if no key,
#   api if ANTHROPIC_API_KEY is set. Force one with RUNTIME_BACKEND=cli|api|mock.
```

The Vite dev server proxies `/runtime`, `/inbox`, `/factory`, `/api/*` to the runtime, so
the browser never talks to `file://` or crosses origin.

### Desktop (Electron)

```bash
npm run electron:dev      # spawns the runtime (RUNTIME_BACKEND=cli) + the app together
npm run electron:build    # packaged .app / .dmg (electron-builder; rebuilds better-sqlite3)
```

### Verify

```bash
npm run build             # tsc + vite build
npm run typecheck         # tsc --noEmit
npm run lint              # eslint, --max-warnings 0
npm run test:unit         # UI/lib unit tests
npm run test:runtime      # agent-runtime tests (boots a real server for some suites)
npm run test:vendor       # skills vendoring tests
```

### Key environment variables

All runtime config is env-driven; every var has a safe default (see `.env.example` for the
full, commented set).

| Variable | Purpose |
|---|---|
| `RUNTIME_PORT` | runtime port (default `3005`) |
| `RUNTIME_BACKEND` | `cli` (subscription, default) · `api` (needs key) · `mock` (tests) |
| `RUNTIME_DB_PATH` | SQLite Delivery/events store (default `agent-runtime/data/mission.db`, `0600`) |
| `RUNTIME_REPO_ROOT` | **pin** the target repo (CI/launcher); makes the Settings picker read-only |
| `RUNTIME_CONFIG_DIR` / `RUNTIME_TOKEN_DIR` | where the persisted workspace + per-boot token live (outside any repo) |
| `RUNTIME_COMMIT_NAME` / `RUNTIME_COMMIT_EMAIL` | commit identity for approve→commit (deliberately non-personal) |
| `RUNTIME_PR_TIMEOUT_MS` | per-command timeout for the git/gh approve ladder (default `60000`) |
| `RUNTIME_SLA_LOW_MS` / `_MED_MS` / `_HIGH_MS` · `RUNTIME_SLA_SWEEP_MS` | SLA deadlines + sweep cadence |
| `RUNTIME_POLICY_FILE` / `RUNTIME_ADAPTERS_FILE` | BOSS-editable policy + ingestion-adapter config (JSON) |
| `RUNTIME_MAX_SSE_CLIENTS` | SSE connection cap (default `16`) |
| `VITE_INBOX` | Inbox feature flag; set `0` to render the pre-Inbox cockpit unchanged (kill-switch) |
| `WAAHYU_STATE_PATH` | legacy cockpit `state.json` source (defaults to this repo's own `agent-status/`) |

> Multi-user login activates only at **≥2 accounts** (`AUTH_ACTIVE_MIN_USERS`, a code
> constant, not an env var). Solo use is zero-login by default.

---

## Requires setup

These capabilities are built and tested against injected/mocked runners but are **unproven
against the real service on this machine** until you complete local setup:

- **Real GitHub PRs + GitHub ingestion** — `brew install gh && gh auth login`. Without
  `gh`, approve falls back to a **local branch** (no PR), and the GitHub-PR ingestion
  adapter has nothing to poll. The runtime never stores the token; it shells out to `gh`,
  which keeps the token in its own keychain.
- **Live agents** — the default `cli` backend needs a Claude subscription reachable via the
  `claude -p` CLI; `mock` runs the full loop with a stub for local verification.

---

## Security posture

Local-first and defense-in-depth. Highlights (full detail in the ADRs):

- **Loopback + gated.** The runtime binds `127.0.0.1`. Every mutating route requires a
  per-boot **token** plus **host** and **origin** checks (defends the DNS-rebinding /
  malicious-local-tab model). The SSE stream uses a **single-use, 30s ticket** instead of
  putting the token in a URL.
- **Second-seat auth.** With ≥2 accounts, login is required: scrypt-hashed passwords,
  `httpOnly` `SameSite=Strict` session cookies, in-memory opaque session store (restart
  logs out — no secret at rest), and **server-side role enforcement** (a `viewer` cannot
  decide, proven by curl → 403).
- **Auto-apply is deny-by-default.** Off everywhere unless the BOSS opts in per band; an
  **un-removable built-in deny-list** forces human review on sensitive paths; the risk
  classifier errs toward the higher band; every auto-apply writes an audit line. External
  deliveries (GitHub / Claude Code) are **triple-gated** and can never auto-apply.
- **Repo writes only via the broker.** `applyChanges` + `CONFIG_GUARD` (refuses
  `package.json` script edits) + `APPLY_DENY` are unchanged; agent work is isolated in git
  **worktrees**; workspace paths are realpath + containment checked (case-insensitive after
  the P5/P6 fixes) and `$HOME` / repo-root are refused.
- **Egress scrub.** Every payload leaving the runtime — chat, Delivery, SSE frame, audit
  export — passes the same `SECRET_RE` scrub. No dollar amounts are ever emitted (usage is
  tokens + context %, never cost).

---

## Feature history (P0–P9)

Built phase-by-phase; each phase passed build + lint/typecheck + unit + runtime + security
+ runtime-verification gates before the next began. Cumulative tests at P9:
**210 unit · 765 runtime · 28 vendor.** ([Program plan](docs/superpowers/plans/2026-07-30-agent-inbox-program-plan.md).)

| Phase | Shipped |
|---|---|
| **P0** Baseline & guardrails | Fixed broken lint (eslint installed real, 46+5 → 0/0) and unit runner (9-fail → 100-pass); wired 297 orphaned runtime tests; regression suite (`docs/qa/REGRESSION.md` R1–R10). |
| **P1** Debt burn-down | Per-agent **Stop** button (mid-stream interrupt), send-loading indicator, full **1800+ skills** palette (virtualized/searchable), delete-agent (CEO undeletable), Agent-Factory manual skill add, "CEO picks the team". |
| **P2** Delivery engine + bus | SQLite `deliveries` + `events_log`; SSE event bus; `GET /inbox`, approve/reject/request-changes through the broker. (sr-security: 2 HIGH fixed.) |
| **P3** Inbox UI + notifications | The Helm Inbox surface — Delivery cards, full-diff review pane, risk chips, SLA timers, typed-confirm; native notification + dock badge; flag-off kill-switch. |
| **P4** Autonomy | Durable queue (survives restart), transient-error auto-retry, failure Deliveries, auto-chain on approve, `MAX_INFLIGHT` parallelism. Proven live: enqueue → fail → retry → failure Delivery, zero human between steps. |
| **P5** Any repo · worktrees · PRs | Point at any git repo; per-task git worktrees; approve → commit → push → `gh pr create` ladder (local-branch fallback). (sr-security: 1 CRIT case-sensitive `$HOME` bypass + 2 HIGH fixed.) |
| **P6** Risk router · policy · SLA | Deterministic classifier; deny-by-default per-band policy + un-removable deny-list; absolute-UTC SLA with half-life re-notify + expiry escalation. (sr-security: 1 HIGH deny case-sensitivity fixed.) |
| **P7** Universal ingestion | GitHub-PR adapter (two-way sync, idempotent) + read-only Claude Code sessions adapter; external deliveries triple-gated. (sr-security: clean — no CRIT/HIGH.) |
| **P8** Usage meter · audit export | Live tokens + context % per agent/thread/tier on the bus; streamed, scrubbed, gated JSON/CSV audit export. No dollars. |
| **P9** Second seat | Local users, roles (approver/viewer), sessions, advisory assignment; solo zero-login unchanged; resolved the ADR-052 per-client-scoping precondition (single-tenant, made enforceable). (sr-security: 1 HIGH role-gate under-scope fixed.) |
| **P10** Dogfood + hardening | **In progress** — ship-grade a11y/perf/design audits, Electron package check, and a BOSS-operated dogfood week. |

---

## Docs

- **ADRs:** [`docs/adr/`](docs/adr/) — 051 (delivery engine), 052 (event bus), 053 (risk
  router / policy / SLA), 054 (ingestion adapters), plus the earlier engine/broker/sandbox
  set.
- **Program plan:** [`docs/superpowers/plans/2026-07-30-agent-inbox-program-plan.md`](docs/superpowers/plans/2026-07-30-agent-inbox-program-plan.md)
  and the per-phase `2026-07-30-inbox-P<N>.md` task docs.
- **QA:** [`docs/qa/BASELINE-2026-07-30.md`](docs/qa/BASELINE-2026-07-30.md),
  [`REGRESSION.md`](docs/qa/REGRESSION.md), and the P10 `FINAL-SWEEP-2026-07-30.md` program record.

## Stack

React 19 · Vite 5 · TypeScript (strict) · Tailwind 3 · Framer Motion · Three.js /
react-three-fiber (cockpit globe) · Node 20 (ESM) · better-sqlite3 (WAL) · Server-Sent
Events · `claude -p` subscription CLI · `gh` CLI · Electron 33.
