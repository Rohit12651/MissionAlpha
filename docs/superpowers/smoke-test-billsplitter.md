# Phase 0 — Smoke Test: bill-splitter (2026-06-20)

**Goal:** Prove the swarm's core wiring runs end-to-end on one real task (cli/subscription backend).

**Setup:** `RUNTIME_BACKEND=cli RUNTIME_TOOLS=write node agent-runtime/server.mjs` (:3005, health 200). Driven headlessly via the runtime HTTP API.

## Result: PASS (both hardest links validated live)

| Stage | Status | Evidence |
|---|---|---|
| CEO strategy | ✅ PASS | POST /runtime/boss/chat → first-principles read + **3 options (A/B/C)** + recommendation (B) + **clarifying question** (item-assignment model) + MVP scope + **GO/NO-GO gate** ("If GO, I'll dispatch senior-web-1"). |
| `claude` CLI wiring | ✅ PASS | Both chat (boss) and /run (senior-web-1) spawned real `claude`, streamed stream-json. |
| SSE streaming + usage | ✅ PASS | meta/token/usage/done events; usage tokens + contextPct reported (ADR-030). |
| Agent build | ✅ PASS | /run senior-web-1 → wrote `billsplit.html` (458 lines, 15KB) in its **sandbox copy**; 19 handlers, people/items/tax/tip, `createTextNode` (XSS-safe), 0 external deps. |
| Sandbox isolation | ✅ PASS | File landed in `…/missionalpha-sandboxes/senior-web-1/`, **live repo untouched**. |
| Quota guard | ✅ PASS | Multiple real `claude` runs, no lockout, no 429 cascade. |

## Findings / rough edges (for follow-up)

1. **Research tools inactive in `tools=none`** — the CEO has no live `WebSearch`/`WebFetch` in the default chat mode, so its "research" is model-knowledge, not live web. The persona advertises MCP/web research it can't use here. *Fix later: grant CEO read+web tools, or document the mode.*

2. **`/run` requires `RUNTIME_TOOLS=write`** — default is `none`, so the build loop 400s (`runtime not in write mode`) until the operator sets the env. *Expected, but undocumented; note in runbook.*

3. **`/run` build silently dropped by `/changes` (real bug) — ✅ FIXED** — root cause was NOT a worktree-vs-sandbox mismatch (both `/runtime/:id/run` and `/runtime/:id/changes` use the per-agent copy-sandbox, and `engineBroker`/`broker` already share `applyAllowed` as the single source of truth). The real cause: the `/run` agent wrote its deliverable at the **sandbox root** (`…/missionalpha-sandboxes/senior-web-1/billsplit.html`), which is outside the appliable scope (`SEED_DIRS=["src"]`), so `listChanges` silently skipped it → `files: 0`. *Fix:* (a) added `public/` to the seeded+appliable `SEED_DIRS` (the static-deliverable surface; apply still gated by `APPLY_DENY` + `CONFIG_GUARD` + containment); (b) the `/run` prompt now steers agents to write only inside `src/`/`public/`; (c) added a broker regression test proving a `public/billsplit.html` build surfaces via `/changes` and applies to the repo, plus a scope-boundary test. `agent-runtime` suite: 183 pass.

4. **Context window exceeded on the build turn** — `contextTokens 309854 > 200000 window` (contextPct 1.0). Persona + task pushed past the window; `claude` compacted and still completed, but larger tasks risk truncation. *Note: keep per-turn task scope tight, or chunk.*

5. **Full middle of the loop not driven headlessly** — CEO→**approve**→architect→auto-dispatch uses the UI's ```dispatch confirm + per-agent /run fan-out. Both ENDS (CEO + agent-build) are proven; the interactive middle is best driven in the running cockpit (localhost:3004) or via a follow-up headless-dispatch test.

## Exit Gate verdict

- ✅ Loop fired at both hardest links (CEO options/gate + agent writes real code in isolation).
- ✅ No quota lockout, no sandbox escape, no live-repo writes, no orphaned state.
- ✅ Findings documented (3 real follow-ups, #3 is a genuine bug — now fixed).

**Phase 0 gate: GREEN.** Cleared to start Phase 1 (PR + review). Finding #3 (`/run` build dropped by `/changes`) is fixed: `public/` added to the appliable scope, `/run` prompt steers writes in-scope, broker regression test added (`agent-runtime` 183 pass).
