# RESUME PROMPT — paste this into a fresh window

MissionAlpha — AUTONOMY PROGRAM. Execute it. 100%, no partials.

REPO: /Users/RohitAnandeshi/Downloads/WaahyuFOLDER/MissonAlpha
BRANCH: feat/multi-provider-credentials @ 05e8dbd — ~66 files uncommitted.
NO COMMITS until I say so. No exceptions.

=== READ FIRST — do NOT re-derive anything in these ===
1. docs/superpowers/plans/2026-08-11-autonomy-program.md  ← THE PLAN. Principle 0 +
   Phases 0-8, each with its skills, tasks and exit gate.
2. docs/superpowers/plans/EXCELLENCE-HANDOFF.md  ← what already shipped: sections A + B,
   14 defects found and fixed, the Fable verdicts, the Known Gaps table.
3. docs/SESSION_MEMORY.md (tail: "SESSION 2026-08-11b") ← the index of the above.
4. docs/superpowers/specs/type-scale.md ← the DECIDED 9-step ladder (Phase 7 needs it).

=== PRINCIPLE 0 — OUTRANKS EVERYTHING ===
THE OPERATOR CHOOSES THE MODEL. THE APP NEVER CHOOSES FOR THEM.
Any connected LLM must be usable for ANY job — autonomous builds, reviews, planning,
analysis, chat. Not chat-only. Where the app cannot drive a provider, that is an ADAPTER
DEFECT TO FIX, never a capability to stamp on the provider. Any phase that reintroduces a
model-specific path FAILS REVIEW on that ground alone.

=== STATE ===
DONE: excellence program sections A (visual suite) + B (phases 4-7 review debt).
BASELINE — never go below: typecheck 0 · lint 0 · unit 451 · runtime 1337 · vendor 44 ·
electron 9 · visual 30 = 1,871 green.
OPEN AND BLOCKING: the visual net reported 30/30 against baselines that PREDATE a full
surface-colour rewrite. It is blind. That is Phase 0.

=== BOOT BOTH SERVERS FIRST (aligned, or everything 401/500s) ===
export RUNTIME_TOKEN_DIR=/var/folders/l1/ndwcjhx13hzg0bpvdtk5xvkh0000gn/T/missionalpha-runtime-dev
export RUNTIME_PORT=3006
nohup node agent-runtime/server.mjs > /tmp/rt.log 2>&1 & disown   # MUST log "listening :3006"
sleep 3 && nohup npm run dev > /tmp/vite.log 2>&1 & disown        # :3004
RESTART the runtime after ANY agent-runtime/*.mjs edit — a stale process serves old code.
The VISUAL suite runs against the PRODUCTION BUILD on :3007, not the dev server.
Kill any stray `vite preview --port 3007` before a visual run — a stale one served old
pixels and produced a FALSE GREEN this session.

=== ORDER OF WORK — the plan file is authoritative; this is the spine ===
P0 fix the visual net (exit = a DEMONSTRATED RED on a real change, not a green run)
P1 PROVIDER-AGNOSTIC EXECUTOR — tool loop for openai-compat, same tools/guards as the CLI
   path, capability BY PROBE not by table, hard caps, executor chosen per account.
   Exit = a live autonomous file edit on a NON-Claude account.
P2 autonomy that runs unattended (bounded auto-approve, self-heal, watchdog)
P3 reviewer→developer handback that AUTO-DISPATCHES the rework (the heart of it)
P4 the conversation visible (story thread + live bus)
P5 CONNECTORS TAB — a real BOS page where the operator connects N apps via MCP
   (catalog + custom, live probe status, per-agent grant matrix, sealed secrets). GitHub on;
   Jira/Bitbucket via MCP; stops honestly at the OAuth line with the reason shown.
P6 no static data anywhere (per-tab audit + knip/ts-prune, no orphans)
P7 finish the excellence program (8.3 accent→3 roles, 8.4 cockpit dark, 9 the 372-site
   sweep, 10 the gauntlet)
P8 30-minute unattended soak — the proof. A soak that needed a human touch is a FAIL.

=== SKILLS — MANDATORY EVERY PHASE, per ~/.claude/CLAUDE.md ===
sp-executing-plans → sp-test-driven-development (RED before GREEN, always).
Any UI: hallmark → impeccable → taste-skill, IN THAT ORDER. Animation: emil-design-eng.
Security-sensitive: security-review + claude-code-security-review, block on CRITICAL.
Root cause unclear: sp-systematic-debugging. After code: code-reviewer.
Before "done": sp-verification-before-completion. Ship gates: gstack /qa /review /cso.
a11y-architect on every new surface. codeburn after each phase.
Caveman output mode ON. Headroom is already wired at the shell.
Opus builds. FABLE 5 VERIFIES every phase (Agent tool, model "fable") and its verdict is
BINDING — a defect REOPENS the phase. Max 3 iterations, then escalate to me.
Fable runs under the same caveman/headroom discipline.

=== PER-PHASE EXIT — all of these, with output pasted ===
1. All 7 gates + visual suite green, counts >= baseline
2. LIVE WIRING PROOF in the browser, with a curl/GET showing the DB actually changed
3. code-reviewer: all findings >= MEDIUM resolved
4. Fable 5 verification; a defect REOPENS the phase
5. Append the phase log to EXCELLENCE-HANDOFF.md
6. Delivery report with a mandatory "Known Gaps & Risks" section

=== LESSONS — do not relearn these ===
1. Independent review found a real defect in EVERY phase, in already-green work. Two of the
   four Fable verdicts last session reopened phases over fixes written that same session.
2. LIVE-VERIFY. Bugs that passed every unit test died under real UI + real server.
3. A timeout that says nothing causes wrong diagnoses. Instrument, then fix the cause.
4. A control that CANNOT SUCCEED must not be rendered enabled.
5. A test can certify a bug (spendCell did). Fixing the test is sometimes correct.
6. Screenshots: pixel comparator, never byte-compare. And verify the net can SEE a change.
7. The live-proof target must never be the working tree — build a scratch runtime + UI
   (pattern: agent-runtime/test/inbox-edit-http.test.mjs boot()).

RULES: everything wired end-to-end, nothing decorative. No fabricated data. Don't break
existing functionality — re-run the full baseline every phase. Production-grade only;
anything stubbed is labeled STUB. No commits until I say so.

WHEN CONTEXT RUNS LOW: update EXCELLENCE-HANDOFF.md + the plan file, then TELL ME to open a
new window. You cannot open one yourself — do not pretend otherwise.

Start with Phase 0. Go.
