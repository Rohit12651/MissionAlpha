# MissonAlpha status

What is done and what is next. Facts about the code live in MEMORY.md; rules live in
CLAUDE.md. Newest entry first.

## BOSS decisions round 2 (2026-10-02, after Landing + Setup delivery)

- [x] 1 agent-runtime approval provenance — 2026-10-02 · approved in-session: the AskUserQuestion "The real fix is in agent-runtime, which is outside the agreed scope. How should I handle it?" was answered "Allow agent-runtime fix (Recommended)". Mine under agent-runtime/: `workspace.mjs` +5/−1 (leading-`~` expansion in `validateWorkspace`) and 4 tests appended to `test/workspace.test.mjs`. The other 89 changed files under agent-runtime/ were uncommitted BEFORE this session (`git diff --stat`), not mine
- [x] 2 parity is a gate — 2026-10-02 · `npm run test:parity`; `test/visual/parity-gate.mjs` (PARITY_ALLOWLIST = the 12 escalated frames, each with a reason) · unit BAD/GOOD/UNRELATED/STALE 5/5 (RED: module missing → GREEN) · proven to fire live: drop setup-4-mobile-top → "NO-MATCH outside the reviewed allowlist" EXIT 1; allowlist matching setup-1-mobile-top → "now MATCHes — remove it" EXIT 1; restored md5-identical · silent on honest code: full run 77 passed EXIT 0, results.md 116/128
- [x] 3 lazy-load Landing + Setup — 2026-10-02 · main chunk 213.13 → 206.93 kB gz (−6.20); Landing 4.22 kB, Setup 3.30 kB load on demand; Setup mounts from its first open on (focus restore kept) · first-run E2E 38/38 EXIT 0
- [x] 4 the 3 LOW findings, test-first — 2026-10-02 · timer: `withTimeout` in firstRun.ts, unit RED (no export) → GREEN 17/17, mutant without clearTimeout RED ("the deadline timer is still pending"), restored md5-identical · Detect again: E2E RED at the rows assertion (rows vanished while asking) → separate `detecting` flag, last result kept on failure → GREEN · Replay focus: 2 E2E RED (focus on <body>; focus on hidden Next) → ROOT CAUSE `CommandPalette` never returned focus on close (every ⌘K command lost it) → palette restores focus before the command runs; App keeps Setup's return target from the first open → GREEN · first-run E2E 38/38 exit 0
- [x] 5 dead code deleted after zero-importer greps — 2026-10-02 · ViewToggle COMPONENT removed (its file keeps `BoardView`/`ShellView`, imported by 4 files) · `.bos-road-*` + the 2 section comments they orphaned · `outputsClient.whenLabel` + `pad2` (its only user; every `whenLabel` import resolves to storiesClient) · `soonestDue` + its 2 test assertions · all gates: lint 0 · typecheck 0 · unit 654/654 · runtime 2862/2862 · electron 14/14 · build ✓ · parity 77 passed · first-run E2E 38/38
- [x] 6 runtime token cached forever after a failure — 2026-10-02 · loop `node --experimental-strip-types --test src/lib/__tests__/runtimeToken.test.ts` RED ×2 on the symptom (2nd call still "") · ROOT CAUSE: `runtimeToken()` caches the promise, and both paths turn a failure into a resolved "" (`.catch(() => "")`, and non-ok → ""), which is then served forever; callers do NOT keep copies (grep: per-call locals) · fix: share the in-flight attempt, drop the cache when it resolves "" · GREEN 4/4 ×3 runs (dev fetch down, HTTP 500, packaged bridge reject, good token cached once) · NOT covered: a cached GOOD token that the runtime later rotates (401) — separate issue
- [x] 7 setup-3/4 mobile handoff → review agent's queue — 2026-10-02 · no queue existed and no review-agent session is reachable from here, so the queue is a file: `docs/superpowers/plans/2026-10-02-review-agent-queue.md` (Inbox, Missions, Setup 3+4 with the full prompt). The review agent must be pointed at it
- [x] 8 commits grouped by concern, each staged + shown + approved — 2026-10-02 · `0fb6f13` runtime ~ · `13c4cb3` token retry · `4272bc8` parity harness + gate · `d5492e0` sketchbook shell + 10 tabs · `0cc87ee` Landing + Setup · this docs commit. Not pushed. Clean-checkout HEAD: tsc 0, build 0, unit 614/615 (JC-6 waits on uncommitted A–E runtime)

## Landing + Setup (Phase G follow-on, approved 2026-10-02)

Approach A: first-run view state in `App`; `<Landing/>` then `<Setup/>` over the cockpit. Spec + plan to follow.

- [x] 1 Spec — 2026-10-02 · `docs/superpowers/specs/2026-10-02-landing-setup-spec.md` (32 ACs, test map, mask list; self-review found 3 gaps, all fixed)
- [x] 2 Architecture — 2026-10-02 · spec §12: 5 ADRs (LS1 App view state, LS2 pure `firstRun.ts`, LS3 calls + failure shapes, LS4 delete tour, LS5 unmount globe) + 8 named modules
- [x] 3 Plan — 2026-10-02 · `docs/superpowers/plans/2026-10-02-landing-setup-plan.md` (14 tasks, each with a done condition; self-review found 4 gaps, all fixed)
- [x] 4 Design/UI/UX — 2026-10-02 · notes in the plan ("Phase 4 design notes"); a11y audit 0 critical / 0 major, 2 minor 4.1.2 fixed test-first (first-run E2E 27/27 exit 0); 2 mockup-defined minors logged
- [x] 5 Develop — 2026-10-02 · T1–T14 all closed (below)
  - [x] T1 pure rules `firstRun.ts` — 2026-10-02 · `src/lib/__tests__/firstRun.test.ts` RED (module missing) → GREEN 14/14; 3 mutations red (accountPlan, readyLines restart, upgrade envPinned); tsc 0, eslint 0
  - [x] T2 unmount PulseGlobe — 2026-10-02 · `first-run.spec.mjs` AC-L7 RED (Received 1) → GREEN (exit 0); tsc 0, eslint 0
  - [x] T3 Landing top — 2026-10-02 · AC-1 RED (no `h1#hero-h`) → GREEN; visual check vs mockup: only the page paper differed → wrapper paints `var(--paper)`
  - [x] T4 HeroFeed — 2026-10-02 · AC-L2/L4/L5 + AC-L3 RED (0 messages) → GREEN 4/4; AC-L3's first green attempt failed on the PROBE (fired before the stream opened), fixed in the test
  - [x] T5 Landing end — 2026-10-02 · RED (0 recipes) → GREEN; first-run E2E 5/5 exit 0; footer honesty: "Runs on this machine"
  - [x] T6 App first-run view state — 2026-10-02 · AC-3/AC-5 RED → GREEN 9/9 (exit 0); AC-2/AC-4 passed from T3, so mutation-proven (ignore flag → AC-2 red; unreachable-as-onboarded → AC-4 red)
  - [x] T7 Setup shell + Welcome — 2026-10-02 · RED (no dialog) → first green attempt failed: the OLD tour also auto-opened (same flag) and took focus — snapshot showed 2 dialogs; old tour no longer auto-opens (ADR-LS4) → GREEN 10/10
  - [x] T8 Engines — 2026-10-02 · 2 RED (still on Welcome) → no-engine case caught a REAL defect: Detect unmounted while focused, focus fell to <body>, Esc (bound to the dialog) never fired — a no-engine user was trapped. Fix: document-level Esc + focus kept inside → GREEN 12/12
  - [x] T9 Account — 2026-10-02 · 5 RED (no Account step) → GREEN 5/5; test premise fixed (asserted a not-yet-built step 4; advance check moved to T10); mutation (plan always "create") turns activate + confirm red; a first, non-compiling mutant was discarded as invalid evidence
  - [x] T10 Project — 2026-10-02 · 3 RED (no Project step) → GREEN; full first-run E2E 20/20 exit 0; restartRequired: step stays and says "Saved. Takes effect after a runtime restart."
  - [x] T11 Ready + finish — 2026-10-02 · 2 RED (no Ready step) → first green run failed on TEST defects (status checked before the POST returned; an override registered before the fixtures lost to them) → fixed → GREEN 2/2
  - [x] T12 ⌘K entries + delete old tour — 2026-10-02 · 2 RED → GREEN; zero-importer grep (only a harness comment, updated); `Onboarding.tsx` deleted; first-run E2E 24/24 exit 0
  - [x] T13 Parity screens + mask probe — 2026-10-02 · landing 8/8 MATCH (cycle 1; mask probe 1:1); setup 22/24 MATCH after 3 cycles (c2: opaque scrim in both + Back on step 1 leaves setup, TDD red→green; c3: scoped text-rendering — zero effect, reverted); setup-3 mobile + setup-4 mobile ESCALATED
  - [x] T14 full gates + regression — 2026-10-02 · lint 0 · typecheck 0 · unit 643/643 · runtime 2862/2862 · electron 14/14 · build ✓ (main 213.13 kB gz) · first-run E2E 35/35 · full audit 116/128 (tabs 86/96, Landing 8/8, Setup 22/24), recomputed from `results.md`
- [x] 6 Test — 2026-10-02 · every §8a row has a named test: unit `firstRun.test.ts` 15/15, E2E `first-run.spec.mjs` 34/34, runtime `workspace.test.mjs` 28/28, parity via `tab-audit.spec.mjs` (77 frames)
- [x] 7 Validate — 2026-10-02 · `gsd-validate-phase` State C (not a `.planning/phases` entry; no gsd-sdk) → audited by hand: all 32 ACs map to a passing test or audit frame; AC-S1 PARTIAL (setup-3/4 mobile escalated). design-critique: no critical; 3 mockup-defined minors logged
- [x] 8 Verify — 2026-10-02 · code review 1 HIGH + 4 MED + 5 LOW, security 0 CRIT/HIGH + 2 MED → all HIGH/MED fixed test-first (8 RED→GREEN E2E + 3 runtime); final re-review 0 CRIT/HIGH, its MEDIUM (focus after failed detect) fixed RED→GREEN; 3 LOWs open (listed in the Log entry below). Gates + audit as T14; setup frames re-run after the last fix: 22/24 unchanged

## Now

**2026-10-15 — Devin-parity Phase 1 in progress; everything committed and pushed (HEAD `7d888fb`, tag `backup/pre-r1-2026-10-15`).**
Goal: MissionAlpha works like Devin (ticket → own env → code → runs its own tests → PR → review → human merge).
Plan: `docs/plans/2026-10-14-devin-loop-phase1.md` (Phase 1) and `docs/plans/2026-10-15-devin-parity-roadmap.md`
(Phases 1–3, tickets P2-1..8, P3-1..5). UI mockup: `docs/mockups/missionalpha-devin-phases.html`.
Phase 1 done so far: tree landed and pushed; worker Bash narrowed to an allowlist; test jail defaults to node:24-alpine;
ship gate names tasks where no tests ran. NOT done: R1–R6 (below), AI planner as default, electron dev build verified
live, and no real PR has ever been opened (C33). CI on `7d888fb` (run 38783915509) still running at time of writing;
the previous run on this branch was cancelled by a newer push (frontend job passed, runtime suite cancelled).

## Next

Order fixed by the user 2026-10-15: wait for green CI, then R1. No new features until Phase 1 exit gate.
- [ ] CI green on `7d888fb` (run 38783915509) — proof: `gh run view` conclusion success
- [ ] R1 Start-job action → typed Job endpoint → accepted Job ID (F01) — proof: brief → one Job ID → board row; a question creates no job; viewer refused
- [ ] R2 accepted/refused enqueue + awaited dispatch (F02, F03) — proof: injected backlog-full leaves no phantom `queued` row
- [ ] R3 planner/worker mode + per-role readiness visible; AI mode default for real runs (F06, F07, F12)
- [ ] R4 failed commit blocks dependents (F04) — proof: injected commit failure, dependent never starts
- [ ] R5 combined-branch acceptance gate (F05) — proof: green alone, red combined → no shippable approval
- [ ] R6 private test repo + 10 graded tickets + single-worker baseline → `docs/plans/phase1-scorecard.md`
- [ ] Phase 1 exit: ≥6/10 PR + green CI, ≥4/10 mergeable as-is, zero silent failures
- [ ] Known flake: `engine.test.mjs` "self-heal … exhausts maxAttempts" (3 s wall-clock wait, 3.9 s under load) — fix or widen
- [ ] Carried over: live `agent-runtime/engine-store/` test-planted tasks + old `ma/*` branches (yours to prune); step 19 server.mjs split (optional)

## Log

### 2026-10-15 — Devin study → parity plan; Phase 1 hardening pushed; backup tagged
- Research: `docs/research/devin-teardown.md` (incl. §9b logged-in walkthrough, read-only, nothing changed in the account).
  Working study mockup `docs/mockups/devin-study-mockup.html` (sessions board, per-PR split diffs, automation editor).
- Architecture review PDF (F01–F16) read in full; F01–F04 confirmed in code (`App.tsx:162` boss vs `server.mjs` ash;
  `ChatPane.tsx:494-527` fire-and-forget; `manager.mjs:494-495` null-ID queued; `manager.mjs:990-1022` commit failure only logged).
- User decisions D1–D7 recorded in the Phase 1 plan (prove one real PR; new private test repo; worker shell allowlist only;
  explicit Start job, chat advisory; delivered = PR open + CI green).
- Commits pushed: `3a89806..70da1d7` (10, incl. `abbad37` worker Bash allowlist, `4389fb9` node:24 jail, `70da1d7` unverified
  tasks on ship gate), then `1dda917` roadmap + mockup, `025297a` session logs, `7d888fb` ignore `.gstack/`.
- Evidence: clean checkout of `68ced87` runtime 2861/2862 (the 1 = image bug fixed by `4389fb9`, then 35/35 jail tests);
  working tree 2865/2866 (the 1 = self-heal timing flake, passes 3/3 alone); seat + manager-review suites 64/64.
- Phases mockup checked in browser: all interactions work, no console errors, no horizontal overflow at 375 px for any view/phase.
- Backup: tag `backup/pre-r1-2026-10-15` → `025297a` on origin.
- Missing: CI result for `7d888fb`; R1–R6 not started; Phase 2/3 tickets have no step-level TDD plans yet (written per ticket at start).

### 2026-10-02 — "The runtime did not answer" on every page: root cause found, fix awaiting approval

- Cause: under `npm run electron:dev`, Electron's main process starts the runtime with settings it does NOT take from `.env` (port hard-coded 3005 at `electron/main.cjs:17`; token dir from the shell env, else the OS temp dir, `main.cjs:18-19`), while the Vite dev proxy the app calls reads both from `.env` (`RUNTIME_PORT=3006`, `RUNTIME_TOKEN_DIR`). Evidence: runtime pid 94289 (Electron child) listens 127.0.0.1:3005 → `/runtime/health` 200; via Vite 3004 → 500 (`ECONNREFUSED 127.0.0.1:3006`); 3006 → nothing; and on 3005 the token Vite serves gets 401.
- Not a code regression from today: the pin and the picker allow-list predate this work; `.env` is local and gitignored.
- No code changed. Fix is in `electron/` (outside scope) → awaiting BOSS approval.

### 2026-10-02 — commit group 5 landed: `0cc87ee`

- `feat: Landing + Setup first run` — 15 files (12 + JobBoard.tsx, jobsClient.ts + test as build dependencies, BOSS option a; staged count verified; secret scan clean). Not pushed.
- Clean-checkout proof of HEAD (`git worktree`, nothing uncommitted): tsc 0 · vite build 0 · unit 614/615 — **1 FAIL: JC-6** (`jobsClient.test.ts:64`), which asserts the client's job-status list equals the RUNTIME's closed set; the committed client has the A–E `strategy` status, the committed runtime (`agent-runtime/jobs.mjs`, still uncommitted A–E work) does not. Closes when that runtime work is committed.

### 2026-10-02 — commit group 4 landed

- `feat(ui): sketchbook redesign of the shell + 10 tabs` — 62 files (14 A, 42 M, 6 D; staged count verified; secret scan clean). Includes inboxTally + MissionsPage as dependencies (BOSS option a). Excluded: inbox/*, clusterModel (Inbox-only), board/JobBoard (Missions, edited today), workspace/*, SESSION_MEMORY. Does not build alone; App.tsx lands in group 5. Not pushed.

### 2026-10-02 — commit group 3 landed

- `test(visual): parity harness + gate` — 143 files (7 source + 136 baseline PNGs; staged count verified). Not pushed. Gate is green only once groups 4–5 land.

### 2026-10-02 — round-2 gates (all seven, parity included)

- lint 0 (first run caught a missing effect dep in Setup; fixed, re-run 0) · typecheck 0 · unit 654/654 · runtime 2862/2862 · electron 14/14 · build ✓ main 206.93 kB gz · parity 77 passed EXIT 0 (116/128 MATCH, the 12 misses exactly the allowlist) · first-run E2E 38/38.
- Mistake caught: editing src/ during a parity run fails every frame with STALE BUNDLE (the harness hashes src/); that run was discarded and re-run on a frozen tree.

### 2026-10-02 — commit group 2 landed

- `fix(app): retry runtime token after a failure` — 2 files (staged count verified = 2). Not pushed.

### 2026-10-02 — commit group 1 landed: `0fb6f13`

- `fix(runtime): expand ~ in workspace paths` — 2 files (staged count verified = 2 before commit). Stale `.git/index.lock` (0 bytes, Sep 17 19:00, no git process) removed with BOSS approval. Not pushed.

### 2026-10-02 — decisions round 2, item 1: agent-runtime approval confirmed

- Quote and exact change recorded in the tracker above. No code changed by this item.

### 2026-10-02 — Landing + Setup delivered (phases 5–8)

- Review fixes test-first; first-run E2E 35/35, unit 643/643, runtime 2862/2862 (incl. 4 new `~` tests), electron 14/14, lint/typecheck 0, build ✓.
- Full audit 116/128, recomputed from `results.md`. Missing: setup-3/4 mobile (escalated), Inbox/Missions (other agent).
- Open LOWs: Detect-again blanks the previous result while busy; replaying Setup while it is open loses the opener for focus restore; the first-run timeout timer is not cleared (harmless, ≤5 s).

### 2026-10-02 — Landing + Setup approved; tracker opened

- Design approach A approved with 6 amendments (upgrade path, early close keeps flag unset, "pending restart", test list, Engines/Account data deltas, reduced-motion hero).
- Prior state: full tab audit 86/96 MATCH (`results.md`, full run exit 0). Nothing committed.

### 2026-09-27 — tests stop touching live state; job questions answered in the Inbox; CI read-only

- `test/fixtures/isolate-state.mjs` (imported first by all 51 server-booting tests): every durable root →
  per-process temp (state empty, shipped config copied). STATE-ISO-1 derives the root list from the code by AST;
  STATE-ISO-2 pins the import + `...process.env`. Both mutation-proven. Live-state snapshot before/after a full run.
- #4: a job's clarify gate (`<job>-q`) now renders the job's own questions, one field each → `/runtime/jobs/:id/answer`;
  `/inbox/:id/approve` on it is a 409 (it used to plan on no answers and "yes" a CEO deferral). Its hire/escalation/
  blocked gates get approve/reject again, in bulk too. CLARIFY-1…5 (red first: approve returned 200), JOBGATE-1…3,
  JC-ANS-1…3; 2 mutations red.
- `ci.yml`: read-only token, no persisted credentials. YAML parses; not run in CI (needs a push).

### 2026-09-27 — stopping the server no longer orphans seats

- `seat-children.mjs`: every claude/engine CLI child spawned detached via `spawnSeat` (chat, Manager, engine seat,
  factory); SIGTERM/SIGINT → SIGTERM every group, 500 ms grace, SIGKILL, synchronous exit (143/130).
- SHUT-1 (real server, fake CLI with its own subprocess) red first: "the claude child … outlived the server".
  SHUT-2/2b (handler), SHUT-3 (AST: no direct CLI spawn), SHUT-4 (wiring). Self-review found the same class in
  per-task kills (kill-switch, timeouts, STOP signalled only the CLI, orphaning its subprocesses): `killGroup`
  at all 4 sites, SHUT-5/6. 7 mutations, all red.
- Live: real `claude -p` seat (own process group) gone after SIGTERM to the server; its task was re-queued.
- Found: tests share the live engine-store (see Next). Changed, uncommitted.

### 2026-09-27 — decision #1: agent-runtime/ deny-by-default

- `RUNTIME_FLOOR` in `applyAllowed`; allowlist of named runtime files left empty (none qualified).
- RTF-1…7 + 6b/6c: red first, then green; mutations M1/M2 red (a vacuous first deletion test caught and rewritten).
  11 old-design tests updated with reasons. Runtime 2843/2843 · unit 601 · tsc 0 · lint 0 · Playwright 32/1/0.
- Live `/apply` probe refused `agent-runtime/kpis.mjs`. Independent security review: no bypass; HIGH pre-existing CI exec.
- Changed, uncommitted. Numbers in the plan record.

### 2026-09-24 (night) — open MEDIUMs fixed; defer "no" works end to end

- Defer-no, bulk-approve skip, answer-needs-a-gate; floor +25 modules + state + lockfiles/npmrc; nested
  package.json; gh/git env hardening; review diff filter/textconv neutralised.
- Two independent security reviews; all fixed or listed for the BOSS. Runtime 2835/2835 · unit 601 · Playwright 32/1/0.

### 2026-09-24 (night) — CEO prompt approved; live run 10 shipped through the CEO gate

- BOSS approved `strategyPrompt`; header + flag flipped together (REV-8 green, disagreement mutation red).
- Run 10: CEO `proceed` with a real memo → Q&A between two jailed seats → shipped local-branch in 11.5 min.
- Not observed: worker argv, a sandbox denial, the repo-scripts gate. Nothing committed.

### 2026-09-24 (evening) — Step 20: the CEO as job status `strategy`

- intake → strategy → clarify; proceed/defer/kill; migration 26; Strategy column + verdict chip.
- Review fixes: answers can no longer skip the CEO; resume returns a job to where it stopped; prompt approval enforced.
- Gates: runtime 2803/2803 · unit 601/601 · tsc 0 · lint 0 · Playwright 32/1/0 · 36 mutations red.
- Not done: step 19; defer-"no" via Ash; CEO prompt approval (yours). Nothing committed.

### 2026-09-24 (later) — Task 18 jail built and proven live; /cso: 2nd HIGH fixed; 2774/2774

- Option 2 (CLI sandbox via `--settings`), BOSS-approved; station seats stay legacy (BOSS).
- JAIL-1 live: control wrote the file, jailed got `Operation not permitted`.
- /cso: Manager spawned inside a non-git foreign target with project settings — now refused.
- Gates: runtime 2774/2774 · tsc 0 · lint 0 · Playwright 32/1/0. D and E closed. Nothing committed.

### 2026-09-24 — Phase E: floor fails closed (16), target scripts gated (17), security pass; 18 awaits BOSS

- **16 ✅** strict `applyAllowed` on engine broker + both ship ladders; CORE_GUARD widened (+providers/,
  +workdir-guard, +repo-scripts). 7 call sites found, not 4. 15 tests, 21 mutations red.
- **17 ✅** `repo-scripts.mjs` gate: a foreign repo's `scripts/agent-*.sh` never runs unless
  `RUNTIME_ALLOW_REPO_SCRIPTS=1`. 10 tests, 14 mutations red.
- **Security pass:** 1 HIGH fixed (chat spawn loaded a foreign repo's `.claude` hooks — `-p` skips trust);
  3 MED + 1 LOW fixed; 4 MED open (see plan table).
- **Visible change:** engine tasks for agents not on the roster are now refused with a reason.
- Gates: runtime 2762/2763 (1 load flake, isolated 2/3 pass) · tsc 0 · lint 0 ·
  Playwright 26/1/**6 failed** (all shell timeouts, load 179) — rule 8 still open.
- **Not done:** Task 18 (needs BOSS option pick), rule 8, Phase E exit, /cso. Nothing committed.

### 2026-09-23 — Phase D exit met: question → reply turn → answer → resume, live (run 9)

Steps 12, 13 and 15 built; 14 was closed 09-21. What it took, in the order the live runs taught it:

- **Step 12 — the TEAM block.** Every worker on a job task now sees its job, its peers BY ID with
  their skills, and four positive steps: read mail first, answer peers, ask-then-stop, re-read before
  finishing. A job title can neither forge a peer line nor close the block.
- **Step 13 — an answer resumes work, once.** Matched on (job, asker, answerer) — never a message id,
  which a seat never sees. The asker is held `awaiting-answer` (its scope stays reserved) and its live
  attempts cancelled; the answer is fenced into its resumed brief.
- **Run 7** showed the Manager reading a seat's `blocked` BEFORE the question behind it — CC copies were
  re-stamped at route time — and dropping an answer the backend sent before it was asked. Both fixed.
- **Run 8** showed a question sitting addressed to a seat whose turn was over. The runtime now gives
  that seat a `replyOnly` turn; the engine treats an empty reply turn as done and DISCARDS anything it writes.
- **Step 15 — tick lease**, in `tick` itself so every caller is covered.
- **Run 9** closed the loop and shipped.

Evidence: runtime 2737/2737 exit 0, unit 597/597 + JC-TONE-ANS, vendor 54/54, electron 14/14, tsc 0,
lint 0, ~45 mutation legs. Two security holes closed in passing (a seat could block, or freeze and cancel,
a peer's task by naming its ids). The board now shows a task waiting on a peer as in motion, not idle.

NOT done: Playwright rule 8 (31/1/1 under load, re-run pending); C33 (no real PR); the seed roster still
cannot run two seats at once; tick lease and reply-turn slot are per-process.

### 2026-09-21 — Live run 6: two seats at once, and a multi-task job shipped

The prompt gate closed first: the BOSS read the `dependsOn` diff and approved it
(`APPROVED-BY: BOSS 2026-09-21`). Then run 6, on an isolated clone at `/tmp/ma-trial6`.

What it proved, in the runtime's own words: `task-dispatched … inFlight:1` immediately followed
by `task-dispatched … inFlight:2` — one tick, two seats, `repo-edit-engineer` on `src/lib/**`
and `sr-frontend` on `src/components/**`. Mid-run `/runtime/health` caught them genuinely
overlapping: one task `held`, the other `EDITING claimedForMs=37476`. Both committed
(`02fff58`, `b886902`), the job shipped `local-branch`, plan stages run 1, replans 0.

The planner used the new field correctly with no coaxing: both tasks came back `dependsOn: []`.

**Three defects the live run found that 2701 passing tests could not:**

1. **`no active account`** — the first attempt failed both tasks `not-capable`. `accounts.json`
   lives in `RUNTIME_TOKEN_DIR`, so isolating that directory isolated the credential. The
   account record and the `cred.key` that decrypts it have to travel together.
2. **The harness did not carry `RUNTIME_SANDBOX_DISK_BYTES`** from `.env` — the C29 class
   again, caught before the run this time rather than after.
3. **`ship()` erased the tree pin it exists to check.** The gate recorded
   `"tree": "bc3351c…"`; the shipped record read `null`, and `worktree` was gone too — the
   final `setSummary` built a fresh `ship` object instead of spreading the existing one. The
   lost audit line is the small half. `ship()` refuses when `known.tree` disagrees with the
   branch, so once the pin is erased a SECOND ship reads it as undefined, skips the comparison
   entirely, and the branch-moved refusal stops existing. A guard that disarms itself on its
   own success. Fixed and mutation-proven (`SHIP-TREE-KEEP-1`).

Also worth recording: the Manager's own gate body flagged that the unit-test gates auto-skipped
and said so in plain words — *"'PASSED' means 'nothing to run', not 'tests exercised this
code'"*. That is addendum #24's discipline appearing in the product's output rather than in
mine.

NOT proven: no real PR has ever been opened (C33 — `origin` removed from every trial clone on
purpose), and run 6 only parallelised because its roster narrowed `sr-frontend`; the shipped
seed roster still cannot.

### 2026-09-20 — Ready-set dispatch BUILT (C21); the prompt gate is open again

Phase D step 14. Dispatch is no longer one-task-at-a-time: `dispatchNext` walks the task list
and starts every READY task, where ready = predecessors `done` + seat free + seat's enforced
`writeScope` disjoint from everything in flight. The in-flight set grows as the loop dispatches,
so two ready tasks that would collide with *each other* still cannot both go.

Evidence, every suite run to a FILE and the exit code captured on its own line (addendum #24):
**runtime 2701/2701 exit 0**, unit 597/597, vendor 54/54, electron 14/14, tsc 0, lint 0,
visual 32 passed / 1 skipped / 0 failed (the skip is `record.spec.mjs`, the opt-in re-recorder
behind `VISUAL_RECORD=1` — read, not counted).
New tests: READY-SCOPE-1, READY-1, READY-2, READY-3, READY-4, READY-5, READY-6, READY-SEAT-1,
READY-SEAT-2, READY-STORE-1, READY-ROSTER-1 (new file
`agent-runtime/test/manager-ready-set.test.mjs`), plus READY-7 and MP-DEPS-1.

Nine mutation legs. Eight reddened exactly the tests they belong to; **the ninth reddened
nothing, and that was the useful one** — see below.

What the design actually rests on, and why READY-7 runs against a real git repo: `commitTask`
copies each approved path's BODY from the task worktree into the assembly worktree and never
merges. Disjoint tasks therefore commit cleanly in any order; same-path tasks silently revert
each other with no conflict marker. READY-7 asserts both halves — the second half exists so
that if the ladder ever learns to merge, a failing test says so and the rule can be relaxed.

**The mutation that reddened nothing.** The spec named three ready conditions, and the third —
"seat free" — was written as its own branch. Deleting it broke no test anywhere. The reason is
structural: a seat's `writeScope` is the same array whichever of its tasks you ask about, and
`scopesDisjoint` is reflexively false, so the scope rule already refuses a seat its own second
task. The branch was unreachable. It is deleted, and READY-SEAT-1/2 pin the subsumption so that
if `scopesDisjoint` ever stops being reflexively false a test says so. Re-running the scope-check
mutation afterwards now reds six tests including Phase C's own SEQ-3 and SEQ-4 — which is the
proof that the new rule really does carry the old guarantee.

Four things this changed beyond the feature:

- **A new schema column.** `job_tasks.dependsOn` (migration 23), holding ROW IDS. The planner
  writes task NUMBERS and a re-plan REORDERS the rows, so storing numbers would silently
  repoint every dependency at whatever task landed in that position. `setTasks` mints all ids
  first, then resolves numbers (fresh plan) and prior ids (re-plan) against that batch.
  READY-STORE-1 pins it.
- **MP-GATE could not fail, and had been cited as evidence twice.** It tested the WHOLE FILE
  for `APPROVED-BY: BOSS <date>`, and the file keeps every prior approval as history — so a
  line from 2026-09-05 satisfied it while the governing line at the top said `_PENDING BOSS_`.
  It now reads the FIRST line, and carries a BAD/GOOD pair that runs on every CI run.
- **A real flake, caught and fixed.** The first full run came back 2698/2699 with
  `engine.test.mjs` red at FILE level while every test inside it read green.
  `ENG-TRACE-1` (mine, from the C23 work) leaves a never-settling dispatch running; a stray
  watchdog write lands after `afterEach` has deleted the tmpdir, and node:test turns the ENOENT
  into an uncaughtException. Measured rather than waved away: 0/3 in isolation, **1/5 with six
  CPU hogs running** — the shape of the rest of the suite. Fixed by waiting for the store to go
  quiet; **0/8 under that same load** afterwards.
- **The gate is open.** `planPrompt` asks for `dependsOn`; the header reverted to
  `_PENDING BOSS_`. Material in both directions: `validatePlan` refuses a cyclic or
  out-of-range graph, and an OMITTED dependency now lets two seats run concurrently that
  should not — where the loser's work vanishes without a conflict.

NOT done, and named so nobody reads this as more than it is:

- **No live run has dispatched two seats at once.** Every READY test is a seam proof.
- **Against the seed roster this feature is inert.** Measured: `sr-frontend` owns `src/**`,
  `sr-backend` owns `src/lib/**` (inside it), `qa` owns `**/*.test.*` (empty literal prefix, so
  it intersects everything). No pair of seed worker seats can parallelise. The gain is for
  HIRED seats, whose scope `proposedWriteScope` derives narrowly from the task's own steps.
  READY-ROSTER-1 pins that, and goes red the day someone narrows `sr-frontend`.
- **The check is per-JOB.** Two different jobs can still put two seats on one tree — unchanged
  from Phase C, which serialised within a job and not across jobs either.
- **`enqueueGoal` throwing mid-loop** leaves the remaining ready tasks undispatched until the
  stall clock fires. For the first task that is Phase C's behaviour exactly; for the rest it is
  new exposure.
- **MP-GATE is a documentation ratchet, not a runtime interlock.** Nothing in the runtime
  refuses to plan while the approval line is pending. The BOSS's review is the enforcement.

### 2026-09-19 — Ready-set dispatch specced (not built)

Phase C's sequential dispatch is what made task ordering real, and it makes Phase D's
parallelism impossible by construction (C21). Spec written before any code:
`docs/superpowers/specs/2026-09-19-ready-set-dispatch.md`.

The design turns on a fact about the existing ladder rather than a new mechanism: `commitTask`
copies file BODIES per approved path into the assembly worktree and never merges
(`pr.mjs:468,481,486`). So parallel tasks with DISJOINT paths commit cleanly in any order, and
parallel tasks sharing a path silently revert each other with no conflict marker. The rule is
therefore about preventing collision, not resolving it: a task is ready when its predecessors
are done, its seat is free, and its seat's `writeScope` does not intersect any in-flight task's.

Disjointness is checked on `writeScope` — ENFORCED by `applyAllowed`/`matchesWriteScope` — not
on `stepPaths()` predictions, which C28 already proved can miss a file entirely.

**Nothing implemented. No tests written.** Two blockers named in the spec: `job_tasks` has no
dependency column, and adding `dependsOn` to the plan prompt re-opens the APPROVED-BY gate on
`manager-prompts.mjs`, which needs BOSS review before any Phase D live run.

### 2026-09-19 — C23 bounded (cause never found)

Not reproduced in three red-capable loops; every mechanism inspected and coherent. The trap:
`reclaimExpiredLeases` correctly skips a task still in `running`, so when the watchdog fails to
fire nothing can intervene. Added `reapStuck()` — a task held past twice its watchdog is killed
and failed through the normal retry path — plus the missing wake: a job whose single task was
claimed had nothing queued and therefore nothing that could ever notice it was stuck.

Evidence: runtime 2688/2688 fail 0 skipped 0 exit 0 · unit 597/597 · tsc 0 · lint 0.
ENG-REAP-1/2 green; three mutations, each reddening ENG-REAP-1 alone.

**Not verified live**: the stall has not recurred since run 1, so the reaper has never fired in
anger. Two of my own tests were wrong first (non-unref'd timers hung the runner; wall-clock
waiting against a manual clock could never age a task) — both recorded.

### 2026-09-19 — A live job SHIPPED (Phase C exit criterion met)

`job_49d5f0028fb8`, on the throwaway clone. One task, one commit, BOSS-approved ship.

    STATUS: shipped · outcome: local-branch · mode: branch · stage: pr
    branch  ma/job/job_49d5f0028fb8
    commit  9e1c5d7 feat: Document formatRelative under a new Helpers heading in README
    plan stages run: 1     ← C30 verified live (run 4 ran 2 and orphaned its commits)

The artifact is real and correct: the seat read `src/lib/formatRelative.ts` and documented its
actual behaviour — the em-dash sentinel for unparseable timestamps, `just now` under 5 s, and
the `Ns/Nm/Nh/Nd ago` bands.

**Three caveats, all disclosed rather than buried.**
1. `outcome` is `local-branch`, not `pr`. I removed the clone's `origin` so nothing could push
   into the operator's repo. The plan allows "a named refusal the BOSS agrees with"; this is
   that, and it means the PR rung is still unexercised live.
2. The brief was deliberately narrowed to ONE documentation task. Runs 3 and 4 used three tasks
   and did not finish. A multi-task job shipping is still unproven.
3. That gate carried `"tree": null` — DIFF-3's tamper check was inert in production because
   `server.mjs` never forwarded `pr.treeOf` to the Manager. Found by reading the shipped
   summary, fixed, and pinned by DIFF-WIRED-2. Third occurrence of that shape this phase
   (SEAT-12, SEQ-WIRED-1): proven at the unit seam, unwired at the hop the server uses.

Evidence: runtime 2686/2686 fail 0 skipped 0, exit 0 · unit 597/597 · vendor 54/54 ·
electron 14/14 · visual 32 passed 1 skipped 0 failed · tsc 0 · lint 0.

The operator's repo is untouched: HEAD still `85796ae`, no new `ma/job/*` branches (the 3
present are C6, dated 2026-09-05), and the one leaked seat file from run 4 was removed.

### 2026-09-19 — C30: a re-plan no longer becomes a fresh plan

The reorder path preserved task rows and then set the job back to `planned`, so the next tick
re-ran the PLAN stage, called `setTasks` with new rows, and orphaned the commits those rows
owned. Live run 4 showed it exactly: branch carried 2 commits, `summary.ship.commits` recorded
1, task titles matched neither. The reorder now dispatches its own work and goes to `building`;
the PLAN stage refuses outright when the branch already has commits (`resume()` and an approved
gate also set `planned`).

Evidence: runtime 2685/2685 fail 0 skipped 0 (`npm run test:runtime`, exit 0) · unit 597/597 ·
vendor 54/54 · electron 14/14 · tsc 0 · lint 0. C30-1/2/3 green; both legs mutation-proven,
each reddening only its own test.

**Not verified live.** Run 5 is the proof and has not run.

### 2026-09-19 — C29 withdrawn; C31 found

C29 was not a product defect. `.env` already pins the jail to `node:24-alpine`; my live-run
harness never sourced it, so the jail fell back to `node:20-alpine`. My "fix" carved an
exemption into a deliberate `--experimental-*` ban and made things strictly worse on the real
runtime (node 20 rejects the flag rather than ignoring it, so every test failed instead of only
the `.ts` ones). Reverted to a zero diff.

C31: a live run wrote `repo-edit-engineer.md` into this repo's `.claude/agents/` because
`RUNTIME_AGENTS_DIR` was unset — noticed only because the agent appeared in an unrelated
session's agent list. File deleted; nothing committed; harness fixed.

### 2026-09-18 — C28 closed, proven live

Root-level files were invisible to the path miner, so a hire was scoped `src/lib/**` for a
README task and every write died out-of-scope. Fixed with one shared predicate, and
`scopable ⇒ appliable` so a seat can never be scoped to a file the broker refuses.

Evidence: live run 3 hired with `writeScope:["README.md"]` and produced the first real commit
any live run has made — `a75bd43 feat: Document the millisecond helper in README`, 1 file, 4
insertions. Tests STEPPATH-1..4, SCOPE-ROOT-1..3; five mutations, all firing.

### 2026-09-18 — Phase C tasks 7–11 closed; exit NOT met

Single-step tasks, hire correlation + scope check, ship-as-you-go with sequential dispatch,
diff-includes-new-files plus a tree pin, and one shared canonical-write guard across broker /
commitTask / codemod (three confirmed symlink-redirect holes, each reproduced before the fix).

Evidence: runtime 2673/2673 · unit 597/597 · visual 32 passed 1 skipped 0 failed · tsc 0 ·
lint 0. 13 mutations, each reddening only its own test.

**Exit criterion not met**: no live job reached `shipped`. Five defects found by the first live
run that 2673 green tests could not see.

### 2026-09-17 — Phases A and B closed

Phase B: mail identity unforgeable, only the engine closes a task, ship outcome shown on the
board, an approved job cannot vanish. A G7 review found the answers-reset covered 1 of 4 gate
paths. Two regressions were found at the exit gate itself: a ratchet left pointed at an address
the code had moved away from, and three test files dying at import because they cached a stale
copy of the skill catalog.

Also found: both phase gates had been reporting "329/329" from a SUBSET of the runtime suite.
The real figure is ~2685. That is how a red ratchet survived two phase exits.
