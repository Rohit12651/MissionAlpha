# AUTONOMY PROGRAM — plan of record

**Goal, in the user's words:** every feature works, end to end, backend to frontend, wired,
communicating continuously without human intervention. No loose ends, no static data,
production-grade.

**Origin:** the five questions of 2026-08-11. This plan turns each answer's *gap* into a
phase. Nothing here is speculative — every phase names the file that must change and the
evidence that proves it changed.

## PRINCIPLE 0 — THE OPERATOR CHOOSES THE MODEL. THE APP NEVER CHOOSES FOR THEM.

Any LLM the operator connects must be usable for ANY job the app can do — autonomous
builds, reviews, planning, analysis, chat. Not chat-only. Not "Claude for the real work and
everything else for talking."

Where the app cannot yet drive a provider, that is an **adapter defect to fix**, never a
capability to stamp on the provider. `capability: "chat_only"` in the current registry is
exactly that defect: five hardcoded literals that never ask the model anything. Phase 1
deletes the table and replaces it with a probe.

**This principle outranks every phase below.** Any phase that would reintroduce a
model-specific path fails review on that ground alone.

**Standing rules (every phase, no exceptions):**
- `~/.claude/CLAUDE.md` PES applies. Build → lint+typecheck → tests → security → runtime
  verification → adversarial self-review. Evidence pasted, or the word "done" is not used.
- **NO COMMITS until the user says so.** Work accumulates in the tree.
- Do not break existing functionality. Re-run the FULL baseline every phase.
- Anything stubbed is labelled **STUB** in that phase's delivery report.
- Model: Opus builds. **Fable 5 verifies and its verdict is BINDING** (a defect REOPENS the
  phase; max 3 iterations, then escalate to the user).
- Caveman output mode stays on. `headroom` compression is already wired at the shell.
- `codeburn` after each phase for cost.

---

## THE HONEST CONSTRAINTS — read before starting

Three things the user asked for that **I cannot do myself**, disclosed rather than silently
dropped:

1. **I cannot open a new context window.** An agent cannot self-invoke one. When context
   fills, the session ENDS. The mitigation is this file plus `EXCELLENCE-HANDOFF.md`: both
   are written so a fresh window resumes without re-deriving anything. **The user must open
   the new window.** A `/loop` skill or a cron routine could drive unattended continuation,
   but neither is authorised here and neither is assumed.
2. **MCP/connector OAuth cannot be completed in a non-interactive session.** Jira,
   Atlassian, Bitbucket and friends need a browser consent flow the user must run
   (claude.ai connector settings, or `claude mcp` / `/mcp` in an interactive terminal).
   Phase 5 builds everything up to that line and stops at it.
3. **The autonomous engine currently cannot run at all** on this machine: the active
   account is `NVIDIA (custom)`, and `engineDispatch` refuses anything without
   `capability: swarm`. **This is an ADAPTER limitation, not a model limitation** — see
   Phase 1, which removes it. Until 1B lands, the soak needs a Claude-capability account
   active; after 1B, any tool-capable provider qualifies and the operator picks.
   Interim unblock (zero build): make a Claude account active. Permanent fix: Phase 1 (the FIRST phase).

---

## PHASE 0 — unblock the visual net (BLOCKS EVERYTHING VISUAL)

**Why first.** Section C left an open finding: `npm run test:visual` reported **30/30 at
`maxDiffPixels: 0` against baselines timestamped 14:15, after a 15:32 edit that changed
every surface colour in `helm.css`.** The new values are in `dist` (`050a14`/`182238`/
`243350` present, old `0b1220`/`121b2e`/`1e2b45` gone) and `data-skin="helm"` is set. A net
that cannot see a full palette rewrite cannot certify anything — and Phase 9 of the
excellence program (514 rewrites) depends on it entirely.

**Skills:** `sp-systematic-debugging` (root cause unclear — mandatory) → `hallmark audit`
on the token layer once the net is trustworthy → `sp-verification-before-completion`.

- [x] **0.1** DONE — pixel histograms, not a byte-diff (byte-compare is the wrong
      instrument, lesson 6). Baseline `#0b1220`/`#121b2e`/`#1e2b45`; capture from the build
      under test `#050a14`/`#182238`/`#243350`; comparator reported **0** differing pixels.
- [x] **0.2** DONE — `getComputedStyle` on the live preview: `.helm-root` = `rgb(5,10,20)`
      over 78% of the viewport, `.helm-pane`/`.bos-side`/`.helm-card` = `rgb(24,34,56)`.
      The captured regions DO consume `--helm-*`, so hypothesis (a) is refuted.
- [x] **0.3** ROOT-CAUSED — **neither (a) nor (b)**. (a) refuted by 0.2. (b) refuted by
      reproducing the blind 30/30 from a cold start with `:3007` free and a fresh build.
      The real cause: both specs' `STRICT` literal omitted pixelmatch's `threshold`, which
      defaulted to 0.2 → cutoff `35215 × 0.2² = 1408.6`, while every surface step in this
      theme scores ~30. `maxDiffPixels: 0` bounds the COUNT of differing pixels, not the
      sensitivity that decides which pixels count. Contract now lives in
      `test/visual/strict.mjs`; `test/visual/comparator-sensitivity.test.mjs` (15 tests)
      asserts every adjacent surface step stays visible and that the specs never
      re-declare a local literal.
- [x] **0.4** DONE — `<meta name="ma-build-id">` stamped by a `vite build` plugin from a
      content hash of `src/**` + `index.html` + tailwind/postcss configs;
      `assertBuildIdentity()` in `settle()` refuses to capture on a mismatch and names both
      hashes. (Not the cause, but owed and now closed.)
- [x] **0.5** DEMONSTRATED RED. Stability 30/30 twice → `--helm-deck` `#182238` → `#1d2a44`
      → **27 failed / 3 passed**, smallest failing diff 46,748 px → reverted → **30/30**.
      The 3 survivors are the only 3 tests that capture no pixels.

**Exit:** 7 gates green · the net demonstrably fails on a real change · finding closed in
`EXCELLENCE-HANDOFF.md` · Fable verification · delivery report.

**STATUS: tasks complete, gates green (1,900 passing / 0 failing).**
`code-reviewer`: WARNING — 1 HIGH (open, see below), 2 MEDIUM + 1 LOW resolved.
Fable 5 (binding): iteration 1 **DEFECT-FOUND** -> fixed; iteration 2 **DEFECT-FOUND** ->
fixed; iteration 3 **INCOMPLETE — terminated on an API session limit without returning a
verdict.** An absent verdict is NOT a pass. **Phase 0 is not independently re-verified after
the iteration-2 fixes; re-run the verifier before Phase 1 relies on this net.**
The open HIGH is not fixable here: `git ls-files test/` returns ZERO, so the entire harness
and all 75 baselines are untracked, CI has never run any of it, and the `-darwin` snapshot
suffix means a Linux runner would be red immediately. Needs a commit (blocked by standing
order) plus a macOS runner decision from the user. Full detail in `EXCELLENCE-HANDOFF.md`.

---

## PHASE 1 — PROVIDER-AGNOSTIC EXECUTOR (FOUNDATION). Any model runs anything.

**The premise being corrected.** `capability: "chat_only"` is stamped on openai/minimax/zai/
custom in a hardcoded table ([registry.mjs:12-16](../../../agent-runtime/providers/registry.mjs)),
and only `claude` gets `"swarm"`. **That is a statement about OUR ADAPTER, not about those
models.** Nemotron, GPT, MiniMax and Z.ai all support tool calling. `openai-compat.mjs`'s
`streamChat` yields text deltas and nothing else — no tool-call parsing, no tool loop, no
file writes — so the honest label for the ADAPTER is "chat only", and it got written onto
the PROVIDER. The user is right: this is a limitation to remove, not a property to respect.

**The rule this phase restores:** the operator chooses the model; the app does not choose
for them. A provider is swarm-capable if it can actually call tools — proved by probe, not
asserted by a table.

**Skills:** `sp-writing-plans` → `sp-test-driven-development` (RED first, always) →
`security-review` + `claude-code-security-review` (**this phase creates a file-writing path
driven by a third-party model — CRITICAL findings block**) → `code-reviewer` → Fable.

- [ ] **1.1 — the tool loop.** Extend `openai-compat.mjs` to the standard OpenAI tool
      protocol: send `tools: [...]`, read `delta.tool_calls`, append the assistant turn with
      its `tool_calls`, execute each, append `{role:"tool", tool_call_id, content}`, repeat
      until the model stops calling tools or a cap trips.
      **The known trap, tested first:** streamed `tool_calls` arrive FRAGMENTED across chunks
      and are keyed by `index` — `name` in one delta, `arguments` split across many. A naive
      parser produces truncated JSON and silently drops a call. The accumulator gets unit
      tests before the loop is written.
- [ ] **1.2 — the tools are the EXISTING ones.** `Read · Glob · Grep · Write · Edit`,
      matching `WRITE_TOOLS`, implemented against the SAME workdir and the SAME guards
      (`applyAllowed`, `safeDest`, the broker). **No second write path.** A tool call that
      escapes the workdir is refused exactly as an operator edit is.
- [ ] **1.3 — capability by PROBE, not by table.** Replace the hardcoded `capability` with
      a probe: issue a trivial tool-call request; a model that returns a well-formed
      `tool_call` is swarm-capable. Cache per account, re-probe when the model changes.
      **Fail closed** — no proof of tool support ⇒ `chat_only`, same as an unknown provider.
      Surface the result in Accounts so the operator sees WHY a provider can or cannot run
      the engine, instead of meeting a silent refusal.
- [ ] **1.4 — hard caps, because an unbounded loop is the real risk.** Max steps per task,
      max wall-clock, max file writes, max total bytes written, and a budget ceiling in USD
      for metered accounts (Phase 7 of the excellence program already meters). Tripping any
      cap aborts the turn and mints a failure Delivery — never a silent stop.
- [ ] **1.5 — non-streaming fallback.** Some OpenAI-compatible servers stream tool calls
      unreliably. Detect and retry the tool turn non-streamed rather than mis-parsing.
- [ ] **1.6 — `engineDispatch` stops being Claude-shaped.** Today it spawns `CLAUDE_BIN`.
      It must dispatch to an EXECUTOR chosen by the active account: `claude-cli` or
      `openai-tools`. Same contract in and out (`{acc} | {error}`), same Delivery minting,
      same guards. The CLI path is not rewritten — it becomes one implementation of two.

**Exit:** 7 gates · **live proof on a NON-Claude account**: queue a real task on the NVIDIA
(or any tool-capable) account, watch it edit a file in the workdir, and show the resulting
Delivery + the diff read off disk · security CRITICAL 0 · `code-reviewer` · Fable ·
delivery report.

**Why this is FIRST and not a later fix.** Every phase after it dispatches work to a model:
the autonomy loop (2), the reviewer handback (3), the soak (8). Build any of them on a
Claude-only executor and the whole program is Claude-only by construction, with a retrofit
owed later. Fix the foundation and every downstream phase is model-agnostic for free.

---

## PHASE 2 — autonomy that actually runs (on ANY provider)

**Answer 1 gap:** the engine is real (queue, `claimNext`, `engineDispatch`, retry with
`notBefore`) but nothing runs unattended — every Delivery waits for a human. Phase 1 has by
now made the executor model-agnostic, so this phase is written against the EXECUTOR
INTERFACE, never against the Claude CLI.

**Skills:** `sp-writing-plans` → `sp-test-driven-development` → `security-review` (auto-
approve is a security surface) → `code-reviewer` → Fable.

- [x] **2.1** DONE — `agent-runtime/engine-readiness.mjs`, ONE predicate shared by
      `engineDispatch` and `GET /runtime/engine/readiness`. Six states (runs/cannot/
      unmeasured/none/backend/deterministic); `unmeasured` is NOT folded into `cannot`.
      `EngineReadinessBanner` renders it ABOVE the KPI tiles with the dispatcher's own
      refusal sentence and a link to Accounts. The route was UNREACHABLE on the first
      attempt (the `/runtime/engine/` prefix block 404s what it does not enumerate) and the
      HTTP test caught it. +10 unit, +6 HTTP, +5 client tests. Readiness, stated honestly. If the active account failed its tool probe, the
      Command Center says so in the operator's terms — "this model did not answer a tool
      call; the engine cannot dispatch to it" — with a link to Accounts and to the probe
      result. A control that cannot succeed must not be rendered as if it could.
- [x] **2.2** DONE — added the two missing bounds to `createBandPolicy`: a diff-size
      ceiling (`maxFiles` 8 / `maxLines` 300, from the diffstat the mint already computed —
      no second diff walk) and a deny-by-default `allowList` (`src/**`, `README.md`). An
      UNMEASURED size is refused, never assumed small (`Number(null)` is 0 and would have
      sailed under any ceiling). Every gate is nested under the auto_approve branch so it
      can only TIGHTEN. Malformed limits/allowList fail the whole file closed;
      `allowList: []` allows nothing. `explainRoute()` names which bound held a delivery.
      +10 tests, one existing test CORRECTED (it specified the gap). **Auto-approve policy, real and bounded.** Today `Auto-approve is off. Every
      delivery waits for your decision.` For unattended operation there must be a policy
      with *explicit* bounds: risk band ceiling, diff-size ceiling, path allowlist, and a
      hard "never auto-approve high risk" rule. TDD first, security-review mandatory,
      **CRITICAL findings block.**
- [x] **2.3** DONE — the ladder already existed; what was missing was proof it REACHES the
      database. `test/self-heal-db.test.mjs` (+4) wires the real engine to the real SQLite
      store and reads rows back with SQL: nothing written while budget remains · one
      `kind='failure'` `status='pending'` row carrying why once spent · visible in the
      pending Inbox LISTING · a guard verdict pages on failure ONE. Self-healing. A failed task must retry with backoff (`notBefore` exists) and,
      after N attempts, mint a failure Delivery instead of dying silently. Prove the
      transition with a test that reads real DB rows.
- [x] **2.4** DONE — `engine.sweep()`, riding the runtime's ONE existing periodic timer
      (never a second one, ADR-025). Closes the real gap: `reclaimExpiredLeases` ran only at
      boot and on a backoff wake, and that wake only arms when some task carries a
      `notBefore` — so on a queue with no pending retry a dead holder's lease was never
      reclaimed until restart. The `running` veto keeps a LIVE task out of the reclaim (two
      writers on one worktree is worse than a stuck row); killing a hung step stays the
      watchdog's job. +4 tests. Watchdog: a task claimed but never settled must be reclaimed, not orphaned.
      There is no heartbeat in the runtime today (`engine.mjs:139` says so) — add one or
      justify its absence in writing.

**Exit:** 7 gates · **live proof**: queue a real task, watch it run, land a Delivery, with a
`curl`/GET showing the DB changed · security-review CRITICAL 0 · code-reviewer ≥ MEDIUM
resolved · Fable · delivery report.

**STATUS: 2.1-2.4 COMPLETE. 8 gates green — typecheck 0 · lint 0 · unit 473 · runtime 1466 ·
vendor 54 · electron 9 · build clean · visual 30 = 2,032 passing.** The visual net produced
its first RED on an unannounced change (4 failed: center + accounts, both themes), fixtures
re-recorded, baselines updated, back to 30/30. Live-verified at the wire AND in the browser
(readiness + policy endpoints; a REAL probe against integrate.api.nvidia.com fail-closing to
`cannot`). Two Phase-1 debts closed: the maxUsd disclosure (now a MEASUREMENT — `reportsCost`
true/false/null) and Accounts' UI, which still carried the deleted table's "the engine only
runs on Claude accounts" claim and never called the probe route at all.
**OWED: the end-to-end live proof of a task running to a Delivery needs a tool-capable
account (same blocker as Phase 1's exit), and Fable verification.**

---

## PHASE 3 — agent-to-agent handback, wired end to end

**Answer 2 gap:** the reviewer→developer loop EXISTS as a state machine (`STORY_STAGES`,
`reject()` → closed `STORY_BACK` map, 409 on an unenumerated jump) but **nothing dispatches
the rework automatically**, and the reject reason travels as a bare `feedback` field.

**Skills:** `sp-test-driven-development` → `sp-systematic-debugging` if the loop stalls →
`code-reviewer` → `security-review` (a rework loop that never terminates is a DoS on your
own budget) → Fable.

- [x] **3.1** DONE — `stories.reject()` is now the ONE handback choke point and fires a
      dispatcher (`agent-runtime/story-handback.mjs`, +15 tests) for EVERY caller. The plan
      said nothing dispatched rework; the truth was narrower and worse — the reviewer gate
      DID enqueue, but only when it was the caller, so a reject from the HTTP route (an
      operator, any other agent) bounced a story nobody picked up. The gate's private
      enqueue is DELETED and its `enqueueGoal` dep removed from the server wiring, so
      double-paying for one fix is structurally impossible. Nothing reports a dispatch that
      did not happen: no seat / no engine / backlog full / enqueue threw all escalate with
      the reason. **Close the loop.** A `reject()` from `review-qa` must ENQUEUE the rework task
      for the build seat automatically, carrying the reviewer's reason as the task brief.
      Today the story bounces stage but no one picks it up. This is the single most
      important item in the whole plan — it is what "communicate continuously without human
      intervention" actually means.
- [x] **3.2** DONE — and the OLD guard was not one: the reviewer gate's budget lived in a
      `Map` that empties on restart, so a story could bounce forever across restarts. The
      count is now `COUNT(*)` over the `reject` rows in `story_log` (durable by
      construction). Past the cap (3, `RUNTIME_MAX_REWORK_ROUNDS`) the story parks `blocked`
      AND a Delivery pages the BOSS — both attempted independently, because a blocked story
      with no Inbox row is invisible and an Inbox row on an `active` story reads as still
      running. **Loop guard.** Cap rework cycles per story (e.g. 3). On the cap, escalate to
      a Delivery for the BOSS rather than looping forever. Test the cap.
- [x] **3.3** DONE — migration **v19** adds `from_stage · by_agent · to_agent · evidence` to
      `story_log` (ADD COLUMN only; pre-v19 rows keep NULLs, the honest value). `ref` alone
      could render "reviewer requested fixes (round 2)" and could not answer from where, by
      whom, to whom, or on what evidence. An ordinary advance OMITS the fields rather than
      nulling them, so the UI never shows "from: null → to: null". Untrusted text capped in
      both dimensions (ref 512, agent 64, evidence 10×200). **Structured handback, not a string.** `{fromStage, toStage, byAgent, toAgent,
      reason, evidence[]}` persisted, so the UI can render "reviewer → sr-backend: X" rather
      than an untyped note.
- [x] **3.4** DONE — the handback fields ride the row `appendLog` already writes inside the
      SAME `db.transaction()` as the stage write. No second log was invented. Every transition keeps its `story_log` row in the SAME transaction (already
      true — `stories.mjs:22`). Add the handback fields to that row; do not invent a second
      log.

**Exit:** 7 gates · **live proof of a full round trip**: build → review-qa → reject → back
to build → advance → review-qa → accept, shown as `story_log` rows read from SQLite ·
code-reviewer · Fable · delivery report.

**STATUS: 3.1-3.4 COMPLETE. 8 gates green — typecheck 0 · lint 0 · unit 473 · runtime 1490 ·
vendor 54 · electron 9 · build clean · visual 30 = 2,056 passing.** The round trip is pinned
in `test/story-handback-roundtrip.test.mjs` against real SQLite rows, and proven LIVE at the
wire: a reject on story_faf80f5d0c81e747 wrote the structured log row (seq 7), dispatched
goal_97219fe58c62 to sr-backend at HIGH priority carrying the reviewer's words verbatim, the
engine claimed it, Phase 2's readiness predicate refused it in the operator's own words, the
Phase 2.3 retry ladder spent 3 attempts, and a failure Delivery landed in the Inbox.
**OWED: Fable verification.**

---

## PHASE 4 — the conversation is visible

**Answer 3 gap:** three stores exist (`story_log` per-story monotonic seq, `events_log` SSE
bus bounded 5000/7d with `Last-Event-ID` replay, `AUDIT.log`) but **there is no surface that
shows "who told whom what, and why"** as a single readable thread.

**Skills:** `hallmark` → `impeccable` → `taste-skill` (IN THAT ORDER — mandatory for any
UI) · `emil-design-eng` for any motion · `a11y-architect` · `code-reviewer` · Fable.

- [ ] **3.1** Story thread view: every transition, in order, with actor, stage move, reason,
      and elapsed time. Reads `story_log` — invents nothing.
- [ ] **3.2** Emit a bus event on every handback so the Activity rail (built in Phase 5 of
      the excellence program) shows it live. Vocabulary must be extended deliberately: an
      event the feed has no verb for renders NOTHING (existing rule, do not weaken it).
- [ ] **3.3** Honesty rules carried forward: `receivedAt` stays client-receipt time and
      stays labelled; no fabricated counts; an empty thread reads "no transitions yet", not
      a spinner forever.
- [ ] **3.4** Reduced-motion honoured (REMOVE the animation, do not shorten it).

**Exit:** 7 gates + visual suite (which Phase 0 made trustworthy) · design chain clean ·
live proof in the browser · a11y pass · Fable · delivery report.

---

## PHASE 5 — CONNECTORS. A real tab. N apps. Like Claude's connector surface.

**What the user asked for, verbatim in intent:** a dedicated tab in the app where they can
see and connect an arbitrary number of external apps — Jira, GitHub, Bitbucket, Slack,
anything with an MCP server — the way Claude's own connectors panel works. Not a config
file. A surface.

**What already exists (do not rebuild it):** `agent-runtime/mcp-registry.mjs` — per-agent
grants (`grantedNames`), config composition (`composeConfig`), secret collection
(`collectSecretValues`), wired at `server.mjs:637,888,895`. The GitHub adapter exists
(`adapters/github.mjs`, currently `github=disabled`). **Jira and Bitbucket do not exist** —
the only hits are strings in `src/data/skills.gen.json`. The registry is the engine; this
phase builds the cockpit for it.

**Skills:** `hallmark` → `impeccable` → `taste-skill` (IN THAT ORDER — a new tab is UI, the
chain is not optional) · `emil-design-eng` for any motion · `a11y-architect` (keyboard path
through connect/disconnect/grant) · `build-mcp-server` / `mcp-builder` for the server side ·
`security-review` + `claude-code-security-review` (**a connector tab is a credential
surface AND a tool-grant surface — CRITICAL findings block**) · `code-reviewer` · Fable.

### 5.1 — the tab itself
- [ ] New BOS nav entry `connectors`, added to the CLOSED `BOS_NAV` registry
      (`src/components/bos/bosNav.ts`) with an icon from the existing lucide vocabulary — no
      new icon language. Its own lazy chunk, matching every other page (the main index sits
      under a hard gzip ceiling).
- [ ] Add it to `test/visual/pages.mjs` PAGES in the same commit. A page that is not in the
      matrix ships unverified — the file says so and it is a real rule.

### 5.2 — N connectors, not a fixed list
- [ ] **Catalog + custom.** A browsable list of known MCP servers to add in one click, PLUS
      a custom entry (command/args/env, or a URL for remote servers). The count is not
      capped by the UI; the registry stores as many as the operator adds.
- [ ] Per-connector card shows: name, transport, **live status**, granted agents, and the
      tools it actually exposes (read from the server after connect — never a hardcoded
      list).

### 5.3 — status that is a measurement, not a dot
- [ ] Four honest states, each from a real probe: `connected` · `needs authorisation` ·
      `failing (reason)` · `disabled`. **A green dot that does not correspond to a
      successful probe is forbidden** — same honesty rule as the ledger's "insufficient
      data".
- [ ] **The OAuth line, stated in the UI.** Some connectors need a browser consent flow that
      this app cannot complete for the operator. Those render as `needs authorisation` with
      the exact command to run, and their connect control is DISABLED with the reason
      attached. A control that cannot succeed must not be rendered enabled — the Phase 4
      lesson, applied.

### 5.4 — grants are the security boundary
- [ ] Per-agent grant matrix: which station may use which connector. Default DENY.
- [ ] **Test that an agent without a grant does not receive the tools** — grant enforcement
      is the whole point; if `composeConfig` leaks an ungranted server the matrix is theatre.
- [ ] Secrets go through the SAME sealed credential store as provider keys. Never plaintext,
      never in the repo, never echoed in a response or a log line.
- [ ] Secret-hygiene sweep in the style of the existing provider test: no secret string may
      appear across a full add → list → connect → use cycle for any connector.

### 5.5 — wired to the agents, not decorative
- [ ] A granted connector's tools must actually reach the agent's tool loop (Phase 1's
      executor for any provider, and the CLI path for Claude). Prove it: grant one connector
      to one station, run a task that must use it, show the tool call in the logs and the
      resulting Delivery.
- [ ] Revoking a grant mid-flight must not corrupt an in-progress turn — decide and test the
      behaviour (finish the turn, or abort cleanly; either is defensible, silence is not).

**Exit:** 7 gates + visual suite (the new page has baselines) · design chain clean ·
a11y pass · security CRITICAL 0 · **live proof: connect one real MCP server, grant it, run a
task that uses it, show the tool call and the DB change** · `code-reviewer` · Fable ·
delivery report **naming exactly which connectors remain user-gated on OAuth**.

---

## PHASE 6 — no static data anywhere

**Answer 5 gap:** the cockpit feeds ARE live (`buildLiveState` — real heartbeats, inflight,
engine tasks — explicitly not the frozen snapshot, `vite.config.ts:172`), and I verified
`/api/state.json`, `/inbox`, `/runtime/agent-ledger`, `/runtime/spend`, `/runtime/stories`,
`/runtime/vault`, `/runtime/accounts` serving real rows. **But no per-tab audit has ever
run.** "Every tab is live" is currently an assertion, not a fact.

**Skills:** `sp-verification-before-completion` · `refactor-cleaner` · `code-reviewer` · Fable.

- [ ] **5.1** Enumerate every tab × every panel. For each: name the endpoint, or mark it
      **STATIC** and fix it.
- [ ] **5.2** Dead-wiring sweep (`npx knip` / `ts-prune`): every exported client fn has a
      caller, every route has a client. **No orphans** — an unused export is either wired or
      deleted.
- [ ] **5.3** Empty states must say WHY ("no runs yet"), never render a fabricated zero. A
      chart plots a 0; a human reads it as a measurement.
- [ ] **5.4** Known absences stay disclosed, not silently filled: no ledger sparkline (no
      per-day history exists — the honest fix is a bucketed endpoint, not invented points).

**Exit:** the tab×panel table pasted with endpoints · knip/ts-prune clean · Fable · report.

---

## PHASE 7 — finish the excellence program

Carried from `EXCELLENCE-HANDOFF.md`, unchanged and still owed:
- [ ] **8.3** accent → 3 roles (active-nav, primary CTA, focus ring)
- [ ] **8.4** cockpit adopts dark tokens — **may be a precondition for Phase 0.3(a)**
- [ ] **9** the 372-site type sweep, batches of ~10, `npm run test:visual` ALONE between
      every batch, every diff reviewed by eye. Tooling is BUILT AND TESTED — do not rewrite
      `scripts/type-scale-sweep.mjs`.
- [ ] **10** the gauntlet: `/qa` · `/cso` · `security-review` · `a11y-architect` ·
      dead-wiring · clean `npm ci` · **30-min unattended soak** · full delivery report.

**Skills:** `hallmark` → `impeccable` → `taste-skill` · gstack `/qa` `/review` `/cso` ·
`a11y-architect` · `codeburn` · Fable.

---

## PHASE 8 — the proof: unattended soak

**The single test that decides whether this program succeeded.** 30 minutes, no human
touch. The swarm must: pick up queued work, run it, hand back on reject, self-heal a
failure, mint Deliveries, keep the activity stream live, and crash **zero** times.

- [ ] Record crash count (expect 0), tasks completed, handbacks executed, deliveries minted.
- [ ] Paste the `story_log` and `events_log` tails as evidence.
- [ ] **A soak that needed a human touch is a FAIL.** Report it as one.

**Depends on:** Phase 1 (a model-agnostic executor exists), Phase 2 (it runs unattended) and Phase 3 (the loop closes). Cannot pass
before both.

---

## Per-phase exit checklist — all of it, with output pasted

1. 7 gates + visual suite, counts ≥ baseline (**typecheck 0 · lint 0 · unit 451 · runtime
   1337 · vendor 44 · electron 9 · visual 30 = 1,871 green** as of 2026-08-11b)
2. LIVE proof in the browser with a `curl`/GET showing the DB actually changed
3. `code-reviewer`: every finding ≥ MEDIUM resolved
4. Fable 5 verification — a defect REOPENS the phase (max 3 iterations, then escalate)
5. Phase log appended to `EXCELLENCE-HANDOFF.md`
6. Delivery report with a mandatory **Known Gaps & Risks** section
7. `codeburn` for cost

## Context-exhaustion protocol

At every phase boundary, and any time context runs low: update `EXCELLENCE-HANDOFF.md` and
this file, then TELL THE USER to open a new window. **The agent cannot open one itself.**
The two documents are the resume mechanism; a fresh window must not need to re-derive
anything recorded in them.
