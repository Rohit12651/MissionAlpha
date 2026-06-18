# MissionAlpha — Session Memory

Living log of build decisions + state. Caveman where terse; normal prose for design rationale.
Last updated: 2026-06-15 (Cycle 1; Cycle 2A; Boss Console; dispatch bridge; CLI subscription backend; F2a read; F2b write+sandbox+broker; config-guard; auth-token+anti-rebinding on /apply — ALL done + 2x security-reviewed + verified).

## SHIPPED (2026-06-15): git init + pushed to https://github.com/Rohit12651/MissionAlpha (main, commit fcf22c8).
gitignore excludes node_modules, .env (both), .runtime-token, agent-status runtime data
(history/ was 1.9G sim junk, SYNC_LOG, HEARTBEAT, INBOX, commands, state.json, *.md status files,
sandboxes). 168 files on remote, no secrets. Histories were unrelated (fresh init vs GitHub stub) →
force-with-lease replaced the auto-stub. credential.helper=osxkeychain (worked); no gh CLI.
Re-push: `git push origin main` (may need keychain/PAT interactively if non-interactive shell fails).

## AUTONOMOUS LOOP (2026-06-15) — BOSS goal → agent builds → reports back — DONE + verified
The full loop: BOSS chats CEO → CEO proposes ```dispatch → operator confirms (F3) → each task
directive triggers the agent to actually DO the work → operator reviews diff → apply → agent
reports DONE to BOSS feed. Reuses F2b sandbox+broker.
- `agent-runtime/server.mjs`:
  - `POST /runtime/:id/run {task}` — token+host gated (added "run" to needsAuth), requires
    TOOLS=write, inflight-capped. Builds task-framed prompt → handleChat (write-mode: seeds sandbox,
    spawns claude -p with Write/Edit in --add-dir sandbox). Agent edits sandbox only.
  - reportBack(agentId, summary) — after successful /apply, spawns agent-heartbeat.sh DONE_CYCLE +
    agent-sync.sh <agent> BOSS task-done. So apply → DONE on board + sync in BOSS feed.
- `src/components/BossConsole.tsx`: fireDispatch now, after recording directives via /api/command,
  also POSTs /runtime/<target>/run {task} (token from /api/runtime-token) per task directive →
  agents actually run. Status: "N agent(s) running — review diffs in their drawers".
- FLOW: dispatch confirm → agents run (sandbox) → open each agent drawer → F2b proposed-changes
  panel → review → apply → repo updated + DONE in feed.
- VERIFIED (curl, full loop): /run task → agent edited sandbox → /changes diff → repo clean pre-
  apply → /apply → repo got file → senior-web-1 state=DONE_CYCLE + BOSS feed "done: 1 file(s):
  src/LOOP.txt". /run no-token→401. Dashboard loads clean, no console errors.
- Human stays gate: operator confirms dispatch AND each apply. No auto-apply.
- sr-security review of /run + reportBack: NEEDS-FIX (no BLOCK). /run auth SAFE, spawn SAFE
  (argv array no shell), sandbox/broker boundary SAFE. Fixed: (#5) bus-format field injection via
  crafted src/ paths → reportBack clean() strips ["'`|$=]+control; applyAllowed rejects ["'`|$=]
  paths; agent-sync.sh strips BODY "/newlines. (#2b) agent-heartbeat.sh awk-splice → validates
  AGENT regex + strips | from fields. VERIFIED: bad agent→"invalid agent name", metachar paths→
  rejected, report-back still works + SYNC_LOG line well-formed.
- NOTE: dispatch→run browser e2e is code-wired + components individually verified; the real-CEO
  must emit a ```dispatch block (system prompt instructs it) for the UI path to trigger runs.

## What MissionAlpha IS
Standalone agent-swarm command tower. Decoupled watcher. Contract = reads ONE file
`agent-status/state.json` (via `WAAHYU_STATE_PATH`) + writes commands to `agent-status/commands/`.
Stack: React 19 · Vite 5 · TS strict · Tailwind 3 · Framer Motion · Three.js (r3f). Port 3004.
Principle (README): "zero coupling beyond that one path." Do NOT break it.

## Comms bus mechanism (how swarm → dashboard works)
- `scripts/agent-heartbeat.sh <agent> <STATE> "<task>" "<files>" "<blocked-by>" "<next>"` → rewrites BROADCAST.md row + appends HEARTBEAT.md.
- `scripts/agent-sync.sh <from> <to> <topic> <ref> "<body>"` → appends SYNC_LOG.md (FROM=/TO=) + recipient INBOX. THIS is "agents talking" → globe edges + live feed.
- `scripts/emit_state.py` → parses BROADCAST/SYNC_LOG/HEARTBEAT/SCHEDULER → writes state.json.
- `scripts/consume_commands.py` → drains commands/ → writes acks.json / respawns.json (loop-close).
- `scripts/agent-scheduler.sh` (via scheduler-ctl.sh start|drive) → ticks emit_state + consume_commands each ~50s. `drive` = AGENT_DRIVER=claude = REAL agents headless = COST.
- States: IDLE | IN_PROGRESS | BLOCKED | AWAITING_REVIEW | RETURNED_FOR_FIX | DONE_CYCLE | OFFLINE. Stale thresholds 120/180/240s.

## Command channel (write-back)
- UI POST `/api/command` {type,target,issuedBy[,reason,body]} → vite middleware validates (type allow-list {ack,respawn,task}, 8KB cap, target-must-exist, no shell) → writes commands/<id>.json + AUDIT.log → consumer drains.
- Buttons: Acknowledge (ack→quiets scheduler), Request Respawn (respawn→revives, self-healing OFFLINE→IDLE), Dispatch task (task→INBOX line, 2000-char cap). All record INTENT only; never run shell from browser.

## CAVEMAN MANDATE (NON-NEGOTIABLE — added this session)
`.claude/agents/PROTOCOL.md` Hard Rule: every agent communicates `/caveman full` on the bus
(heartbeat task/next, sync bodies, INBOX). Code/commits/ADR/memo bodies = normal prose.
First action each session: `/caveman full`. Violations = blocking finding.

## Cycle 1 — Operator Control Plane — COMPLETE (built by Claude this session, real code)
Scope doc: `docs/ceo/cycle1-control-plane-scope.md` (+ .docx). All on-architecture, no LLM, flag-able.
- F3 Permission gate — `src/components/PermissionGate.tsx` (reusable confirm modal: focus-trap, ESC/backdrop cancel, affected list+count, Emil motion).
- F6 Bulk actions — `src/components/BulkActionBar.tsx` (ack-all-stale / respawn-all-offline; loops existing /api/command; F3 HARD-gates F6).
- F5 Audit viewer + F7 command feedback — `src/components/ControlPlanePanel.tsx` (pending/done/rejected pills + expandable audit table w/ lifecycle chips). Polls new endpoints.
- Endpoints added to `vite.config.ts`: `GET /api/audit?limit=N` (tail-N AUDIT.log) + `GET /api/commands/status` (pending/done/rejected dirs).
- Types added `src/data/types.ts`: AuditEntry, CommandLifecycle, CommandStatusEntry, CommandStatusSnapshot.
- Seam ext `DataSource.ts`/`LocalPollAdapter.ts`/`useAgentState.ts`: getAudit(), getCommandStatus().
- Wired in `src/App.tsx` (live-only, hidden in replay).
- NOTE: `VITE_CONTROL_PLANE` feature flag from scope was SKIPPED (shipped always-on for live demo). TODO if formalizing.

## Swarm simulator (demo tool — NOT real agents)
`scripts/sim_swarm.py` — drives 16 agents (heartbeat + caveman talk + emit_state) so dashboard
looks alive with ZERO cost. Cadence 6s (TICK_SECONDS env). 25 caveman talk msgs. Injects
senior-web-2 = BLOCKED (blocked-by senior-security-engineer) so BLOCKED column + globe populate.
`--once` for single tick. It's THEATER — writes no real code; tasks are labels.
Real work = `scheduler-ctl.sh drive` (costs $) OR Claude (this session).

## Cycle 2 + Chat Fork — SCOPED (not built yet)
Scope doc: `docs/ceo/cycle2-sessions-and-chat-fork-scope.md`.
- TRACK A (Cycle 2, F4 session history): durable snapshot store `history/<date>.ndjson` via SIDECAR
  recorder (keeps watcher read-only), sessions browser, computed summary (no LLM), audit overlay on
  scrubber. Endpoints GET /api/sessions, GET /api/sessions/:id. On-architecture, Type-2, days.
- TRACK B (Chat Fork, F1 streaming + F2 fs/repo): SEPARATE Agent Runtime service (Claude Agent SDK),
  dashboard = thin streaming client (SSE/WS). Sandbox per agent (worktree/container), permission broker
  (every Write/Edit/Bash → F3 gate → operator confirm), threat model FIRST (sr-security leads),
  adversarial tests (injection/traversal/escape). Type-1, weeks, cost-bearing. BREAKS decoupling →
  must be a FORK, not in watcher.
- USER DECISION: GO both. Sequence = **A first, then B** (option 3).

## Cycle 2 — Track A (F4 session history) — COMPLETE (built + verified live this session)
On-architecture, no LLM, watcher stays read-only (sidecar recorder writes MissionAlpha's own history).
- `scripts/record_history.py` — sidecar recorder: reads state.json, appends to
  `agent-status/history/<YYYY-MM-DD>.ndjson` (1 snapshot/line), de-dupes on generatedAt,
  rotates by UTC day, prunes > RETENTION_DAYS (14). `--once` or loop (TICK_SECONDS, default 30).
- Endpoints added to `vite.config.ts`:
  - `GET /api/sessions` → SessionSummary[] (newest first; computed: startTs/endTs, snapshotCount,
    agentsSeen, peakActive, maxBlocked, commandsFired-from-AUDIT.log-by-date).
  - `GET /api/sessions/:id` → {summary, snapshots} (decimated to SESSION_SNAPSHOT_CAP=240).
  - GOTCHA: connect strips the mounted prefix → req.url is "/" or "/<id>", NOT "/api/sessions/...".
    Parse via `path.replace(/^\/api\/sessions/,"").replace(/^\/+/,"")`. Traversal guard: id must
    match SESSION_DATE_RE `^\d{4}-\d{2}-\d{2}$` else 400.
- Types `src/data/types.ts`: SessionSummary, SessionDetail.
- Seam ext (DataSource/LocalPollAdapter/useAgentState): listSessions(), getSession(id).
- Component `src/components/SessionsBrowser.tsx` — collapsible panel: session cards + on-select
  computed summary (peak active / max blocked / commands / agents seen / snapshots / duration).
  F4c computed summary DONE. Polls /api/sessions @15s.
- Wired in `src/App.tsx` below ControlPlanePanel (live-only).
- VERIFIED live: 13→28 snapshots recorded, /api/sessions + /:id return data, traversal→400,
  UI panel renders summary, zero console errors.
- FOLLOW-UPS (not done): F4d audit-overlay on TimeScrubber + deep scrub-into-history via existing
  replay machinery (getSession snapshots feed reconstructAt) — SessionsBrowser currently shows
  summary highlights only, not full scrub-through. VITE_SESSIONS flag skipped (always-on demo).

## Track B (Chat Fork) — Phase 1 (F1 streaming chat) — COMPLETE (built + verified live)
Honors fork principle: SEPARATE process, NOT in watcher. Chat-only (NO tools — F2 deferred).
- `agent-runtime/` = standalone Node service (own package.json, @anthropic-ai/sdk installed).
  `server.mjs` listens :3005 (RUNTIME_PORT). Endpoints:
  - `POST /runtime/:agentId/chat` {message} → SSE stream (events: meta/token/done/error).
  - `GET /runtime/health` → {ok,mode,model}.
  - Per-agent in-memory thread (last 20 msgs). Body cap 16KB, message cap 4000 chars.
  - DUAL MODE: ANTHROPIC_API_KEY set → real `client.messages.stream()` (model RUNTIME_MODEL,
    default claude-sonnet-4-6, caveman system prompt). No key → live caveman MOCK stream
    (word-by-word, 45ms). Flips to real Claude the moment key is exported. NO key currently.
  - SECURITY Phase 1: chat-only. System prompt forbids claiming tool/fs/exec use.
- `vite.config.ts`: added server.proxy `/runtime` → http://localhost:3005 (browser same-origin;
  watcher process never hosts the LLM).
- `src/components/AgentChat.tsx` — streaming chat panel: POST + reads response.body SSE frames
  token-by-token, live typing cursor, mode chip (live/mock), per-agent thread, Enter-to-send.
- Wired into `src/components/AgentAction.tsx` (both branches) → appears in agent drawer below
  Dispatch task. So: open any agent → chat with its brain, tokens stream live.
- VERIFIED live: runtime health ok (mock), SSE stream via vite proxy emits meta+token events,
  browser drawer chat streams reply, zero console errors.
- RUN: `cd agent-runtime && node server.mjs` (or set ANTHROPIC_API_KEY first for real Claude).

## Boss Console (global chat, BOSS above CEO) — Phase 1 COMPLETE (built + verified live)
Plan: `docs/ceo/boss-console-plan.md`. Operator(BOSS/Rohit) sits ABOVE ceo; global top-level chat
to command swarm via CEO. Conversational like Claude Code (multi-turn, streaming).
- `agent-runtime/server.mjs`: `boss` channel uses CEO_BOSS_SYSTEM prompt (Bezos/Musk/Solomon/Fink
  persona, PROSE not caveman to BOSS, strategic, supreme over 16 agents). systemFor(id) routes:
  id==="boss" → CEO prompt, else caveman agent prompt. mockCeoReply() = CEO-voice mock when no key.
  Endpoint reuses POST /runtime/boss/chat (matches existing :agentId regex).
- `src/components/BossConsole.tsx`: GLOBAL component — fixed top-right gold "BOSS" crown button →
  full-height slide-over (right), streaming chat thread (BOSS↔CEO), mode chip, Enter-to-send,
  per-session thread. SSE parse same as AgentChat.
- Mounted in `src/App.tsx` top-level (always available, even during load).
- VERIFIED: BOSS button → console opens → message → CEO streams strategic reply, zero console errors.
- LAYOUT: BossConsole docked LEFT (persistent, like Claude's chat pane). App controls open state
  (default open) + reserves 404px left padding. Collapse (×) → reopen rail top-left. Verified.

## Boss dispatch bridge (CEO → gated commands) — COMPLETE (built + verified live)
- `agent-runtime/server.mjs`: CEO_BOSS_SYSTEM now instructs CEO to END action-replies with a
  fenced ```dispatch block (lines "<verb> <agent-id> <instruction>", verbs task|ack|respawn).
  mockCeoReply build-branch emits a sample dispatch block (demoable without key).
- `src/components/BossConsole.tsx`: parseDispatch() strips the ```dispatch block from CEO prose +
  parses directives. Renders gold "CEO proposes N dispatches" card → "Review & confirm" → F3
  PermissionGate (lists verb→target) → on confirm fires each via onCommand (issuedBy:"BOSS",
  type task/ack/respawn). Per-message fired state; "dispatched N/N to swarm" status.
- `src/App.tsx`: passes sendCommand → BossConsole onCommand.
- VERIFIED live: BOSS "build referral feature" → CEO proposes 3 → confirm → AUDIT.log got 3
  `BOSS task architect|senior-web-1|senior-qa` entries (real commands on the bus, consume_commands
  drains them). CEO never auto-fires; BOSS gates every dispatch. Zero console errors.
- boss-console-plan.md now ~95%: chat ✓ dispatch ✓ F3-gate ✓ audit ✓. Remaining: formal QA tests,
  ADR-017 file (design was inline).

## CLI BACKEND — real Claude via SUBSCRIPTION (no API key/credits) — DONE + verified
Key win: runtime can drive the local `claude` CLI headless instead of the Anthropic API →
uses the Claude Code SUBSCRIPTION (logged-in), zero key, zero credits.
- `agent-runtime/server.mjs`: BACKEND = RUNTIME_BACKEND || (KEY ? "api" : "cli"). cliReply() spawns
  `claude -p --output-format stream-json --include-partial-messages --verbose --no-session-persistence`,
  writes (system persona + thread transcript) to stdin, parses stdout JSON: emits
  stream_event/content_block_delta text deltas as SSE tokens (fallback: result text). Ignores
  hook/system noise. health.backend reports api|cli|mock.
- 3 backends: api (key, costs) · cli (subscription, free) · mock (no LLM). Auto-picks cli when no key.
- UI chips (BossConsole + AgentChat): show "live · subscription" for cli (green), "mock" amber.
- VERIFIED live: backend=cli, Boss console streamed a REAL CEO reply via subscription in-app,
  per-agent drawer chat also real (same backend). Zero console errors.
- CAVEATS: cli = subscription rate-limits (not $/call); ~3-5s/msg startup (claude session + hooks);
  single-shot per turn (thread re-sent each call). To switch to API: set ANTHROPIC_API_KEY in
  agent-runtime/.env + RUNTIME_BACKEND unset/api.
- This resolves the "no credits" blocker — real Claude chat in the app for free via subscription.

## F2a — agent READ-ONLY repo tools — DONE + verified + security-reviewed
Built on cli backend: `claude -p` already has tools; F2 = CONTROLLING them.
- `agent-runtime/server.mjs`: RUNTIME_TOOLS env ("none"|"read"|"write", default none).
  cliReply() builds --allowed-tools per mode: read = Read/Glob/Grep (cwd=REPO_ROOT), write =
  +Write/Edit (cwd=per-agent sandbox) — Bash NEVER. systemFor() appends TOOL_NOTE capability text.
  Egress scrub (SECRET_RE) on every SSE token strips sk-ant-/gh_/AKIA/PEM patterns.
- `.claude/settings.json` (NEW) permissions.deny: Read(**/.env), .env.*, *.pem, *.key, *.p12,
  id_rsa*, credentials*, secrets*, .claude/**, .aws/**, .ssh/**, .git/** — HARD tool-layer block
  (not model goodwill). claude reads it from cwd=REPO_ROOT.
- RUN read mode: `cd agent-runtime && RUNTIME_TOOLS=read npm start`.
- VERIFIED live (curl):
  - read works: agent read package.json → "vite --port 3004"; tailwind.config.ts → "Yes · .ts".
  - write denied (read mode): "Cannot write files" + no file created.
  - out-of-repo read denied: /tmp/... → "outside repo root" (claude workspace scoping).
  - secret read: sentinel NOT leaked (model refuse + deny rule + scrub, 3 layers).
- sr-security review (senior-security-engineer agent) verdict: read mode NEEDS-FIX→addressed
  (deny rules + scrub added). Bash SAFE (off). Per-turn replay = MEDIUM (transcript re-sent;
  acceptable, resets on restart). Runtime port has NO authz (anyone on :3005 → tool chat) — known,
  loopback-only, Phase-6 auth concern.

## F2b — agent WRITE via sandbox + permission broker — DONE + security-hardened + verified
Agents can WRITE, but only to an isolated COPY outside repo; nothing reaches live repo without
operator confirm. (MissionAlpha not a git repo → copy-staging, not git worktree.)
- `agent-runtime/server.mjs`:
  - SANDBOX_ROOT = tmpdir()/missionalpha-sandboxes (or RUNTIME_SANDBOX_ROOT) — OUTSIDE repo.
  - seedSandbox(): copies SEED_DIRS=["src"] + SEED_FILES=["README.md"] with dereference:true
    (symlinks→files), skips symlinks. EXCLUDES package.json/vite.config.ts/scripts (exec-on-apply).
  - write-mode cli spawn: cwd=sandbox, --add-dir sandbox only, --permission-mode acceptEdits,
    --allowed-tools Read/Glob/Grep/Write/Edit (Bash NEVER). Filtered child env (drops *_KEY/_SECRET/
    _TOKEN/PASSWORD/ANTHROPIC_API_KEY).
  - PERMISSION BROKER: GET /runtime/:id/changes (diff sandbox vs repo, scrubbed) + POST /:id/apply
    {paths} (operator-confirmed only). applyAllowed() validates RESOLVED path (resolve+containment+
    APPLY_DENY+seeded-scope, not raw string). applyChanges() refuses symlink dest (lstat) + realpath-
    parent containment assert. walk() skips symlinks + depth/count caps.
  - server.listen(PORT, "127.0.0.1") — loopback only.
- UI: `src/components/AgentChat.tsx` — after each turn fetches /changes; shows amber "N proposed
  changes (sandbox)" panel → "Review & apply to repo" → F3 PermissionGate → POST /apply → "applied
  N/N to repo". Per-agent.
- sr-security (2 reviews): 1st = BLOCK (found CRITICAL symlink-write-through at apply + HIGHs:
  resolved-path, exec-on-apply seed scope, env leak, all-interfaces bind, unscrubbed /changes).
  ALL must-fixes applied. 2nd review's findings addressed.
- VERIFIED live (curl): write isolates to sandbox (repo clean); /changes diff; legit apply→repo;
  SYMLINK ESCAPE refused ("dest is a symlink", target unchanged); ../, abs, .env, package.json,
  nested ../../../etc ALL rejected; loopback bind. node --check OK.
- RUN: `cd agent-runtime && RUNTIME_TOOLS=write RUNTIME_SANDBOX_ROOT=/tmp/ma-sb npm start`.
  Default RUNTIME_TOOLS=none (safest); read/write opt-in.
- CONFIG GUARD (sr-security nice-to-have, DONE): package.json re-added to SEED_FILES BUT
  configGuardViolation() refuses apply if any CONFIG_GUARD["package.json"] key differs (scripts,
  dependencies, devDependencies, optional/peerDependencies, bin, main, module, exports). Parse-fail
  = refuse. VERIFIED: scripts change→refused, dependencies change→refused, description-only→applied.
- BROWSER UI VERIFY (DONE): staged a sandbox change → opened senior-web-1 drawer → AgentChat
  fetchChanges showed amber "proposed changes" panel → "Review & apply" → F3 gate → Apply →
  "✓ applied 1/1 to repo" → live repo got the file. Zero console errors. Full e2e flow works.
- NOTE: senior-qa subagent couldn't run (Bash denied for that subagent) — ran QA cases myself.
## AUTH TOKEN + anti-rebinding on /apply,/changes — DONE + 2nd security review + verified
Closes "anyone local can call /apply, server enforces nothing".
- `agent-runtime/server.mjs`: RUNTIME_TOKEN = randomBytes(24).hex on startup, written to
  TOKEN_FILE = tmpdir()/missionalpha-runtime/.runtime-token (mode 0600) — OUTSIDE repo (sr-security
  #5: in-repo token was readable by read-mode agent → self-authorize /apply). tokenOk()=
  timingSafeEqual. originOk()=reject non-loopback Origin. hostOk()=reject non-loopback Host (anti-
  DNS-rebinding). needsAuth gate on /changes+/apply requires host+origin+token. Global host gate on
  all routes (health excepted). MAX_INFLIGHT=4 concurrent claude children (cost/fork-bomb cap, /chat
  →429 when busy). scrub() now also redacts RUNTIME_TOKEN literal.
- `vite.config.ts`: serveRuntimeToken(env) → GET /api/runtime-token reads tmp token file, same-origin
  only (Host+Origin loopback check, Vary/nosniff/no-store). server.allowedHosts=['localhost','127.0.0.1']
  (anti-rebinding for whole dashboard incl proxy).
- `src/components/AgentChat.tsx`: runtimeToken() fetches /api/runtime-token once (cached), sends
  x-runtime-token header on /changes + /apply.
- `.claude/settings.json`: added Read(**/.runtime-token) deny (defense-in-depth, token now in tmp anyway).
- sr-security 2nd review: 1st = BLOCK (#5 token-in-repo HIGH, #4 rebinding MEDIUM, #6 /chat abuse
  MEDIUM). ALL fixed. VERIFIED (curl+browser): no-token→401, valid→200, wrong→401, evil-Origin→401,
  evil-Host→403 (vite token endpoint + runtime /changes + /chat), token now in tmp not repo, full
  token-gated UI apply flow works (panel→review→F3 gate→apply→repo updated), zero console errors.
- REMAINING (LOW, tracked): gate/handler regex are parallel (drift risk if handler loosened — SAFE
  today); /chat not token-gated (host-gated + inflight-capped instead); per-turn transcript replay
  (resets on restart).

## Background processes (this session)
- dev server `npm run dev` port 3004.
- sim `scripts/sim_swarm.py` (6s).
- scheduler pid (scheduler-ctl.sh start) ticking emit_state.

## Test residue (cleanup if resetting)
acks.json (ceo, architect), respawns.json (senior-web-1 + earlier), manual heartbeats. Reset:
`echo '{}' > agent-status/acks.json && echo '{}' > agent-status/respawns.json && python3 scripts/emit_state.py`

## ═══ AGENT FACTORY (2026-06-17) — IN PROGRESS ═══
Executing docs/ceo/agent-factory-plan.md. BOSS spawns AI-authored agents (Path B) w/ real-posting skills.
P0 GATE (CEO): BOSS decisions locked (real posting, persist, Path B, same runtime+F2b). Platforms =
Twitter/X + LinkedIn via composio MCP (default, baked). Composio key NOT set → posting layer built
composio-ready w/ safe SIMULATED dry-run fallback (mock-when-no-key, same pattern as backend); real
post path activates when COMPOSIO_API_KEY present. Security invariants hold regardless (Claude never
sees creds, per-post BOSS gate, audit). Decisions → STRATEGY_APPROVED. Building P1→P9 this session.

## ═══ AGENT FACTORY — COMPLETE + TESTED (2026-06-17) ═══
All 9 phases done, tested (curl + Playwright browser e2e + adversarial), tsc clean, committed+pushed.
BOSS describes need → Claude (cli/subscription) authors spec → BOSS reviews/edits → confirms → agent
persisted (.claude/agents/<id>.md + factory/registry.json) + live + chat/run-able. Real-posting skills
(Twitter/X + LinkedIn), every external post BOSS-gated dry-run→confirm→execute→audit.

### Backend — agent-runtime/factory.mjs (new) + server.mjs wiring
- SKILL_CATALOG (7 closed skills) + PLATFORMS (twitter 280/25cap, linkedin 3000/15cap). Spec schema:
  {id ^[a-z][a-z0-9-]{2,48}$, role, title, persona, skills[catalog], tools[Read|Write|Run — NO Bash],
  integrations[platform needs matching posting skill], createdBy:"BOSS"(forced), createdAt}.
- REGISTRY: createAgent writes persona .md (committed) + registry.json (committed) + announces BROADCAST
  row. loadRegistry() at startup. server.systemFor(id) now loads created-agent persona (+ caveman + no-
  self-post mandate); built-ins unchanged.
- AGENT-CREATOR: POST /factory/author {description} → cli claude (AGENT_CREATOR_SYSTEM, no tools) streams
  reasoning then a ```spec block → parseSpecFromText → validateSpec → SSE `spec` event. mockAuthorSpec
  fallback. NOT auto-created (BOSS confirms via /factory/create). REAL cli author VERIFIED (subscription).
- CREDENTIAL BROKER: POST /factory/connect {platform,handle,secret} → AES-256-GCM encrypt (KEK from
  BROKER_KEY env or 0600 .broker-key in tmp runtime dir, OUTSIDE repo) → connections.json (tmp,0600).
  connId opaque. GET /factory/connections returns {connId,platform,handle} only — NEVER secret. Secret
  lifetime = connect body→encrypt, and 1 decrypt-on-stack at post time. Never logged/streamed/seeded/env.
- POSTING: /factory/post/preview (read-only dry-run, mints single-use confirmToken bound to
  sha256(agentId+connId+content), 120s TTL) → BOSS F3 confirm → /factory/post/execute (requires fresh
  matching confirmToken) → composio when COMPOSIO_API_KEY else clearly-marked SIMULATED (no fabricated
  net call; composioPost throws if half-configured). Rate-limit rolling-24h per account. authorizePost:
  created agent may only post via a connId whose platform ∈ its integrations (T6 confused-deputy).
- Endpoints all under /factory/* (vite proxy added). Mutating/sensitive ones host+origin+token gated
  (reuse existing gates); /factory/skills + /factory/health host-gated only (no secrets). Extended egress
  scrub (SECRET_RE + bearer/oauth/access_token/JWT/google/meta/slack) applied to all SSE + JSON.

### Frontend — 4 surfaces (src/components/factory/ + src/lib/factoryClient.ts)
- index.css: added --c-factory-violet (dark oklch(0.78 0.13 300) ~7.6:1, light oklch(0.48 0.18 300) ~5:1).
- CreateAgentFlow.tsx (surface 1): describe→author SSE stream→editable spec review card (title/role/persona
  collapse, skill/tool/integration chips, CAN-POST marker)→confirm/re-author/discard.
- AgentFactory.tsx (surface 2 + host): collapsible panel, tabs Agents(gallery, stagger, built-in band) /
  Skills / Accounts(broker connect+revoke, password field, "creds stay with you") / Post(compose→preview).
- SkillCatalog.tsx (surface 3): searchable dense list, posts-only filter, pick+browse modes.
- PostApprovalGate.tsx (surface 4): PermissionGate fork, violet frame+gold confirm, rendered content
  preview, char/limit color, dry-run/simulated marker, focus-trap+ESC+reduced-motion.
- Wired in App.tsx below SessionsBrowser (live-only). emil motion, OKLCH-only, a11y, mobile.

### Docs: ADR-019/020/021 (docs/adr/), threat model (docs/security/agent-factory-threat-model.md, STRIDE+
OWASP-LLM, must-pass checklist), UX contract (docs/design/agent-factory-ux.md). Agents (architect, sr-
security, principal-ux) authored content but were Write-blocked in sandbox → I persisted their output.

### Verified
- curl: author(mock+REAL cli), create, agents list, connect, connections(no secret), preview→execute
  (simulated post + rate decrement), audit chain.
- adversarial: no-token→401, Bash tool→reject, reserved id(ceo)→reject, integration w/o skill→reject,
  secret-shaped persona→reject, dup id→reject, confirmToken replay→reject, execute w/o token→reject,
  cross-platform connId→403, grep for secret across audit/connections/SSE = NO LEAK.
- Playwright headless e2e (full BOSS flow): open factory→New Agent→describe→author→spec review→confirm→
  gallery→connect account→compose→preview→approval modal→Simulate post→audited. CONSOLE_ERRORS: [].
- tsc --noEmit clean (also removed 2 pre-existing dead imports). NOTE: repo has no eslint installed/config
  (lint script aspirational) — tsc noUnusedLocals is the type/lint gate.

### Run: runtime `cd agent-runtime && RUNTIME_TOOLS=write RUNTIME_SANDBOX_ROOT=/tmp/ma-sb npm start` (cli/
subscription, factory=on). dashboard `npm run dev`. Real posting needs COMPOSIO_API_KEY + connId→action
wiring in factory.composioPost (currently throws if key set but unwired — fail-loud, never fake success).

## ═══ AGENT FACTORY — BOSS REVIEW FIXES (2026-06-17) — DONE + TESTED ═══
5 fixes from BOSS, built by senior-web-1 + senior-backend-2 swarm agents (Write worked; Bash blocked → I ran checks). Committed 9656b29, pushed.
1. Removed "Dispatch task" box from agent drawer (AgentAction.tsx) — chat covers it.
2+3. Drawer focus-steal + scroll-jump (same root): focus-trap effect had unstable `onClose` in deps → re-ran every 2s poll → re-focused close btn. Fix: onCloseRef + deps [open,agent?.id] + focus({preventScroll:true}). AgentDrawer.tsx.
4. In-drawer agent management (NEW src/components/factory/AgentManage.tsx): edit skill set → PATCH /factory/:id, gated Delete. Self-hides for built-ins (returns null if id not in registry) → no dead buttons. Added factory.updateAgent (same validation as create) + PATCH route (server.mjs) + factoryClient.updateAgent.
5. Created agents = first-class board citizens. ROOT FIX (not just sim): agent-heartbeat.sh awk now APPENDS a BROADCAST row if agent absent (was update-only); emit_state.py _merge_registry_meta() merges factory/registry.json into META (parse_broadcast dropped any id not in the hardcoded 16); sim_swarm.py heartbeats+chatters registry agents each tick. Created agent now shows on board w/ heartbeat, lifecycle motion, role/tier, bus traffic, persists across ticks. Verified: state.json 17 agents, java17-developer IDLE/idle col.
TESTED: Playwright e2e all 5 (zero console errors) + UI Save-skills PATCH roundtrip + adversarial curl (Bash/integration/404 rejects). tsc clean. java17-developer (user's browser-created agent) kept in registry, restored to original skills.

## ═══ UNIFIED WORKSPACE (chat-first + model tiers) — IN PROGRESS (2026-06-17) ═══
Executing docs/ceo/workspace-plan.md. Turn MissionAlpha chat-first: chat = PRIMARY center panel
(Claude-Code-style), per-chat Claude model-tier picker (Opus/Sonnet/Haiku), board demoted to a
secondary toggle-able "Team" panel. Conversation history persists to disk.
BOSS decisions locked: Claude tiers ONLY (opus→claude-opus-4-8, sonnet→claude-sonnet-4-6,
haiku→claude-haiku-4-5), subscription via cli --model, default=sonnet, NO GPT/Gemini. Board stays
fully functional. Phases P0 ceo→P1 ADRs→P2 ux→P3 model plumbing∥P4 persistence→P5 UI reflow→
P6 security→P7 QA→P8 memory. STRICT model allowlist (no raw --model passthrough). threads/ gitignored.

## ═══ UNIFIED WORKSPACE — COMPLETE + TESTED (2026-06-18) ═══
All phases P0→P8 done, tested (curl + real-cli + Playwright e2e + adversarial), tsc clean, SECURITY_APPROVED, committed+pushed. MissionAlpha is now CHAT-FIRST: chat = primary center panel (Claude-Code-style), per-thread model-tier picker, board demoted to a secondary collapsible "Team" panel. No feature lost.

### Docs (P1/P2)
- docs/adr/ADR-022-model-tiers.md — STRICT closed tier allowlist {opus:claude-opus-4-8, sonnet:claude-sonnet-4-6, haiku:claude-haiku-4-5}, default sonnet. Security invariant: only an allowlisted tier KEY influences the model; raw input NEVER reaches the claude argv. Unknown tier→400.
- docs/adr/ADR-023-chat-first-shell.md — layout inversion + multi-thread conversation model + disk persistence.
- docs/design/chat-first-ux.md — UX contract (rail/center/team, model picker, motion, a11y, responsive). OKLCH tokens only, no index.css change needed.

### Backend (P3 model tiers + P4 persistence) — agent-runtime/server.mjs + factory.mjs
- MODEL_TIERS = Object.freeze({opus,sonnet,haiku}); DEFAULT_TIER=sonnet; resolveTier(raw) uses hasOwnProperty + strict-type guard (rejects number/array/object → 400). /chat, /run, /factory/author accept optional {model}; 400-on-unknown BEFORE inflight++/spawn. cliReply + authorSpec push `--model <modelId>` as a DISTINCT argv token; modelId ONLY ever MODEL_TIERS[key], never raw input. API backend uses resolved modelId for SDK. meta SSE event carries {tier, model}. /runtime/health reports {tiers, defaultTier}.
- THREAD PERSISTENCE: in-memory `threads` Map now disk-backed → agent-runtime/threads/<safeId(id)>.json (mode 0600, gitignored). loadThreads() at startup hydrates Map; persistThread() after every turn (last-THREAD_KEEP=40 msgs, 256KB byte cap + trim fallback). threadSafeId strips path-traversal chars; content already egress-scrubbed. Survives restart (verified).

### Frontend (P5) — src/
- lib/modelTiers.ts — tier list + per-thread localStorage (ma.model.<threadId>), default sonnet.
- components/workspace/ModelTierPicker.tsx — custom listbox (Opus smartest / Sonnet balanced / Haiku fastest), keyboard a11y (↑↓/Home/End/Enter/Esc/typeahead), emil motion, OKLCH.
- components/workspace/ChatPane.tsx — UNIFIED primary center chat for every thread. Boss thread = dispatch bridge (parseDispatch + F3 PermissionGate + fireDispatch → /api/command + /run with tier). Agent thread = F2b sandbox /changes panel + gated /apply. Controlled messages (lifted to App) so history survives thread-switch; runtime persists to disk too. Sends {model:tier} on /chat + /run. role=main, aria-live streaming, errors role=alert.
- components/workspace/ThreadRail.tsx — left nav: Boss pinned (gold) + per-agent (cyan / factory=violet); active = bg+3px bar+aria-current; collapsible icon rail.
- components/workspace/TeamPanel.tsx — collapsible right aside (role=complementary, id=team-panel); desktop 420px static, mobile full-screen overlay sheet. Hosts the board ONCE, unchanged.
- App.tsx — reflowed into chat-first shell: rail | ChatPane(flex-1) | TeamPanel(board). All board features (Cycle1/2 control plane, BulkAction, ControlPlane, Sessions, Factory, replay/scrubber, kanban, feed, globe, AgentDrawer drilldown) preserved inside TeamPanel. Layout state persisted (ma.activeThread/rail.collapsed/team.open). Mobile: rail+team = overlays via header buttons. BossConsole.tsx left in place but UNMOUNTED (its dispatch fn now in ChatPane) — not deleted (ADR-023 non-goal).

### Security (P6) — senior-security-engineer: SECURITY_APPROVED, no HIGH/CRITICAL
Verified invariant empirically + by inspection: frozen map, hasOwnProperty + strict-type guard, 400-before-spawn in all 3 routes, --model distinct argv token no shell:true, SDK uses resolved id, thread store no traversal (0600, gitignored, scrubbed, byte-capped), all existing host/origin/token gates + egress scrub + MAX_INFLIGHT intact. Applied the one LOW hardening (strict-type guard). Adversarial matrix all PASS: --dangerously-…, "haiku --add-dir /etc", constructor/toString/__proto__, gpt-4o, number/array/object → all 400; missing→sonnet.

### QA (P7) — TESTS_GREEN
- Playwright headless e2e (1440px + 375px mobile): chat-first shell present (main+threads nav+picker), model picker switch→Opus, message streams reply, Team panel toggle off→on, 18 thread rows, agent-thread opens, mobile renders. CONSOLE_ERRORS: [].
- Real cli verified: `claude -p --model claude-haiku-4-5` accepted by the subscription binary, streamed "PONG"; meta reports tier:haiku model:claude-haiku-4-5 (resolves the ADR-022 CLI-flag caveat).
- Persistence: chat→restart runtime→threads=1 reloaded.
- tsc --noEmit clean.

### Run: runtime `cd agent-runtime && RUNTIME_TOOLS=write RUNTIME_SANDBOX_ROOT=/tmp/ma-sb npm start` · dashboard `npm run dev` (binds IPv6 localhost:3004 — curl `localhost` not `127.0.0.1`) · sim `TICK_SECONDS=6 python3 scripts/sim_swarm.py`. Mock backend for free UI tests: prefix `RUNTIME_BACKEND=mock`.
### NOTE for BOSS: unrelated uncommitted churn left untouched (NOT this feature) — factory/registry.json + .claude/agents/java17-engineer.md (your browser-created agent), and docs/SESSION_MEMORY.md (133KB) + docs/ceo/master-roadmap.md appeared from another process. Surfaced, not committed.
