# Agent Factory — START prompt (paste into a fresh context window)

Copy everything in the block below into a new Claude Code session to execute the
Agent Factory plan (`docs/ceo/agent-factory-plan.md`) end-to-end.

---

```
/caveman

PROJECT: MissionAlpha agent-swarm command tower at /Users/RohitAnandeshi/Downloads/WaahyuFOLDER/MissonAlpha (separate from the WaahyuPython cwd). It's a React19/Vite/TS dashboard (port 3004) + a separate Node "agent-runtime" service (port 3005) that drives the local `claude` CLI (subscription auth, no API key). GitHub: https://github.com/Rohit12651/MissionAlpha (push with git -c user.name="Rohit A" -c user.email="rohita7333@gmail.com"; force-with-lease ok; histories already aligned).

STEP 0 — LOAD CONTEXT FIRST (mandatory, do before anything):
1. Read /Users/RohitAnandeshi/Downloads/WaahyuFOLDER/MissonAlpha/memory/SESSION_MEMORY.md — full state of everything built (Cycle 1, session history, Boss Console, dispatch bridge, CLI subscription backend, F2a read tools, F2b write+sandbox+broker, auth token, autonomous loop). Understand the existing architecture before extending it.
2. Read /Users/RohitAnandeshi/Downloads/WaahyuFOLDER/MissonAlpha/docs/ceo/agent-factory-plan.md — THE PLAN you are executing. Follow it phase by phase.
3. Skim agent-runtime/server.mjs, src/components/BossConsole.tsx, src/components/AgentChat.tsx, .claude/agents/ (the 16 agent defs + PROTOCOL.md), scripts/ to ground yourself.

TASK: Build "Agent Factory" end-to-end per agent-factory-plan.md. BOSS spawns AI-authored agents (Path B: BOSS describes need → Claude `agent-creator` writes full spec → BOSS reviews → agent persisted + live on board + chat/dispatch/run-able). Agents can hold REAL external-posting skills (start with Twitter/X + LinkedIn). Persistent. Same runtime/subscription + F2b sandbox.

EXECUTE ALL 9 PHASES (P0 ceo gate → P1 architect ADRs → P2 ux/design → P3 registry ∥ P4 agent-creator → P5 integrations+credential broker → P6 sr-security gate → P7 UI build → P8 QA → P9 memory). Each phase: do the work, hit the exit gate, test before moving on. Don't skip. Finish AND test in one go.

USE THE REQUIRED AGENTS (NO NEGOTIATION) — spawn them via the Agent tool for their owned work per the plan's roster: architect (ADRs), principal-ux-design (UX), senior-web-1/2 (UI), senior-backend-1/2 (registry + agent-creator + posting), senior-security-engineer (cred/post threat model — HARD gate, review every security-sensitive piece), senior-cicd-engineer (secrets/integration config), senior-qa (e2e + adversarial), memory-updater (persist). ceo frames strategy.

DESIGN — modern, mandatory: apply impeccable (craft+audit), emil-design-eng (motion: modal/gallery/spec-card/approval-gate), hallmark/taste-skill (anti-slop structure), gstack design-review (critique pass), ui-designer + frontend-developer agents for components. OKLCH tokens only, a11y, reduced-motion, mobile 320-768. 4 surfaces: create-agent flow, agent gallery, skill catalog, per-post approval modal.

HARD SECURITY (non-negotiable, sr-security gates):
- Claude NEVER sees/enters credentials/API keys/passwords. BOSS connects accounts via OAuth in his own browser (or a secure field straight to the broker). Broker stores encrypted; runtime/agents reference connId only, never raw secret. Never in Claude context/logs/SSE stream/agent read-scope/child env.
- Every real external post: dry-run preview → BOSS confirm (F3-style PermissionGate) → execute → audit. NO auto-post. Rate-limit + per-account cap.
- Only BOSS triggers agent creation. Validate every spec (safe charset, catalog-constrained skills/tools, no exec escalation). Prompt-injection must not post or exfiltrate creds.
- Reuse existing guards: runtime auth token (tmp file, /api/runtime-token), host/origin gates, sandbox+broker, applyAllowed path validation, egress scrub.

INTEGRATIONS: real posting via composio MCP skills (composio-twitter-automation, composio-linkedin-automation) — needs Composio API key (run /connect-apps:setup or ask BOSS). At P1, confirm platforms + composio-vs-direct-API with BOSS, then proceed. Default: Twitter/X + LinkedIn via composio.

RUN/TEST the stack:
- runtime: cd agent-runtime && RUNTIME_TOOLS=write RUNTIME_SANDBOX_ROOT=/tmp/ma-sb npm start  (port 3005)
- dashboard: npm run dev  (port 3004)
- live board: TICK_SECONDS=6 python3 scripts/sim_swarm.py
- browser test via Python Playwright in a venv (/tmp/pwenv may exist; or recreate: python3 -m venv /tmp/pwenv && /tmp/pwenv/bin/pip install playwright && /tmp/pwenv/bin/python -m playwright install chromium). Test full flows in headless chromium, screenshot, check console errors.
- Token for /factory + /runtime calls: cat "$(node -e 'console.log(require("os").tmpdir())')/missionalpha-runtime/.runtime-token", send as x-runtime-token header.

GIT HYGIENE: .gitignore already excludes node_modules, .env(s), .runtime-token, agent-status runtime data (history/SYNC_LOG/HEARTBEAT/INBOX/commands/state.json/*.md status), .vite/, agent-runtime/sandboxes. Keep secrets out of commits. Stop sim/scheduler before committing (they churn ignored files). Verify staged size sane + no secrets before commit.

DELIVERABLES: working Agent Factory (create flow + gallery + skill catalog + post-approval), all 9 phases done + tested (curl + browser + adversarial), sr-security sign-off, tsc + lint clean, memory updated (SESSION_MEMORY.md), committed + pushed to GitHub. Update memory at start AND end (mandatory).

Caveman mode all the way to cut tokens. Code/commits/security writeups = normal prose. Begin with Step 0 (read memory + plan), then P0.
```

---

## Notes
- Default platforms baked in: **Twitter/X + LinkedIn via composio**. New session still confirms at P1.
- Playwright venv `/tmp/pwenv` may not survive across sessions — prompt includes recreate command.
- The plan (`agent-factory-plan.md`) is the source of truth; this prompt just bootstraps a fresh context to execute it.
