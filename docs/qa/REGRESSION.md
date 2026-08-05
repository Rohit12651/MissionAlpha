# Regression Suite — re-run at EVERY phase exit (grows monotonically)

Rule: every item green before a phase may exit. New phases append items; nothing is ever removed.
Automation level: `auto` = scripted/curl, `browser` = playwright/agent-browser or manual browser walk with screenshot evidence.

## Setup (once per run)
```bash
cd /Users/RohitAnandeshi/Downloads/WaahyuFOLDER/MissonAlpha
npm run dev &                                   # :3004 (IPv6 localhost)
cd agent-runtime && RUNTIME_BACKEND=mock npm start &   # :3005 loopback (mock = free, deterministic)
python3 ../scripts/sim_swarm.py --once 2>/dev/null || true   # populate state.json if sim present
TOKEN=$(curl -s http://localhost:3004/api/runtime-token)
```
(cli backend variants of R1 are spot-checked at phase exits that touch chat; mock is the default regression backend for cost.)

## R1 — Chat streams (browser)
Open localhost:3004 → boss thread → send "ping" → tokens stream, mode chip shows backend, no console errors.
Agent thread (any station) → same. PASS = streamed reply both places.

## R2 — Boss dispatch → F3 gate → bus (browser)
Boss chat (mock backend emits sample ```dispatch block) → "CEO proposes N dispatches" card → Review & confirm → F3 PermissionGate lists verb→target → confirm → AUDIT.log gains BOSS entries.
```bash
tail -5 agent-status/AUDIT.log   # expect BOSS task <agent> lines
```

## R3 — F2b sandbox → changes → gated apply (auto + browser)
```bash
# stage a sandbox change for senior-web-1 (write mode runtime required for full path; mock: seed sandbox file manually)
curl -s -H "x-runtime-token: $TOKEN" http://localhost:3005/runtime/senior-web-1/changes   # 200 JSON
```
Browser: agent drawer → proposed-changes panel → Review & apply → F3 → apply → file lands in repo → DONE in feed. PASS = file present + feed line.

## R4 — Factory author → create → on board (browser)
Factory → New Agent → describe → spec streams → confirm → agent appears in gallery + registry.json + board (after next state tick). PASS = all three.

## R5 — Board live (browser)
Kanban columns populated from state.json, heartbeat ribbon ticking, feed streaming, globe rendering, card click → drawer. PASS = all five surfaces live, zero console errors.

## R6 — Sessions + replay (browser)
SessionsBrowser lists sessions w/ computed summary; TimeScrubber replays a past snapshot. PASS = both.

## R7 — Skills palette (browser)
Cmd-K / palette opens, search returns skills, attach flow works. PASS.

## R8 — Settings + theme (browser)
SettingsPanel opens; theme toggle flips and persists across reload. PASS.

## R9 — Runtime auth gates (auto)
```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3005/runtime/senior-web-1/changes                      # 401 (no token)
curl -s -o /dev/null -w "%{http_code}\n" -H "x-runtime-token: WRONG" http://localhost:3005/runtime/senior-web-1/changes  # 401
curl -s -o /dev/null -w "%{http_code}\n" -H "Host: evil.com" http://127.0.0.1:3005/runtime/senior-web-1/changes  # 403 (host gate on gated routes)
curl -s -o /dev/null -w "%{http_code}\n" -H "Host: evil.com" http://127.0.0.1:3005/runtime/health                # 200 — health is host-gate-EXEMPT by design
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3005/runtime/health                                    # 200
```

## R10 — Static gates (auto)
```bash
npm run typecheck      # 0 errors
npm run lint           # eslint clean, 0 warnings
npm run test:unit      # 100/100
npm run test:runtime   # 329/329 (P0 wired the 297 orphaned agent-runtime/test/ suites into the script; grows)
npm run test:vendor    # 6/6
npm run build          # exit 0
```

---
## Appended by later phases
(P2+: SSE bus contract checks · P3: inbox e2e · P4: queue resume · P5: worktree/PR · P6: policy matrix · P7: adapter idempotency · P8: export shape · P9: authz matrix — each phase's exit criteria graduate into this file.)
