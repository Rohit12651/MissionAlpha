# MissionAlpha Roadmap — Gated Phase Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement each phase task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take MissionAlpha from "multimodal input shipped" to "self-assembling agent swarm validated end-to-end" — in strictly sequential, verified phases.

**Architecture:** Five phases. Each produces working, verified software on its own. A phase is DONE only when its **Exit Gate** is green. **Do not start a phase until the previous phase's Exit Gate passes.** No parallel phases.

**Tech Stack:** Node ESM agent-runtime (`claude` CLI subscription backend), React/Vite cockpit, Docker sandbox, file-based agent bus, factory + registry.

---

## GLOBAL RULES (apply to every phase)

1. **One phase at a time.** Finish + verify + commit the current phase before touching the next.
2. **TDD always** — `sp-test-driven-development` fires before any implementation code (RED → GREEN → REFACTOR).
3. **Verify before "done"** — `sp-verification-before-completion` fires before claiming a phase complete.
4. **Security-sensitive paths** (sandbox, exec, factory, auth, uploads) → `security-review` skill + `security-reviewer`/`senior-security-engineer` agent BEFORE merge.
5. **Commit small, commit often.** Every GREEN test = a commit.
6. **Caveman mode** stays on for chat; code/commits written normal.

---

## PHASE 0 — Smoke Test (validate the core loop)

**Goal:** Prove the swarm runs end-to-end on one real task before building more. No new features.

**Assigned skills/agents:**
- `sp-systematic-debugging` — if any stage stalls, root-cause before patching
- `e2e-runner` (agent) — drive + observe the run
- `sp-verification-before-completion` — confirm each stage actually fired
- `kw-engineering-debug` — fallback for runtime errors

**Tasks:**
- [ ] **0.1** Start runtime with the **cli** backend (subscription, not mock): `RUNTIME_BACKEND=cli node agent-runtime/server.mjs`. Start vite. Confirm `/runtime/health` 200.
- [ ] **0.2** In the Boss chat, send ONE scoped goal: *"Build a bill-splitter web app: enter people + items, split totals, show each person's share."*
- [ ] **0.3** Observe **CEO stage** — does it research + return ≥3 options + post `AWAITING_USER_DECISION`? Record pass/fail.
- [ ] **0.4** Approve one option. Observe **architect** — emits design/DB/API + `READY_FOR_LEAD`.
- [ ] **0.5** Observe **dispatch** — senior-lead-dev decomposes, agents spawn in worktrees (check `agent-status/` + worktrees on disk).
- [ ] **0.6** Observe **QA + review + report back**. Confirm quota-guard + sandbox held (no lockout, no escape).
- [ ] **0.7** Write findings to `docs/superpowers/smoke-test-billsplitter.md`: which stages fired, where it stalled, rough edges.

**Exit Gate (must ALL be true to proceed):**
- ✅ Full loop fired CEO → approve → architect → build → QA → report (or every break point documented with root cause).
- ✅ No quota lockout, no sandbox escape, no orphaned worktrees.
- ✅ Findings doc written.
- 🚦 **STOP. Do not start Phase 1 until this gate is green.** If broken: fix via `sp-systematic-debugging`, re-run 0.2–0.6.

---

## PHASE 1 — Ship current branch (PR + review)

**Goal:** Get the 3 pushed commits (multimodal + dock + sandbox CI fix) reviewed and merged.

**Assigned skills/agents:**
- `sp-requesting-code-review` — prep the review
- `code-review` skill + `code-reviewer` (agent) — quality pass on the diff
- `security-review` skill + `security-reviewer` (agent) — uploads + sandbox paths
- `/pr` (command) — open the PR

**Tasks:**
- [ ] **1.1** Confirm CI green on `feat/multimodal-input` (the sandbox fix). If red, `sp-systematic-debugging` on the failing job.
- [ ] **1.2** Run `code-reviewer` agent over `git diff main...feat/multimodal-input`. Fix CRITICAL/HIGH findings.
- [ ] **1.3** Run `security-reviewer` agent over `agent-runtime/uploads.mjs` + `server.mjs` multipart branch + `sandbox.mjs` chmod. Fix CRITICAL/HIGH.
- [ ] **1.4** Open PR via `/pr` with summary + test plan (181 runtime tests, smoke-test result from Phase 0).
- [ ] **1.5** Address review comments (`sp-receiving-code-review`). Merge when approved.

**Exit Gate:**
- ✅ CI green. ✅ No open CRITICAL/HIGH. ✅ PR merged to `main`.
- 🚦 **STOP. Do not start Phase 2 until merged (or user says branch-continue).**

---

## PHASE 2 — #8 Phase-2: XLSX → CSV (finish file input)

**Goal:** Accept `.xlsx` attachments by converting to CSV server-side (model can't parse binary xlsx).

**Assigned skills/agents:**
- `sp-test-driven-development` — tests first
- `xlsx` skill — spreadsheet handling reference
- `node-specialist` (agent) — Node conversion impl
- `security-reviewer` (agent) — new dep + parse path
- `sp-verification-before-completion` — final check

**Files:**
- Modify: `agent-runtime/uploads.mjs` (add `xlsxToCsv`, extend ALLOWED with `.xlsx`)
- Modify: `agent-runtime/server.mjs` (`handleChatMultipart` — convert xlsx parts to CSV sidecar before dispatch)
- Test: `agent-runtime/test/uploads.test.mjs`
- Dep: add `xlsx` (SheetJS) or `node-xlsx` to `agent-runtime`

**Tasks:**
- [ ] **2.1** Add dep: `cd agent-runtime && npm i xlsx`. Commit lockfile.
- [ ] **2.2 (RED)** Write failing test in `uploads.test.mjs`:
  ```js
  test("xlsxToCsv converts first sheet to CSV with row cap", () => {
    // build a tiny workbook buffer, assert CSV text + row-cap truncation note
  });
  ```
- [ ] **2.3** Run it → FAIL (`xlsxToCsv` not defined).
- [ ] **2.4 (GREEN)** Implement `xlsxToCsv(absPath, {maxRows=5000})` in `uploads.mjs`: read workbook, emit `<file>.csv` sidecar, cap rows, return `{csvPath, rows, truncated}`. Add `.xlsx` → `{kind:"spreadsheet"}` to ALLOWED.
- [ ] **2.5** Run test → PASS.
- [ ] **2.6** Wire into `handleChatMultipart`: for each `kind==="spreadsheet"` accepted file, convert; pass the CSV sidecar path (not the binary) into the manifest with note `"from Excel <name>, N rows"`.
- [ ] **2.7** Integration smoke: `curl -F files=@sample.xlsx ...` → 200, manifest references `.csv` sidecar.
- [ ] **2.8** `security-reviewer` agent on the xlsx parse (zip-bomb / formula / size). Add caps if flagged.
- [ ] **2.9** Update `ChatPane.tsx` accept list + footer to include `xlsx`. tsc + build.
- [ ] **2.10** Commit + push.

**Exit Gate:**
- ✅ uploads tests green (incl. new xlsx). ✅ Integration smoke passes. ✅ Security review clean. ✅ build green.
- 🚦 **STOP. Do not start Phase 3 until green + committed.**

---

## PHASE 3 — #6: Factory self-creates agents for out-of-scope stacks

**Goal:** When the required stack has no agent (e.g. Go, Angular), the system mints a capable agent on demand.

> **This phase is large. First task is to write its OWN detailed sub-plan via `sp-writing-plans` — do not free-code it.**

**Assigned skills/agents:**
- `kw-product-management-write-spec` — write the feature spec first
- `sp-brainstorming` — explore the skill-catalog + exec-gate design
- `architect` (agent) / `kw-engineering-system-design` — design the catalog extension + exec boundary
- `sp-writing-plans` — produce the bite-sized sub-plan
- `security-review` + `senior-security-engineer` (agent) — **BLOCKING gate**: AI-authored agents getting `Run`/exec is the core risk
- `sp-test-driven-development` — implement the sub-plan
- `code-reviewer` (agent) — final pass

**Tasks (program-level — sub-plan expands each):**
- [ ] **3.1** `kw-product-management-write-spec`: spec "stack-gap → mint agent". Inputs: architect stack-manifest. Output: new agent wired + usable.
- [ ] **3.2** `architect` agent: design extending `factory.mjs` SKILL_CATALOG with dev skills (e.g. `code-implement-<stack>`, tools `Read/Write/Run`), persona "redirects" to an existing specialist skill (e.g. `golang-pro`, `angular-architect`).
- [ ] **3.3** **SECURITY DESIGN GATE** — `senior-security-engineer` agent: define how created agents get sandboxed `Run` (reuse `sandbox.mjs` Docker jail + `mcp-registry` launcher allowlist). **No exec for AI-authored agents outside the jail.** Sign-off required before any code.
- [ ] **3.4** `sp-writing-plans`: write `docs/superpowers/plans/<date>-factory-dev-agents.md` (bite-sized TDD).
- [ ] **3.5** Implement that sub-plan (TDD). Gap-detection (architect emits `stack-manifest.json` + diff vs roster → `AGENT_GAP`), catalog extension, `createAgent` path, jailed exec.
- [ ] **3.6** `security-review` skill full pass. `code-reviewer` agent. Fix CRITICAL/HIGH.

**Exit Gate:**
- ✅ Security sign-off on exec boundary. ✅ Sub-plan tests green. ✅ A demo: request an out-of-scope stack → agent minted + runs jailed.
- 🚦 **STOP. Do not start Phase 4 until green + security-cleared + committed.**

---

## PHASE 4 — #7: Dynamic team composition + routing

**Goal:** Created agents (Phase 3) get auto-assigned work — routing becomes data, not prose.

> Depends on Phase 3. Write its own sub-plan via `sp-writing-plans` first.

**Assigned skills/agents:**
- `kw-engineering-system-design` — design the team manifest + resolver
- `architect` (agent) — routing-as-data design
- `sp-writing-plans` — sub-plan
- `sp-test-driven-development` — implement
- `code-reviewer` (agent) — final pass

**Tasks (program-level):**
- [ ] **4.1** Design `factory/team-manifest.json` = `[{id, capabilities, owns:[paths]}]` (built-ins + created agents).
- [ ] **4.2** `sp-writing-plans`: sub-plan for a `(task → agent)` resolver that reads the manifest (replaces prose routing in `ORCHESTRATION.md`).
- [ ] **4.3** Implement (TDD): `senior-lead-dev` consults manifest; created agents become first-class routable; insert via existing `registry`. Grant MCP connectors via `mcp-registry.grant()` as needed.
- [ ] **4.4** Demo: mint a stack agent (Phase 3) → it auto-receives matching tasks in a dispatch.
- [ ] **4.5** `code-reviewer` agent. Fix findings.

**Exit Gate:**
- ✅ Sub-plan tests green. ✅ Demo: created agent auto-routed + does work. ✅ committed.
- 🚦 **DONE.** Q6/Q7 "give it any stack, it staffs itself" achieved.

---

## SEQUENCE (the only allowed order)

```
Phase 0 (smoke) ─gate→ Phase 1 (PR) ─gate→ Phase 2 (xlsx) ─gate→ Phase 3 (#6 factory) ─gate→ Phase 4 (#7 routing)
```

**Each `─gate→` is hard.** A phase that fails its Exit Gate loops on itself (debug → fix → re-verify) until green. Never skip ahead.

## Self-Review notes

- Phases 3 + 4 are intentionally program-level — each spawns its own `sp-writing-plans` sub-plan with full TDD code at execution time (per the skill's "break multi-subsystem specs into sub-plans" rule). Phases 0–2 are concrete here.
- XLSX (2) carries real TDD steps. Smoke (0) + PR (1) are procedural by nature.
- Security gates are explicit on every sensitive path (uploads, sandbox, factory exec).
