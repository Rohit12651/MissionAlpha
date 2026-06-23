# PRD — Skills Command Palette (persistent, family-organized)

> Authored via `kw-product-management-write-spec`. PRODUCT SPEC (what + why + acceptance). Each
> requirement group's executable RED→GREEN build plan is produced at build time via `sp-writing-plans`
> (task-0) — see the per-requirement **Fire (CLAUDE.md)** lines + the **Build: Skill + Agent Map**.

| | |
|---|---|
| **Status** | Draft — ready for build |
| **Owner** | Rohit (boss) · design owner: `principal-ux-design` |
| **Surface** | New `src/components/skills/SkillPalette.tsx` + `src/lib/missionSkills.ts` (extend) + `scripts/gen-skills.mjs` (new) + `.claude/` (local copy) |
| **Date** | 2026-06-22 |
| **Reference mockup** | `docs/mockups/` (placement: dockable left palette, family-grouped) — approved 2026-06-22 |

---

## Problem Statement

MissionAlpha has a tiny inline `/` menu (16 hand-stubbed entries in `missionSkills.ts`, grouped only
by kind: prompt/command/skill). The operator cannot discover or invoke the **full** skill catalog
(~1,400 skills + ~180 commands available under `~/.claude/`) from the cockpit, and the catalog isn't
self-contained — it depends on what happens to be installed globally. Operators who want to apply a
specific skill (e.g. `impeccable`, `kw-engineering-code-review`, an `sp-*` step) have no organized,
searchable way to find and drop it into a chat.

**Who/when:** the operator, every time they want to invoke a skill they don't have memorized.
**Cost of not solving:** the swarm's biggest capability — its skill library — is effectively hidden;
MissionAlpha isn't portable (catalog lives outside the repo).

---

## Goals

1. **Discoverable full catalog** — the operator can find any of the ~1,600 skills/commands from the
   cockpit, grouped by family, in ≤2 keystrokes to open + a search. (Measure: any skill reachable in
   <5s via search.)
2. **Self-contained MissionAlpha** — the skill catalog lives IN the repo (`.claude/` local copy +
   generated `missionSkills.ts`); the app does not depend on the user's global `~/.claude`. (Measure:
   palette fully populated with `~/.claude` renamed away.)
3. **Organized by CLAUDE.md family** — skills are sectioned by family (Engineering, Design, Data,
   Sales, Marketing, Finance, HR, `sp-*` workflow, UI/UX, Security, Legal, FSI, Composio, ECC, …),
   not a flat list. (Measure: every catalog entry has a non-empty `family`.)
4. **Fast at scale** — the palette stays responsive (no jank) with ~1,600 entries. (Measure: open +
   scroll + filter at 60fps; first paint < 150ms.)
5. **Zero new risk** — picking a skill only drops its prompt into the composer (gated send); no new
   execution path. (Measure: `security-reviewer` PASS on the copy script + no new action surface.)

---

## Non-Goals

1. **No auto-execution of skills from the palette** — pick → drops prompt into composer; the operator
   edits + sends through the EXISTING gated flow. No "run skill" button. (Keeps the security surface
   unchanged.)
2. **No live filesystem scan at runtime** — the app reads the generated `missionSkills.ts`, never
   `fs`-scans `.claude/` in the renderer. (Packaged app + perf + security.)
3. **No editing/authoring skills from the palette** — it's a launcher, not a skill editor. (Separate
   concern; `skill-creator` exists for that.)
4. **No replacing the existing ⌘K `CommandPalette`** — that stays (app actions: switch model, open
   drawers, dispatch). The Skills palette is a SEPARATE surface for the skill catalog. They may share
   the ⌘K entry but are distinct lists. (Avoid conflating actions with skills.)
5. **No keeping the old inline 16-stub `/` menu as-is** — the inline `/` in `ChatPane` should route
   to / be superseded by the new catalog (single source of truth = generated `missionSkills.ts`).

---

## User Stories

**Operator (boss) — primary**
1. As the operator, I want to open a Skills palette from the title bar / `/` / ⌘K, so I can browse
   the full skill library without leaving the cockpit.
2. As the operator, I want skills grouped by family with collapsible sections, so I can scan a
   category (e.g. all UI/UX skills) instead of one giant list.
3. As the operator, I want to search by name or hint, so I can jump to a skill I half-remember.
4. As the operator, I want to pick a skill and have its prompt dropped into the chat composer, so I
   can edit and send it through the normal gated flow.
5. As the operator, I want the catalog to be complete and in-repo, so MissionAlpha works the same on
   any machine regardless of my global `~/.claude`.

**Maintainer**
6. As a maintainer, I want a single command (`npm run gen:skills`) that re-syncs the catalog from the
   local `.claude/`, so adding a skill is one step.

**Edge cases**
7. As the operator searching a term with no matches, I want a clear empty state, not a blank panel.
8. As the operator, I want ↑↓/Enter/Esc + a focus ring, so I can drive the palette by keyboard.

---

## Requirements

### Must-Have (P0)

**C1 — Vendor the catalog into the repo (`.claude/` local copy)**
Copy the global `~/.claude/skills/` + `~/.claude/commands/` into MissionAlpha's local `.claude/`
so the repo is self-contained.
- Acceptance:
  - Given the copy script (`scripts/copy-skills.mjs` or documented `rsync`), When run, Then
    `.claude/skills/` + `.claude/commands/` contain the full set (~1,439 + ~178), with each skill's
    `SKILL.md` (+ assets) intact.
  - Given a `.gitignore` review, Then the vendored `.claude/` is committed (or an explicit decision
    recorded if too large — see Open Questions) and does NOT include secrets/credentials.
  - Given `~/.claude` renamed away, Then the next build still produces a full catalog (self-contained).
- **Fire (CLAUDE.md):** `sp-writing-plans` → `node-specialist` (copy script) → `terminal-ops` (safe
  bulk copy) → **`security-reviewer` (BLOCKING — copying many files: confirm no secrets/keys/tokens
  vendored, path-safe, no symlink escape)** → `sp-verification-before-completion`. **Agents:**
  `node-specialist`, `security-reviewer`.

**C2 — Catalog generator → `missionSkills.ts`**
A re-runnable generator scans the LOCAL `.claude/skills` + `.claude/commands` and writes the full
categorized catalog into `src/lib/missionSkills.ts`, adding a `family` field to `MissionSkill`.
- Acceptance (Given/When/Then):
  - Given `scripts/gen-skills.mjs`, When run (`npm run gen:skills`), Then `missionSkills.ts` is
    rewritten with one entry per skill/command: `{ id, kind, family, title: "/id", hint, prompt }`.
  - Given a skill id, When categorized, Then `family` is assigned by a PURE `familyOf(id, sourceDir)`
    mapping (e.g. `sp-*`→"sp · workflow", `kw-engineering-*`→"engineering", `kw-design-*`→"ui/ux" or
    "design", `impeccable|hallmark|emil-*|taste*`→"ui/ux", `legal-*`→"legal", `fs-*`→"finance",
    `composio-*`→"integrations", `ecc/*`→"ecc", else "misc"). `familyOf` has RED→GREEN unit tests.
  - Given a command vs a skill, Then `kind` is set correctly (`command` for `.claude/commands`,
    `skill` for `.claude/skills`); `hint` comes from the skill/command description (first line / frontmatter).
  - Given the generator runs twice with no source change, Then the output is byte-identical
    (deterministic ordering: family → id).
  - Given the existing hand-curated prompt entries (standup/review/unblock/ship), Then they are
    PRESERVED (merged, kind "prompt", family "prompts").
- **Fire (CLAUDE.md):** `sp-writing-plans` → `node-specialist` (generator) → `sp-test-driven-development`
  (pure `familyOf` + parse) → `sp-verification-before-completion`. **Agents:** `node-specialist`,
  `typescript-reviewer` (the emitted `missionSkills.ts` must typecheck), `data-engineer` (catalog
  shape/dedup at scale).

**C3 — Persistent dockable Skills palette UI**
A new `SkillPalette` — dockable left panel (per the approved mockup) — opened from a title-bar
"✦ Skills" button, `/`, or ⌘K; grouped by family (collapsible), searchable, keyboard-navigable;
**virtualized** for ~1,600 rows; pick → drops the prompt into the chat composer.
- Acceptance (Given/When/Then):
  - Given the cockpit, When the operator clicks "✦ Skills" / presses `/` (empty composer) / ⌘K-skills,
    Then the dockable Skills palette opens and STAYS open (persistent) until closed (Esc / ✕ / toggle).
  - Given the palette open, Then skills render in **collapsible family sections** with the family
    name + count; default expanded for the top families, collapsible.
  - Given a search query, Then the list filters across id + hint live; matching is debounced; an
    empty result shows a clear empty state.
  - Given ~1,600 entries, Then scrolling/filtering stays at 60fps (list is **virtualized** — only
    visible rows mount).
  - Given ↑↓/Enter/Esc, Then the operator can move selection, pick (Enter), and close (Esc) by keyboard.
  - Given a pick (click or Enter), Then that skill's `prompt` is dropped into the chat composer and
    focus moves there (reuse the existing `pickSkill` behavior); the palette may stay open or close
    (design decision — default: close on pick).
  - Given the palette is open, Then the cockpit behind it dims but stays visible (docked, not modal-blocking).
- **Fire (CLAUDE.md):** `sp-writing-plans` → `hallmark` (anti-slop structure) → `impeccable`
  (`craft`/`layout`/`typeset` the palette + rows) → `emil-design-eng` (open/close + dim motion ≤200ms)
  → `frontend-design` → `sp-test-driven-development` → `webapp-testing` (open/search/pick, dev+packaged)
  → `sp-verification-before-completion`. **Agents:** `principal-ux-design` (palette design contract),
  `react-specialist` (virtualized list + state), `react-reviewer`, `performance-engineer` (virtualization
  + 60fps at 1,600 rows), `ui-ux-tester`.

**C4 — Accessibility**
The palette is fully keyboard + screen-reader operable.
- Acceptance:
  - Given keyboard-only, Then open → search → navigate → pick → close all work; visible focus ring
    throughout; family headers are real buttons (`aria-expanded`); list uses `role="listbox"` +
    `aria-activedescendant`.
  - Given a screen reader, Then each row announces id + family + kind; the result count is announced
    (`aria-live`).
  - Given `prefers-reduced-motion`, Then open/close + dim are instant (no animation).
  - Contrast ≥ 4.5:1 on all palette text.
- **Fire (CLAUDE.md):** `sp-writing-plans` → `kw-design-accessibility-review` → `sp-test-driven-development`
  → `sp-verification-before-completion`. **Agents:** `a11y-architect` (WCAG 2.2), `accessibility-tester`, `ui-ux-tester`.

### Nice-to-Have (P1)

- **C-P1-1 — Recent / favorite skills** — pin or surface recently-picked skills at the top.
- **C-P1-2 — Fuzzy search + family filter chips** — fuzzy match + click a family chip to scope.
- **C-P1-3 — Inline `/` menu reads the same catalog** — the ChatPane `/` popup uses the generated
  catalog (top results) so the two surfaces share one source of truth.

### Future Considerations (P2)

- **C-P2-1 — Skill detail preview** — hover/select shows the skill's description/SKILL.md excerpt.
- **C-P2-2 — Per-agent skill grants** — show which skills an agent is allowed to use.
- **C-P2-3 — Usage analytics** — most-used skills, surfaced for quick access.

---

## Success Metrics

**Leading (days)**
- Catalog completeness: generated entries ≈ source count (skills+commands) → **≥99%** parsed.
- Palette open rate: % of sessions that open the Skills palette → target **≥50%** in 2 weeks.
- Search-to-pick time → **<5s** median in usability check.
- Perf: open + filter at **60fps**, first paint **<150ms** with full catalog.

**Lagging (weeks)**
- Skill usage breadth: # of distinct skills invoked per week rises (catalog is actually used).
- Portability: MissionAlpha runs with a complete catalog on a fresh machine (no global `~/.claude`).

---

## Build: Skill + Agent Map (CLAUDE.md — MANDATORY, fire per phase)

Every group: **task-0 = `sp-writing-plans`** → **`sp-subagent-driven-development`** → **`sp-test-driven-development`** → **`sp-verification-before-completion`**. Specialists per group:

| Group | Skills (fire in order) | Agents | Gate |
|---|---|---|---|
| **C1** vendor `.claude/` | `sp-writing-plans` → `terminal-ops` | `node-specialist`, `security-reviewer` | **security-reviewer BLOCKING** (no secrets vendored) |
| **C2** generator → `missionSkills.ts` | `sp-writing-plans` → `sp-test-driven-development` | `node-specialist`, `typescript-reviewer`, `data-engineer` | typecheck of emitted file |
| **C3** palette UI | `sp-writing-plans` → `hallmark` → `impeccable` → `emil-design-eng` → `frontend-design` → `webapp-testing` | `principal-ux-design`, `react-specialist`, `react-reviewer`, `performance-engineer`, `ui-ux-tester` | 60fps @ 1,600 rows |
| **C4** a11y | `sp-writing-plans` → `kw-design-accessibility-review` | `a11y-architect`, `accessibility-tester`, `ui-ux-tester` | WCAG 2.2 |

Rule: **never free-code a phase** — `sp-writing-plans` first, then the agents. Commit per GREEN.
**C1 gates on `security-reviewer`** before commit (bulk file vendoring).

---

## Verified Code Anchors (2026-06-22)

- `src/lib/missionSkills.ts` — `MissionSkill { id, kind, title, hint, prompt }` (ADD `family`);
  `MISSION_SKILLS`, `KIND_LABEL`, `filterSkills(query)`. 16 stub entries today.
- `src/components/workspace/ChatPane.tsx` — inline `/` menu: `slashQuery`/`skillResults`/`pickSkill`
  (`setInput(s.prompt)` + focus). Reuse `pickSkill` semantics for the palette's drop-prompt.
- `src/components/CommandPalette.tsx` — existing ⌘K **action** palette (`commands: PaletteCommand[]`),
  SEPARATE from the new Skills palette; may share the ⌘K entry, distinct lists.
- `src/App.tsx` — `paletteOpen` state + `<TitleBar onOpenPalette/>`; add a parallel `skillsOpen` +
  `onOpenSkills` (title-bar "✦ Skills" button) + `<SkillPalette>` mount.
- Sources: local `.claude/skills/` (present), `.claude/commands/` (present); global `~/.claude/skills`
  (~1,439), `~/.claude/commands` (~178) = copy source for C1.

---

## Open Questions

- **[eng — blocking for C1]** Vendoring ~1,600 skill files into git — commit them, OR keep `.claude/`
  gitignored + ship via a setup script / `extraResources`? (Default: commit a PRUNED set — `SKILL.md`
  + `*.md` only, strip heavy assets — and record size; reconsider if > ~50MB.)
- **[product — non-blocking]** On pick, close the palette or keep it open for multi-pick? (Default: close.)
- **[design — non-blocking]** Family taxonomy: collapse the long tail (`composio-*` ~800) under one
  "Integrations" family with a sub-search, vs many tiny families? (Default: one "Integrations" family.)
- **[eng — non-blocking]** Should the inline `/` menu be replaced now (C3) or in P1 (C-P1-3)?
  (Default: P1 — keep inline working, unify later.)

---

## Timeline Considerations

- No hard deadline. Order: **C1 → C2 → C3 → C4**. C1+C2 are tooling/data (no UI); C3 is the visible
  palette; C4 is the a11y pass. Each is independently shippable.
- Dependency: C3 depends on C2's `family` field + populated catalog; C2 depends on C1's local `.claude/`.
- Risk: catalog SIZE (C1 vendoring + C3 render at 1,600 rows) — mitigated by pruned vendoring +
  virtualization (both P0 acceptance).

---

## Self-Review (spec quality)
- Goals measurable (completeness ≥99%, open rate, search<5s, 60fps, security PASS). ✔
- Non-goals prevent scope creep (no auto-exec, no runtime fs-scan, no skill editor, keep ⌘K palette). ✔
- Every P0 has Given/When/Then incl. negative/edge (empty search, reduced-motion, ~/.claude removed). ✔
- Per-group CLAUDE.md skills + agents named; C1 security-gated (bulk vendor). ✔
- Blocking open question surfaced (vendor-to-git vs gitignore+ship). ✔
- Scale (1,600 entries) addressed in goals + perf P0 + timeline risk. ✔
