# MissionAlpha — Agent Factory v2: Delete · Skills (1800+) · Stop · Loading
## Plan Document — 2026-06-26
## Status: APPROVED FOR BUILD — NO NEGOTIATIONS

> Builds 7 confirmed requests onto the existing agent-pool bridge. Each phase names the
> exact CLAUDE.md skills + subagents to fire. TDD is mandatory; reviews are gates.

---

## 0. SKILLS + AGENTS — MANDATORY FIRE ORDER (CLAUDE.md)

Fire in order, never skip. Per-phase overrides listed inside each phase.

| When | Skill / Agent |
|------|---------------|
| Session start | `sp-using-superpowers` |
| Before any code (per feature) | `kw-product-management-write-spec` |
| Before writing impl | `sp-test-driven-development` (RED→GREEN) |
| UI components | `react-specialist` + `frontend-design` + `impeccable craft` |
| Types | `typescript-pro` |
| Motion/loading polish | `emil-design-eng` |
| Anti-slop UI audit | `hallmark audit` |
| After each file | `code-reviewer` subagent |
| Server/endpoints/secrets | `security-reviewer` subagent + `security-review` skill |
| React changes | `react-reviewer` subagent |
| TS changes | `typescript-reviewer` subagent |
| a11y (modals, destructive) | `a11y-architect` subagent |
| Before "done" | `sp-verification-before-completion` |
| Pre-ship | `kw-engineering-deploy-checklist` |
| Commit | `/commit-push-pr` (on user word only) |

Subagents fire via the Agent tool. UI gets `react-reviewer` + `typescript-reviewer` every change. Server gets `security-reviewer` every change.

---

## 1. SCOPE — 7 features, grouped into 4 phases

```
Phase A — Delete agents from board           (req 1)
Phase B — Factory: relocate Add + 1800 skills (req 2, 3, 4)
Phase C — Stop on agents + on pool modal      (req 5, 6)
Phase D — CEO-assemble loading polish         (req 7)
```

Build order: **A → C → D → B**. (B is biggest; do the small high-value ones first so the app is usable, then the skills system.)

---

## 2. CURRENT STATE (verified)

- Agent cards: `src/components/cockpit/AgentRoster.tsx` (rail) + kanban `src/components/KanbanColumn.tsx` / `KanbanBoard.tsx`. NO delete/stop on cards.
- Agent Factory UI: `src/components/factory/AgentFactory.tsx` (+ `CreateAgentFlow.tsx`, `SkillCatalog.tsx`, `ConnectorPanel.tsx`). Tabs: Create · Skills·9 · Accounts·0 · Post.
- Factory skills: `SKILL_CATALOG` = **9** (closed, tool/exec/platform-bound, the `validateSpec` security choke).
- The 1800+: `src/lib/missionSkills.ts` = **1879** prompt-template skills (palette). Frontend-only, NO exec.
- Delete endpoints exist: `POST /factory/pool/remove` (imported) · `DELETE /factory/:id` (`factory.deleteAgent`, factory-created).
- Stop endpoint exists: `POST /runtime/:id/cancel` (kills the agent's `claude -p` child). `chatKillMap` keyed by agentId.
- Pool import: `GET /factory/pool` · `POST /factory/pool/import` · `PoolPicker.tsx` modal + `+ Add` in rail.
- CEO-assemble: `PoolPicker.tsx` "Let CEO assemble" tab → `askCeo` → `/runtime/boss/chat` → `parseIds`. Spinner = small `Loader2`.

---

## 3. DECISION LOCKED (req 3/4)

The 1879 skills attach as **PROMPT-ATTACH skills**: selecting a skill appends its `prompt` string to the agent's persona. NO new tool/exec capability (security unchanged — real access still governed by runtime TOOLS mode + sandbox + the 9-skill factory catalog for exec/posting). This is the ONLY safe way to surface 1800+ without re-securing each.

- Factory exec/posting skills = the existing **9** (unchanged, still the security catalog).
- Prompt-attach skills = the **1879** (behavior priming only).
- Both shown in Create flow, clearly separated: "Capabilities (9)" vs "Skill priming (search 1879)".

---

## PHASE A — Delete agents from the board (req 1)

**Goal:** every agent card except `ceo` has a delete/remove action wired to the correct endpoint.

**Skills/agents:** `kw-product-management-write-spec` → `sp-test-driven-development` → `react-specialist` + `impeccable craft` → `a11y-architect` (destructive confirm) → `security-reviewer` (delete auth) → `react-reviewer` + `typescript-reviewer`.

### A1 — Server (verify, minor)
- `POST /factory/pool/remove {ids}` ✅ exists → un-pins imported.
- `DELETE /factory/:id` ✅ exists → deletes factory-created.
- Builtin seed agents (architect etc. when NOT imported): only removable by un-pinning if imported; a pure builtin that's only visible because it's *active* can't be "deleted" (it's a seed id) — the delete button hides for non-removable builtins, OR maps to "remove from board" = stop + (if imported) unpin.
- Add a single **resolver**: `removableKind(agent)` → `"imported" | "factory" | "none"`. `ceo` → `none` (never).
- TESTS (TDD, pure helper in a new `src/lib/agentActions.ts`): removableKind(ceo)→none; imported→imported; factory→factory; plain-builtin→none.

### A2 — UI
- `AgentRoster.tsx` Row + kanban card: on hover, a small **trash** icon (not for `ceo`).
- Click → confirm dialog (reuse `PermissionGate` or native confirm) → call:
  - imported → `POST /factory/pool/remove {ids:[id]}`
  - factory → `DELETE /factory/${id}` (x-runtime-token)
- After success → board poll drops it; optimistic remove from local list.
- `ceo` card: NO trash (guard in render).

### A3 — Gates
- `a11y-architect`: destructive action needs `aria-haspopup="dialog"` + confirm + focus return.
- `security-reviewer`: delete endpoints auth-gated (they are); confirm no cross-agent delete.
- DoD: TDD green, tsc 0, delete imported + factory both work in app, ceo has no trash.

---

## PHASE C — Stop button on agents + pool modal (req 5, 6)

**Goal:** interrupt a running agent mid-task; cancel the CEO-assemble call.

**Skills/agents:** `sp-test-driven-development` → `react-specialist` + `emil-design-eng` (stop affordance, ≤160ms press) → `impeccable craft` → `security-reviewer` (cancel path) → `react-reviewer` + `typescript-reviewer`.

### C1 — Agent card Stop
- Reuse `POST /runtime/:id/cancel` (kills child via `chatKillMap`).
- Show **Stop ■** on an agent card/drawer ONLY when `agent.column === "in_progress"` / streaming (live).
- Click → `POST /runtime/${id}/cancel` → child SIGTERM→SIGKILL → card flips out of in_progress on next poll.
- For the boss/ceo card: cancel maps to `boss` id (alias) — `POST /runtime/boss/cancel`.
- TESTS: button renders only when in_progress; click calls cancel with right id.

### C2 — Pool modal Stop (CEO-assemble)
- `PoolPicker.tsx` "Let CEO assemble": while `ceoThinking`, the **Ask CEO** button becomes **Stop** (red ■).
- Hold an `AbortController` on the `askCeo` fetch → Stop aborts it + `POST /runtime/boss/cancel`.
- Mirrors the ChatPane stop pattern (already built): `abortRef`, swallow AbortError.
- TESTS: ceoThinking → Stop shows; stop aborts controller + posts cancel.

### C3 — Gates
- `emil-design-eng`: stop press `active:scale-95`, red token, ≤160ms.
- `security-reviewer`: `/cancel` unauth (matches /chat) — already justified; confirm id bound.
- DoD: TDD green, stop a live agent in-app → it halts; stop CEO-assemble mid-think → it aborts.

---

## PHASE D — CEO-assemble loading polish (req 7)

**Goal:** a Claude-style loading indicator on the "Describe the job" send, not the tiny spinner.

**Skills/agents:** `react-specialist` + `emil-design-eng` (loading motion) + `impeccable craft` → `frontend-design` → `react-reviewer`.

### D1 — Loading UI
- Replace the small `Loader2` with a **Claude-style pulsing dots / shimmer** in the CEO-assemble panel while `ceoThinking`.
- Disable the input + show "CEO is assembling the team…" with animated dots (3-dot bounce, staggered, `prefers-reduced-motion` respected).
- Optional: stream the CEO's pick reasoning live (reuse `readStream`) so it feels alive.
- TESTS (light): ceoThinking → loading indicator present; cleared on settle.

### D2 — Gates
- `emil-design-eng`: dot stagger, ease-out, ≤300ms loop, reduced-motion fallback.
- `hallmark audit`: not a generic spinner — intentional.
- DoD: send in CEO-assemble → clear animated loading; reduced-motion = static.

---

## PHASE B — Factory: relocate Add + wire 1800 skills (req 2, 3, 4)

**Goal:** move "Add agents" into the Factory beside Create; show all 1879 skills (searchable); let BOSS attach skills when creating an agent.

**Skills/agents:** `kw-product-management-write-spec` → `kw-engineering-system-design` (the prompt-attach model) → `sp-test-driven-development` → `react-specialist` + `frontend-design` + `impeccable craft` → `typescript-pro` → `security-reviewer` (persona-attach can't escalate) → `react-reviewer` + `typescript-reviewer` → `hallmark audit`.

### B1 — Relocate "Add agents" (req 2)
- `AgentFactory.tsx`: add an **"Add from pool"** action **beside Create** (same panel: "BOSS spawns agents · Create · Add · Skills · Accounts · Post").
- Reuse `PoolPicker` modal (already built) — just trigger it from the Factory panel too. Keep the rail `+ Add` OR move it per taste (default: both).
- TESTS: trigger renders in Factory; opens PoolPicker.

### B2 — Surface the 1879 skills (req 3)
- New endpoint **`GET /factory/skills/catalog?q=&limit=`** — paginated/searchable over a server-side skill list. BUT the 1879 live in the FRONTEND (`missionSkills.ts`). So:
  - Frontend reads `missionSkills.ts` directly (already imported by the palette) — no server round-trip needed for the list.
  - Add a **`SkillPicker.tsx`** component: searchable, virtualized (1879 rows → use windowing or simple filter+cap), grouped by `family`/`kind`.
- Replace the Factory "Skills · 9" tab label semantics: show **two groups** — "Capabilities · 9" (factory exec catalog) and "Skill priming · 1879" (prompt-attach, searchable).
- TESTS (pure, `src/lib/skillAttach.ts`): search filters; selecting builds a persona-suffix string from chosen skills' prompts; cap total attach length (e.g. 4000 chars) to protect the persona budget.

### B3 — Attach skills on Create (req 4)
- `CreateAgentFlow.tsx`: add a **skill-attach step** — search the 1879, check skills → their `prompt` strings fold into the new agent's persona (suffix: `\n\nSKILLS:\n- <prompt>\n- ...`).
- Server `POST /factory/create`: persona already accepts up to 6000 chars + `validateSpec` (secret-shape check stays). The attached skills ride inside persona → NO new field, NO new exec. The 9-skill capability catalog (`skills[]`) is UNCHANGED + still the only exec/posting gate.
- For IMPORTED pool agents: allow attaching skills too → extend `importedAgents` entry with an optional `attach` suffix (re-bind persona on import or via a new `POST /factory/pool/attach {id, skillIds}`).
- TESTS: skillAttach builds correct suffix; length cap enforced; create with attached skills → persona contains them; capability skills (the 9) still validated separately.

### B4 — Gates (CRITICAL — security)
- `security-reviewer` + `security-review` skill: PROVE prompt-attach grants no capability. The attached skill text is persona only; `--allowed-tools` at spawn is unchanged; the 9-catalog still governs exec/posting/integrations. A skill whose prompt says "use Bash" cannot — Bash is never in `--allowed-tools` for these agents.
- Confirm attach length cap + secret-shape scan on the combined persona.
- `hallmark audit` + `impeccable craft`: the 1879 picker must not look like a raw dump — grouped, searchable, fast.
- DoD: Factory shows Add beside Create; skill picker lists 1879 searchable; create an agent with 3 attached skills → persona carries them, exec capability unchanged.

---

## 4. FILE CHANGE MAP

### Server (`agent-runtime/`)
- `server.mjs` — (A) confirm pool/remove + DELETE /factory/:id reachable from UI; (C) `/runtime/:id/cancel` reused (boss alias for ceo); (B) optional `POST /factory/pool/attach {id, skillIds}` for imported-agent priming.
- No new exec paths. No change to `factory.mjs` validateSpec security (the 9 catalog stays the gate).

### Frontend (`src/`)
- NEW `src/lib/agentActions.ts` (pure) — `removableKind`, delete routing. + tests.
- NEW `src/lib/skillAttach.ts` (pure) — search + persona-suffix builder + length cap. + tests.
- NEW `src/components/factory/SkillPicker.tsx` — searchable 1879 skill picker.
- `src/components/cockpit/AgentRoster.tsx` — trash (non-ceo) + Stop (in_progress).
- `src/components/KanbanColumn.tsx` / card — trash + Stop on the kanban card.
- `src/components/factory/AgentFactory.tsx` — "Add from pool" beside Create + two-group Skills.
- `src/components/factory/CreateAgentFlow.tsx` — skill-attach step (SkillPicker).
- `src/components/cockpit/PoolPicker.tsx` — Stop on CEO-assemble + Claude-style loading.

---

## 5. EXECUTION ORDER + per-phase skill fire

1. **Phase A** (delete) — spec → TDD `agentActions.ts` → AgentRoster/Kanban UI → a11y + security + react/ts reviewers → verify in app.
2. **Phase C** (stop) — TDD → card Stop + modal Stop → emil + security + reviewers → verify (stop a live agent).
3. **Phase D** (loading) — emil + impeccable loading → react-reviewer → verify.
4. **Phase B** (factory + 1879) — system-design (prompt-attach) → TDD `skillAttach.ts` → SkillPicker + Factory + Create wiring → security-review (no escalation) + hallmark + reviewers → verify.
5. **Final** — `sp-verification-before-completion` → `kw-engineering-deploy-checklist` → full runtime + UI suite → screenshot proof per feature → commit on user word.

---

## 6. SECURITY CONSTRAINTS (non-negotiable)

1. **Prompt-attach grants ZERO capability** — attached skill text is persona only; spawn `--allowed-tools` unchanged; the 9-catalog remains the sole exec/posting gate.
2. **Delete endpoints stay auth-gated** (originOk + tokenOk). CEO never deletable.
3. **`/cancel` unauth** matches `/chat` (already justified); agentId regex-bound.
4. **Combined persona** (base + attached skills) runs the existing secret-shape scan + length cap (≤6000).
5. **No raw 1879 dump to an unauth endpoint** — the list is frontend-local (missionSkills.ts), not a new server leak.
6. **childEnv secret strip unchanged** on every spawn.

---

## 7. DEFINITION OF DONE

Per phase: TDD green · tsc 0 · relevant reviewer subagents (no CRITICAL/HIGH) · `impeccable craft` UI pass · manual in-app proof (screenshot).

Full set:
- [ ] Delete works (imported + factory), ceo has no delete
- [ ] Add agents lives in the Factory beside Create
- [ ] Skill picker lists 1879, searchable, fast
- [ ] Create attaches chosen skills into persona (no exec change — security-proven)
- [ ] Stop on each live agent card → halts the child
- [ ] Stop on CEO-assemble → aborts
- [ ] CEO-assemble shows Claude-style loading
- [ ] `hallmark audit` full pass · `kw-engineering-deploy-checklist` clear
- [ ] All tests green (runtime + new pure-lib tests)

---

*Created 2026-06-26 · Branch: `feat/cockpit-ux-enhancements` · Next: Phase A, `sp-test-driven-development`*
