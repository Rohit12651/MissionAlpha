# Factory Dev-Agents (#6) Implementation Sub-Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (TDD, fresh subagent per task). Steps use `- [ ]`. This plan is Phase 3 of the roadmap; it may NOT start coding the exec coupling until the security gate (G1–G6) tasks below are green.

**Goal:** When a required stack is out of scope (no Go/Angular agent), the system mints a capable agent on demand that builds/tests code ONLY inside the existing Docker jail — never raw host exec.

**Architecture (ADR-050):** Architect declares needs in `stack-manifest.json`; a pure `gap-detector` diffs vs a `capabilities` index → `AGENT_GAP` → CEO surfaces to USER → **USER GO** → factory mints a `dev:true` agent whose persona **redirects to an installed specialist** (golang-pro / angular-architect). The minted agent writes code via `/run` (sandbox worktree) and builds/tests via the existing `/exec` Docker broker. No new exec path.

**Security verdict:** GO-WITH-GUARDS. G1–G6 are BLOCKING — implement them FIRST; the feature ships behind them.

---

## SECURITY GATE — G1–G6 (do these BEFORE any catalog/exec coupling)

Each guard is a task with a failing test first. The exec-coupling tasks (Section B) are blocked until all six are green.

### Task G1: Factory agents forced to approval for ALL exec (no auto-run `safe`) [CRITICAL]
**Files:** Modify `agent-runtime/tool-broker.mjs` (`decide`); Test `agent-runtime/test/tool-broker.test.mjs`
- [ ] **RED** — test: `decide("some-minted-id", classify("ls"))` with `isFactory=()=>true` → `autoRun === false` (even though `ls` is `safe`). Built-in id → `safe` still auto-runs.
- [ ] Run → FAIL.
- [ ] **GREEN** — thread an `isFactoryAgent(agentId)` predicate (registry membership from `factory.mjs`) into `decide`; gate `autoRun = !isFactory && klass === "safe"`.
- [ ] Run → PASS. Commit.

### Task G2: Per-agent network default-deny for factory tier [HIGH]
**Files:** Modify `tool-broker.mjs` (`execTool`); Test same.
- [ ] **RED** — test: a factory agent calling exec with `o.network=true` does NOT get a networked container unless an operator network-grant is present → assert `runInSandbox` called with network false.
- [ ] **GREEN** — add `networkAllowed(agentId)` (default false for factory tier); in `execTool` honor `o.network` only if `networkAllowed`. Built-ins keep current behavior.
- [ ] PASS. Commit.

### Task G3: Explicit lower-trust `factory` tier, enforced + audited [HIGH]
**Files:** `tool-broker.mjs`, `factory.mjs` (expose `isFactoryAgent`); Test.
- [ ] **RED** — test: an exec by a factory id stamps `tier:"factory"` in the `exec.run` audit line; a built-in stamps `tier:"builtin"`.
- [ ] **GREEN** — derive tier from registry membership (the `.md` already writes `factory:true`); enforce G1+G2 off this tier; add `tier` to the audit record.
- [ ] PASS. Commit.

### Task G5: Bind `--allowed-tools` from validated spec at the minted-agent spawn [CRITICAL]
**Files:** Modify `agent-runtime/server.mjs` (`cliReply` + `engineDispatch`); Test `agent-runtime/test/spawn-tools.test.mjs` (NEW)
- [ ] **RED** — test: for a registry (factory) agent, the spawn argv `--allowed-tools` is derived from `spec.tools` (∩ allowed), NOT the global `RUNTIME_TOOLS` mode; and the prompt (persona) is written to stdin AFTER args are finalized (assert arg array built before any stdin write).
- [ ] **GREEN** — in `cliReply`/`engineDispatch`, when `factory.createdPersona(id)` exists, compute allowed-tools from the agent's spec (Read always; Write/Edit only if the spec has a write-class skill; Bash never). Keep `--strict-mcp-config`. Built-in agents unchanged.
- [ ] PASS. Commit.

### Task G4 + G6: Catalog skills unlock `Run` only — no host paths, no apply relaxation, no MCP coupling [HIGH/MED]
**Files:** Modify `factory.mjs` (catalog + validateSpec); Test `agent-runtime/test/factory.test.mjs`
- [ ] **RED** — tests: (a) a `code-implement-*` skill has `tools ⊆ {Read,Write,Run}`, `platforms:[]`, `posting:false`; (b) a minted dev agent with empty `integrations` cannot post (`authorizePost` false); (c) a dev skill does NOT add to `SEED_DIRS`/`SEED_FILES` and does NOT touch `CONFIG_GUARD`; (d) exec capability never implies an MCP grant (default-deny holds).
- [ ] **GREEN** — add the dev skills (Section A) with exactly those flags; assert `guards.mjs` unchanged by this feature.
- [ ] PASS. Commit.

**GATE:** all G1–G6 green + a security-reviewer re-pass on the diff → only then start Section A/B.

---

## SECTION A — Mint machinery (after the gate)

### Task A1: capabilities index (pure)
**Files:** Create `agent-runtime/capabilities.mjs`; Test `test/capabilities.test.mjs`
- [ ] **RED** — test: `capabilityIndex()` lists the 16 builtins' `{langs,frameworks,dbs}`; `capsForSpec(spec)` derives a minted agent's `stack` from its dev skill.
- [ ] **GREEN** — static index + helper. PASS. Commit.

### Task A2: gap-detector (pure)
**Files:** Create `agent-runtime/gap-detector.mjs`; Test `test/gap-detector.test.mjs`
- [ ] **RED** — test: `detectGaps({needs:{langs:["go"]}}, index)` → `{gaps:[{kind:"lang",value:"go"}], covered:[]}`; a covered stack → `gaps:[]`.
- [ ] **GREEN** — pure diff. PASS. Commit.

### Task A3: dev skills + redirect in factory
**Files:** Modify `factory.mjs` (SKILL_CATALOG, `SPECIALIST_ALLOWLIST`, validateSpec, writePersonaFile); Test `test/factory.test.mjs`
- [ ] **RED** — tests: dev skill requires an allowlisted `redirect`; `redirect` not in `SPECIALIST_ALLOWLIST` → `{error}`; `writePersonaFile` emits the redirect directive; `BUILTIN_IDS`/secret-scrub still enforced.
- [ ] **GREEN** — implement. PASS. Commit.

---

## SECTION B — Wiring + endpoints (after A)

### Task B1: systemFor dev-agent branch
**Files:** Modify `server.mjs` (`systemFor`); Test `test/system-for.test.mjs`
- [ ] **RED** — test: a dev-skill persona gets the redirect directive + a run/exec tool note; the "no tools / never claim you ran code" clause is dropped for dev agents, kept for content agents.
- [ ] **GREEN**. PASS. Commit.

### Task B2: exec-capability gate on /exec (the S1 runtime gate)
**Files:** Modify `server.mjs` (`/exec` route); Test `test/exec-loop.test.mjs`
- [ ] **RED** — test: a minted CONTENT agent (no dev skill) → `POST /exec` returns 403; a minted DEV agent → reaches classify/approval; built-ins unchanged.
- [ ] **GREEN** — gate `/exec` on `builtin OR holds a dev:true skill`. PASS. Commit.

### Task B3: advisory detect-gaps endpoint (read-only, NO auto-mint)
**Files:** Modify `server.mjs`; Test `test/exec-loop.test.mjs` or new
- [ ] **RED** — test: `POST /runtime/factory/detect-gaps {manifest}` (token+origin gated) returns `{gaps,covered}` and NEVER calls `createAgent`.
- [ ] **GREEN**. PASS. Commit.

### Task B4: architect + ORCHESTRATION docs
**Files:** Modify `.claude/agents/architect.md` (emit stack-manifest), `.claude/agents/ORCHESTRATION.md` (mint flow, USER-gated, routing = builtin ∪ minted [Phase 4]); Create `docs/adr/ADR-050-on-demand-agent-minting.md`
- [ ] Write. Commit.

---

## SECTION C — Demo + exit gate

### Task C1: end-to-end demo
- [ ] Drive: a goal needing Go → architect manifest → `detect-gaps` flags `go` → mint a `go-impl-*` agent (USER GO) → it `/run` writes a tiny Go file → `/exec go test` is forced to approval (G1) → operator approves → runs in the jail → result returns. No host exec, no auto-run.
- [ ] Write `docs/superpowers/demo-factory-dev-agents.md` with evidence.

**EXIT GATE (Phase 3):**
- ✅ G1–G6 green + security-reviewer re-pass clean
- ✅ Sections A/B tests green; agent-runtime suite stays green
- ✅ Demo: out-of-scope stack → minted agent builds+tests jailed, exec approval-forced
- ✅ ADR-050 written
- 🚦 Then Phase 4 (#7 routing) may start.

## RISK REGISTER (accepted residuals — from security review)
- `chmod 0o777` host-side `/work` exposure (single-operator/CI scope)
- sandbox image pinned by tag not digest
- per-destination egress filtering deferred when network granted
- specialist-subagent invocability from a `claude -p` headless turn is UNVERIFIED — if a `-p` turn can't spawn VoltAgent subagents, redirect degrades to persona-text reference (lower competence). Verify early in A3.

## Self-review
- Every G-guard + section task has RED→GREEN→commit. No placeholders.
- Security gate precedes feature code (matches the roadmap's blocking design gate).
- Reuses the existing jail (no new exec path) — the core safety decision.
