# Phase 3 — Live Demo: Factory Dev-Agents (#6 / ADR-050)

**Setup:** `RUNTIME_BACKEND=cli RUNTIME_TOOLS=write node agent-runtime/server.mjs` (:3005), Docker up. Driven via the runtime HTTP API. 251 tests green + 2 security reviews preceded this run.

## Result: PASS — out-of-scope stack → minted agent → gated + jailed exec

| Step | What | Evidence |
|---|---|---|
| 1. Gap detection | `POST /runtime/factory/detect-gaps {needs:{langs:["go"]}}` | `{"gaps":[{"kind":"lang","value":"go"}],"covered":[]}` — Go correctly flagged (no builtin builds Go). |
| 2. Mint | `POST /factory/create` a `go-impl-demo` agent (skill `code-implement-go`, `redirect:"golang-pro"`) | Spec persisted: `{id:"go-impl-demo", skills:["code-implement-go"], redirect:"golang-pro", createdBy:"BOSS"}`. |
| 3. B2 capability gate | content-only agent (`content-writing`, no dev skill) → `POST /exec` | **HTTP 403** `exec not permitted for this agent` — content agents can't reach the jail. |
| 4. G1 forced approval | dev agent, **safe** command `echo …` → `/exec` | `{"pending":true,"klass":"safe",...}` — a `safe` command (which auto-runs for a built-in) is **forced to approval** for the AI-authored agent. |
| 5. Approve → jailed run | `POST /runtime/exec/<callId>/approve {scope:"once"}` running `echo hi-from-jail && id -u` | `ran:true, exitCode:0, stdout:"hi-from-jail\n65534\n"` — ran in the Docker jail **as uid 65534 (non-root)**. |
| 6. G2 network deny | same run | `network: None` — factory agent network forced off. |

## What this proves (the #6 security thesis)

- **Self-extension works:** the system detects a stack it can't build (Go), and an agent for it is minted on demand with a persona that **redirects to the `golang-pro` specialist** for competence.
- **AI-authored exec is contained, not free:**
  - **B2** — only built-ins or dev-skill agents reach `/exec`; a minted content agent is denied (403).
  - **G1** — a minted agent NEVER auto-runs; even a `safe` command requires operator approval.
  - **Jail** — approved commands run in the existing Docker sandbox: **non-root (uid 65534)**, `--cap-drop ALL`, `--network none` (G2), read-only rootfs, worktree-only mount. No raw host exec — `Run` is not representable as Bash (`ALLOWED_TOOLS` = Read/Write/Run, no Bash).
  - **Mint is USER-gated** (CEO `capability-gap` → USER GO); `detect-gaps` is advisory/read-only and never calls `createAgent`.

## Not shown live (already proven elsewhere)
- The `/run` write-mode build (agent writes actual Go source) — the agent-build half was proven in Phase 0 (`smoke-test-billsplitter.md`); this demo focused on the novel #6 surface (gap → mint → exec gating). Running real Go (`go test`) would also need a Go toolchain image, out of scope for the security demo.

## Bug fixed during the demo
- `capabilities.mjs` wrongly listed `go` as a capability of `architect` + `senior-code-reviewer` (they design/review, don't build Go) → `detect-gaps` falsely reported Go covered. Removed `go` from both; Go is now correctly a gap. (capabilities + gap-detector tests: 23 pass.)

## Exit Gate verdict (Phase 3)
- ✅ G1–G6 implemented + security re-pass (B2 GO; G1 route-hole found + fixed + tested)
- ✅ Sections A/B: gap detection, mint, capability gate, detect-gaps endpoint, ADR-050
- ✅ Live demo: out-of-scope stack → minted agent → exec gated (B2) + approval-forced (G1) + jailed non-root (G2)
- ✅ 251 tests green
- 🚦 **Phase 3 gate: GREEN.** Cleared for Phase 4 (#7 dynamic routing).

## Cleanup note
Test/demo agents (`go-impl-demo`, `content-demo`, `captest-*`, `g1test-*`, `b1-*`, `dbg-go-1`) were minted into `factory/registry.json` during tests/demo — purge before committing the registry (keep `java17-engineer`).
