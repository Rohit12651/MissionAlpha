# Unified Workspace — START prompt (paste into a fresh context window)

Copy the block below into a new Claude Code session to execute `docs/ceo/workspace-plan.md`
end-to-end (chat-first MissionAlpha + Claude model-tier picker + board-as-secondary).

---

```
/caveman

PROJECT: MissionAlpha agent-swarm command tower at /Users/RohitAnandeshi/Downloads/WaahyuFOLDER/MissonAlpha (separate from the WaahyuPython cwd). React19/Vite/TS dashboard (port 3004) + a separate Node "agent-runtime" service (port 3005) driving the local `claude` CLI (subscription auth, no API key). GitHub: https://github.com/Rohit12651/MissionAlpha (push with git -c user.name="Rohit A" -c user.email="rohita7333@gmail.com"; force-with-lease ok).

STEP 0 — LOAD CONTEXT FIRST (mandatory):
1. Read /Users/RohitAnandeshi/Downloads/WaahyuFOLDER/MissonAlpha/memory/SESSION_MEMORY.md — full state of everything built (Cycle 1 control plane, Cycle 2A session history, Boss Console + dispatch bridge, CLI subscription backend, F2a read tools, F2b write+sandbox+broker, auth token, autonomous loop).
2. Read /Users/RohitAnandeshi/Downloads/WaahyuFOLDER/MissonAlpha/docs/ceo/workspace-plan.md — THE PLAN you execute, phase by phase.
3. Skim agent-runtime/server.mjs, src/App.tsx, src/components/BossConsole.tsx, src/components/AgentChat.tsx, src/components/KanbanBoard.tsx + the board components, .claude/agents/ to ground yourself.

TASK: Build the "Unified Workspace" end-to-end per workspace-plan.md. Turn MissionAlpha into an ALL-IN-ONE, CHAT-FIRST app: chat is the PRIMARY center panel (Claude-Code-style), with a per-chat Claude model-tier picker (Opus/Sonnet/Haiku), task-giving, and the agent-team board demoted to a secondary toggle-able "Team" status panel. No tab switching. Conversation history persists.

BOSS DECISIONS (locked, no negotiation):
- Models = Claude tiers ONLY: opus->claude-opus-4-8, sonnet->claude-sonnet-4-6, haiku->claude-haiku-4-5. Subscription via cli `--model`. Default tier = Sonnet. NO GPT/Gemini.
- Chat = center/main panel. Board = secondary "Team" view (collapsible panel/tab). Board stays fully functional, just demoted — do NOT delete or break any existing feature (Cycle1/2 control plane, dispatch, autonomous loop, F2b, per-agent chat).

EXECUTE ALL PHASES (P0 ceo gate → P1 architect ADRs → P2 ux/design → P3 model-tier plumbing ∥ P4 conversation persistence → P5 chat-first UI reflow → P6 security → P7 QA → P8 memory). Each phase: do the work, hit the exit gate, test before moving on. Finish AND test in one go.

USE THE REQUIRED AGENTS (NO NEGOTIATION) via the Agent tool per the plan roster: architect (ADR-022 model tiers, ADR-023 chat-first shell), principal-ux-design (UX contract), senior-web-1 (App reflow → chat-first shell), senior-web-2 (model picker + board→secondary Team panel + thread switcher), senior-backend-1 (model param on /chat + /run, allowlisted `--model`), senior-backend-2 (thread persistence), senior-security-engineer (model-param injection guard — HARD gate, review every sensitive piece), senior-qa (e2e + adversarial), memory-updater (persist). ceo frames strategy.

DESIGN — modern, mandatory: apply impeccable (craft+audit), emil-design-eng (motion: panel slide/collapse, model-switch, streaming), hallmark/taste-skill (anti-slop; reference Claude Code / Linear / Raycast feel — calm, dense, fast), gstack design-review (critique pass), ui-designer + frontend-developer agents. OKLCH tokens only, a11y, reduced-motion, mobile 320-768 (mobile = chat full-screen, board behind a tab).

HARD CONSTRAINTS:
- Model param STRICT allowlist: only the 3 tier keys (opus/sonnet/haiku) -> mapped to fixed model ids. NEVER interpolate raw user input into the `claude` argv (block flag-injection like model="--dangerously-..."). Reject unknown tier with 400.
- Reuse existing security: runtime auth token (tmp /api/runtime-token), host/origin gates, sandbox+broker, applyAllowed, egress scrub. No regression.
- Conversation persistence to disk (e.g. agent-runtime/threads/<id>.json) must be gitignored.

RUN/TEST the stack:
- runtime: cd agent-runtime && RUNTIME_TOOLS=write RUNTIME_SANDBOX_ROOT=/tmp/ma-sb npm start  (port 3005)
- dashboard: npm run dev  (port 3004)
- live board: TICK_SECONDS=6 python3 scripts/sim_swarm.py
- browser test via Python Playwright headless chromium (venv: python3 -m venv /tmp/pwenv && /tmp/pwenv/bin/pip install playwright && /tmp/pwenv/bin/python -m playwright install chromium). Screenshot, check console errors.
- token for /chat,/run,/changes,/apply: cat "$(node -e 'console.log(require("os").tmpdir())')/missionalpha-runtime/.runtime-token", send as x-runtime-token header.

GIT HYGIENE: .gitignore already excludes node_modules, .env(s), .runtime-token, agent-status runtime data, .vite/, agent-runtime/sandboxes. Add agent-runtime/threads/ to gitignore. Stop sim/scheduler before committing (they churn ignored files). Verify staged size sane + no secrets before commit.

DELIVERABLES: chat-first MissionAlpha (chat center primary, model-tier picker, board as secondary Team panel, persisted history), all phases done + tested (curl + browser + adversarial), sr-security sign-off, tsc + lint clean, memory updated, committed + pushed to GitHub. Update memory at START and END (mandatory).

Caveman all the way to cut tokens. Code/commits/security writeups = normal prose. Begin with Step 0 (read memory + plan), then P0.
```

---

## Notes
- This is SEPARATE from the agent-factory plan (`agent-factory-plan.md` / `agent-factory-START.md`).
  Run whichever first; both are standalone. Sequence suggestion: workspace (chat-first shell) BEFORE
  agent-factory, so new agents land in the better UI — but either order works.
- Default model tier = Sonnet (balanced). Source of truth = `workspace-plan.md`.
