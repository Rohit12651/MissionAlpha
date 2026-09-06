# Excellence Program — HANDOFF / resume point

## ⇢ AUTONOMY PROGRAM · PHASE 3 — 2026-08-14. THE LOOP CLOSES. A REJECT NOW DISPATCHES.

**STATUS: tasks 3.1–3.4 complete. 8 gates green. Live wire proof of the full chain.
Fable verification OWED.**

| Gate | Phase 2 | Now |
|---|---|---|
| typecheck | 0 | **0** |
| lint | 0 | **0** |
| unit | 473 | **473** |
| runtime | 1466 | **1490** (+24) |
| vendor | 54 | **54** |
| electron | 9 | **9** |
| build | clean | **clean (7.4s)** |
| visual | 30 | **30** (unchanged — Phase 3 is runtime-only; the thread UI is Phase 4) |

**2,056 passing, 0 failing.**

### THE DEFECT, NAMED PRECISELY — and it was NOT "nothing dispatches rework"

The plan said nothing dispatched the rework automatically. That was half right, and the
half that was wrong is the interesting half: `story-reviewqa.mjs` DID enqueue fix goals —
**but only when the reviewer gate itself was the caller.** A reject arriving any other way —
`POST /runtime/stories/:id/reject`, an operator, any future agent — moved the stage and
stopped. The story bounced and sat there.

So the fix is not "add a dispatch". It is **move the dispatch to the choke point every
caller already goes through**, and delete the private one. Two dispatch paths would have
paid for the same fix twice.

### 3.1 — `stories.reject()` IS THE HANDBACK, and it fires for everyone

`agent-runtime/story-handback.mjs` (NEW, +15 tests) is what a committed reject now fires.
Pure over injected seams, so both of its real decisions are testable without a database:

- **WHO picks it up** — the handback may name a seat; otherwise `SEAT_FOR_STAGE` owns one.
  A stage with no seat ESCALATES rather than vanishing: an undispatchable rework that looks
  dispatched is worse than one that pages a human.
- **WHEN TO STOP** — see 3.2.

The seam fires AFTER the transaction commits. A dispatch fault can never roll back a
transition that already happened; it is logged, not swallowed, because a story that bounced
and was never picked up is the exact silence this phase removes. Every non-dispatch outcome
(no seat, no engine wired, backlog full, enqueue threw) escalates with the reason —
**nothing reports a dispatch that did not happen.**

`story-reviewqa.mjs`'s private `enqueueGoal` is DELETED and its `enqueueGoal` dep removed
from the server wiring, so the double-pay is structurally impossible rather than merely
avoided.

### 3.2 — THE LOOP GUARD, AND WHY THE OLD ONE WAS NOT ONE

The reviewer gate's round budget lived in `const reviewRounds = new Map()`. **It empties on
restart.** A story could bounce indefinitely across restarts and the cap would never bite —
a budget that resets is not a budget, and an uncapped rework loop is a denial-of-service on
your own wallet: reviewer blocks, fixer fixes, reviewer blocks, paying every round.

The count now comes from `stories.reworkCount(storyId, stage)` — a `COUNT(*)` over the
`reject` rows already in `story_log`. Durable by construction, because the log is already
the record of every transition. Past the cap (default 3, `RUNTIME_MAX_REWORK_ROUNDS`) the
story is parked `blocked` AND a Delivery pages the BOSS with the round count and the last
reason. **Both halves are attempted independently** — a story parked blocked with no Inbox
row is invisible; an Inbox row on a story still marked `active` reads as though the loop is
still running. Neither failure may suppress the other, and a test pins that.

### 3.3 / 3.4 — STRUCTURED, IN THE SAME ROW, IN THE SAME TRANSACTION

Migration **v19** adds `from_stage · by_agent · to_agent · evidence` to `story_log`. ADD
COLUMN only, so every existing row survives with NULLs — the honest value for a transition
that never carried them. No second log: the plan's 3.4 asks for these fields on the row that
already exists, and putting them anywhere else would let two records of one transition
disagree.

`ref` alone could render *"reviewer requested fixes (round 2)"* and nothing else. It could
not answer **from where**, **by whom**, **to whom**, or **on what evidence** — which is
precisely the question the log is supposed to answer. An ordinary advance carries none of
these fields (they are omitted, not null) so the UI never renders `from: null → to: null`.

Untrusted agent text is capped in BOTH dimensions — a 200-item array of 5,000-char strings
is the same unbounded-paste problem as one long string. Pinned: `ref` ≤ 512, `by_agent` ≤ 64,
evidence ≤ 10 items × 200 chars.

### THE LIVE WIRE PROOF — every seam, in one chain

```
POST /runtime/stories                    → story_faf80f5d0c81e747
… advance ×5                             → stage review-qa
POST /runtime/stories/:id/reject         → stage build
GET  /runtime/stories/:id  (story_log seq 7)
  { event:"reject", stage:"build", fromStage:"review-qa", byAgent:"operator",
    toAgent:"sr-backend", evidence:["vault:v_wire","task_wire"],
    ref:"auth admits an expired token" }
GET  /runtime/engine/runs
  goal_97219fe58c62 → sr-backend, priority HIGH, 3 task records
  steps[0] = "REWORK REQUESTED. This story was sent back from 'review-qa' to 'build' …"
  attempts 1,2,3 → all failed: "no active account cannot run the autonomous engine…"
GET  /inbox?status=pending
  1 × kind=failure, "sr-backend is stuck — spawn", Attempts: 3
```

Read that chain: **the reject dispatched real work to a real seat, the engine claimed it,
Phase 2's readiness predicate refused it in the operator's own words, Phase 2.3's retry
ladder spent its budget, and a failure Delivery landed in the Inbox.** Phases 2 and 3 are
wired to each other, not merely each green on their own.

`byAgent: "operator"` is the SERVER's view of the caller (the session), never the client's
claim about itself — the same rule the story author already follows.

**One honest caveat about that trace:** the walk was driven by hand, so the S2 pipeline
drivers (which normally OWN requirements/design/plan) fired asynchronously against my manual
advances and appended rows 8–11. The interleaving there is an artefact of walking the stages
manually in a mock backend, not a measured property of the handback. The rows that matter —
7 (the structured reject) and the engine/Inbox state — are unaffected.

### One existing test was CORRECTED, not preserved (sixth instance, still rare, still visible)

`reviewer BLOCK bounces to build and mints per-blocker fix goals` asserted that the GATE
enqueues. That was the specification of the defect: it made the reviewer the only route in
the system that dispatched rework. It now asserts the gate produces a STRUCTURED bounce and
**enqueues nothing itself**, with the dispatch proven in the round-trip file.

---

## ⇢ AUTONOMY PROGRAM · PHASE 2 — 2026-08-14. THE ENGINE SAYS WHETHER IT CAN RUN, AND AUTO-APPROVE IS BOUNDED.

**STATUS: tasks 2.1–2.4 complete. Two Phase-1 debts closed in the same pass. All 8 gates
green. Live-verified in the browser AND at the wire. Fable verification OWED.**

### GATES — nothing went down, six things went up

| Gate | Phase 1 | Now |
|---|---|---|
| typecheck | 0 | **0** |
| lint | 0 | **0** |
| unit | 467 | **473** (+6) |
| runtime | 1425 | **1466** (+41) |
| vendor | 54 | **54** |
| electron | 9 | **9** |
| build | clean | **clean (6.1s)** |
| visual | 30 | **30** |

**2,032 passing, 0 failing** (was 1,985).

### THE VISUAL NET DID ITS JOB — the first RED it has ever produced on a real change

Phase 0 fixed a comparator that could not see colour and proved it with a *demonstrated*
RED. This is the first time that net has caught a change it was not told about:

```
before re-baselining   4 failed · 26 passed · 1 skipped
                       center @ dark · center @ light · accounts @ dark · accounts @ light
after re-record + update-snapshots   30 passed
```

Exactly the two pages this phase edited, in both themes. Nothing else moved. The
`/runtime/engine/readiness` request also had **no fixture**, and the harness failed loudly
on it rather than capturing an error state — the Phase-0-FIX data plane behaving as
designed. `npm run test:visual:record` re-recorded 38 data-plane responses; the fixture set
now contains `GET /runtime/engine/readiness`.

### 2.1 — READINESS IS A MEASUREMENT, AND ONE PREDICATE SERVES BOTH CALLERS

`agent-runtime/engine-readiness.mjs` (NEW, +10 unit tests, +6 HTTP tests). `engineDispatch`
no longer builds its own refusal: it and `GET /runtime/engine/readiness` are computed from
the SAME function. Two copies of "can the engine run" drift, and the surface then promises
what the loop declines — which is precisely how `capability: "chat_only"` survived as long
as it did.

**Six states, not two.** `runs · cannot · unmeasured · none · backend · deterministic`.
`unmeasured` is deliberately NOT folded into `cannot`: nobody has asked the model yet, and
reporting an unasked question as a settled no is the same unearned claim the deleted
capability table made, one scale smaller.

Two branches that took real thought:
- **The mock backend does NOT block a probed non-Claude account.** `BACKEND` names the
  CLAUDE transport; an OpenAI-compatible account drives its own HTTP endpoint and never
  reads it. Gating it there would refuse a provider for a reason that is not about it.
- **The deterministic soak spawner reports `ready`.** It substitutes only the diff-authoring
  step, so a surface saying "cannot dispatch" while the engine demonstrably dispatches would
  be lying about the one thing it exists to describe.

**THE ROUTE WAS UNREACHABLE ON THE FIRST ATTEMPT, and the test caught it.** Declared next to
`/runtime/agent-ledger` with its own `needsAuth` line, it 404'd: the `/runtime/engine/`
prefix block owns its namespace and 404s anything it does not enumerate. Third instance of
this class in the project (the accounts PATCH that 405'd, bulk-decide outside
`routeNeedsApprover`) — and the first one caught by a test written before the handler was
believed to work.

UI: `EngineReadinessBanner` sits **above** the KPI tiles on the Command Center. Whether the
swarm can act at all outranks what it did today; an operator who reads the numbers first has
already queued work that cannot run. A transport failure renders "readiness unavailable",
never "the engine cannot run" — we do not know, and either claim would be unmeasured.

### 2.2 — AUTO-APPROVE, BOUNDED FOUR WAYS (was: bounded one way and called bounded)

The band ceiling was already structural (`medium`/`high` cannot be `auto_approve`). What was
missing is what makes it a *bound*:

| bound | why it is not optional |
|---|---|
| **diff-size ceiling** (`maxFiles` 8 / `maxLines` 300) | "Low risk" is a classifier's opinion about the KIND of change. It says nothing about size. A low-risk rewrite of forty files is still forty files nobody read |
| **path allowlist**, deny-by-default (`src/**`, `README.md`) | The pre-existing deny-list can only refuse what someone thought to NAME. Running unattended, an unforeseen path must be refused, not permitted |

**AN UNMEASURED SIZE IS REFUSED, NOT ASSUMED SMALL.** `Number(null)` is 0 and would have
sailed under any ceiling — the most permissive number in the range, produced by a caller who
measured nothing. `withinLimits` rejects absent/non-numeric outright. Same rule as the tool
probe: an unasked question is not a yes.

Every new gate is nested under the `auto_approve` branch, so each can only turn
`auto_approve` into `human` and nothing else. A high-risk, oversized, unlisted diff still
reads `typed_confirm` — a knob that tightens one way and loosens the other is not a safety
knob. A malformed `limits`/`allowList` fails the WHOLE FILE closed to all-human, exactly as
a malformed `bands` block does. An explicit `allowList: []` means allow NOTHING; only an
absent key falls back to the built-in set.

`explainRoute()` names which bound held a delivery, logged at the decision point. A gate that
declines silently is indistinguishable from one that is broken, and an invisible policy is
the one that gets loosened out of frustration.

**One existing test was CORRECTED, not preserved** (fifth instance in this project, still
rare and still visible): `low=auto_approve routes a clean low delivery to auto_approve`
asserted auto-approval from a band and a path list ALONE. That test WAS the specification of
the gap — unattended auto-approval on a diff whose size nobody measured.

### 2.3 — SELF-HEALING, PROVEN AGAINST REAL DATABASE ROWS

The retry ladder was already covered in `autonomy.test.mjs` — but at the SEAM, asserting
against the `onTerminalFailure` callback. That proves the engine INTENDS to page the
operator; it does not prove a row the Inbox can read ever lands.
`test/self-heal-db.test.mjs` (+4) wires the REAL engine to the REAL SQLite store and reads
the rows back **with SQL, not through the API that wrote them**: no row while the retry
budget remains · exactly one `kind='failure'`, `status='pending'` row carrying *why* once it
is spent · the row appears in the pending Inbox LISTING (present in the table ≠ reached the
operator) · a guard verdict pages on failure ONE and is never retried.

### 2.4 — THE HEARTBEAT THE RUNTIME DID NOT HAVE

`engine.mjs:139` said, in writing, that there is no heartbeat anywhere in the runtime.
`reclaimExpiredLeases` ran in exactly two places: the boot reconcile, and the backoff wake
timer — and that wake only arms when some task carries a `notBefore`. **On a queue with no
pending retry, a lease whose holder died was never reclaimed until the next restart.**

`engine.sweep()` (+4 tests) rides the runtime's ONE existing periodic timer (the SLA/cadence
interval). Never its own: ADR-025 keeps all wall-clock in one place. The `running` veto is
the load-bearing part — a task this process is STILL EXECUTING is not a dead one however
long it has been going. Re-queuing it would put a second writer on one git worktree and
orphan the first child, whose kill handle would be gone from `running`. Killing a genuinely
hung step is the WATCHDOG's job; these two answer different questions and must not merge.
`sweep()` also ticks, because a requeue nobody picks up is not a recovery.

### PHASE 1 DEBTS CLOSED IN THE SAME PASS

**P1-D — the maxUsd cap is now honest to the operator.** It is enforced from a reported
`usage.cost`, which in practice only OpenRouter sends; for vLLM / NIM / MiniMax / Z.ai
`usdSpent` stays 0 and the $2 ceiling NEVER TRIPS. This was disclosed in code and in Known
Gaps but never to the person reading the budget. The probe now **MEASURES** it on the same
real call — `reportsCost: true | false | null` — and `null` (not measured) is a third state,
because asserting "does not report cost" about an endpoint nobody reached is the same
unearned claim in a different domain. `spendCapExplanation()` is decorated onto every account
by the runtime rather than reimplemented in TypeScript, so it cannot drift from the executor.

**Phase 1 task 1.3's UI half was never actually done, and the page still carried the deleted
table's claim.** `AccountsPage.tsx` rendered `account.capability` and said in its own header
comment *"The engine only runs on Claude accounts"* — the Principle-0 violation, still live
in the UI, after the table it came from was deleted. It now renders `engineStanding()`
(runs / cannot / unmeasured), carries a **Probe** control per account, and states the
spend-cap answer. `probeAccount` and `engineStanding` had been exported and tested with **no
caller anywhere** — dead exports that read as a shipped feature.

### LIVE PROOF (browser + wire, both)

```
GET /runtime/engine/readiness  (no accounts)
  → {"ready":false,"standing":"none","refusal":"no active account cannot run the
     autonomous engine: no account is active. Add an account and set it active."}
GET /runtime/policy
  → limits {maxFiles:8,maxLines:300} · allowList ["src/**","README.md"] · valid true
```
In the browser: added a temporary custom account → Accounts showed **TOOL SUPPORT NOT
MEASURED** + "Spend cap: not measured" → clicked **Probe** → a REAL request to
`integrate.api.nvidia.com` returned HTTP 404 → the card flipped to **CANNOT RUN THE ENGINE**
carrying the transport reason, and the spend cap stayed *not measured* (a failed call
measures nothing). Command Center showed **Engine cannot dispatch** with the identical
refusal sentence the dispatcher would return. Temporary account deleted afterwards
(`GET /runtime/accounts` → 0).

That is the fail-closed path exercised end to end against a real endpoint — it is NOT the
Phase 1 live-success proof, which still needs a real tool-capable key.

---

## ⇢ AUTONOMY PROGRAM · PHASE 1 — 2026-08-14. THE EXECUTOR IS PROVIDER-AGNOSTIC.

**STATUS: Fable iteration 2 = PASS. Code + security VERIFIED.
LIVE PROOF ON A REAL NON-CLAUDE PROVIDER IS STILL OWED — it is the phase's stated exit and
it is NOT satisfied. Phase 1 is CODE-COMPLETE, NOT EXIT-COMPLETE.**

### FABLE ITERATION 2 — PASS, with the bound MEASURED not assumed

Re-ran the round-1 blowup against the NEW path: 40-char and 100-char `(a+)+$` both pin to
~5000ms (round 1: 34-char never returned), i.e. the exponential is off the critical path
entirely. **49 event-loop ticks fired on the main thread during the 5s blowup** — proof the
regex is on a separate isolate and the whole-process DoS is gone. `worker.terminate()` kills
it mid-execution. Verified the deadline bounds the ENTIRE worker run (walk + read + glob +
match), not just the regex, and that `globToRegExp` output is nested-quantifier-free so the
glob leg cannot ReDoS either.

Also verified at the INTEGRATION boundary, which is where the kill switch was inert:
`engine.mjs:292-293` populates `handle.kill` from `ctx.registerKill`, so `withWatchdog`'s
`handle.kill?.()` is no longer a no-op; `ac.signal` threads all the way to
`doFetch(endpoint, { signal })`. The zombie loop can no longer outlive a kill.
Worker lifecycle: `finish()` idempotent, deadline backstops every path, a synchronous
`new Worker` throw fails closed. Thread-per-Grep is NOT a new exhaustion vector (tool calls
are sequential within a turn). `scratchSeq` is main-thread-only so the scratch names cannot
race; concurrent writes to one dest each stage a distinct tmp and rename atomically.

**One LOW, fixed:** `grep-worker.mjs` called `maxGrepFileBytes` a "per-file ceiling" closing
Grep's unbounded-read gap. It bounds what is SEARCHED, not what is READ — the full file is
still allocated. Corrected, because a comment claiming more than the code delivers is the
defect class this program keeps paying for.

**Fable's closing note, carried forward verbatim in substance:** every part of the claim is
now proven structurally and against protocol-accurate stubs — containment, caps, kill
switch, single write path, probe-derived capability — **but not once end-to-end against a
live tool-capable non-Claude model.** That is the one thing a green Phase 1 does not
demonstrate.

### REVIEW ROUND 1 — both reviewers found the SAME CRITICAL, independently

| # | Sev | Finding | Status |
|---|---|---|---|
| P1-A | **CRITICAL / HIGH (both)** | **Model-controlled ReDoS in `Grep`.** An UNTRUSTED model's `pattern` was compiled with JS's backtracking RegExp and matched SYNCHRONOUSLY IN THE MAIN SERVER PROCESS — and the model controls the haystack too (it can `Write` the file it then greps). Measured on the real path with `(a+)+$`: 22 chars → 794ms · 26 → 1131ms · 30 → **18,127ms** · 34 → **never returned**. Froze every HTTP handler, every other agent and the kill-switch registration (the CLI path is isolated in a spawned child; this one was not). **It also bypassed ALL FIVE caps**, which are only checked BETWEEN tool calls — falsifying task 1.4's own claim that caps are "the real risk control". And it falsified "the same tools": Claude's Grep is ripgrep (linear-time, separate process); the UNTRUSTED path got the weaker in-process backtracking one | **FIXED** — Grep now runs in a terminable worker (`providers/grep-worker.mjs`) under a hard 5s deadline, plus per-file byte and per-line length caps. Isolation, not pattern inspection: safe-regex detection is a graveyard of bypasses; a worker bounds patterns nobody has thought of. 4 regression tests including the exact ReDoS shape |
| P1-B | **HIGH** | **The kill switch was INERT for this executor.** `runOpenAiToolsExecutor` never called `ctx.registerKill` and never passed a signal, so `handle.kill` stayed null and `withWatchdog`'s timeout was a no-op. The engine would then believe the task ended, **remove the worktree**, and leave a zombie loop still making paid HTTP calls and still writing into a deleted directory — with exec-tools swallowing the ENOENT as an ordinary tool error so the model carried on | **FIXED** — AbortController registered via `ctx.registerKill`, signal threaded to the loop and to fetch. A mid-request abort now reports ABORTED rather than a generic "executor failed", which would have told the operator the provider broke when their own kill had worked |
| P1-C | **HIGH** | `exec-tools` Write/Edit wrote directly, missing the scratch+rename TOCTOU fix `patch-edit.stageEdits` already had — the UNTRUSTED path lacking a hardening the operator path has is the wrong way round | **FIXED** — both now write via `wx` scratch + `rename`, which cannot follow a symlink planted at the destination |
| P1-D | MEDIUM | **The `maxUsd` cap is unenforceable for exactly the providers this phase unlocks.** Only OpenRouter reports `usage.cost`; vLLM / NIM / MiniMax / Z.ai report nothing, so `usdSpent` stays 0 and the $2 ceiling never trips. Real bounds for those accounts are steps and wall-clock, which cap API CALLS, not dollars | **DISCLOSED** in code and in Known Gaps. NOT surfaced in the Accounts UI — that is owed |
| P1-E | MEDIUM | `credentials.mjs` header still said *"capability is DERIVED from the provider type (claude → swarm, everything else → chat_only)"* — the deleted table, described in a security-relevant read path. The stale-claim class again | **FIXED** |

**Gates after the fixes:** typecheck 0 · lint 0 · unit 467 · runtime **1425** · vendor 54 ·
electron 9 · build clean. **Visual re-run owed.**

### What Principle 0 demanded, and what was actually wrong

`capability: "chat_only"` was stamped on openai / minimax / zai / custom in a hardcoded
table, and only claude got `"swarm"`. **Five literals that never asked a model anything.**
They described OUR ADAPTER — `streamChat` yielded text deltas and could not call a tool —
and the label got written onto the PROVIDER, refusing GPT, Nemotron, MiniMax and Z.ai from
autonomous work all of them can do. THE TABLE IS DELETED. There is no `capability` field on
a preset and no `capabilityForType()` to call; deriving capability from a brand is now
impossible by construction rather than merely discouraged.

### 1.1 — the tool loop, and THE TRAP TESTED FIRST

`providers/tool-call-accumulator.mjs` (+14 tests) was written before any loop code, because
streamed `tool_calls` arrive FRAGMENTED and keyed by `index`: `name` in one delta,
`arguments` split across many. Read one fragment and you get `{"pa` — and the usual
"handling" is a try/catch that DROPS the call, so a model that asked to write a file appears
to have chosen to do nothing. Covered: split arguments, split names, parallel calls
interleaved, out-of-order indices, a missing `index`, empty arguments, and — the one that
matters — **a malformed call is REPORTED (`ok:false` + raw text), never dropped**, so the
loop can hand it back as a tool error the model can retry.

`providers/tool-loop.mjs` (+13 tests) runs the standard protocol and appends the assistant
turn WITH its `tool_calls` (omit that and the provider 400s on the next request).

### 1.2 — the SAME tools, the SAME guards, no second write path

`providers/exec-tools.mjs` (+19 tests): Read · Glob · Grep · Write · Edit. Every write
resolves through `workdir-guard.resolveWorkdirDest` — **the containment check was EXTRACTED
from patch-edit.mjs (`safeDest`) so the untrusted-model path and the operator-edit path share
ONE implementation instead of two that drift.** patch-edit's own 42 tests are the proof the
extraction changed nothing. Nothing here writes to the repo: the agent fills its WORKDIR and
`broker.applyChanges` remains the single unchanged path into the repository.

`Edit` REFUSES an ambiguous match rather than replacing the first of several occurrences —
that would edit a line the model did not mean and nothing downstream would show it.

### 1.3 — capability BY PROBE

`providers/capability-probe.mjs` (+14 tests) sends one trivial tool and believes only a
well-formed call. **FAIL CLOSED**: a refusal, a text answer, a transport error or a malformed
call is not capability. A probe recorded against a DIFFERENT model is ignored — switching the
model switches the thing that was measured. Cached on the account (`setToolProbe`), surfaced
at `POST /runtime/accounts/:id/probe`, and **registered in `routeNeedsApprover` in the same
change as the route** — it mutates state and spends money, and both `/inbox/bulk-decide` and
`PATCH /accounts/:id` previously shipped ungated because that was left to a later review.

Claude stays `swarm` without an HTTP probe because it runs through the Claude CLI — a
statement about TRANSPORT, not a brand privilege. Any provider that passes the probe gets
identical standing.

### 1.4 / 1.5 — caps, and the fallback

Five caps: steps · wall-clock · file writes · bytes written · USD. **Every trip is a
FAILURE WITH A NAMED REASON** that becomes a failure Delivery; there is no silent stop.
An UNREPORTED cost never trips the USD budget — spend is measured, never inferred (Phase 7
rule, applied here). Task 1.5: a stream that truncates a tool call is retried NON-STREAMED
rather than guessed at.

### 1.6 — `engineDispatch` stops being Claude-shaped

It used to BE the CLI path. The CLI is now one of two executors selected by the active
account, with the SAME contract (`{acc} | {error}`), the SAME workdir and the SAME broker.
The refusal message no longer says "switch to a Claude account" — it names the model, what
it did when given a tool, and that the fix is a probe.

### THE CHAIN PROOF — `executor-broker-chain.test.mjs` (+6)

A non-Claude model's Edit/Write goes through the REAL broker into a scratch repo, read off
disk. `.env` is written into the workdir but **never offered as an appliable change**;
traversal and symlink writes are refused at the tool; a CAPPED turn still leaves its partial
work visible to the broker rather than discarding it.

### GATES

| Gate | Before | Now |
|---|---|---|
| typecheck | 0 | **0** |
| lint | 0 | **0** |
| unit | 467 | **467** |
| runtime | 1341 | **1420** (+79) |
| vendor | 54 | **54** |
| electron | 9 | **9** |
| build | clean | **clean (5.49s)** |
| visual | 30 | **30** |

**1,980 passing, 0 failing.**

### Two tests were CORRECTED, not preserved — both certified the defect

1. `capabilityForType: claude→swarm, everything else→chat_only` — the test WAS the
   specification of the bug. Replaced with: capability is not derivable from a type, and a
   probed custom provider runs the engine.
2. `setActive` warning asserted `/chat/i` ("saved for chat"). The refusal must name the
   missing MEASUREMENT and offer the probe, not name a brand as the remedy. It now asserts
   `/tool support/`, `/probe/`, and **`doesNotMatch(/claude/i)`**.

Third and fourth instances of "fix the test, not the implementation" in this project
(spendCell, then the Phase 0 threshold). The exception stays rare and visible.

---

## ⇢ AUTONOMY PROGRAM · PHASE 0 — 2026-08-13. THE VISUAL NET WAS BLIND. IT NOW SEES.

**⚠️ THE SECTION BELOW ("SESSION 2026-08-11b — THE VISUAL SUITE IS GREEN, 30/30, THREE
RUNS BACK TO BACK") IS SUPERSEDED AND ITS CENTRAL CLAIM WAS FALSE.** Those 30/30 runs were
real runs of a comparator that could not see colour. Do not cite them as evidence of
anything. Kept below as the triage record.

### The finding, with the number that proves it

`npm run test:visual` reported **30/30 at `maxDiffPixels: 0`** against baselines painted in
the OLD palette, after Phase 8.2 rewrote every surface colour. Reproduced from a cold start
with `:3007` free and a fresh build, so the stale-`vite preview` theory is DEAD:

| | dominant colours |
|---|---|
| baseline `center-desktop-dark-darwin.png` | `#0b1220` (638,150 px) · `#121b2e` (234,714 px) · `#1e2b45` |
| capture from the build under test | `#050a14` (639,046 px) · `#182238` (234,676 px) · `#243350` |
| pixels the comparator reported as different | **0** |

The comparator was running — swapping in a *different page's* baseline failed at 16,962 px.
It simply could not see colour.

### ROOT CAUSE — one missing option, and it is not the one the name suggests

Both specs declared `const STRICT = { maxDiffPixels: 0, animations: "disabled" }` under the
comment "maxDiffPixels: 0 — strict". **`maxDiffPixels` bounds HOW MANY pixels may differ.
What decides WHICH pixels count as differing is pixelmatch's `threshold`**, which was never
set and therefore sat at Playwright's default **0.2** — a YIQ colour-distance cutoff of
`35215 × 0.2² = 1408.6`. Arithmetic for the rewrite:

| pair | YIQ delta | cutoff 1408.6 |
|---|---|---|
| `#0b1220 → #050a14` | 33.19 | invisible |
| `#121b2e → #182238` | 33.19 | invisible |
| `#1e2b45 → #243350` | 30.38 | invisible |

Two orders of magnitude below the noise floor. A ~1.1-million-pixel repaint read as zero.
**Neither of the plan's two hypotheses (0.3a viewport coverage, 0.3b stale server) was the
cause.** Both were checked and eliminated with evidence.

### THE EXIT GATE — a demonstrated RED, not a green run

Same suite, same stale baselines, same app, only the threshold corrected:

```
BEFORE:  30 passed  (3.3m)
AFTER:   27 failed · 3 passed  (2.5m)
         largest diff 772,073 pixels (ratio 0.84 of all image pixels)
```
The 3 that passed are the only 3 tests that take no screenshot (clock pinned, missing
fixture reported, EventSource stubbed). Every one of the 27 that capture pixels went red.

Then, after reseeding — **Task 0.5 exactly as the plan specifies it**, one token changed:

```
stability run 1                                 30 passed
stability run 2                                 30 passed
--helm-deck  #182238 -> #1d2a44  (YIQ delta 31.8)
                                                27 failed · 3 passed
                                                smallest failing diff 46,748 px
reverted                                        30 passed
```

### THE COMPARISON CONTRACT — `test/visual/strict.mjs`, one source of truth

Both specs now import `STRICT`; a guard test fails if either re-declares its own literal,
because a local literal is exactly how the option went missing. `playwright.config.mjs`
also sets the defaults, so a future call site that forgets to spread `STRICT` still gets a
comparator that can see.

`threshold: 0` was tried FIRST and **measured, then rejected**: a clean re-run of the
unchanged app failed 4/30 at 2, 5, 12 and 29 pixels — all on one 2px vertical edge, all off
by exactly ±1. A net that fails four tests per run on an unchanged tree gets re-baselined
out of habit, which is how the blind net survived a whole session. So the gate is set by
CAUSE, against two separately-measured noise classes:

| class | shape | instrument |
|---|---|---|
| edge rounding, ±1–2 per channel (delta ≤ 2.02) | many pixels, tiny delta | `threshold: 0.012` → cutoff **5.07** |
| rounded-corner AA on `.helm-chip`'s `color-mix(… , transparent)` fill (delta 18.13) | ~17 pixels, large delta | `maxDiffPixels: 40` |

Margins: tightest REAL pair `--helm-line-soft → --helm-line` = **30.38**, i.e. 6× above the
cutoff and 15× above ±2 noise. Every real change the program makes is unbounded in count
(772,073 px for the palette; a type-size change reflows a whole glyph run) while the corner
artefact is bounded at 17, measured across five full-suite runs / 150 test executions.

**One real cause was eliminated rather than budgeted for.** Cross-launch variance was 86
pixels with UNEQUAL per-channel deltas (r+4 g+7 b+5) — the signature of subpixel (LCD) text
antialiasing. `FREEZE_CSS` now forces grayscale font smoothing and `geometricPrecision` at
capture time: **86 → 22 pixels**, and the survivors are back to the ±1 class.

### TASK 0.4 — the build-identity stamp (owed regardless of the cause)

`vite build` stamps a content hash of every build input (`src/**`, `index.html`, tailwind
and postcss configs) into `index.html` as `<meta name="ma-build-id">`; `settle()` recomputes
it from the working tree and refuses to capture on a mismatch, naming both hashes. It exists
because `reuseExistingServer: false` is **not** the guarantee it reads as: `vite preview
--strictPort` exits when the port is taken and Playwright then proceeds against whatever
answers. Verified live: `dist` stamp `6b9866d8f2309b9c` == working tree. Deliberately
content-derived, never a timestamp, so the stamped page cannot itself become pixel churn.

### A SECURITY DEFECT FOUND WHILE GATING — sandbox probe failed OPEN

`npm run test:runtime` reported 10 failures on this machine. They were Docker-gated tests
carrying `{ skip: !DOCKER_UP }` that **failed instead of skipping**, so the skip predicate
was true with no daemon. Measured on Docker CLI 27.3.1, daemon stopped:

```
docker info                                -> exit 1
docker info --format '{{.ServerVersion}}'  -> exit 0, stdout EMPTY
```

`dockerAvailable()` used the templated form and tested only `!err`, so it answered **true
with no daemon**. That is not just a noisy test run: the same predicate is the entire body
of `preflight()`, whose own comment says *"Fail-closed."* — the gate that tells the runtime
whether it can jail an agent's command. It reported ok on a host with no sandbox at all.
Fixed to require non-empty output; `agent-runtime/test/sandbox-probe.test.mjs` (4 tests)
drives all three daemon states through a stub binary so it reproduces with or without
Docker installed. **Out of Phase 0's scope; fixed because a security predicate failing open
is not something to leave behind a disclosure.**

### GATES

| Gate | Before | Now |
|---|---|---|
| typecheck | 0 | **0** |
| lint | 0 | **0** |
| unit | 451 | **466** (+15 comparator-sensitivity) |
| runtime | 1337 | **1341 · 0 fail · 0 skipped** (+4 sandbox-probe) |
| vendor | 44 | **54** (+10 build-id) |
| electron | 9 | **9** |
| build | clean | **clean (5.48s)** |
| visual | 30 (blind) | **30 (sighted, 5 consecutive green runs)** |

**1,900 passing, 0 failing** (program start 1,871). Nothing was deleted; every increase is
new coverage, and every one of the 29 new tests is a regression test for something found in
this phase or its reviews.

**On the Docker-gated tests:** for most of this session Docker Desktop's daemon would not
start, so those 15 ran as FAILURES (that is how the fail-open probe defect was found) and
then, after the fix, as correct SKIPS. The daemon eventually came up and the final run is
**1341/1341 with zero skipped** — the container escape suite genuinely executed.

### INDEPENDENT REVIEW — the precedent held AGAIN, and one defect was mine twice over

`code-reviewer` (WARNING: 0 CRITICAL · 1 HIGH · 2 MEDIUM · 1 LOW) and a binding Fable 5
verification (**DEFECT-FOUND** → phase reopened, iteration 1 of 3) ran in parallel. Both
independently re-derived the load-bearing arithmetic against the INSTALLED comparator
(`node_modules/playwright-core/lib/coreBundle.js`, @playwright/test 1.62.1) and confirmed
the YIQ coefficients, the `35215 × threshold²` cutoff, and that `threshold` is a per-pixel
colour cutoff and not a ratio. Fable independently reproduced both the 30/30 clean state and
the one-token kill (483,914 px on its own run) and verified the baselines decode to the new
palette only.

**What they found that I had got wrong:**

| # | Sev | Finding | Resolution |
|---|---|---|---|
| D1 | MED | **`determinism.spec.mjs` asserted `threshold: 0` and "a pixel-exact bar is achievable" — both false** once the contract became 0.012/40. This is the ORIGINAL SIN REPEATED: the blind net survived because a comment ("maxDiffPixels: 0 — strict") claimed a property the code lacked, and I reintroduced exactly that inside the go/no-go spec | rewritten to state what is in force, name strict.mjs as the authority, and record that the paragraph itself previously repeated the failure |
| D2 | LOW | **The worst-case rounding model was reasoned, not measured.** I claimed same-sign on all channels is worst (i/q cancel, 0.5053). Enumeration refutes it: worst ±1 is **0.5416** at `[-1,+1,+1]`, worst ±2 is **2.1662**. Conclusions survived, but a guard headed "measured, not assumed" contained an assumption | `roundingNoise()` now evaluates all 27 sign combinations; 0.5416/2.1662 pinned by assertion; strict.mjs's table corrected to 0.54/2.17 (9× and 2.3× margins) |
| D3 | LOW | **My stale-server rationale overstated the hazard.** Fable OBSERVED Playwright 1.62.1 refusing to run outright ("...is already used") when a squatter holds :3007 at suite start | narrowed in both harness.mjs and build-id.mjs to the real window: the ~1 min `npm run build` phase, where a late port grab makes `--strictPort` exit and the run continues against the squatter |
| D4 | — | **`includeAA` is a THIRD blind class.** Playwright forwards only `threshold`, leaving pixelmatch's `includeAA: false` default, so AA-classified pixels are excused at ANY delta and in **UNBOUNDED number** — they never touch the 40-pixel budget. A hairline moving 1px can vanish | documented; strict.mjs now carries a consolidated five-item "EVERYTHING THIS NET CANNOT SEE" list, and two tests pin the comparator's source facts so a Playwright upgrade fails a test instead of silently invalidating the arithmetic |

**ITERATION 2 — Fable found the SAME CLASS A THIRD TIME, in a file I had just edited.**

| # | Sev | Finding | Resolution |
|---|---|---|---|
| D5 | MED-LOW | `playwright.config.mjs:26` asserted *"maxDiffPixels stays 0 — the STRICTNESS of the comparison is untouched"* — eleven lines above the line setting **40**. Written when the budget WAS 0, never updated. Found with a one-line grep | rewritten to claim nothing about values; records what it used to say and why that was the same mechanism |
| D6 | LOW | `harness.mjs:6` still demanded *"a byte-identical image every run"* — the bar this phase's own record disproved (identical DOM, PNGs differing by one byte) | rewritten to "reproduces the same image", with byte-identity named as the wrong bar |
| — | — | **A sixth blind spot, and the biggest: below-the-fold content.** `toHaveScreenshot` without `fullPage` captures the VIEWPORT only; `bos.css` has six-plus `overflow-y: auto` panes. Unlike the 40-px budget this is **UNBOUNDED** — an entire component below the fold can regress invisibly | listed as (f), plus (g) transient interaction states and (h) fixture-absent data states. Recorded as structural, not a tolerance |

**THE RULE IS NOW A TEST, because three occurrences is a pattern, not bad luck.**
`staleClaims()` scans `playwright.config.mjs`, `strict.mjs`, `harness.mjs` and both specs for
any comment quoting a concrete `maxDiffPixels`/`threshold` value and fails when it disagrees
with `strict.mjs`, unless the ±1-line window is explicitly framed as history. The window is
±1 line because a single-line version produced three FALSE POSITIVES on correctly-framed
historical references — the framing routinely lands on the neighbouring line. Two self-tests
keep it honest: one feeds it the exact sentence that shipped in `playwright.config.mjs` and
asserts it is caught; one feeds it a correctly-framed historical reference and asserts it is
not. A guard that cannot fail manufactures confidence.

**Occurrences of this one defect class, for the record:** (1) `"maxDiffPixels: 0 — strict"`
in both specs — the original blindness, a whole session of green runs certifying nothing;
(2) `determinism.spec.mjs` claiming `threshold: 0` after the contract became 0.012/40 —
**written by me while fixing (1)**; (3) `playwright.config.mjs` saying `maxDiffPixels stays
0` — **found while verifying the fix for (2)**. Each was caught by an independent reader.
None was caught by me.

**ITERATION 3 — VERDICT: PASS. PHASE 0 IS CLOSED.**
Re-run after the API session limit cleared. The verifier re-ran the gates itself on the
current tree (unit 466, full visual 30 passed / 1 skipped) and confirmed
`SCREENSHOT_THRESHOLD = 0.012` / `MAX_DIFF_PIXELS = 40` unchanged. Its closing statement:
every defect found across the three iterations (D1-D6) was in the EVIDENCE/DISCLOSURE layer;
**the instrument itself never failed a falsification attempt.** It explicitly did NOT verify
the 1341/1341 zero-skipped runtime run — Docker was down when it probed — so that number
rests on my run alone and is labelled as such.

Three non-gating residuals it disclosed, ALL now closed:
1. `strict.mjs` said the eye-review backstops "all five" under a list grown to eight.
   Corrected: it backstops the five IN-FRAME classes (a)-(e); **nothing** backstops (f)-(i),
   which by definition never appear in a diff.
2. **Three further detector evasions** it found by probing: `"stays at 0"`, `"remains 0"`,
   and `claiming` (which I had added to HISTORICAL) widening hole 1. `"stays at"` is one
   word from the sentence that shipped as recurrence 3, so the narrow regex did not cover
   even the common shape it claimed. **Fixed rather than pinned** — the connector
   alternation now covers `stays at|remains|sits at`, `claiming` is removed, and all four
   phrasings are regression-tested. Test fixtures are SPLIT before the number so the literal
   never appears in a file that scans itself, in preference to an ignore-sentinel, because a
   bypass inside the guard against unenforced claims is the last thing this phase should ship.
3. **A ninth blind spot: one rendering configuration** — Chromium only, `deviceScaleFactor: 1`
   only, three discrete widths only (a break at 1024-1439, where the sidebar boundary lives,
   is invisible). Added as (i).

Final Phase 0 gate: typecheck 0 · lint 0 · unit **467** · runtime **1341/1341** · vendor 54 ·
electron 9 · build clean · visual **30** = **1,901 passing, 0 failing**.

**(superseded note kept for the record)** ITERATION 3, FIRST ATTEMPT — NO VERDICT.
The verifier was resubmitted with the D5/D6 fixes and terminated part-way on an API session
limit, having reported only "detector probes done — now the remaining gates before I
finalize". **It never returned PASS or DEFECT-FOUND.** Under this program's own rule a
verdict is binding and its absence is not a pass, so Phase 0's independent verification
stands at: iteration 1 DEFECT-FOUND (fixed), iteration 2 DEFECT-FOUND (fixed), iteration 3
INCOMPLETE. Re-run it before Phase 1 depends on this net.

**What I did in its place — my own sweep, which found two more things.** Not a substitute
for the verdict, and recorded as my own work rather than as verification:
1. Ran the stale-claim detector over a WIDER file set than it scans (`build-id.mjs`,
   `sandbox.mjs`, `vite.config.ts`, `fixtures.mjs`, `pages.mjs`, `record.spec.mjs` and the
   detector's own file). One hit, in `comparator-sensitivity.test.mjs` itself — a correctly
   framed historical line whose framing word ("became") was missing from the exemption list.
   Fixed, and **the detector now scans its own file**, because exempting it would be the
   same "trust me" move this phase exists to delete.
2. **Probed my own detector for evasions and found two.** A historical word anywhere in the
   ±1-line window exempts even a genuinely present-tense claim; and a claim wrapped across a
   line break escapes the per-line regex. Both are now PINNED BY TEST — the test asserts
   they DO get through, so the detector cannot be mistaken for a proof, and closing either
   one fails the test and forces the Known Gaps entry to be updated. A guard that overstates
   its coverage would be this defect class for the fourth time, in the guard against it.

**code-reviewer HIGH — the visual suite is not in CI, and it is worse than that.**
`.github/workflows/ci.yml` never runs `test:visual`. Investigating it surfaced a larger
fact: **zero files under `test/` are tracked by git** — the specs, the 75 baselines, the
fixtures, `strict.mjs` and `playwright.config.mjs` are ALL untracked. CI has therefore never
executed any part of this harness, and `npm run test:unit` in CI silently matches nothing
under `test/visual/`, so CI's unit count is ~437 where local is 462. This is NOT fixable by
adding a job: nothing is committed (standing order), and Playwright suffixes snapshots with
the platform, so the `-darwin` baselines would make an `ubuntu-latest` job red on its first
run. See Known Gaps for the recommendation.

---

## ⇢ SESSION 2026-08-11b — SUPERSEDED, SEE PHASE 0 ABOVE. Its "30/30" was a blind net.

**Gap 7 (the blocker on Phase 9) is CLOSED as a blocker and DOWNGRADED, not deleted —
read the honesty note below before treating it as fixed.**

### A1 — fixtures re-recorded. DONE.
`npm run test:visual:record` **passed on the first attempt** against the production build
on :3007 with the runtime up on :3006. The previous session's `navigateTo` timeout did NOT
reproduce. The `preview: { proxy }` block it added to `vite.config.ts` is what unblocked
it; the residual failure it reported was in the same broken-environment run.

- **37 data-plane responses recorded, every one HTTP 200/201.** No 599 record-failures.
- **Both Phase 6/7 routes are now fixtured:** `GET /runtime/agent-ledger?window=7d` and
  `GET /runtime/spend?window=7d` — verified present, status 200, real payload shapes
  (`approvalRate: null` + `rated: false` on the ledger; `usd: null`, `activeMetered: true`
  on spend, i.e. the honesty rules survive the round trip).
- **Redaction re-verified on the new file:** `grep -c "$HOME"` → **0**; token and SSE
  ticket both replaced with the `*-not-a-real-credential` placeholders (1 each).

### A2 — the "app shell never laid out" defect. NOT REPRODUCED. INSTRUMENTED. STILL OPEN.
**120 test executions across four full suite runs produced ZERO shell failures.** I did not
fix it, because I could not make it happen. What I did instead, in order:

1. **Instrumented first, as instructed.** `{"found":false}` was true of THREE different
   states and could not tell them apart — React never mounted, a Suspense fallback still
   pending (every page's `<main>` lives INSIDE its Suspense boundary in App.tsx), or
   `AppErrorBoundary` catching a render crash. `waitForShell` now reports `readyState`,
   `rootChildren`, `bodyHtmlLength`, the Suspense fallback's own text, the alert text and
   the first 240 chars of body text, and attaches the page's `pageerror` / console-error /
   failed-request log collected from before `goto`. `navigateTo` got the same treatment: on
   a miss it dumps the viewport, whether `nav.bos-side` exists, its computed `display`, and
   every candidate button's text — because Playwright's text matching follows innerText
   semantics, so a `display:none` rail (below 1024px) reports EMPTY text on every button
   and matches nothing, which is indistinguishable from "the button is gone" without it.
2. **Added a fast-fail on the terminal state.** `AppErrorBoundary` never resolves, so
   waiting 45s for a `<main>` that cannot appear reports nothing. It now throws in ~1s with
   the captured exceptions. **This is NOT a shortened timeout — the 45s deadline is
   unchanged for every state that can still resolve.**
3. **Tested one hypothesis and REFUTED it.** Deleted the two new fixture keys and re-ran
   `inbox` + `stories` (the exact pair that failed last session): **4/4 passed.** Those
   pages never request ledger/spend, so a missing fixture there is not the mechanism.

**Honest position: the cause is unknown.** The most likely explanation is that the old
failures were environment-bound (they were measured in the same run whose fixture file was
already stale), but that is an inference, not a proof. If it returns, the error message now
names which of the three states it is. Do not raise a timeout.

### A3 — baselines reseeded, then proven.
Reseed run **30/30**. Then, alone on an idle machine: **run 1 = 30/30 · run 2 = 30/30 ·
run 3 = 30/30** (run 3 after the fast-fail edit, to prove the instrumentation did not break
the healthy path). All 27 pre-reseed failures were pixel diffs from the re-recorded data
(e.g. `inbox @ light` 892 px, ratio 0.01) — inspected by eye on the deck capture: real
content, real roster, no 503 page, the diff confined to the inbox badge count.

**Gates re-run after the harness edits — baseline HELD, nothing regressed:**
typecheck **0** · lint **0** · unit **447** · runtime **1329** · vendor **44** ·
electron **9** · build clean (8.86s) · visual **30** = **1,859 green**.

---

## SECTION B — the phases 4-7 review debt. TWELVE REAL DEFECTS, ALL FIXED.

Six independent reviews ran in parallel (code-reviewer on 4/5/6/7, security-reviewer on 4
and 7). **The precedent held again: every single phase contained a real defect in work
that was already gated green, and three of them were CRITICAL.** Two were reproduced
empirically by the reviewer before being reported, not merely reasoned about.

### The three CRITICALs

**C1 — an operator's edit was silently discarded and the AGENT's text shipped instead.**
`readInboxBody` capped every `/inbox` body at 8,000 bytes and, on overflow, called
`req.destroy()` — whose `close` handler resolved the body as `{}`. So an edit over ~8 KB
(a 250-line file clears that easily) arrived as a body with NO `edits` key and the route
carried on into an ORDINARY approve: the agent's original text was written to the repo
while the browser, its socket just reset, showed the operator a generic failure. The
operator's correction was thrown away and the very thing they were correcting shipped —
with no signal that anything had landed at all. Reproduced: 7,976 bytes → edited text
lands; 8,876 bytes → `deliveryStatus=approved, landedIsOriginal=true`.
**Fix:** the decide route now reads up to 2.6 MB (sized to patch-edit's own 2 MB edit
ceiling) and an over-cap body resolves to a distinct `BODY_TOO_LARGE` sentinel → **413**,
never `{}`. Overflow no longer destroys the socket immediately (that is why the client saw
a transport error instead of the refusal); it stops buffering, keeps the connection alive
long enough to write the 413, and drops the connection only past 4× the cap.
**Tests:** a 60 KB edit must LAND (the regression that was broken), and an over-limit body
must 413 with the row still pending and the repo untouched.

**C2 — a viewer could rewrite provider credentials (`PATCH /runtime/accounts/:id`).**
The second instance of the `/inbox/bulk-decide` class of gap. `routeNeedsApprover` gated
POST create, POST `/secret` and DELETE — but not PATCH, which can replace the sealed
secret AND rewrite `baseUrl`. A read-only seat could therefore point an account at a host
it controls and have the approver's real API key sent there on the next turn: credential
exfiltration. **Fix:** one line in `routeNeedsApprover` + a regression test that probes an
unknown id, so a 404 or 400 (reaching the handler) fails the test as loudly as a 200.

**C3 — spend was attributed to the wrong account, or silently dropped.**
`recordUsage` re-read the active account AT SETTLE TIME, under a comment claiming that
this is what prevents mis-attribution. It is the opposite. A CLI turn runs for tens of
seconds and nothing stops the operator switching providers meanwhile, so cost incurred by
account A was written against whoever was active at settle — attributed to B, or dropped
entirely when B was a subscription (an unmetered account records nothing). **Fix:** the
account is captured at DISPATCH on both paths (`turnAccount` in `handleChat`,
`activeAccount` in the engine) and threaded to the settle point. `recordUsage` no longer
looks the account up at all, and the parameter is deliberately NOT defaulted to a fresh
lookup — a caller that forgets it must record nothing rather than guess.

### The three HIGHs

**H1 — the ledger reported a WRONG median wait.** `decisions` correctly excluded expired
and failure rows; the latency block two lines below did not. `decidedAt` is not
exclusively a human timestamp — `deliveries.mjs` stamps it with `decidedBy: 'system'` when
a pending row is force-expired, and a dismissed "agent is stuck" row carries one too. An
agent whose real reviews took 5 minutes could display a median wait of a day, sitting next
to an honest "insufficient data" rate. Fixed by gating the latency on the same
`isRealDecision` predicate. Test seeds fast real decisions plus a system-stamped expired
row and a dismissed failure: **RED reported 13.5h where the truth is 2h.**

**H2 — the UI hid real spend as "included".** `spendCell` returned the word "included"
whenever the CURRENTLY active account was unmetered, before even looking at the row. But
`activeMetered` describes the account active right now, not the window on screen, and
every row in the spend table is by construction from an api_key account. An operator who
spent $12.34 on an API account and then switched to a subscription saw the whole week
relabelled "included" — a false statement about the period, the same lie this phase exists
to prevent, merely inverted. **The old test certified the bug by name**, so the test was
corrected rather than the code — the documented exception to "fix the implementation".

**H3 — a TOCTOU let a concurrent agent redirect an operator's edit outside the workdir.**
`stageEdits` lstat'd every destination and THEN wrote every destination, so nothing pinned
the inode across the gap — and in a batch, one file's gap spans every other file's write.
The manual-run sandbox is keyed by agentId and reused across runs, so an agent's own tool
loop can legitimately replace a file with a symlink in that window, and the operator's
bytes would follow it. **Fix:** write each edit to a scratch file (`wx`, fail-if-exists)
and `rename()` into place only once every write has succeeded. `rename(2)` does not follow
a symlink at the destination — it replaces it — so the swap wins nothing.

### The six MEDIUMs

| # | Phase | Defect | Fix |
|---|---|---|---|
| M1 | 4 | "ALL-OR-NOTHING" staging held only for VALIDATION failures; a failure during the write loop left earlier files already rewritten — bytes nobody approved, which a later plain approve would apply | same temp+rename mechanism as H3; RED test proved the half-staged batch |
| M2 | 5 | Focus pause had no un-pause path. Tabbing into the rail paused the feed; tabbing onward never resumed it, so it stayed paused for the session, silently accruing an unseen count | `onBlurCapture` with a `relatedTarget` containment check |
| M3 | 5 | Changing the agent filter reported the ENTIRE view as "N new" — `lastTopSeq` was a seq from the previous filter's list | re-baseline on `agent` change |
| M4 | 5 | A seq-less frame got a freshly decremented counter, so the SAME frame redelivered after a reconnect got a DIFFERENT id and the dedupe never matched — it rendered twice | `fallbackSeq()`: deterministic, content-derived, always negative. Trade-off (two identical anomalous frames collapse) stated in the code |
| M5 | 5 | A COLLAPSED rail still paid a full Set+sort and filter pass over 500 rows on every accepted frame | both memos and the arrival effect gated on `open` |
| M6 | 7 | The OpenAI-compatible path — OpenRouter and custom endpoints, the accounts this phase exists for — could NEVER report a cost: `streamChat` returned the usage object and `adapterReply` dropped it by breaking on `done` without reading `value` | usage threaded into `save`; `costFromUsage()` refuses anything that is not a real reported number; `stream_options.include_usage` sent generally and OpenRouter's `usage:{include:true}` sent to OpenRouter ONLY (an unknown body field can be a 400 on a stricter self-hosted server) |

### LIVE BROWSER PROOF — phase 4, against a real server, with the DB checked afterwards

The real runtime's `REPO_ROOT` is **this repository**, and its 12 pending code deliveries
carry 29 changed paths / 1044 lines each. Approving one would have written 1044 lines over
a tree holding 61 files of uncommitted program work. **That is not a live-proof target,
so I stood up an isolated one** rather than skipping the proof or risking the tree:
a second runtime on **:3008** with its own scratch repo, DB, sandbox and token dir, and a
second Vite on **:3005** proxying to it.

1. Minted a real pending `code` delivery (`src/greet.ts`) through the runtime's own
   `/changes` path — not hand-inserted into SQLite.
2. In the browser: Inbox → the card → **Edit** → the editor opened pre-filled with the
   agent's 57 bytes → retyped it → **Done** → the button relabelled itself
   **"Approve with 1 edit → apply"** → clicked it.
3. **On disk, in the scratch repo:** `export const greet = 'OPERATOR EDITED IN BROWSER';`
   — the operator's bytes, not the agent's.
4. **From the server:** `01KZS5HE8TQ6T31BA40RE70DB2 approved BOSS 2026-08-11T19:45:54Z`.

### LIVE BROWSER PROOF — phases 6 and 7, UI read against the server

On the same isolated stack, the **Agents deck** rendered, from real server rows:

```
Agent      Delivered  Approved                       Failures  Median wait  Spend
liveagent  1          insufficient data · 1 decided  0         4m           included
```

`GET /runtime/agent-ledger?window=7d` → `decisions: 1, approvalRate: null, rated: false,
medianDecisionMs: 226309` (3m46s — the real gap between minting the delivery and approving
it in the browser). `GET /runtime/spend?window=7d` → `usd: null, meteredTurns: 0,
activeMetered: false`. **The honesty rules are visible on screen against live data:** a
single decision reads "insufficient data", never "100%"; the spend cell reads "included"
with the footer stating why; the median is a real measured latency and — after the H1 fix
— counts only that real decision.

### FABLE 5 VERIFICATION — binding. 2 PASS, 2 REOPENED, both then fixed.

| Phase | Verdict | Outcome |
|---|---|---|
| 4 | **PASS** | Verified the 413 sentinel and the scratch+rename staging directly; 66/66 tests re-run. Two LOW residuals disclosed below |
| 5 | **DEFECT-FOUND (LOW)** → fixed | **My own fix was incomplete.** `onBlurCapture` resumed the feed while the POINTER was still over the rail: hover is a reading signal the blur handler could not see, so tabbing out with the mouse still resting on the rail re-stuck the feed and shifted rows under a stationary cursor. Now `hovered` is tracked as state, `onBlurCapture` returns early while hovered, and `onMouseLeave` is made symmetric (it no longer resumes while focus is still inside). Also corrected a comment that described a "received" label in the header which the component does not render |
| 6 | **PASS** | 30 backend + 13 client tests re-run. Confirmed the median fix against seeded SQLite. Accepted the `auto_approved`-in-median choice as coherent and disclosed |
| 7 | **DEFECT-FOUND (MEDIUM)** → fixed | **The C3 fix did not go far enough.** `guardedSpawn` RETRIES the engine's spawn closure after a 429, and each attempt re-reads the live secret — but attribution was pinned at dispatch. Switching providers during a backoff meant the retry ran on B while the cost was recorded against A: a subscription turn's flat-rate figure persisted as real spend on an api_key account. The account is now read at THE SAME POINT as the secret, per spawn (`spawnAccount`), so what pays and what is billed cannot diverge |

Both reopenings were defects in fixes made *this session* — which is the argument for the
verification gate existing at all.

### GATES AFTER EVERY FIX — the baseline rose, nothing regressed

| Gate | Was | Now |
|---|---|---|
| typecheck | 0 | **0** |
| lint | 0 | **0** |
| unit | 447 | **451** |
| runtime | 1329 | **1337** |
| vendor | 44 | **44** |
| electron | 9 | **9** |
| build | clean | **clean (10.3s)** |
| visual | 30 | **30** |

**TOTAL 1,871 green** (was 1,859). +12 tests, every one a regression test for a defect
found this session. Nothing was deleted.

### Residual risks disclosed by the verifiers, NOT fixed

| # | Risk | Sev | Why it stands |
|---|---|---|---|
| R1 | The 413 ceiling counts the JSON-encoded body (2.6 MB) while the validator caps raw edit bytes at 2 MB. Content that is almost entirely newlines/quotes could pass the validator and still exceed the transport cap | LOW | ~30% headroom; no real source file approaches it. The failure mode is a loud 413, not a silent drop |
| R2 | `safeDest` realpath-checks the destination's PARENT, so swapping the parent DIRECTORY for a symlink between check and rename would still place bytes through it | LOW | Inherited from broker.mjs's own model; needs an agent racing a directory rename inside its own workdir. Static symlink cases are refused and tested |
| R3 | `AgentLedger.tsx` can render `NaN/6` in a sub-label if handed a payload missing `approved`/`autoApproved` | LOW | Unreachable through the real contract (SQL counters cannot emit non-numbers) and the route is token+origin+loopback gated |
| R4 | Heavy auto-approval drags "Median wait" toward zero, since policy applies stamp `decidedAt` near mint time | LOW | Coherent with the column's stated meaning ("time from delivery to decision", not human review time) and already disclosed in the footer |

**⇢ NEXT: sections C, D, E — 8.2-8.5, the Phase 9 sweep, and the Phase 10 gauntlet.**
The design-skill chain (`hallmark` → `impeccable` → `taste-skill`) on the phase 4-7 UI is
still owed and is best run WITH section C, since 8.2-8.5 rewrites the token layer those
surfaces render against — running it before would audit colours that are about to change.

---

## ⇢ START HERE (new session)

**Done:** Phases 0, **0-FIX**, 1, 2, 3, **4**, **5**, **6**, **7**, and Phase 8 tasks
**8.0 + 8.1**. **NOT DONE: Phase 8 tasks 8.2-8.5, all of Phase 9, all of Phase 10.**
**NO COMMITS until the user says so.** ~55 files sit uncommitted in the tree.

### ⇢ NEXT ACTION, precisely
1. **Phase 9 is unblocked and is the big one.** `docs/superpowers/specs/type-scale.md`
   holds the decided mapping; `src/theme/tokens.css` holds the ladder. Sweep **batches of
   ~10 files**, run `npm run test:visual` between each, review every diff by eye.
   Target: `grep -rhoE 'text-\[([0-9]|1[01])(\.[0-9]+)?px\]' src --include='*.tsx' | wc -l`
   → **0** (currently **372**, across 64 files).
2. **Phases 8.2-8.5** (surface ladder ≥1.25:1, accent → 3 roles, cockpit dark tokens,
   WCAG re-verification) are untouched and should land BEFORE or WITH the sweep.
3. **Every phase 4-7 still owes:** live browser proof, `hallmark`→`impeccable`→
   `taste-skill`, `code-reviewer`, and a Fable verification pass. The code and the tests
   are done; the independent review is not.
4. **Phase 10 (final gauntlet) is entirely untouched** — including the 30-minute
   unattended soak and the dead-wiring sweep.

### ⛔ OPEN DEFECT — the visual suite does not reliably reach 30/30. FIX THIS FIRST.
> **SUPERSEDED 2026-08-11b — see the session block at the top of this file.** The suite has
> since run **30/30 five times consecutively**. The shell-layout failure below did NOT
> reproduce in 150 test executions; it is instrumented, downgraded, and no longer blocks
> Phase 9. Everything below is kept as the triage record, not as current state.

**This blocks Phase 9.** The sweep's only safety net is the screenshot diff, and a net
that fails 2-5 tests per run at random cannot certify a 61-file rewrite.

**Symptom.** Some matrix tests fail in `settle()` with
`app shell never laid out within 45000ms — last seen: {"found":false}` or
`{...,"height":0}`. The very next test on the same page passes in ~6s. Which tests fail
moves between runs.

**What I checked, so the next session does not repeat it:**
- It is NOT the old comma-selector bug (`waitForSelector("nav, main")` latching onto a
  hidden nav). That was real, and is fixed — `waitForShell()` now polls real geometry.
- It is NOT `networkidle` (the cockpit polls forever, so idle is never reached). Also
  fixed — `quiesce()` waits two animation frames.
- It is NOT the dev server: the suite now runs against the production build on :3007.
- **My "busy CPU" theory is NOT PROVEN.** I first attributed it to running test suites
  concurrently, and one reseed did fail 5 tests while other suites ran. But a later run
  on a near-idle machine still failed. Treat the CPU explanation as UNCONFIRMED.

**NARROWED, 2026-08-11 late.** The final reseed was **26 passed / 4 failed**, and the
four split into TWO DIFFERENT causes — which is why earlier runs looked so random:

- **2 failures were the harness working correctly.** `deck @ dark` and `deck @ light`
  reported `unfixtured data-plane requests: ["GET /runtime/agent-ledger?window=7d",
  "GET /runtime/spend?window=7d"]`. Those are the Phase 6/7 routes, added AFTER the
  fixture file was recorded. The suite refused to capture a baseline containing two 503s.
  **That is the 0-FIX feature proving itself on real new code.** Fix = re-record.
- **2 failures are the real open defect** (`inbox @ dark`, `stories @ light`), both
  `app shell never laid out … {"found":false}`. Still unexplained.

**RE-RECORDING IS CURRENTLY BLOCKED — fix this first, it is a small, well-understood bug.**
`npm run test:visual:record` now drives the PRODUCTION build on :3007, and `vite preview`
does not read `server.proxy` (that key is dev-only), so every `/runtime` request 404'd at
the static server instead of reaching :3006. I added a `preview: { port, proxy }` block to
`vite.config.ts` mirroring the dev proxy — **that part is done and correct**. The recorder
now gets further but fails in `navigateTo` with
`locator.waitFor: Timeout 15000ms exceeded`, i.e. a sidebar label never attached during
the two-pass walk. Suspect the viewport round-trip (1440 → 320 → 768 → 1440) not restoring
the desktop-only sidebar before the next click. Re-check `navigateTo`'s wait against the
production build before touching any timeout.

**Where I would look next**, in order:
1. Instrument the failure: `waitForShell` already reports display/height/children — dump
   `document.body.innerHTML.length` and the Suspense fallback's presence alongside it. If
   `found:false` means the Suspense fallback is still mounted, the lazy chunk is the
   suspect, and the question becomes why that chunk import stalls under `page.route()`
   interception.
2. Check whether the fixture route handler can ever be slow to fulfil — every unmatched
   data-plane request is fulfilled with a 503, and a page that fires many of them during
   boot pays a round trip through the route handler for each.
3. Try `workers: 1` with a fresh browser per test vs. a reused browser.

**Do NOT "fix" this by raising a timeout.** Two wrong diagnoses in this session were both
timeout bumps, and both hid the real cause for another hour.

**Baseline moved (all increases, nothing regressed):**
typecheck 0 · lint 0 · unit **447** · runtime **1329** · vendor **44** · electron 9 ·
visual **30** = **1,859 green**. (Program start was 1,710 — **+149**, nothing deleted.)

### Visual harness — THREE corrections after the first fix (read before touching it)
1. **The readiness selector was the real bug.** `waitForSelector("nav, main")` resolves to
   the FIRST match in DOM order and waits for *that* to be visible. The shell renders more
   than one `<nav>` and the first is hidden below 1024px, so the wait sat on a permanently
   invisible element while `<main>` had been painted the whole time. It looked like
   load-dependent flake because which nav comes first shifts with route and viewport.
   Now `waitForShell()` polls real geometry and, on failure, throws with the element's
   display / height / child count. **A timeout that says nothing caused two wrong
   diagnoses before this one.**
2. **`networkidle` is unusable here.** The cockpit polls forever (2s / 3s / 4s / 30s), so
   there is never a 500ms quiet window. `waitForLoadState("networkidle")` ran to its full
   timeout every call and added ~30s per test for no information. `quiesce()` now waits
   two animation frames plus a short margin.
3. **The suite runs against the PRODUCTION BUILD on :3007**, not the dev server
   (`npm run build && npm run preview:visual`, `reuseExistingServer: false`). The net now
   guards what ships, and the module-transform server is out of a 30-context serial run.

### Boot the environment FIRST (both, aligned — else 401/500)
```bash
cd /Users/RohitAnandeshi/Downloads/WaahyuFOLDER/MissonAlpha
export RUNTIME_TOKEN_DIR=/var/folders/l1/ndwcjhx13hzg0bpvdtk5xvkh0000gn/T/missionalpha-runtime-dev
export RUNTIME_PORT=3006
pkill -f "agent-runtime/server.mjs"; pkill -f "vite --port 3004"
nohup node agent-runtime/server.mjs > /tmp/rt.log 2>&1 & disown   # MUST say "listening :3006"
sleep 3 && nohup npm run dev > /tmp/vite.log 2>&1 & disown        # :3004
```
`node agent-runtime/server.mjs` does NOT read `agent-runtime/.env`; Vite DOES. Start the
runtime bare and it lands on 3005 while Vite proxies 3006 → every call 500s. A
`RUNTIME_TOKEN_DIR` mismatch → every call 401s. **Restart the runtime after ANY
`agent-runtime/*.mjs` edit — a stale process serves old code.**

### The gate (all 7 + visual, every phase)
```bash
npm run typecheck && npm run lint && npm run test:unit && npm run test:runtime \
  && npm run test:vendor && npm run test:electron && npm run build
npx playwright test test/visual --config=playwright.config.mjs
```
**Current baseline — never go below:** typecheck 0 · lint 0 · unit **447** · runtime
**1329** · vendor **44** · electron **9** · visual **30** (see the open defect above)
= **1,859 green**.
(Program start was 1,710. Nothing was deleted; every increase is new coverage.)

**Run the visual suite ALONE** — see the warning at the top of this file.

### Hard-won lessons — do not relearn these
1. **Independent review found a real defect in EVERY phase, in work already gated green.**
   3 of 6 were security. Never claim done before `code-reviewer` + a Fable pass.
2. **Live-verify in the browser.** Two bugs (dead risk gate, clustering decided rows)
   passed every unit test and only died under real UI + real server.
3. **`risk` is an OBJECT** `{score, band, reasons}`. `RiskBand = "low"|"medium"|"high"|null`.
   `"unrated"` is a DISPLAY label only (`riskLabel`), never a stored band.
4. **Wiring gaps are real:** the PATCH route existed but `server.mjs` 405'd it; bulk-decide
   existed but was outside `routeNeedsApprover`. Always prove the button reaches the DB.
5. Byte-compare is the wrong instrument for screenshots — use the pixel comparator.

---

**Resume with:** "continue the excellence program" — read this file + the plan, pick up at
the first unchecked box. Do not re-derive anything recorded here.

- **Plan:** `docs/superpowers/plans/2026-08-10-helm-excellence-program.md`
- **Spec:** `docs/superpowers/specs/2026-08-10-excellence-manifesto-review.md` (rev 3)
- **Branch:** `feat/multi-provider-credentials` @ `05e8dbd` (pushed)
- **RULE: NO COMMITS until the user says so.** Work accumulates in the working tree.

---

## Baseline — locked 2026-08-10, all 7 gates green

| Gate | Command | Result |
|---|---|---|
| typecheck | `npm run typecheck` | **0 errors** |
| lint | `npm run lint` | **0** (--max-warnings 0) |
| unit | `npm run test:unit` | **372 / 372**, 0 fail |
| runtime | `npm run test:runtime` | **1208 / 1208**, 0 fail |
| vendor | `npm run test:vendor` | **28 / 28**, 0 fail |
| electron | `npm run test:electron` | **9 / 9**, 0 fail |
| build | `npm run build` | clean (5.86s) |

**TOTAL: 1,617 tests green.** Any later phase reporting fewer, without deleting the
corresponding feature, has broken something. Stop and fix.

### Environment facts (do not rediscover)
- Node 26 · better-sqlite3 13.0.3
- UI dev `:3004` (`npm run dev`) · runtime dev `:3006`
  (`agent-runtime/.env`: `RUNTIME_PORT=3006`, `RUNTIME_TOKEN_DIR=/var/folders/l1/ndwcjhx13hzg0bpvdtk5xvkh0000gn/T/missionalpha-runtime-dev`)
- Token: `$RUNTIME_TOKEN_DIR/.runtime-token`
- **RESTART the runtime after ANY `agent-runtime/*.mjs` edit** — a stale process serves
  old code. This has bitten the project before.

---

## Phase status

| Phase | Status | Notes |
|---|---|---|
| 0 — baseline + visual harness | **CONDITIONAL PASS** | 28/28 stable ONLY with both servers up+aligned. Data plane NOT fixtured — see Fable review |
| 1 — edit-account | **DONE + Fable-hardened** | PATCH + Edit UI. 2 real bugs found by Fable and FIXED (atomicity, type-parity) |
| 2 — failure clustering | **DONE** | 45 dupes → 12 clusters live. bulk-decide route + ClusterCard. Pending-only fix |
| 3 — bulk decisions | **DONE** | Multi-select + bulk bar. CRITICAL auth bypass found by code-reviewer and FIXED |
| 0-FIX — hermetic harness | **DONE** | Fixtured data plane. Proven: 30/30 with the runtime KILLED. Fable PASS; all findings fixed |
| 4 — approve-with-edit | **DONE, review open** | Guard test first. Backend + UI + 11 wire tests. impeccable found 1 CRITICAL (edit offered where it can never land) — FIXED |
| 5 — activity stream | **DONE, review open** | Bounded 500-ring, reconnect dedupe on the real bus seq, reduced-motion honoured |
| 6 — agent ledger | **DONE, review open** | Pure SQL. Honesty rule enforced 3× (server, label, sort) |
| 7 — metered spend | **DONE, review open** | Migration v18. Unmetered rows structurally impossible. usage.mjs comment corrected |
| 8 — A1 CSS tokens | **PARTIAL** | 8.0 spec + 8.1 tokens.css DONE. **8.2-8.5 NOT started** |
| 9 — A2 component sweep | **NOT STARTED** | Unblocked now. 372 sub-12px sites across 64 files |
| 10 — final gauntlet | **NOT STARTED** | Incl. dead-wiring sweep + 30-min soak |

"Review open" = code and tests complete and green; live browser proof, the design-skill
chain, `code-reviewer` and Fable verification are NOT yet run for that phase.

---

## Phase 4 log — the reviewer findings, and what changed because of them

`impeccable` + `taste-skill` reviewed the approve-with-edit UI and returned 1 critical,
6 major, 8 minor. **All actioned.** The critical one is worth reading in full because it
is exactly the class of defect this program exists to catch:

> **CRITICAL — Edit was offered on files where it can never succeed.** `broker.mjs` caps
> reviewed text at 4000 chars and scrubs secrets out of it, and the runtime then fails
> closed on any edit whose reviewed text is not byte-identical to disk. So for every file
> over ~100 lines, or any file containing a redacted secret, the UI rendered an enabled
> Edit button, accepted a fully retyped file, and surfaced the refusal only AFTER the
> operator pressed Approve on a production write.

Fixed by teaching the runtime to compute `editable` + `editableReason` per change (it can
see the truncation marker and the redaction placeholders in the stored patch) and
disabling the control with the reason stated. **A control that cannot succeed must not be
offered** — that is the "everything wired" rule read in the other direction.

Also fixed from that review:
- the refusal message itself contained an em dash (house style) — rewritten;
- the field-level ERROR state was rendered only while the editor was OPEN, so the common
  Edit → Done → Approve path never showed it — now rendered unconditionally;
- the same error rendered twice (pane banner + field) with two `role="alert"` nodes —
  the banner is now suppressed when a field owns the message;
- the error binding was a **string prefix match** on the server's wording — replaced with
  a structured `editErrors: [{path, message}]` so a reworded message cannot silently
  downgrade the field-level state;
- Edit swapped a unified diff for a whole file body **without changing the label** —
  the region's `aria-label` and a visible note now say which one you are looking at;
- `Approve 2 edits` understated a 5-file delivery — now `Approve with 2 edits`;
- `DiffEditor` was not memoized, so every keystroke reconciled every sibling diff;
- Revert unmounted the focused button, letting Tab escape the modal focus trap;
- `.helm-btn-slim` was **dead CSS** (specificity 0,2,0 losing to `[data-variant]` at
  0,3,0) — the button was never actually slim;
- a comment claimed the editor toggle "does not jump the layout", which the code cannot
  deliver — corrected rather than left as an aspirational lie.

---

## KNOWN GAPS & RISKS — session of 2026-08-11

Disclosed, not hidden. A hidden gap is the violation; a disclosed one is engineering.

### Not done at all
| # | Gap | Severity |
|---|---|---|
| 1 | **Phase 9 (component sweep) not started.** 372 sub-12px `.tsx` sites across 64 files, plus 95 CSS declarations. This is the single largest visible change in the program and it is entirely ahead. | **High** |
| 2 | **Phase 8 tasks 8.2-8.5 not started** — surface ladder still 1.09:1 (target ≥1.25:1), accent still ~168 sites (target 3 roles), cockpit still light against a dark sidebar, WCAG not re-verified. | **High** |
| 3 | **Phase 10 not started** — no `/qa`, no `/cso`, no `a11y-architect`, no dead-wiring sweep (`knip`/`ts-prune`), no 30-minute unattended soak, no clean `npm ci` run. | **High** |

### Done but not independently verified
| # | Gap | Severity |
|---|---|---|
| 4 | **Phases 5, 6, 7 have had NO live browser proof, no `code-reviewer`, and no Fable pass.** Every one of the first six phases had a real defect found in work that was already gated green, and three of those were security. Assume these three phases contain defects. | **High** |
| 5 | **Phase 4 had impeccable + hallmark but no Fable and no live browser proof.** Its wire-level tests are strong (11 tests reading the repo file on disk), which is the strongest evidence available short of a browser. | Medium |
| 6 | Phase 7's metered path has **never run against a real api_key account**. Every spend test uses a synthetic account object; no real provider has reported a real `total_cost_usd` through this code. The unmetered path IS proven end to end. | Medium |

### Real defects and limitations found, not yet fixed
| # | Gap | Severity |
|---|---|---|
| 7 | **THE VISUAL SUITE DOES NOT RELIABLY REACH 30/30 — open, unexplained, and it BLOCKS Phase 9.** 2-5 matrix tests per run fail in `settle()` with "app shell never laid out"; the next test on the same page passes in ~6s; which tests fail moves between runs. Three wrong theories already ruled out (comma selector, networkidle, dev server) and the "busy CPU" theory is NOT confirmed — a near-idle run still failed. Full triage notes at the top of this file. | **HIGH — blocks Phase 9** |
| 8 | **`test/visual/__fixtures__/api.json` contains the recording operator's real workspace** — chat transcripts, vault records, agent names. Credentials and home paths ARE redacted (verified: 0 occurrences). Re-record against a scratch workspace before this repo is published anywhere. | Medium |
| 9 | **One runtime-suite flake observed once** (1 fail of 1285) during a concurrent visual run; the immediate re-run was 1285/1285 and every later run has been green. Not reproduced, not diagnosed. | Low |
| 10 | **No sparkline on the agent ledger**, though the plan asked for one. There is no per-day history in the payload and inventing the points is forbidden. Real fix: a bucketed endpoint. | Low |
| 11 | **No syntax highlighting in the diff editor.** Deliberate: every highlighter worth using emits HTML, and the diff surface is the live XSS control. Real fix: Shiki `codeToTokens` → React elements, never `innerHTML`. | Low |
| 12 | **Phase 4 stages a validated edit into the workdir BEFORE the status flip.** If the flip then loses a race with a concurrent decider, that decider lands the EDITED bytes. The alternative (flip first) silently applies the agent's ORIGINAL text after the operator asked for a change, which is strictly worse. Disclosed, deliberate. | Low |
| 13 | **The activity feed's timestamps are CLIENT receipt times**, because the SSE frame carries no server timestamp. Named `receivedAt` and labelled in the UI so it cannot be misread. Real fix: add a timestamp to the wire frame. | Low |
| 14 | The WebGL globe is still excluded from visual capture (pre-existing, documented in `harness.mjs`). | Low |

### Delivered this session but not yet used
`scripts/type-scale-sweep.mjs` + `scripts/lib/type-scale.mjs` (+16 tests in `test:vendor`)
execute the Phase 9 mapping deterministically. Dry run over the tree reports **514 sizes
to rewrite across 61 files and ZERO undecided sizes** — which independently confirms the
Task 8.0 mapping covers 100% of what is actually present. `--write --batch 10` applies one
batch and stops with the exact next steps. **Nothing has been swept yet**, because a batch
is only safe once the visual suite is trustworthy (gap 7).

Scoping decision recorded in the script header: the sweep emits plain px on the ladder
(`text-[12px]`), NOT `text-[length:var(--type-1)]`. Collapsing 15 sizes to 9 is the risky,
valuable change; introducing a brand-new Tailwind idiom at 556 sites in the same commit
would make every visual diff harder to attribute. Tokenising the call sites is a clean
follow-up once the sizes are right.

### Nothing is stubbed
No placeholder functions, no mock data, no TODO-as-done shipped in this session. Every
feature listed as DONE is wired end to end and has a test that reads real state.

---

## Phase 5 log — activity stream — DONE (pending live proof)

**Pure model:** `src/lib/activityStream.ts` (+18 tests). Bounded 500-row ring, newest
first, fully immutable; an event outside the feed's vocabulary returns the SAME array
reference so an ignored frame costs zero renders.

**Three honesty rules baked in, each with a test:**
1. An event the feed has no verb for renders NOTHING — never a row reading
   "a undefined undefined". The vocabulary is deliberately NARROWER than the SSE catalog
   (the catalog carries reserved names nobody emits and identity-only plumbing frames).
2. **Time is named for what it is.** The SSE frame carries `id`, `event`, `data` and NO
   server timestamp (`events.mjs` writes one to SQLite but does not put it on the wire).
   The field is therefore `receivedAt`, not `at`, and the row's tooltip says "Received by
   this browser at …". Naming it `at` would have someone read it as server truth inside a
   month.
3. `usage.tick` renders TOKENS, never a dollar figure — asserted.

**Reconnect dedupe is real, not hoped for.** `RuntimeEvent` gained an optional `seq`,
attached in `useRuntimeEvents` from the frame's own `lastEventId`. `applyActivity` drops a
row whose id it already holds, so an off-by-one in ADR-052's replay watermark cannot show
the operator the same event twice. A client-side counter would have restarted at zero on
every reconnect and deduped nothing.

**Wiring:** folded in App.tsx's SINGLE SSE subscription (a second `EventSource` would
double the runtime's fan-out for a read-only panel) and passed down to `CommandCenter` →
`ActivityStream`. The buffer keeps filling while the panel is closed and while the
operator is on another page, so opening the rail shows history. Open/closed persists in
`localStorage` under `ma.activity.open.v1`.

**Motion:** one 140ms transform+opacity row-enter. Under `prefers-reduced-motion: reduce`
the animation is REMOVED, not shortened — a 500-row feed crossfading is exactly the
vestibular load the query exists for. The media query is read live via a `matchMedia`
listener, not sampled once at mount.

**Auto-scroll pauses on hover, on focus-within, and on any scroll away from the top**, and
raises a real "N new" count (not a dot). A feed that yanks the viewport mid-read is worse
than no feed.

**OPEN:** live browser proof, `hallmark`/`impeccable` pass on the rail, code-reviewer,
Fable.

---

## Phase 6 log — agent ledger — DONE (pending live proof)

`agent-runtime/agent-ledger.mjs` (+13 unit tests) + `GET /runtime/agent-ledger?window=`
(+12 HTTP tests) + `src/lib/ledgerClient.ts` (+12 tests) + `AgentLedger.tsx` on the deck.
**Pure SQL over existing rows — no writes, no schema change, no new event.**

**THE HONESTY RULE IS ENFORCED THREE TIMES** (server, client label, and sort order):
- < 5 decisions ⇒ `approvalRate: null`, `rated: false` ⇒ the cell reads
  `insufficient data`. Never a percentage. Never a 0 — a chart plots a 0.
- `rateLabel()` refuses again on the client for any non-finite or out-of-range value, so a
  regressed payload or a hand-rolled response still cannot render `NaN%`.
- Unrated rows **sink** when sorting by rate, in BOTH directions. Ranking a no-data agent
  next to a genuinely failing one is the same lie told with position instead of text.

**Three more places it refuses to invent a number** (each tested): a `pending` row is not
a judgement, so it is outside the denominator; an `expired` row means the SLA ran out and
NOBODY decided — scoring that against the agent would blame it for the operator's backlog;
a `decidedAt` earlier than `createdAt` (clock skew across a restart is real) is discarded
rather than reported as a negative latency.

**A test I had to correct rather than the code:** the first version asserted
`decisions === 6` including the expired row. The code was right and the test was wrong —
recorded here because "fix the implementation, not the test" has an exception and this
was it.

**NO SPARKLINE.** The plan sketched one. There is no per-day history in the payload and
the only way to draw a trend from a single aggregate is to invent the points. Listed in
Known Gaps with the shape of the real fix (a bucketed endpoint), not quietly dropped.

**OPEN:** live browser proof, design skills pass, code-reviewer, Fable.

---

## Phase 7 log — metered spend — DONE (pending live proof)

`agent-runtime/spend.mjs` (+15 tests) + migration **v18** (`spend` table) +
`GET /runtime/spend?window=` (+4 HTTP tests) + a Spend column on the ledger.

**THE PREMISE CHANGED; THE OLD RULE WAS RIGHT UNDER THE OLD PREMISE.** `usage.mjs` said
"NO DOLLARS, EVER — subscription is flat-rate so a $ figure would be false." Correct — and
correct *because* every run went through a subscription. Multi-provider broke that premise:
api_key accounts bill per token. The rule is now **scoped, not repealed**, and Task 7.3
rewrote the `usage.mjs` header and the `usage.tick` comment to say exactly that, because a
stale comment contradicting the code is how this project's worst error happened.

**Four rules, each tested:**
1. ONLY `authMethod === "api_key"` meters. Unknown / missing / subscription fail closed.
2. A subscription turn records `null`, **never 0**. Zero is a measurement; null is the
   truth. It is never even written — the table's `CHECK (authMethod = 'api_key')` makes an
   unmetered row **structurally impossible**.
3. A metered turn with no REPORTED figure records null. Spend is never inferred from token
   counts we have no price for — no rate cards, no modelling.
4. A blended subscription+API total cannot be constructed. `rollupSpend` sums metered
   turns only and returns `mixed`, and the UI is required to caveat it. "$0.01 today" on a
   day that also ran 40 subscription turns is a false statement about the day.

`spendLabel()` is exhaustively tested to never emit a `$` for an unmetered account under
any input shape.

**Wiring:** recorded at the SAME settle point as usage, on BOTH the chat and autonomous
paths, reading the ACTIVE account per turn (not cached) so switching providers mid-session
cannot mis-attribute. `total_cost_usd` is now READ from the CLI result and threaded
through `onDone → save → recordUsage`; whether it means anything is spend.mjs's decision
alone.

**OPEN:** live browser proof with a real api_key account, security-review, code-reviewer,
Fable.

---

## Phase 8 — PARTIAL. Tasks 8.0 and 8.1 done; 8.2-8.5 NOT started

- **Task 8.0 DONE — `docs/superpowers/specs/type-scale.md`.** The 9-step ladder, the full
  mapping of all 30 existing sizes, the measured histograms, and the grep commands that
  verify it. **This is what unblocks Phase 9.** Read it before touching a component.
- **Task 8.1 DONE — `src/theme/tokens.css`**, imported FIRST from `index.css`. Declares
  `--type-1..9` in rem and nothing else, so it changes zero pixels on its own.
- **8.2 (surface ladder ≥1.25:1), 8.3 (accent → 3 roles), 8.4 (cockpit dark tokens),
  8.5 (WCAG re-verification): NOT STARTED.**

**Measured, for whoever picks this up:**
`.tsx`: 556 `text-[Npx]` sites across 64 files, **372 of them sub-12px**, 15 distinct sizes.
CSS: 176 declarations, **95 sub-12px**, 21 distinct sizes.

---

## Phase 0-FIX log — hermetic visual harness — DONE

**The defect being fixed (Fable's Phase 0 finding):** captures depended on a live :3006
runtime, live SQLite state and a live auth token. When the environment broke, the harness
did not fail — it captured the 401/500 error page and, on `--update-snapshots`, baked it
into the baselines.

**Shipped**
- `test/visual/fixtures.mjs` (NEW) — record/playback of the data plane via `page.route()`.
  Any request under `/api/`, `/runtime`, `/inbox`, `/factory` is served from
  `test/visual/__fixtures__/api.json`. A request with NO fixture is answered **503** and
  pushed to `report.missing`, which every spec asserts is empty.
- `test/visual/record.spec.mjs` (NEW) — the recorder. Skipped unless `VISUAL_RECORD=1`.
  `npm run test:visual:record`. **Two passes × every page × every viewport** — a
  single desktop-only pass under-recorded by 13 of 35 keys (measured), and the miss only
  surfaces later as a 503 mid-capture.
- `harness.mjs` — `STUB_SSE_JS` replaces `EventSource` in page context with a stub that
  opens and stays silent. `route.fetch()` on a `text/event-stream` never resolves, so the
  stream cannot be fixtured; stubbing is both hermetic and deterministic.
  `installHermetic(page)` = fixtures + freeze + SSE stub, returns the report.
- `test/visual/fixtures.test.mjs` (NEW, 14 tests) — wired into `test:unit`.

**PROOF (not assertion)**
- `npm run test:visual` → **30 passed / 1 skipped WITH `agent-runtime/server.mjs` KILLED.**
  Before this phase that run captured error pages.
- Delete `__fixtures__/api.json` → the suite throws
  `visual fixtures missing at … — run npm run test:visual:record` and fails. Loud, not silent.
- A test asserts an unfixtured data-plane request returns 503 **and** lands in
  `report.missing` — the guard cannot rot into a no-op.

**Reviewer findings — ALL FIXED**
| Source | Sev | Finding | Fix |
|---|---|---|---|
| Fable | LOW | A **real SSE ticket** was committed in the fixture. Redaction only covered `GET /api/runtime-token`. | `POST /runtime/events/ticket` redacted; response shape preserved |
| Fable + code-reviewer | **MED** | The operator's absolute home path was baked into fixture bodies (SQLite task records, a git error string) | `redactAbsolutePaths()` replaces `$HOME` with `/fixture-home`. Verified: **0** occurrences after re-record |
| Fable | LOW | `fixtureKey` collided: `?a=1&b=2` vs `?a=1%26b%3D2` produced one key; repeated params fragmented | Pairs re-encoded and sorted as whole `k=v` strings. Both cases regression-tested |
| code-reviewer | **MED** | `determinism.spec` "two consecutive captures" asserted `report.missing` only BEFORE the 1500ms timer window. `FREEZE_JS` does not pin `setInterval`, so a late poller could bake the SAME 503 into both captures — pixel-identical, comparator passes | assertion now brackets the wait |
| code-reviewer | LOW | Playwright's default `testMatch` also matches `*.test.*`, so it imported `fixtures.test.mjs` and ran the node:test suite a second time during collection | `testIgnore: "**/*.test.mjs"` |

**Flake, root-caused (do not re-bump a timeout).** Two tests failed in a full serial run
while passing solo, taking 35s against a 6s solo baseline. That profile is
`toHaveScreenshot` **polling**: it re-captures until the image matches or `expect.timeout`
expires, so late-settling content burns retries and, under load, runs out. Fixed at the
cause — `quiesce()` waits for `networkidle` after `settle()` and after every nav (all data
is in-memory now, so idle is immediate) — plus `expect.timeout` 15s → 30s to remove the
cliff behind it. **`maxDiffPixels` stays 0: strictness unchanged, only convergence time.**

**Known gaps (0-FIX)**
1. `__fixtures__/api.json` contains the recording operator's REAL workspace — chat
   transcripts, vault records, agent names. Credentials and home paths are redacted;
   content is not. Deliberate (synthetic data would not exercise the same layouts).
   **Re-record against a scratch workspace before this repo is published anywhere.**
2. Under `--update-snapshots`, a 503 during capture still WRITES the PNG before the
   trailing assertion fails. The run goes red, so it is loud — but the fix is re-record +
   re-run, not just re-run. Mitigated by checking `report.missing` before every capture.
3. The WebGL globe is still hidden for capture (pre-existing, documented).

---

## Phase 4 log — approve-with-edit — backend DONE, UI built, verification IN PROGRESS

**Task 4.0 — the guard test, written FIRST** (`src/lib/__tests__/no-innerhtml.test.ts`, 5
tests). Scans all of `src/` for `innerHTML` / `outerHTML` / `dangerouslySetInnerHTML` /
`insertAdjacentHTML` outside comments and string literals. **Four of the five tests are
SELF-TESTS** proving the scanner can fail — a guard that cannot fail manufactures
confidence, and this session had already shipped one fake assertion in the visual harness.
Result on the tree: **0 sinks** (the 18 grep hits are all comments).

**Task 4.1 — `agent-runtime/patch-edit.mjs`** (NEW, 27 tests). `validateEdits`,
`validateUnifiedDiff`, `reviewedMatchesDisk`, `restoreTerminator`, `stageEdits`.
- An edit may REVISE a proposal, never EXTEND it — the path must be in the delivery's own
  `changedPaths` AND pass `applyAllowed()` again (the row was authored by an agent).
- Staging is all-or-nothing; a file not already in the workdir cannot be created;
  symlinked destinations and symlinked parent dirs are refused.
- **THE CORRUPTION GATE — the most important thing in this phase.** `broker.mjs` shows the
  reviewer `scrub(trunc(after))`: secrets redacted, body cut at 4000 chars. Writing that
  back would bake `[redacted]` into source or silently delete a long file's tail. An edit
  is REFUSED unless the reviewed text is a faithful rendering of the workdir file.
- **Found by the wiring test, not the unit tests:** the unified-diff round trip drops
  exactly one trailing newline (a terminator is not a line), so a byte-exact gate refused
  EVERY legitimate edit. Gate now allows that one byte and `restoreTerminator()` puts it
  back on write. This is why the wire-level tests exist.

**Task 4.3 — wiring.** `deliveries.decide(id, "approve", { edits })` stages BEFORE the
status flip, so a refused edit leaves the row PENDING and nothing applied. `server.mjs`
passes `body.edits` on the EXISTING `/inbox/:id/approve` route — no new route, no new
authorization surface (already `routeNeedsApprover`). `workdirFor` is derived from the
same `isEngineTaskKey` predicate as `brokerFor`, extracted so the two can never disagree
(staging into one isolation dir while applying from another would silently drop the edit).
The on-disk patch record is REWRITTEN so the audit trail shows what was approved.

**Task 4.2 — `src/components/inbox/DiffEditor.tsx`** (NEW). Per-file Edit/Done/Revert, an
announced `edited` flag (`role="status"` — not colour alone), one editor open at a time,
approve button labelled `Approve N edits → apply`. Controlled `<textarea>`: React sets the
value as a DOM property, so the browser never parses it as markup. Editable only on a
PENDING delivery; a decided one still renders the original read-only `DiffBlock`.

**Wire-level proof: `agent-runtime/test/inbox-edit-http.test.mjs` (NEW, 11 tests, all
green) — every assertion reads the REPO FILE ON DISK, not the response body:**
- an edited approve lands the OPERATOR's bytes, not the agent's
- the on-disk patch record reflects what was approved
- a plain approve is byte-for-byte unchanged by Phase 4
- out-of-delivery path / traversal / empty / malformed → refused, **row stays pending, repo untouched**
- edits refused on reject + request-changes, and on an already-decided delivery
- an edited approve still 401s without a token and still 403s on an evil `Host`

**STILL OPEN for Phase 4:** live browser proof, `hallmark`/`impeccable`/`taste-skill`
passes on the editor, `security-review`, `code-reviewer`, Fable verification, visual
baseline review for the ReviewPane change.

---

## Phase 3 log — bulk decisions — DONE

**Shipped:** `selectionModel.ts` (pure, 9 tests) · `DeliveryBulkBar.tsx` ·
`DeliveryCard` bulk checkbox (`role=checkbox`, keyboard, modifier-click) ·
`InboxPanel` selection wiring with `prune()` so a stale selection cannot be acted on.

**Skills run (per CLAUDE.md routing):** `hallmark audit` → `impeccable audit` →
`code-reviewer` agent → live browser verification.

### hallmark audit findings — FIXED
- **8-state rule (component-scope):** `.helm-bulkbox` shipped with only 2 of 8 states.
  No hover, no `:focus-visible`, no `:active`, no disabled — a keyboard user got no
  focus ring on a control that mutates a bulk selection. All 8 now present, motion
  behind `prefers-reduced-motion`.
- **Gate 59 (no two-line clickable text):** 4 buttons wrapped at 320px. Fixed with
  `white-space: nowrap` on `.helm-btn`; the flex container wraps whole buttons instead.
- **Gate 36 (no horizontal scroll):** PASS at 320px (`scrollWidth === innerWidth`).

### impeccable audit findings — FIXED
- Absolute bans: side-stripe borders 0 · gradient text 0 · glassmorphism 0 · nested
  cards 0.
- **Em dash in user-facing copy** (bulk bar helper text) → replaced with a semicolon.
  Register: **product**. No PRODUCT.md/DESIGN.md in repo (nudged once, proceeded).

### code-reviewer findings — ALL FIXED (verdict was BLOCK)
| Sev | Finding | Fix |
|---|---|---|
| **CRITICAL** | `/inbox/bulk-decide` was NOT in `routeNeedsApprover`. Its regex requires an `:id` segment, so the bulk path never matched — a **viewer-role session could bulk-approve** (incl. high-risk via `confirmHighRisk`) while correctly blocked from the single-item route. Real authorization bypass. | Registered the exact path in `routeNeedsApprover` |
| **HIGH** | `RiskBand` is `"low"｜"medium"｜"high"｜null`; `"unrated"` is only a DISPLAY label (`riskLabel`), never a stored band. The gate compared `band !== "unrated"`, so **every real delivery (null band) was treated as high** and bulk-approve silently 400'd. | `null`/`undefined` → skip; unknown STRING bands still fail closed. Verified across all 6 band cases. |
| **HIGH** | `runBulk` swallowed `r.error` — a refused batch flashed "Working…" and returned to idle with no explanation. | Error surfaced inline in the bulk bar with `role="alert"` |
| **MEDIUM** | Route had **ZERO tests** | +8 route tests (cap, verbs, auth, Host, approver registration, null-band, per-item failure) |

Clustering + selection logic survived adversarial review unbroken.

---

## Phase 2 log — failure clustering — DONE

**Backend**
- `agent-runtime/failure-signature.mjs` (NEW, pure) — `failureSignature()` +
  `groupBySignature()`. Only `kind:"failure"` AND `status:"pending"` matching the
  runtime's `<agent> is stuck — <reason>` shape may collapse. Fails closed on anything
  else, so a real code/design delivery can never be merged into someone else's decision.
- `server.mjs` — `POST /inbox/bulk-decide {ids[], decision, feedback?, confirmHighRisk?}`.
  NOT a second decision path: loops the SAME `deliveries.decide()`, so policy/broker/audit
  guards all still apply per item. Adds a 200-id cap and a high-risk gate.

**Frontend**
- `src/lib/clusterModel.ts` (NEW) + `ClusterCard.tsx` (NEW) + `InboxPanel` wiring
- `bulkDecide()` in `inboxClient.ts`
- Collapse is announced ("N duplicate failures collapsed into M clusters") — silent
  collapsing would be worse than none.

**Tests added: +22** (11 runtime signature, 11 client model)

**LIVE PROOF**
- Inbox went from a wall of duplicates to **45 duplicate failures collapsed into 12
  clusters**, incl. `coo-station is stuck — spawn ×18`
- "Dismiss all 2" → clusters 2→1, inbox badge 18→16, server rejected count 27→32
- Security gate proven: bulk-approve of 2 high-risk pending ids WITHOUT
  `confirmHighRisk` → refused, `decided: 0`, pending unchanged at 19

### TWO REAL BUGS caught by live verification (not by tests)
1. **`risk` is an OBJECT** `{score, band, reasons}`, not a string. The high-risk gate
   compared `d.risk === "high"` and therefore NEVER FIRED — the whole protection was
   dead. Now reads `.band` and FAILS CLOSED (anything not positively low/medium/unrated
   counts as high).
2. **Decided deliveries were being clustered** → a "Dismiss all 4" button on four
   already-rejected rows; the runtime refused each with "already decided". Now
   pending-only, mirrored in BOTH the client and runtime signature fns, regression-tested
   on both sides.

---

## Phase 1 log — edit-account — DONE (pending Fable verification)

**Backend**
- `credentials.mjs` → `updateAccount(id, patch)`. Metadata-only by default; `secret`
  re-seals only when non-empty. `providerType` immutable (capability tier + sealed secret
  were derived from it). Secret write happens LAST so a validation throw cannot leave a
  re-sealed secret behind.
- `routes.mjs` → `PATCH /runtime/accounts/:id`, same auth+Host gate, same
  `assertSafeHttpUrl` SSRF guard as create (an edit must not be a way around the guard).
- `server.mjs` → PATCH added to the accounts method allowlist (**was 405'd**) and body is
  now read for PATCH. This was a real wiring gap: route existed but was unreachable.
- `server.mjs:1007` message now names a real affordance ("open Accounts, click the pencil").

**Frontend**
- `accounts.ts` → `AccountPatch` type + `updateAccount()`. Empty-string fields are stripped
  so a blank "replace token" box can never wipe a working credential.
- `AccountsPage.tsx` → `EditAccountForm` + pencil button per row, one row open at a time.

**Tests added: +20** (8 store, 6 HTTP, 6 client)

**LIVE WIRING PROOF** (runtime :3006, UI :3004):
- UI: pencil → form opens → change model → Save → form closes, row updates, "Account updated."
- Server: `GET /runtime/accounts` shows the new model — it persisted
- Disk: `accounts.json` shows the new model, `'sk-' in raw` = **False** (no plaintext secret)
- Secret survived: `hasSecret: true` after a metadata-only edit
- SSRF: `PATCH baseUrl=http://169.254.169.254/...` → **400**
- Secret never echoed in the PATCH response
- Original model restored afterwards (user state left as found)

**ENVIRONMENT GOTCHA (cost ~20 min, do not repeat):** `node agent-runtime/server.mjs` does
NOT load `agent-runtime/.env`. Vite DOES (via loadEnv), so its proxy targets
`RUNTIME_PORT=3006`. Starting the runtime bare puts it on 3005 → proxy 500s. Vite also
reads `RUNTIME_TOKEN_DIR` for `/api/runtime-token`; a mismatch → 401.
**Always start both with `RUNTIME_PORT=3006` and the same `RUNTIME_TOKEN_DIR`.**

---

## Phase 0 log

### Task 0.1 — baseline lock — **DONE**
All seven gates run and green; counts recorded above.

### Task 0.2 — determinism spike — **GO** ✅
4/4 pass, stable across 4 consecutive runs, at `maxDiffPixels: 0`, including across a full
reload AND a cold browser context. **Phase 9 has a safety net.**

KEY FINDING — byte-compare was the WRONG instrument. First attempt asserted
`Buffer.compare(a,b)===0` and failed across reloads. Diagnosis: DOM was IDENTICAL (same
innerText, same innerHTML length, no differing line) while the PNG differed by exactly
1 byte (99083 vs 99084) — PNG encoder / GPU compositing variance, not app
nondeterminism. Switched to Playwright's pixel comparator. Still strict (0 differing
pixels), just measured correctly.

### Task 0.3 — baseline matrix — DONE
72 matrix references (12 pages x 3 viewports x 2 themes) + 2 determinism = **74 PNGs**.
`npm run test:visual` / `npm run test:visual:update` added.

THREE REAL OBSTACLES found and fixed (all documented in-file):
1. **Onboarding modal** (`fixed inset-0 z-[90]`, key `ma.onboarded.v1`) covers everything
   on a fresh browser profile. Without seeding it, all 72 baselines would be pictures of
   a modal and every nav click is intercepted. Harness now seeds the key.
2. **Sidebar is desktop-only** (`.bos-side` hidden below 1024px). A 320/768 capture cannot
   navigate. Matrix navigates at 1440 first, then resizes.
3. **Inbox is not a `.bos-item`** — it is `.bos-inbox-pin`, rendered separately with the
   pending badge. Selector matches both.

---

## FABLE 5 VERIFICATION — Phase 0 + 1 (score 3/10, findings actioned)

Fable REFUTED the "28/28 stable" claim, scoring 26 / 9 / 2 / 2 across four runs.
**Its structural criticism is correct and is the top open risk.**

### Fixed in response (all verified)
| Finding | Sev | Status |
|---|---|---|
| `updateAccount` partial mutation on a validation throw — half-applied patch persisted to disk (PoC'd) | **HIGH** | **FIXED** — rewritten validate-everything-then-apply. PoC now shows `GOOD` in memory and on disk. 6 regression tests added. |
| `updateAccount` bypassed addAccount's rules — model on a `claude` acct, label 128 vs LABEL_MAX 80, baseUrl on non-needsBaseUrl types | **MED** | **FIXED** — now enforces LABEL_MAX / MODEL_MAX / MODEL_TYPES / preset.needsBaseUrl identically |
| "fresh browser context" determinism test was FAKE — asserted PNG byte-length within 2048 while its comment claimed pixel comparison | **MED** | **FIXED** — runs the real comparator at maxDiffPixels 0 |
| accounts baselines stale vs HEAD (captured before the Pencil button) | **HIGH** | **FIXED** — all 72 reseeded from HEAD |

### NOT fixed — the real open risk (blocks phases 8-9)
**The visual harness has no data-plane fixtures.** Captures reflect whatever the live
`:3006` runtime, its SQLite state and its auth token happen to be. Re-measured with both
servers up and aligned: **28/28, twice, plus determinism 4/4 three times.** Fable's
26/9/2/2 was measured while its dev server had died and `/inbox` was 401ing — so the
NUMBERS reflect a broken environment, but the DIAGNOSIS is right: when the environment
breaks, this harness silently bakes garbage into baselines instead of failing loudly.

**Required before Phase 9 opens:** `page.route()` mocks (or a seeded fake runtime) for
`/api/state.json`, `/inbox*`, `/runtime*` so captures are hermetic. Until then the net is
usable for same-session before/after diffing, NOT as a portable CI gate.

Also open from Fable: frozen client clock (`FIXED` = 2026-08-12T02:00Z, the code comment
says 08-10T12:40 — comment wrong) vs live server timestamps, so relative-time bugs are
invisible; `el.click()` would not catch a new pointer-events overlay that blocks real
users while changing zero pixels; `test/visual/` is untracked (resolves at commit).

---

## Open threads

1. **Task 8.0 — the 16→9 type-scale mapping does not exist yet.** It is a taste decision,
   not a measurement. Must be written to `docs/superpowers/specs/type-scale.md` before
   Phase 9 opens.
2. **Autonomy limit (disclosed to user):** an agent cannot self-invoke a new context
   window. When context fills, the session ends. This file is the resume mechanism.
   Unattended overnight running would require the `/loop` skill or a cron routine — not
   authorized, not assumed.
