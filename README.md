# MissionAlpha — Agent Swarm Command Tower

Standalone, real-time visual command tower for AI-agent swarms. Watches the
Waahyu 16-agent swarm today; built to watch any swarm that exports the same
`state.json` schema tomorrow (global product path).

> **Independent app.** MissionAlpha does NOT live inside the swarm it watches.
> It reads ONE file — the swarm's exported `state.json` — over a configurable
> path. Swarm code and dashboard code never mix.

## Architecture (the seam)

```
<swarm>/agent-status/state.json   ──(read via WAAHYU_STATE_PATH)──►   MissionAlpha
                                                                        │
                                          DataSource interface  ◄───────┘  the seam
                                          ├─ LocalPollAdapter   (now: poll /api/state.json @2s)
                                          └─ LiveStreamAdapter  (later: SSE/WS gateway — global)
                                                        │
                                          React 19 + Vite 5 + Tailwind + Framer Motion + Three.js
```

The swarm (Waahyu) emits `state.json` each scheduler tick via its own
`scripts/emit_state.py`. MissionAlpha only ever reads it. Zero coupling beyond
that one path.

## Setup

```bash
cp .env.example .env          # set WAAHYU_STATE_PATH (default = ../WaahyuPython/agent-status/state.json)
npm install
npm run dev                   # http://localhost:3004
```

The Vite dev middleware serves the swarm's `state.json` at `/api/state.json`
(reads `WAAHYU_STATE_PATH`), so the browser never touches `file://`.

Ensure the swarm is exporting state: in the swarm repo run its scheduler
(`./scripts/scheduler-ctl.sh start`) or a one-off `python3 scripts/emit_state.py`.

## Build phases

See `docs/BUILD-PLAN.md`. Phase 1 (scaffold + data seam) ✅. Phases 2–5: kanban,
CEO bar + live feed + heartbeat, 3D pulse globe + dark/light theme, polish.
Phase 6 (global): swap `LocalPollAdapter` → `LiveStreamAdapter` + hosted gateway.

## Stack

React 19 · Vite 5 · TypeScript (strict) · Tailwind 3 · Framer Motion ·
Three.js + react-three-fiber + drei + postprocessing · recharts · lucide.
Components via 21st.dev Magic MCP, elevated with impeccable + soft-skill +
emil-design-eng + hallmark.

## Relationship to Waahyu

Waahyu = the swarm (16 agents + scheduler + comms bus). Unchanged by this app.
MissionAlpha = the watcher. The only contract between them is the `state.json`
schema (see `docs/BUILD-PLAN.md` §1).
