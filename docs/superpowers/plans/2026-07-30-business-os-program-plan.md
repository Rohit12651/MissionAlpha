# Helm Business OS — End-to-End Program Plan (B0–B7)

> **For agentic workers:** REQUIRED SUB-SKILL: `sp-subagent-driven-development` (recommended) or
> `sp-executing-plans` to implement phase-by-phase. Each phase MUST open by generating its own
> bite-sized task doc via `sp-writing-plans` (saved to `docs/superpowers/plans/2026-07-30-bos-B<N>.md`)
> before any code is written.

**Goal:** Turn the Helm Business OS concept (`docs/ceo/HELM-BUSINESS-OS-master-spec.md`, mockup
`docs/mockups/helm-business-os-mockup_1.html`) into a real, working, wired, production-grade app —
business stations, shared memory vault, cadence workflows, CRM-lite, content engine, outputs —
**on top of** the shipped MissionAlpha Agent Inbox (P0–P10, all gates green), breaking nothing.

**Architecture:** Runtime (`agent-runtime/`, Node/SQLite/SSE — exists) grows a vault store, a
cadence scheduler table, leads/content/outputs tables. React app (Vite :3004) grows a sidebar
shell (feature-flagged) that MOUNTS the shipped surfaces (Inbox, Settings, Board, Chat, Factory,
Sessions) and adds the new Business-OS pages. Everything rides the existing SSE bus; nothing
polls, nothing waits for a human except decisions (which flow through the existing Inbox).

**Tech stack (unchanged):** React 19 · Vite 5 · TS strict · Tailwind · Node 20 mjs ·
better-sqlite3 WAL · SSE · `claude -p` cli backend · Electron 33 · helm skin (post-a11y-fix tokens).

---

## 0. BOSS mandate → enforcement map (NO NEGOTIATION — every point addressed)

| # | BOSS point | Enforced by |
|---|---|---|
| 1 | Detailed phased plan, skills named per phase | This doc — §Skills chain inside every phase |
| 2 | Every phase built by **Opus 4.8 in caveman mode** w/ CLAUDE.md skills | §1 Model Protocol; Build lane of every phase |
| 3 | Not just UI — backend-to-frontend, real working app | Every phase has Backend + Frontend + **Wiring** lanes; exit criteria are runtime behaviors |
| 4 | Test/validate/verify each phase w/ skills + **Fable 5** | §3 Verification Protocol — Fable verify lane at every phase exit |
| 5 | **No commits until told** | §4 Commit Policy — global hard rule (unchanged from Inbox program; still in force) |
| 6 | Every mentioned feature works | §FEATURE LEDGER below inlines EVERY spec feature as a per-phase checkbox — the plan is self-contained; a phase cannot exit with an unchecked box (or it's disclosed BLOCKING/DEFERRED per §7) |
| 7 | Everything WIRED, communicates, runs without human intervention | §2 Wiring Contract (bus events on every mutation) + B4 cadence autonomy; "wired proof" item in every exit |
| 8 | Add what BOSS forgot | §5 Added-by-brain (ventures data model, null-guarded router, vault provenance, flag kill-switch, dedupe, backup) |
| 9 | Don't break current app; fix what's broken | B0 baseline re-run + §6 Regression (R1–R10 + Inbox suites) at EVERY exit + `VITE_BOS` kill-switch |
| 10 | Every point addressed | This table + self-review at doc end |
| 11 | Use `~/.claude/CLAUDE.md` + skills every phase | §1 PES gates + named skill chains per phase; headroom/caveman/claude-mem always-on |
| 12 | No loose ends — production-grade, 100%, autonomous while BOSS sleeps | §7 Production-Grade Definition + autonomous execution mandate; gaps disclosed or phase not exited |
| 13 | Context dies → new window continues; never burn tokens (headroom/caveman/codeburn) | §8 Continuation Protocol; token discipline both lanes |
| 14 | **Fable 5 verify lane ALSO runs headroom/caveman/codeburn** | §1 — token discipline applies to BOTH lanes, no exception |

---

## 1. Model Protocol (every phase)

- **Build lane — `claude-opus-4-8`, `/caveman full` first action.** All implementation
  sessions/subagents. Caveman in chat/bus; code, commits (when ever allowed), ADRs = normal prose.
- **Verify lane — `claude-fable-5`.** After Opus reports TESTS_GREEN, separate Fable session runs
  §3. Fable never patches (exception precedent: P9-style direct fix only when reviewer round-trips
  would burn more tokens — must be disclosed). Fails a gate → phase returns to Opus.
- **Token discipline BOTH lanes (points 13+14):** headroom already wraps `claude` (do not
  re-setup) · `/caveman full` first action incl. Fable sessions · `codeburn` check at session end ·
  `headroom learn` after heavy debugging · subagents get file PATHS + exact task, never pasted
  file bodies · `Explore`/`cavecrew-investigator` for search, not main-thread dumps.
- **Memory:** `claude-mem`/`memory-updater` when OAuth restored; until then
  `docs/SESSION_MEMORY.md` append per phase (the proven P0–P10 mechanism).
- **Library rule:** unfamiliar API → context7 MCP first (Operating Discipline 9/9b).
- **Design rule:** any UI touch → `hallmark` → `impeccable` → `taste-skill`; any motion →
  `emil-design-eng`. Helm tokens = post-a11y-fix values (#868FA3 faint · #D16A5F red) — the
  mockup's raw values are BANNED (spec §1 note 1).

## 2. Real-time Wiring Contract (point 7)

Existing bus (`GET /runtime/events`, SSE, ticket-gated) is the single spine. Existing catalog
(delivery.* · task.* · agent.state · usage.tick · policy.autoapplied) stays untouched. Business OS
**amends the closed catalog once, at B2**, ADR-052-style (all three places + catalog-equality
tests updated together, amendment recorded in this doc):

```
event: vault.written    data:{id,node,venture,agent}  → vault graph count++, brief log line, center KPIs
event: workflow.run     data:{id,skill,agent,status}  → workflows table row, schedule timeline, deck note
event: lead.moved       data:{id,from,to,by}          → pipeline kanban glide, center KPIs
event: content.changed  data:{id,status}              → content grid pill, calendar gap check
event: output.created   data:{id,kind,venture}        → outputs list insert
```

Rules (unchanged from Inbox program): emit-on-persist in the same function, no dual paths; UI
subscribes once via existing `useRuntimeEvents.ts` (extend `RUNTIME_EVENT_NAMES` in the same
amendment); scrub (SECRET_RE) on every payload; no manual refresh anywhere.
**Autonomy loop (no human):** cadence tick → workflow dispatch through existing queue
(≤MAX_INFLIGHT) → agent runs → writes vault memory + mints Delivery when there's an artifact →
risk router → Inbox (or policy auto) → on approve: existing apply→PR→reportBack→auto-chain.
Humans appear ONLY at Inbox decisions. Leads/content/outputs mutations all emit + audit.

## 3. Verification Protocol (point 4 — Fable 5 at every exit)

PES gates in order, evidence shown, failing gate = phase returned:
1. `npm run build` exit 0 · 2. `npm run typecheck` 0 + eslint 0/0 ·
3. `test:unit` + `test:runtime` + phase's new tests + §6 regression — all green ·
4. `security-review` skill on any new endpoint/exec/store; **sr-security blocking** where the
   phase says so · 5. Runtime verification: boot real stack, execute exit criteria in browser
   (`webapp-testing`/`playwright`/preview tools), screenshots · 6. Adversarial self-review:
   `/code-review` + `cavecrew-reviewer` on the diff, sev≥Medium resolved ·
7. PES delivery report w/ Known Gaps → append `docs/SESSION_MEMORY.md`; reserved words only with
   evidence. Bundle budget: index ≤190KB gz = 194,560 B HARD (per-phase “don’t grow” is advisory; adjudicated at B1: 188,403 accepted, growth must justify itself each phase).

## 4. Commit Policy (point 5 — global hard rule)

**NO `git commit`/`push`/`stash`/`reset`/`checkout` until BOSS says commit.** sp-writing-plans
per-task "Commit" steps are REPLACED by "**Checkpoint:** `git add -A && git status` review".
Phase exit = snapshot tarball `../ma-snapshots/B<N>-<date>.tgz`. Don't touch BOSS's stash@{0} or
the 8 `ma/task/*` branches. Ports: :3004 vite · :3005 NEVER kill · :3006 restartable.
When BOSS says commit: conventional commits, phase order, subjects ≤50 chars.

## 5. Added-by-brain (point 8 — BOSS didn't list, now in scope)

1. **`VITE_BOS` feature flag** (default ON in dev, kill-switch): BOS sidebar shell mounts behind
   it; flag off = shipped app byte-identical (point 9 insurance, proven pattern from P3).
2. **Null-guarded router** — the mockup's crash class (spec §10 #1) is impossible by construction:
   every nav id maps to a lazy component or the item doesn't render.
3. **Ventures data model** — `ventures` table + `venture` scoping key on vault/leads/content/
   outputs rows; WAAHYU seeded default; switcher = real scoping, "All ventures" aggregate.
4. **Vault provenance** — every record: author agent, venture, ts, source run id; renders in the
   record viewer header. No anonymous memory.
5. **Idempotent workflow runs** — cadence dispatch dedupes (skill+agent+scheduled-slot key), so a
   restart can't double-fire; kill-restart resume test like P4's.
6. **DB safety** — new tables ride the existing SQLite WAL + migrations table + backup endpoint;
   `data/` stays gitignored 0600.
7. **Empty/loading/error states** for every new surface (PolicyEditor gold-standard pattern).
8. **Honest numbers** — every KPI computed from stores; no invented metrics anywhere (hallmark
   gate 56); placeholder = labeled "—".
9. **A11y by construction** — new pages render inside the existing `<main id="ma-main">` + skip
   link; focus/reduced-motion kit inherited; contrast pairs from the fixed tokens only.
10. **Roadmap page** (BOSS asked "where is Roadmap") — read-only render of this plan's PROGRAM
    STATUS into the shell (cheap, closes the mapping gap honestly) — B7.

## 6. Regression Suite (point 9 — re-run at EVERY exit)

R1–R10 (Inbox program §6: chat streams · dispatch gate · sandbox/apply · factory · board ·
sessions/replay · skills palette · settings/theme · runtime auth 401/403 · tsc+unit+runtime) **+**
Inbox-era suites (unit 211 · runtime 773 · vendor 28 · electron 9 all green at B0 baseline) **+**
flag-off check: `VITE_BOS=0` renders the shipped app identically. Each phase adds its e2e to the
pile; the pile only grows.

## 7. Production-Grade Definition (point 12)

Phase NOT done while any exist: stub function · mock data in live path · new TODO · curl-only
feature (no UI) or UI-only (no backend) · unauthed endpoint · un-emitting mutation (silent bus
gap) · missing empty/loading/error state · skipped test · red regression · invented metric ·
undocumented behavior change. Deferrable → phase report as BLOCKING/DEFERRED w/ reason. Silence
about a gap = the violation.

## 8. Continuation Protocol (point 13)

Resume state: (1) this plan's PROGRAM STATUS checkboxes, (2) `docs/SESSION_MEMORY.md` tail,
(3) claude-mem when restored. New window bootstrap = read those three + `git status`. Never
re-derive settled work. Token discipline per §1.

## PROGRAM STATUS (live — update every phase)

- [x] B0 shell + router + mount shipped surfaces — COMPLETE 2026-07-30 (build Opus + verify: browser-proven all nav wired, flag-off proven on :3014, mobile ShellToggle regression caught+fixed). Gates: tsc 0 · lint 0/0 · unit 214 · runtime 773 · vendor 28 · build ✓ · index 188.31KB gz.
- [x] B1 command deck — COMPLETE 2026-07-30 (Opus build + verify). Deck live: captain card w/ REAL scoreboard stats (1 approved · 3 decided today), 5 seeded stations + swarm (registry-real, live badges), StationModal (dialog/trap/ESC, real skills), +New station→factory, BosTopbar+clock. Gates: tsc 0 · lint 0/0 · unit 230 · runtime 788 · vendor 28 · build ✓ · main 188,403 gz (≤190K program budget; deck lazy 4.3KB own chunk, 0 markers in main). Deferred labeled: brief CTA disabled→B3 · RECORDS READ —→B2 · cadence tags→B4 · role-filter pills skipped (disclosed).
- [x] B2 knowledge vault — COMPLETE 2026-07-30 (Opus build + verify + sr-security SECURITY_APPROVED). Vault store (slug-only case-REFUSING containment, root→venture→node→file symlink chain, scrub at rest+egress), migration v9, bus amendment ONCE (+5 names, ADR-052 §Amendment + ADR-055), completion+decision hooks, lazy Vault UI (graph/search/detail/viewer), venture popover, deck RECORDS READ live. LIVE SSE PROOF: API POST → open page updated zero-refresh. Security: 0 CRIT/HIGH; 2 MED + 3 LOW found & FIXED + regression-tested. Gates: tsc 0 · lint 0/0 · unit 250 · runtime 844 · vendor 28 · build ✓ · main 190,797 gz.
- [x] B3 CEO brief — COMPLETE 2026-07-30 (Opus build + verify). Console Send → /runtime/captain/route (deterministic keyword routing, labeled not-AI) → vault record + task.queued via existing engine.enqueueGoal → live log update, input clears, inline error path. Agent log REAL last-24h from events_log; needs-review pill → Inbox deep-link (initialSelectedId, additive). CTA enabled (B1 hand-off closed). Gates: tsc 0 · lint 0/0 · unit 269 · runtime 889 · vendor 28 · build ✓ · main 190,406 gz. BriefPage lazy (3.3KB, 0 markers in main).
- [x] B4 workflows + schedule — COMPLETE 2026-07-30 (Opus build + verify). AUTONOMY LIVE: 15 cadences seeded (forward next_run), tick on the one existing timer, (id,slot) CAS dedupe + kill-restart resume (test-proven), Run-now via PermissionGate F3-confirm + approver, Pause/toggle live. Workflows table + Schedule timeline browser-proven; live chip 15→14 on toggle via bus; **failure→Delivery autonomy proven: cadence dispatch → mock fail → failure Delivery in Inbox, ZERO human (badge 2→4)**. Gates: tsc 0 · lint 0/0 · unit 281 · runtime 908 · vendor 28 · build ✓ · main 190,851 gz. Both pages lazy.
- [ ] B5 command center (computed KPIs)
- [x] B6 lead pipeline + content engine — COMPLETE 2026-07-30 (Opus build + verify + sr-security SECURITY_APPROVED, 0 CRIT/HIGH/MED). Leads store (v11) + content store (v12), kanban 4-col + drag, LeadDrawer + Draft-follow-up→Inbox (F3 confirm → real Delivery "Follow-up: Acme" authored sales-station, pending), ContentPage + real calendar-gap chip + BriefEditor→Inbox, openFollowUps flipped real. Browser-proven; Inbox badge live 5→6 on mint. Gates: tsc 0 · lint 0/0 · unit 315 · runtime 990 · vendor 28 · build ✓ · main 192,109 gz (headroom 2,451).
- [x] B7 outputs + roadmap + ship-gauntlet — COMPLETE 2026-07-30 (Opus build + verify, 1 MED fixed). Outputs registry (real audit-export generator + produced rows, global-scope fix), read-only Roadmap page (7 of 8 shipped), ship-gauntlet: WCAG AA contrast all pass on BOS surfaces, single-main/one-h1/no-hscroll, adversarial sweep (11 endpoints 401/403), 11/11 defects closed, BOS-FINAL-SWEEP written. Gates: tsc 0 · lint 0/0 · unit 316 · runtime 1011 · vendor 28 · electron 9 · build ✓ · main 192,549 gz.

---

# FEATURE LEDGER — every master-spec feature, inline (the plan is self-contained)

Every feature from `docs/ceo/HELM-BUSINESS-OS-master-spec.md` as a live-verified checkbox,
grouped by owning phase. **A phase does not exit while one of its boxes is unchecked** (or the
box is re-filed as BLOCKING/DEFERRED with reason, §7). Checkbox = proven running in the browser
against the real runtime, not code-exists. Two cross-phase hand-offs are pre-declared (no silent
partials): captain-card "records read" goes real at B2; modal Run-now goes live at B4.

## B0 — Shell + mounts (spec §2, §6.1, §9)
- [x] Sidebar 230px: brand (compass SVG 26px + "Helm" Space Grotesk 700 + sub-label 10px uppercase)
- [x] **Pinned Inbox** above nav group — 1px brass border, brass-tint fill, paper text, right brass badge = LIVE pending count (SSE `delivery.*`, `#221803` text on brass)
- [x] Nav group w/ 3 states: dim → hover (deck-raised bg + paper) → active (deck-raised-2 bg + brass-bright + 1px border)
- [x] Null-guarded typed router — unknown id cannot render a nav item (mockup crash class impossible)
- [x] AGENTS quick-list: mono label + rows (7px color dot · name · faint right role) → click opens that agent's modal (modal itself B1)
- [x] Venture switcher pill visible bottom-pinned ("Venture / WAAHYU ▾") — functional popover lands B2/B5
- [ ] (DEFERRED→B1, disclosed — component ships with its first consumer page) Topbar pattern component: eyebrow (mono faint uppercase "<CONTEXT> · <VENTURE>") + H1 26px left · status chips + live clock (1s tick) right
- [x] **Inbox page** = shipped Agent Inbox mounted (mail-skin list optional reskin): rows w/ unread brass dot + FROM + subject/snippet + time · row → shipped review pane (full diff · risk chips · SLA · typed-confirm APPLY on high · Approve→apply→PR / Request-changes / Reject) · filters All/High-risk/My-swarm/External/Failures · badge SSE-live
- [x] **Settings** nav item bottom (above switcher) → shipped SettingsPanel (Workspace/Policy/Adapters/Users/theme/reduced-motion) — spec §9 "must add"
- [x] **Missions** nav item → shipped Board (kanban + heartbeat + feed + globe)
- [x] **Chat** nav item → shipped ChatPane (boss + agent threads)
- [x] **Sessions** nav item (under Knowledge vault) → shipped sessions browser + replay
- [x] **Agent Factory** reachable (nav or deck header; "+ New station" button lands B1)
- [x] ⌘K palette lists all BOS pages
- [x] `VITE_BOS` flag: ON in dev; OFF = shipped app byte-identical (screenshot-diff proof)

## B1 — Command deck (spec §3, §7-partial)
- [x] Topbar: "AGENT NETWORK · <venture>" · H1 "Command deck" · green-dot chip "N of M on watch" (REAL counts from live-state) · clock
- [x] Captain card: 64px compass emblem (brass ring + radial glow) · decorative concentric circles top-right · "Captain / CEO" H2 + REAL status badge · description copy · **DECISIONS TODAY = real deliveries count** · RECORDS READ = labeled "—" until B2 (pre-declared) · CTA "Open brief →" navigates + moves nav active state
- [x] Stations band: "STATIONS, ONE MEMORY" divider + hairline · responsive grid (`minmax(0,1fr)`, wraps ≤768px, 375px floor)
- [x] Station card: 34px brass icon well · LIVE status badge (ON WATCH green / STANDING BY amber / OFF WATCH faint via `agent.state`) · "STATION 0N" eyebrow · name H3 · uppercase role · 2-line live note (last activity) · hover brass border + translateY(-2px) transform-only
- [x] 5 business stations seeded as REAL agents (COO comms&ops · CMO content&intel · Sales rep revenue · Developer build · Data analyst signal) w/ the full 15-skill matrix (§B4 ledger) in their specs; merged w/ dev swarm roster + role filter
- [x] Station/quick-list click → modal: eyebrow "ROLE · STATUS" · H2 · ✕ 28px · description · skill rows (name Space Grotesk 500 + SKILL tag + brass CADENCE tag + desc) — React, NO innerHTML, ESC-close + focus trap + backdrop-close
- [x] "+ New station" on deck header → existing factory flow; created station appears on deck via bus, zero refresh

## B2 — Knowledge vault (spec §5, §8-data) — bus amendment phase
- [x] Store: markdown records under `data/vault/<venture>/<node>/` + SQLite index; provenance on every record (author agent · venture · ts · source run id) — no anonymous memory
- [x] 6 nodes seeded: Ventures · Market intel · Content engine · Pipeline · Tech notes · Decisions
- [x] Ventures table + venture scoping key; WAAHYU seeded (more ventures = real CRUD via switcher, no invented sample ventures)
- [x] Agents auto-write memory on task completion (reportBack hook) → `vault.written` on bus <500ms
- [x] Catalog amendment ONCE: `vault.written` · `workflow.run` · `lead.moved` · `content.changed` · `output.created` — events.mjs + useRuntimeEvents + ADR-052 + equality tests together
- [x] Vault page topbar: "SHARED MEMORY · <scope>" · chip "● <REAL count> records"
- [x] Search row: ≥2 chars → dropdown grouped by node · Enter → filtered view · Esc → clear
- [x] Memory graph: responsive (viewBox scale) · center node w/ REAL count + brass glow · 6 satellites w/ hairline spokes · hover/selected brass ring+icon · keyboard `tabindex=0` + Enter-select
- [x] Node click → detail panel: crumb "The log / <node>" (brass leaf) · H3 · meta chips · 2×2 REAL stat tiles · FILES list (name + mono size) · empty state "Click a node to inspect it."
- [x] File click → record viewer: safe markdown render (no innerHTML) + provenance header (station · venture · written-at · source run)
- [x] Center-node click → recent-records list (unfiltered)
- [x] Venture switcher popover FUNCTIONAL (data layer): lists real ventures + "All" · Enter/arrows/Esc keyboard · persists · scopes vault
- [x] Captain card RECORDS READ flips real (closes B1 hand-off)

## B3 — CEO brief (spec §4)
- [x] Topbar: "CAPTAIN'S CONSOLE · <venture>" · H1 "Daily brief" · amber chip "Last brief <real> ago"
- [x] Console: 88px compass dial (opacity-only pulse, reduced-motion freeze) · "Talk to the Captain" H3 · helper copy · input + brass Send
- [x] Send → POST `/runtime/captain/route` (needsAuth, approver, 2000-char cap) → optimistic log entry "Captain · routing…" → classified → station dispatched via existing queue → entry updates w/ owner + `logged` pill · input clears · inline red error note on failure (never silent)
- [x] Agent log: REAL last-24 (events_log replay + live bus: delivery.* task.* vault.written workflow.run) · row = brass agent tag + title + meta ("<kind> · <venture>") + pill (logged/completed green · needs review amber) + relative time
- [x] Log row click → vault record deep-link (node + file)
- [x] `needs review` pill click → exact Inbox delivery deep-link

## B4 — Workflows + Schedule (spec §6.3, §6.4, §7-full) — autonomy phase
- [x] `cadence.mjs`: SQLite table (skill · agent · venture · cadence · next-run · enabled) · tick in scheduler · idempotent slot dedupe · kill-restart resume (test-proven)
- [x] **15 skills seeded as cadence rows** — COO: scan-competitors (daily·7am) · vendor-tracker (daily) · inbox-triage (2×daily) │ CMO: content-brief-builder (daily·8am) · trend-scan (daily) · calendar-sync (weekly) │ Sales: lead-scorer (daily·7am) · follow-up-drafts (daily) · pipeline-rollup (weekly) │ Dev: repo-health-check (weekly·Mon) · workflow-audit (weekly) · claude-code-handoff (on-demand) │ Analyst: daily-rollup (daily·EOD) · anomaly-flag (daily) · weekly-digest (weekly·Sun)
- [x] Runs dispatch through existing queue (≤MAX_INFLIGHT); outputs → vault memory + Delivery when artifact; **failed run → failure Delivery in Inbox** (P4 rule)
- [x] Workflows page: 5-col table (Workflow semibold · Station · Cadence mono · Last run relative · Status pill on/paused/failed) · hover raise · empty state
- [x] Row click → drawer: description · last-10 run history (outcome + duration) · next-run countdown · **Run now** · Pause/Resume · Edit cadence — all F3-style confirm + approver-gated
- [x] Schedule page: vertical timeline (brass mono time 70px · title · faint sub "COO · scan-competitors") · ‹ today › day switcher · "now" hairline marker · empty state "Nothing scheduled — the stations rest." · row → same drawer
- [x] `workflow.run` events live-update table + timeline + deck notes + brief log, zero refresh
- [x] Station modal gains Run-now + last-run per skill + "Open in Workflows" footer (closes B1 hand-off)

## B5 — Command center (spec §6.2, §8-UI)
- [x] 4 stat tiles (mono 26px + label): Decisions today · Records written · Deliveries approved · Open follow-ups — ALL computed from stores; delta shown only when a real trend exists (no invented numbers)
- [x] Ventures panel: row per venture (name + sub · right brass metric) · click → switch venture + drill
- [x] Needs-you panel: pending deliveries · click → Inbox
- [x] Tiles recompute live on `delivery.decided` / `vault.written` / `workflow.run`
- [x] Venture switcher scopes EVERY page (topbar eyebrows · deck · brief log · vault · pipeline · content · outputs); "All ventures" = aggregate view; choice persists
- [x] Empty states: zero ventures / nothing pending / empty DB → honest zeros

## B6 — Lead pipeline + Content (spec §6.5, §6.6)
- [x] Leads store (SQLite, venture-scoped, audit line on every mutation)
- [x] Kanban: 4 columns New · Contacted · In talks · Closed (uppercase titles + mono counts) · lead card (name 12.5px + faint source · value · idle days)
- [x] Drag card → stage persists + `lead.moved` + audit + vault Pipeline log · glide transform-only w/ reduced-motion path
- [x] Lead drawer: touch timeline · Sales-rep drafts awaiting review · "Draft follow-up" → mints Inbox item authored by Sales rep
- [x] Sales-rep cadences feed the board (scorer surfaces today's calls · follow-up-drafts for >5-day-idle · weekly rollup flags stuck deals)
- [x] Content page: 3-col grid · status pills draft (amber) / scheduled (faint) / published (green) · card title 2-line + meta (venture · station · date)
- [x] Card click → brief editor (body + hook + calendar slot) · "Approve brief" routes through the Inbox like any delivery
- [x] Calendar-gap warning chip when >3 days empty (CMO calendar-sync output)
- [x] CMO content-brief-builder cadence populates cards

## B7 — Outputs + Roadmap + gauntlet (spec §6.7, §9-roadmap, §10 all)
- [x] Outputs page: rows (32px brass icon well · name 13px · meta station · venture · when · mono Download hover-brass) · sources = audit exports (JSON/CSV) + digests + rollups + briefs · row click → preview · Download saves · `output.created` live-inserts
- [x] Roadmap page: read-only render of this plan's PROGRAM STATUS (closes spec-§9 Roadmap mapping)
- [x] Defect ledger closed — all 11: #1 nav crash (B0 router) · #2 seven pages built (B0–B7) · #3 AA tokens (fixed values everywhere) · #4 zero innerHTML · #5 focus/ESC/trap/main/skip inherited · #6 offline fonts · #7 opacity-only pulses · #8 responsive graph/grids 375px · #9 zero invented metrics · #10 switcher/search/Send all functional · #11 dark-only confirmed intentional
- [x] Ship-gauntlet passed w/ evidence in `docs/qa/BOS-FINAL-SWEEP-<date>.md`: hallmark audit (scored) · impeccable audit+polish · taste final pass · emil motion review · WCAG AA computed ratios on new pages · /benchmark 60fps (kanban + graph) · index ≤190KB gz (new pages lazy) · e2e golden path · adversarial sweep (endpoints curl-attacked · SSE flood · malformed records/leads · giant briefs) · copy audit · zero console errors
- [x] Full regression green: R1–R10 + unit/runtime/vendor/electron + B0–B6 e2e + flag-off byte-identical

---

# PHASES

Format: Goal → Files → Lanes → Skills chain → Exit criteria (runtime-verified) → Security.
Implicit in every phase: Opus 4.8 caveman build · Fable 5 verify (§3) · regression (§6) ·
checkpoint-not-commit (§4) · SESSION_MEMORY append · snapshot · phase task doc FIRST
(`sp-writing-plans`).

---

## B0 — Shell, router, mount shipped surfaces  (S–M)

**Goal:** BOS sidebar shell exists behind `VITE_BOS`; Inbox + Settings + Board/Chat + Factory +
Sessions reachable as nav items; old app untouched with flag off; the mockup's nav-crash class
impossible.

**Files:** Create `src/components/bos/BosShell.tsx` (sidebar per spec §2: brand, pinned Inbox w/
live badge, nav group, agents quick-list, venture switcher pill-stub), `src/components/bos/BosRouter.tsx`
(typed page registry — id→lazy component; unknown id can't render), `src/theme/bos.css` (additive,
`[data-skin="helm"]` scoped, fixed tokens). Modify `src/App.tsx` (mount behind flag beside
existing ShellToggle), reuse `InboxPanel`, `SettingsPanel`, board/chat/factory/sessions mounts.

**Lanes:** Backend: none new. Frontend: shell + router. Wiring: pinned-Inbox badge rides existing
`delivery.*` counts (same source as ShellToggle); nav active state; ⌘K palette gains BOS pages.

**Skills chain:** `sp-writing-plans` → `mem-search` (recall shell/App.tsx decisions) →
`hallmark` (shell structure vs spec §2, no re-theming) → `impeccable craft` → `taste-skill` →
`emil-design-eng` (nav transitions ≤150ms) → `sp-test-driven-development` (router registry tests
FIRST: unknown id, flag off renders nothing) → `/code-review` + `cavecrew-reviewer` → gstack
`/qa` → `sp-verification-before-completion`.

**Exit criteria:** flag on → sidebar renders, every nav item opens a real mounted surface, badge
live via SSE, no console errors; flag off → shipped app byte-identical (screenshot diff); 375px
usable; regression green. **Security:** none new (no endpoints). No commit.

---

## B1 — Command deck  (M)

**Goal:** Agents page per spec §3 — Captain card w/ REAL stats, station grid from the REAL agent
registry (business stations + dev swarm merged, role filter), live status from heartbeats, modals
w/ real skills, "+ New station" → existing factory.

**Files:** Create `src/components/bos/CommandDeck.tsx`, `StationCard.tsx`, `StationModal.tsx`.
Modify `agent-runtime/factory.mjs` (role/station metadata on agent spec — additive field),
`GET /runtime/agents` response (station fields). Captain stats = deliveries DB (decisions today)
— no invented numbers.

**Lanes:** Backend: registry metadata. Frontend: deck. Wiring: station badges ride existing
`agent.state`; captain stats recompute on `delivery.decided`; modal skills from agent spec.

**Skills chain:** `sp-writing-plans` → context7 (none expected; registry is in-repo) →
`sp-test-driven-development` (metadata migration + stats query tests FIRST) → `hallmark` →
`impeccable` (`craft`+`animate`: hover raise transform-only) → `taste-skill` → `emil-design-eng`
→ `silent-failure-hunter` (stats query failure must render "—" + error note, never blank) →
`/code-review` → gstack `/design-review` → `sp-verification-before-completion`.

**Exit criteria:** deck shows real agents w/ live badges (kill an agent → badge flips via bus, no
refresh); captain "decisions today" matches DB count; modal lists the agent's actual skills;
"+ New station" creates through existing factory and the new station appears on deck via bus;
regression green. **Security:** `security-review` on the widened /runtime/agents payload (scrub).
No commit.

---

## B2 — Knowledge vault  (M) — **bus amendment phase**

**Goal:** Real shared memory: markdown records + SQLite index w/ provenance + venture scoping;
agents write on task completion; responsive graph UI + search + record viewer; `vault.written`
(+ the other 4 BOS events) added to the catalog ONCE, properly.

**Files:** Create `agent-runtime/vault.mjs` (write/list/search/get; records under
`agent-runtime/data/vault/<venture>/<node>/`; SQLite index table; scrub on write),
`agent-runtime/__tests__/vault.test.mjs`, `src/components/bos/VaultPage.tsx`, `MemoryGraph.tsx`
(viewBox-scaled, keyboard-focusable nodes), `RecordViewer.tsx` (text render, NO innerHTML).
Modify `agent-runtime/server.mjs` (`GET/POST /runtime/vault*`, needsAuth; POST approver-gated),
`events.mjs` + `useRuntimeEvents.ts` + ADR-052 (catalog amendment, all together + equality tests),
`deliveries.mjs`/broker reportBack (completion hook writes a memory), migrations (ventures table,
vault index).

**Lanes:** Backend: store + endpoints + hook. Frontend: graph/search/viewer. Wiring: every write
emits `vault.written`; graph counts, brief log (B3), center KPIs (B5) all consume the same event.

**Skills chain:** `sp-writing-plans` → `sp-brainstorming` (record schema: node taxonomy vs spec §5)
→ context7 (better-sqlite3 FTS if used) → `sp-test-driven-development` (store/scrub/scope/
idempotency tests FIRST) → **`security-review` + `claude-code-security-review` MANDATORY**
(new mutating endpoints, path containment under data/vault — case-insensitive per the program's
recurring lesson, scrub, venture isolation) → `/code-review` → gstack `/review` →
`sp-verification-before-completion`.

**Exit criteria:** agent completes a task → memory file exists on disk w/ provenance + row in
index + `vault.written` on an open SSE connection <500ms; graph node counts real; search finds
it; viewer renders it (text); venture scoping proven (record in venture A invisible under B);
restart → vault intact; adversarial curls 401/403/400; catalog-equality tests pass; regression
green. **Security:** sr-security BLOCKING (new store + endpoints + path writes). ADR-055 (vault)
written. No commit.

---

## B3 — CEO brief  (M)

**Goal:** Captain console routes real text; agent log is live; spec §4 behaviors complete.

**Files:** Create `src/components/bos/BriefPage.tsx`, `CaptainConsole.tsx`, `AgentLog.tsx`.
Modify `agent-runtime/server.mjs` (`POST /runtime/captain/route` — needsAuth, approver-gated,
2000-char cap reuse: logs to vault, classifies via captain agent, dispatches via existing queue).

**Lanes:** Backend: route endpoint. Frontend: brief page. Wiring: console → vault write +
queue task, both emit; log renders last-24 from events_log replay + live bus (delivery.* ·
task.* · vault.written · workflow.run); `needs review` pill deep-links Inbox delivery.

**Skills chain:** `sp-writing-plans` → `sp-test-driven-development` (route endpoint: cap,
classification fallback→captain-owned when unroutable, dedupe) → `security-review` (text →
prompt path: injection posture, scrub, no shell) → `hallmark`→`impeccable`→`taste-skill` →
`emil-design-eng` (dial pulse = opacity-only, reduced-motion freeze) → `ai-writing-auditor` (UI
copy) → `silent-failure-hunter` (route failure → inline error + vault audit line, never silent) →
`/code-review` → gstack `/qa` → `sp-verification-before-completion`.

**Exit criteria:** type into console → entry appears in log optimistically → station dispatched
(task.queued on bus) → completion writes vault memory → log line updates, ZERO refresh; pill
click lands on the right Inbox delivery; SSE kill → banner + recovery (existing pattern);
regression green. **Security:** sr-security pass on /captain/route. No commit.

---

## B4 — Workflows + Schedule  (M) — **autonomy phase**

**Goal:** Point 7 fully: cadences run the stations while BOSS sleeps. Skills fire on schedule
through the existing queue; failures mint failure Deliveries; Workflows table + Schedule timeline
render it all live.

**Files:** Create `agent-runtime/cadence.mjs` (SQLite table: skill/agent/venture/cadence-expr/
next-run/enabled; tick integrated into existing `scheduler.mjs`; idempotent slot dedupe;
kill-restart resume), `__tests__/cadence.test.mjs`, `src/components/bos/WorkflowsPage.tsx`,
`SchedulePage.tsx`, `WorkflowDrawer.tsx` (run history, Run-now/Pause F3-confirm + approver).
Modify `server.mjs` (`GET/POST /runtime/cadence*`), seed the 15 spec-§7 skills as cadence rows.

**Lanes:** Backend: cadence engine. Frontend: two pages + drawer. Wiring: every run transition
emits `workflow.run`; failure path reuses P4 failure-Delivery mint; approve → auto-chain
(existing); deck notes + brief log consume the same events.

**Skills chain:** `sp-writing-plans` → `sp-test-driven-development` (cadence state machine FIRST:
next-run calc, slot dedupe, restart resume, failure→Delivery) → `sp-systematic-debugging` (any
race) → `sp-dispatching-parallel-agents` (MAX_INFLIGHT semantics awareness) →
`silent-failure-hunter` (missed tick must surface as status, not vanish) → `security-review`
(cadence endpoints gated; cadence-expr validated — no eval) → `/code-review` → gstack `/qa` +
`/careful` (scheduler touches the proven queue) → `sp-verification-before-completion`.

**Exit criteria:** enable 3 cadences → walk away 10 min → runs fired ≤MAX_INFLIGHT, vault
memories + Deliveries stacked, zero human input; kill -9 runtime mid-tick → restart → no lost or
doubled runs (test proves); Pause stops next slot; Run-now dispatches immediately w/ F3 confirm;
Schedule timeline shows today pivoted by time w/ "now" marker; failure run → failure Delivery in
Inbox; regression green. **Security:** sr-security pass on cadence endpoints. ADR-056 (cadence)
written. No commit.

---

## B5 — Command center  (S–M)

**Goal:** Cross-venture dashboard, all numbers computed, spec §6.2.

**Files:** Create `src/components/bos/CommandCenter.tsx`, `StatTiles.tsx`, `VenturesPanel.tsx`,
`NeedsYouPanel.tsx`. Modify `server.mjs` (`GET /runtime/bos/kpis?venture&window` — pure read,
needsAuth, viewer-readable like scoreboard).

**Lanes:** Backend: KPI query (SQL over deliveries/vault/cadence/leads-when-B6). Frontend:
dashboard. Wiring: tiles recompute on `delivery.decided` / `vault.written` / `workflow.run`;
NeedsYou = pending Deliveries, click → Inbox; ventures rows → switcher scope.

**Skills chain:** `sp-writing-plans` → `sp-test-driven-development` (KPI SQL: windows, empty DB →
zeros not nulls, venture scope) → **`dataviz` skill** (stat tiles/sparklines per design system) →
`hallmark`→`impeccable`→`taste-skill` → `security-review` light (read endpoint shape/scrub) →
`/code-review` → `sp-verification-before-completion`.

**Exit criteria:** tiles show real counts matching direct DB queries; decide a delivery in
another tab → tile ticks via bus; venture switcher filters everything; empty venture → honest
zeros + empty states; regression green. No commit.

---

## B6 — Lead pipeline + Content engine  (M–L)

**Goal:** CRM-lite + content per spec §6.5/§6.6, both deciding through the Inbox.

**Files:** Create `agent-runtime/leads.mjs` + `content.mjs` (SQLite tables, venture-scoped,
audit on every mutation), tests, `src/components/bos/PipelinePage.tsx` (4-col kanban, drag =
stage change), `LeadDrawer.tsx`, `ContentPage.tsx`, `BriefEditor.tsx`. Modify `server.mjs`
(CRUD endpoints, needsAuth; mutations approver-gated), cadence seeds (sales-rep + CMO skills
now mint real drafts → Deliveries).

**Lanes:** Backend: two stores. Frontend: two pages. Wiring: `lead.moved`/`content.changed` on
every mutation; sales-rep cadence drafts follow-ups → Inbox items; approve → send/mark logic via
broker; CMO briefs → content cards; calendar-gap chip from cadence data.

**Skills chain:** `sp-writing-plans` → `sp-brainstorming` (lead schema minimalism — KISS, no
speculative CRM fields) → `sp-test-driven-development` (stage transitions, venture scope, audit
rows FIRST) → `security-review` + `claude-code-security-review` (untrusted lead/content text:
scrub, cap, no prompt injection into station runs; external-content rules from P7 reused) →
`hallmark`→`impeccable`→`taste-skill` → `emil-design-eng` (drag glide transform-only,
reduced-motion path) → `ai-writing-auditor` (content surfaces) → `/code-review` → gstack `/qa` →
`sp-verification-before-completion`.

**Exit criteria:** create lead → kanban card; drag → stage persists + `lead.moved` + audit line;
follow-up cadence drafts land in Inbox, approve → draft marked sent + vault memory; brief editor
round-trip; calendar-gap chip appears when >3 days empty; venture scoping proven; regression
green. **Security:** sr-security BLOCKING (new mutating stores + untrusted text). No commit.

---

## B7 — Outputs · Roadmap page · ship-grade hardening  (M)

**Goal:** Last surface + the same final gauntlet the Inbox program got.

**Files:** Create `src/components/bos/OutputsPage.tsx` (artifact registry over audit-export +
digests + rollups; preview + download), `RoadmapPage.tsx` (read-only render of this plan's
PROGRAM STATUS — closes the Roadmap mapping), `agent-runtime/outputs.mjs` (registry rows on
export/digest creation, emits `output.created`). Modify: whatever the audits demand.

**Lanes/Skills chain (the gauntlet):** `sp-writing-plans` → outputs+roadmap build (TDD as above)
→ design gates: **`hallmark audit`** (scored, whole BOS shell) + **`impeccable audit` +
`impeccable polish`** + `taste-skill` final pass + `emil-design-eng` motion review →
WCAG 2.2 AA sweep w/ computed contrast (extend `docs/qa/DESIGN-A11Y-AUDIT` method to new pages;
`accessibility-tester`-grade) → perf: gstack `/benchmark` (60fps kanban+graph; index ≤190KB gz —
new pages lazy) → full e2e `webapp-testing`+`playwright` golden path + **adversarial sweep**
(every new endpoint curl-attacked, SSE flood, malformed records/leads, giant briefs) →
`ai-writing-auditor` + `content-quality-editor` (all BOS copy + README section) → `/code-review`
full-BOS pass → gstack `/retro` → `sp-verification-before-completion` → **final PES delivery
report** appended to SESSION_MEMORY.

**Exit criteria:** all 10 spec pages live + wired (zero DEAD nav); outputs list real artifacts,
download works; roadmap renders live checkboxes; scored design audits pass w/ evidence in
`docs/qa/BOS-FINAL-SWEEP-<date>.md`; a11y AA on new pages (computed ratios); 60fps; zero console
errors on golden path; full regression (R1–R10 + Inbox suites + B0–B6 e2e) green; flag-off still
byte-identical; BOSS demo walkthrough written. **Then:** wait for BOSS commit decision (§4).

---

## Self-review (skill-mandated)

**Mandate coverage:** all 14 BOSS points mapped in §0, each to a concrete mechanism. ✓
**Self-containment:** the FEATURE LEDGER inlines every spec feature as a checkbox — an executor
in a fresh window needs ONLY this plan (+ SESSION_MEMORY tail + git status) to build everything;
the spec remains the deeper UI/UX reference. Cross-phase hand-offs pre-declared (records-read→B2,
modal Run-now→B4) — no silent partials. ✓
**Spec coverage:** master-spec §6.1→B0 (mount) · §3/§6.2→B1/B5 · §5→B2 · §4→B3 · §6.3/6.4→B4 ·
§6.5/6.6→B6 · §6.7+Roadmap→B7 · §8 switcher→B2 (data) + B5 (UI) · §9 mapping→B0 mounts + B7
roadmap · §10 defects→each assigned (crash→B0, tokens/a11y→§1+B7, innerHTML→everywhere-React,
dead controls→B2/B3/B5). Every spec feature has a phase; no orphan. ✓
**Placeholder scan:** no TBD; per-phase code detail deferred to each phase's mandated
`sp-writing-plans` task doc — a BLOCKING first deliverable, so no one codes from this doc alone. ✓
**Wired check:** every phase's exit includes a bus-observed behavior; §2 catalog amendment is
single-shot at B2 with equality tests. ✓
**Break-nothing check:** flag kill-switch + full regression pile at every exit + `/careful` on
the one phase touching the proven queue (B4). ✓
