# CEO Strategy Memo + Build Scope — Cycle 1: Operator Control Plane

**Slug:** `cycle1-control-plane`
**Author:** CEO agent (strategic gate)
**Status:** `AWAITING_USER_DECISION` → flips `STRATEGY_APPROVED_BY_USER` on Rohit's GO
**Date:** 2026-06-14
**Persona blend:** Bezos (JTBD + 6-pager) · Musk (first-principles, "best part is no part") · Solomon (risk-adjusted, reversible) · Fink (long-duration, on-architecture)

---

## PART A — STRATEGY MEMO (Bezos 6-pager)

### 1. Headline + Recommendation

Ship the **Operator Control Plane** — four on-architecture features (Audit-log viewer, Bulk actions, Command feedback, Permission gates) that turn MissionAlpha from a *read-mostly watcher* into a *trustworthy control surface* — without coupling the dashboard to any LLM runtime.

**Recommendation: GO. All four are Type-2 (reversible), cheap, and use data the swarm already emits.**

### 2. Customer JTBD (verbatim)

> "as i am boss" · "i can able to do anything" · "asking questions without blindly doing the work" · "did my click actually land"

Decomposed jobs:
- **J1 — Trust:** "When I act, I must know it landed (or failed, and why)." → F7 command feedback.
- **J2 — Accountability:** "I must see every action taken + when + by whom." → F5 audit viewer.
- **J3 — Scale:** "When 15 agents die at once, I act once, not 15 times." → F6 bulk actions.
- **J4 — Safety:** "Don't fire irreversible/mass actions blindly — ask me first." → F3 permission gates.

### 3. First-Principles Atoms

- **Hard constraint (unbreakable):** MissionAlpha = decoupled watcher. Contract = `state.json` (read) + `commands/` (write). README: "zero coupling beyond that one path." Cycle 1 must NOT break this.
- **Hard:** No new backend service. Only the existing Vite dev middleware + new read endpoints over files the swarm already writes.
- **Soft (assumed):** "operator" is the only identity (no auth yet — Phase 6). We carry that assumption forward; F5/F7 designed so real auth slots in later.
- **Atom of value:** every datum these 4 features need **already exists on disk** (`AUDIT.log`, `commands/`, `commands/done/`, `commands/rejected/`, `state.json` stale/dead flags). Cycle 1 = *surface + batch + guard* existing data. Net-new compute ≈ 0.

### 4. Outside-World References (control-plane prior art)

1. **PagerDuty** — ack-to-silence + bulk-ack incidents (F6 pattern). Operators never click N times.
2. **Kubernetes `kubectl`** — dry-run + confirm on destructive ops; `delete --all` requires explicit scope (F3 pattern).
3. **AWS Console** — every mutating action → CloudTrail audit entry, surfaced in-console (F5 pattern).
4. **Datadog / Grafana OnCall** — command/action status chips (queued → ack → resolved) (F7 pattern).
5. **GitHub Actions** — job state machine pending→running→success/failure visible inline (F7 pattern).

Triangulation: every mature control plane separates *act → confirm landed → audit*, and guards mass/irreversible actions. MissionAlpha currently does the act, skips confirm + audit + guard. Cycle 1 closes the standard loop.

### 5. Options (recap — decided)

- **Option A (CHOSEN): Control Plane first** (F5+F6+F7+F3). On-architecture, Type-2, days. Delivers J1–J4.
- Option B: Chat/LLM first (F1+F2 streaming + fs access). Type-1, weeks, breaks decoupling, ×16 tool-exec security surface. → Deferred to separate "IDE fork" track.
- Option C: Multi-swarm first (the global Fink bet). High value but premature before single-swarm control is trustworthy. → Cycle 3.

### 6. CEO's Recommended Path + Why

Bezos: J1 (trust) is table-stakes — an operator who can't confirm an action won't trust the tool, full stop. Musk ("best part is no part"): we add ZERO new services — just render/batch/guard existing files; delete the idea of an LLM backend for now. Solomon: all four reversible (feature-flaggable, no schema migration). Fink: stays on the `state.json`/`commands/` contract → preserves the long-duration multi-swarm option.

### 7. Pre-mortem (12 months, if we got Cycle 1 wrong)

- **F6 mis-fires:** "Respawn all" hit 15 agents with no confirm → mass unintended respawn storm. → Mitigation: F3 gate is a HARD dependency of F6, not optional.
- **F7 lies:** UI shows "done" optimistically but command was rejected → operator trusts a false green. → Mitigation: F7 reads `done/`+`rejected/` ground truth, not optimistic state.
- **F5 unbounded:** AUDIT.log grows forever, viewer loads 100k lines → UI jank. → Mitigation: tail-N + virtualized list + date filter.
- **Scope creep:** someone bolts streaming/LLM onto this cycle → couples watcher. → Mitigation: CEO scope-drift gate; F1/F2 explicitly NON-GOAL of Cycle 1.

### 8. Asks of USER (GO / NO-GO)

1. GO on Option A scope (F5+F6+F7+F3) as Cycle 1? **[ ] GO  [ ] NO-GO  [ ] iterate**
2. Confirm F3 (permission gates) is a HARD gate on F6 (bulk) — bulk actions never fire without confirm? **[ ] yes**
3. Accept "operator" single-identity assumption for now (real auth = Phase 6)? **[ ] yes**

### 9. Open Questions (CEO uncertain)

- Q1: Should bulk actions be all-or-nothing, or per-agent best-effort with a result summary? (CEO leans **best-effort + summary** — partial success is real.)
- Q2: Audit viewer — dashboard-actions only, or also mirror swarm-side events from SYNC_LOG? (CEO leans **commands first**, SYNC later.)
- Q3: Feature-flag the whole cycle behind `VITE_CONTROL_PLANE=1` for safe rollout? (CEO leans **yes**.)

---

## PART B — ENGINEERING BUILD SCOPE (per agent, every phase)

> Dispatched per `.claude/agents/ORCHESTRATION.md` pipeline AFTER `STRATEGY_APPROVED_BY_USER`.
> Pipeline: CEO → architect (ADR) → principal-ux (design) + principal-db (n/a, no schema) + sr-security (write-surface review) → senior-lead-dev (decompose) → senior-web-1/2 (impl) + senior-cicd (middleware/endpoints) → senior-qa (tests) → senior-code-reviewer (merge gate) → memory-updater (persist).

### Feature set (Cycle 1)

| ID | Feature | JTBD | Owner (impl) | Net-new compute |
|----|---------|------|--------------|-----------------|
| F5 | Audit-log viewer | J2 accountability | senior-web-1 | 0 (render existing AUDIT.log) |
| F6 | Bulk actions | J3 scale | senior-web-2 | 0 (loop existing POST) |
| F7 | Command feedback (pending/done/rejected) | J1 trust | senior-web-1 | 0 (read 3 dirs) |
| F3 | Permission gates | J4 safety | senior-web-2 | 0 (confirm dialog component) |

---

### PHASE 0 — CEO INTAKE + GATE (this doc)

- **Owner:** CEO.
- Artifacts: this memo. State → `AWAITING_USER_DECISION`.
- **Exit gate:** Rohit GO → CEO writes `agent-status/CEO.md` = `STRATEGY_APPROVED_BY_USER` with scope guardrails + non-goals below.
- **Non-goals (HARD — scope-drift triggers `RETURNED_FOR_SCOPE_REVIEW`):** no LLM/streaming (F1), no fs/repo access (F2), no auth, no new backend service, no `state.json` schema change beyond additive read-only.

---

### PHASE 1 — ARCHITECT: ADR + contracts

- **Owner:** architect. **Blocks:** all impl.
- **Tasks:**
  1. Write `docs/adr/ADR-00X-control-plane.md` — decision: surface existing files via new **read-only** Vite endpoints; no DB, no service.
  2. Define 3 new endpoints (additive to vite.config.ts):
     - `GET /api/audit` → tail-N parsed lines of `commands/AUDIT.log` → `AuditEntry[]`.
     - `GET /api/commands/status` → counts + recent entries from `commands/` (pending), `commands/done/`, `commands/rejected/` → `CommandStatusSnapshot`.
     - `POST /api/command/bulk` → array of `CommandRequest`; loops existing single-write path; returns `BulkResult`.
  3. Define new TS types in `src/data/types.ts` (additive):
     ```ts
     export interface AuditEntry { at: string; cmdId: string; issuedBy: string; type: CommandType; target: string; reason?: string; note?: string; }
     export type CommandLifecycle = "pending" | "done" | "rejected";
     export interface CommandStatusEntry { id: string; type: CommandType; target: string; lifecycle: CommandLifecycle; at: string; error?: string; }
     export interface CommandStatusSnapshot { pending: number; done: number; rejected: number; recent: CommandStatusEntry[]; }
     export interface BulkResult { ok: boolean; issued: number; failed: number; results: CommandResult[]; }
     ```
  4. Extend `DataSource` interface (the seam) — additive methods, both adapters implement:
     ```ts
     getAudit(limit?: number): Promise<AuditEntry[]>;
     getCommandStatus(): Promise<CommandStatusSnapshot>;
     sendBulk(cmds: CommandRequest[]): Promise<BulkResult>;
     ```
  5. Feature flag contract: `VITE_CONTROL_PLANE` env → gate UI mount + endpoints.
- **Exit gate:** ADR merged; types compile; sr-security signs off on endpoint surface (Phase 2). Drift from memo → `RETURNED_FOR_STRATEGY_FIX`.

---

### PHASE 2 — PRINCIPAL-UX + SR-SECURITY (parallel)

**principal-ux-design** (owns `src/theme/` tokens + design contract):
- Design 3 surfaces, all OKLCH tokens, dark/light, reduced-motion, a11y (aria-live, focus-visible), mobile 320/375/414/768:
  1. **Audit panel** — collapsible drawer/tab, virtualized list, columns: time · type-chip · target · who · reason. Date + type filter. Empty/loading/error states.
  2. **Command-status chips** — per-command 🟡pending → 🟢done → 🔴rejected(reason tooltip). Header summary counts.
  3. **Bulk action bar** — top-of-board: "Acknowledge all stale (N)" · "Respawn all offline (N)", disabled when N=0.
  4. **Permission gate dialog** — modal: action summary, affected-agent list, count, Confirm/Cancel; Confirm requires focus; ESC=cancel. Emil-motion: ease-out enter ≤300ms, scale(0.95)+opacity, transform-origin center.
- Output: design notes + token additions; hand-off contract to senior-web-1/2.

**senior-security-engineer** (AUTHORITY to BLOCK):
- Review the 3 endpoints. Checklist:
  - `GET /api/audit` — path-traversal guard (only read configured AUDIT.log), tail-N cap (no full-file load), no PII leak beyond existing fields.
  - `POST /api/command/bulk` — reuse existing validator per item (type allow-list `{ack,respawn,task}`, 8KB cap, target-must-exist), **cap array length** (e.g. ≤64) to prevent flood, rate-limit, audit EVERY item.
  - F3 confirm is server-irrelevant (UI guard) → ensure server still validates (defense in depth; never trust client gate).
- **HARD gate:** HIGH/CRITICAL finding blocks merge.

---

### PHASE 3 — SR-CICD: endpoints + middleware

- **Owner:** senior-cicd-engineer (owns vite.config.ts middleware per spec). Pairs w/ senior-web on contracts.
- **Tasks:**
  1. Implement `GET /api/audit` — read `commands/AUDIT.log`, tail-N (default 200), parse TSV → `AuditEntry[]`, JSON. Atomic-read safe.
  2. Implement `GET /api/commands/status` — scan `commands/*.json` (pending), `commands/done/*.json`, `commands/rejected/*.json`; count + parse recent N; merge `rejected` error field if present → `CommandStatusSnapshot`.
  3. Implement `POST /api/command/bulk` — parse `CommandRequest[]`, enforce length cap, loop existing single-command write logic per item, collect `CommandResult[]` → `BulkResult`. Audit each.
  4. Wire all behind `VITE_CONTROL_PLANE` flag (404 when off).
  5. Update `.env.example` with `VITE_CONTROL_PLANE=1`.
- **Exit gate:** endpoints return valid JSON; manual curl smoke for each; flag-off returns 404.

---

### PHASE 4 — SENIOR-WEB: adapters + UI impl (parallel, file-owned)

**senior-web-1** (owns: `LocalPollAdapter.ts` audit/status methods, Audit panel, Command-status chips):
- `LocalPollAdapter`: implement `getAudit`, `getCommandStatus` (fetch new endpoints).
- `LiveStreamAdapter` (if present/stub): add same methods (stub or SSE-ready) so seam stays symmetric.
- Build **AuditPanel** component — virtualized, filterable, polls `/api/audit` @ same cadence or on-open.
- Build **CommandStatus** chips — integrate into AgentAction drawer + header summary; reflect pending/done/rejected from `getCommandStatus`.

**senior-web-2** (owns: bulk action bar, PermissionGate dialog, `sendBulk`):
- `LocalPollAdapter.sendBulk` → POST `/api/command/bulk`.
- Build **BulkActionBar** — computes N stale/offline from current `DashboardState`; buttons gated.
- Build **PermissionGate** modal component (reusable) — wraps any destructive action: respawn, bulk-respawn, bulk-ack. Returns promise<confirmed>.
- Wire F3 into: existing single Respawn (optional confirm), all F6 bulk actions (MANDATORY confirm). Per memo Ask #2.
- **Coordination point:** senior-web-1 owns drawer chips, senior-web-2 owns dialogs — integrate at AgentAction.tsx via messaging; no file collision (dialog = new file, chips = new file).

- **Exit gate:** all 4 features render behind flag; manual click-through works; TS strict passes; `npm run lint` clean (max-warnings 0).

---

### PHASE 5 — SENIOR-QA: test suite

- **Owner:** senior-qa. **Blocks:** code-review gate.
- **Tests:**
  - **Unit:** AUDIT.log TSV parser (malformed line, empty file, tail-N boundary). CommandStatus dir-merge (pending/done/rejected, empty dirs). Bulk array builder from DashboardState (N stale selection correctness).
  - **Contract:** each endpoint shape vs types; flag-off → 404; bulk length-cap rejection.
  - **Component:** PermissionGate (Confirm fires, Cancel/ESC aborts, focus trap). BulkActionBar disabled at N=0. Audit filter narrows list.
  - **E2E (playwright, headless 3004):** click Respawn → confirm dialog → command file appears → status chip pending→done → audit row appears. Bulk respawn offline → confirm shows count → N files written → BulkResult summary.
  - **a11y:** axe pass on new surfaces; reduced-motion honored.
  - **Regression:** existing ack/respawn/task single-path still works (no break).
- **Exit gate:** `TESTS_GREEN` posted to bus. Coverage on new modules.

---

### PHASE 6 — SENIOR-CODE-REVIEWER: merge gate

- **Owner:** senior-code-reviewer (FINAL gate, adversarial). Fires after `TESTS_GREEN`.
- Checklist: no inline hex (OKLCH tokens only), no `transition: all`, no `scale(0)`, additive-only types (no breaking seam), feature flag respected, server validates independent of client gate, AUDIT.log read bounded, bulk cap enforced, no `file://`, no coupling to LLM/fs (scope adherence).
- **Blocks merge until all sev≥Medium resolved.** sr-security re-confirm on write-surface.

---

### PHASE 7 — MEMORY-UPDATER + CEO post-launch

- **memory-updater:** persist to ClaudeMem + MCP memory + `memory/ARCHITECTURE_MEMORY.md`: "Cycle 1 control plane = surface/batch/guard existing files; seam stayed read-one-file + write-commands." Update dependency map w/ 3 new endpoints + components.
- **CEO Phase 9 (monitoring):** watch for scope drift during build; flag burn >20%.
- **CEO Phase 10 (retro, +30d):** metrics-review — did operator trust rise (fewer terminal fallbacks)? assumption-map: held/broke. File `docs/ceo/cycle1-control-plane-retro.md`. Persist `Initiative:cycle1-control-plane` outcome.

---

## PART C — SEQUENCING + DEPENDENCY GRAPH

```
Phase0 CEO gate (Rohit GO)
   ↓
Phase1 architect ADR + types + endpoints contract  [BLOCKS ALL]
   ↓
Phase2 principal-ux design  ∥  sr-security endpoint review
   ↓
Phase3 sr-cicd endpoints (GET audit, GET status, POST bulk)  [BLOCKS web impl of F5/F6/F7]
   ↓
Phase4 senior-web-1 (audit panel + status chips)  ∥  senior-web-2 (bulk bar + permission gate)
        └ F3 gate is HARD dependency of F6 ┘
   ↓
Phase5 senior-qa (unit + contract + component + E2E + a11y + regression)
   ↓
Phase6 senior-code-reviewer (merge gate)  + sr-security re-confirm
   ↓
Phase7 memory-updater persist  +  CEO monitor → retro(+30d)
```

**Critical path:** architect → sr-cicd endpoints → senior-web → qa → review.
**Parallelizable:** ux ∥ security (Phase 2); web-1 ∥ web-2 (Phase 4).

## PART D — ACCEPTANCE CRITERIA (Cycle 1 = DONE when)

- [ ] F5: AUDIT.log visible in UI, filterable by type+date, virtualized, bounded read.
- [ ] F6: one-click "ack all stale" / "respawn all offline" → fires N commands → BulkResult summary.
- [ ] F7: every command shows true lifecycle pending→done→rejected(+reason) from disk, not optimistic.
- [ ] F3: every destructive + every bulk action requires confirm dialog (count + agent list) before firing.
- [ ] Zero new backend service; only Vite middleware endpoints over existing files.
- [ ] `state.json`/`commands/` contract unchanged (additive read-only).
- [ ] Whole cycle flag-gated `VITE_CONTROL_PLANE`; off = current behavior.
- [ ] TS strict + lint(0 warn) + TESTS_GREEN + code-review pass + sr-security sign-off.
- [ ] No LLM, no fs/repo access, no streaming (non-goals respected).

## PART E — NON-GOALS (explicit, scope-drift = blocked)

- F1 streaming reply / F2 fs+repo access (= LLM fork, separate track).
- Auth / multi-user identity (Phase 6).
- Multi-swarm (Cycle 3).
- Any `state.json` schema change beyond additive read-only endpoints.

---

**END MEMO.** State: `AWAITING_USER_DECISION`. Awaiting Rohit GO to flip `STRATEGY_APPROVED_BY_USER` + dispatch architect.
