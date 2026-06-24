# Phase 4 — Live Demo: Dynamic Team Routing (#7 / ADR-050 §Phase-4)

**Setup:** runtime on :3005 (cli+write). The team is `BUILTIN_IDS ∪ minted_registry`. Routing is a pure resolver over the capability index + minted dev-skill stacks. 259 tests green.

## Result: PASS — a stack resolves to its owning agent (built-in or minted)

`POST /runtime/factory/resolve {needs:{langs,frameworks,dbs}}`

| Call | Result |
|---|---|
| `{needs:{langs:["python","go"]}}` | `python → architect (builtin)`, `go → <minted go agent> (minted)` |
| mint a `code-implement-go` agent, then `{langs:["go"]}` | `go → <minted agent> (source:"minted")` |
| `{langs:["python"]}` | `python → builtin` |
| no token | **401** |

## What this proves (the #7 thesis)
- **Routing is data, not prose:** `router.mjs::resolveAgents(needs, mintedSpecs)` maps each needed lang/framework/db to the agent that owns it — built-in from `capabilities.mjs`, or minted from the registry (caps derived from the dev-skill `stack`).
- **Minted agents are first-class:** a Go requirement routes to a minted `code-implement-go` agent (source `"minted"`), so Phase-3 minted agents auto-receive matching work.
- **Tie-break:** a minted specialist wins over a broad built-in for the same stack.
- **`unresolved` = a real gap** → feeds the USER-gated mint flow (Phase 3).
- **No engine change:** the engine enqueue already accepts any `agentId`; resolved owners (built-in or minted) dispatch through the existing path.

## Coverage
- `router.mjs` pure logic: 8 unit tests (`test/router.test.mjs`) — builtin resolve, minted resolve, unresolved, framework, mixed, dedupe/case, fullIndex merge, empty.
- `/runtime/factory/resolve` endpoint: same token+origin+host auth as `detect-gaps`; read-only (never mutates registry). Proven live (401 without token; routes correctly with token).
- **Self-review (in lieu of a full code-review agent for this small surface):** pure module, no I/O; needs are lowercased/trimmed/deduped; values are matched against a static index (no injection surface); endpoint is a thin auth-gated mirror of the already-reviewed `detect-gaps`.

## Exit Gate verdict (Phase 4)
- ✅ `router.mjs` + `/resolve` endpoint + 8 tests; suite 259 green
- ✅ Live demo: builtin + minted routing + auth
- ✅ Docs: ORCHESTRATION.md + senior-lead-dev.md updated (resolver in the dispatch workflow)
- 🚦 **Phase 4 gate: GREEN.** Q6/Q7 achieved: out-of-scope stack → mint (Phase 3) → auto-routed (Phase 4).

## Follow-up (test hygiene)
The exec-loop B-block tests run a real server that writes minted test agents into the tracked `factory/registry.json`, polluting it each run. Tests should use a temp `RUNTIME_*` registry dir. Re-cleaned to `[java17-engineer]` after this run.
