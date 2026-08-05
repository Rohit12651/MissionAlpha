# Helm — Business OS · Master Feature Spec

**Date:** 2026-07-30 · **Source of truth:** `docs/mockups/helm-business-os-mockup_1.html` (copied from
`~/Downloads/helm-business-os-mockup_1.html`, 47 KB) · **Record type:** complete feature + UI/UX spec (PES).

**What this document is.** A production-grade, end-to-end specification of every surface in the
Helm Business OS mockup: every sidebar item and its placement, every page, every element on each
page, and the exact click-by-click behavior — both **as-built** in the mockup and **as-specified**
for the seven nav destinations the mockup styles but never builds. It also answers, feature by
feature, where MissionAlpha's existing surfaces (Chat, Agents, Board, Agent Factory, Sessions,
Roadmap, Settings) live — or don't — in this concept, and assigns each a production home.

**Method (PES / skill chain).** Authored under `principal-standard` gates. Design-system analysis
uses the `hallmark` audit lens (loaded this session; the helm skin is hallmark-stamped Workbench /
technical-luxury); motion rules cross-checked against `emil-design-eng` discipline; a11y numbers
carry over from `docs/qa/DESIGN-A11Y-AUDIT-2026-07-30.md` (WCAG contrast computed exactly);
spec structure follows the repo's master-spec convention (`docs/ceo/MISSION-INBOX-master-spec.md`).
Every claim about the mockup cites its source line range. Nothing below is invented: as-built
sections describe code that exists; SPEC sections are explicitly labeled as net-new design derived
from the mockup's own orphaned CSS.

---

## 0. Build-state audit — what the mockup actually implements

The mockup declares **10 nav destinations** but implements **3 pages**. The other 7 are nav items
pointing at pages that do not exist — and `showPage()` (L701–706) has **no null guard**, so
clicking any of them throws `TypeError: Cannot read properties of null (reading 'classList')`
after deactivating every page → **the main area goes permanently blank** until a working nav item
is clicked. This is the mockup's one hard defect (contrast: the merged Inbox mockup's `showPage`
guards with `if(!page) return;`).

| # | Sidebar item (top→bottom) | `data-page` | Page exists? | State |
|---|---|---|---|---|
| 1 | **Inbox** (pinned, brass-bordered, badge "10") | `inbox` | ❌ | DEAD — crashes nav |
| 2 | Command center | `center` | ❌ | DEAD — crashes nav |
| 3 | CEO brief | `brief` | ✅ `page-brief` | **LIVE** |
| 4 | Agents *(default active)* | `deck` | ✅ `page-deck` | **LIVE** |
| 5 | Workflows | `workflows` | ❌ | DEAD — crashes nav |
| 6 | Schedule | `schedule` | ❌ | DEAD — crashes nav |
| 7 | Lead pipeline | `pipeline` | ❌ | DEAD — crashes nav |
| 8 | Content | `content` | ❌ | DEAD — crashes nav |
| 9 | Knowledge vault | `log` | ✅ `page-log` | **LIVE** |
| 10 | Outputs | `outputs` | ❌ | DEAD — crashes nav |

Also live: 5 **agent skill modals** (COO/CMO/Sales rep/Developer/Data analyst), the **memory
graph** with 6 selectable nodes + detail panel, a ticking **clock** (1 s interval), and the
**captain CTA** that navigates deck → brief. The **venture switcher** and the modal-panel data are
static. Every DEAD page nonetheless has its **full CSS already written** (L306–380) — the SPEC
sections below (§6) derive each page's design from exactly that orphaned CSS, so the mockup's own
visual language completes itself.

---

## 1. Design system (tokens · type · shape · motion)

Declared at `:root` (L10–25). This is the same Helm brass/ink family the shipped MissionAlpha
helm skin uses — with **two critical deltas** (see production notes).

| Group | Token | Value | Role |
|---|---|---|---|
| Surface | `--ink` | `#0B1220` | page background |
| | `--deck` | `#121B2E` | sidebar, cards, panels |
| | `--deck-raised` | `#182338` | hover, chips, inputs, icon wells |
| | `--deck-raised-2` | `#1E2B45` | active nav, captain-card gradient top |
| | `--line` / `--line-soft` | `#26324A` / `#1D2A40` | borders / row separators |
| Accent | `--brass` / `--brass-bright` | `#C89B3C` / `#E0B759` | identity, active states, CTAs |
| Semantic | `--green` / `--amber` / `--red` | `#4F9D69` / `#D9A441` / `#C1554A` | working / standby-open / risk-off |
| Text | `--paper` / `--paper-dim` / `--paper-faint` | `#EDE6D6` / `#9BA3B4` / `#5D6579` | primary / secondary / labels |

**Type:** Space Grotesk 600–700 (display: brand, h1–h3, buttons) · Inter 400–500 (body) ·
IBM Plex Mono (eyebrows 10–11 px letter-spaced uppercase, badges, stats, timestamps, file sizes).
**Shape:** cards 12 px · panels/modals 14 px · pills/badges 20 px · controls 6–10 px.
**Motion:** hover transitions 150 ms; station hover `translateY(-2px)` + brass border; console
dial 2.6 s brass pulse (box-shadow keyframes L217).

**Production notes (mandatory — carried from the shipped audit):**
1. `--paper-faint #5D6579` and `--red #C1554A` are the **pre-fix values that fail WCAG AA**
   (2.70–3.21:1 and 3.82–4.16:1). Production uses the shipped helm.css fixes:
   **`#868FA3`** (faint → 4.84–5.77:1) and **`#D16A5F`** (red → 4.86–5.42:1).
2. Google Fonts CDN links (L7–8) are mock-only. Production is offline-first (`font-src 'self'`):
   optimistic Space Grotesk/IBM Plex Mono stacks degrading to bundled Lato + platform mono.
3. All mockup rendering via `innerHTML` template strings (modals L790, detail panel L836) is
   **banned in production** (P3 XSS rule: text rendering / React, never innerHTML).
4. Mockup has **zero** `:focus-visible` styles, no reduced-motion block, inline `onclick`
   handlers, no `<main>` landmark. Production inherits the shipped fixes: 2 px brass-bright ring
   (9.89:1, never animated), double reduced-motion net, React events, `<main id="ma-main">` + skip link.
5. Box-shadow pulse (L217) animates a paint property — production replaces with the shipped
   opacity-only `helm-breathe`.

---

## 2. Shell anatomy — exact placements

```
┌──────────────┬──────────────────────────────────────────────┐
│ SIDEBAR 230px│ MAIN (flex:1, pad 28px 40px 60px)            │
│              │                                              │
│ Brand        │ ┌ Topbar ──────────────────────────────────┐ │
│ ── pinned ── │ │ eyebrow + H1 (left)   status chips +     │ │
│ Inbox [10]   │ │                       clock (right)      │ │
│ ── group ──  │ └──────────────────────────────────────────┘ │
│ Command ctr  │                                              │
│ CEO brief    │ [ one active .page at a time ]               │
│ Agents ◀     │                                              │
│ Workflows    │                                              │
│ Schedule     │                                              │
│ Lead pipeline│                                              │
│ Content      │                                              │
│ Knowledge v. │                                              │
│ Outputs      │                                              │
│ ── AGENTS ── │                                              │
│ ● CMO        │                                              │
│ ● Sales rep  │                                              │
│ ● Dev        │                                              │
│ ● COO        │                                              │
│ ● Data analyst                                              │
│ ── bottom ── │                                              │
│ Venture: WAAHYU ▾                                           │
└──────────────┴──────────────────────────────────────────────┘
```

**Sidebar, top→bottom (L388–460):**
- **Brand** (L389–395): brass clock-compass SVG 26 px + "Helm" (Space Grotesk 700 18 px) +
  "BUSINESS OS" sub-label (10 px faint uppercase).
- **Pinned Inbox** (L397–401): sits *above* the nav group, styled unlike any other item —
  1 px **brass border**, `rgba(200,155,60,0.08)` fill, paper text, right-aligned brass **badge
  "10"** (mono 10 px on `#221803`). It is the product's center of gravity; the visual weight says
  "this is where decisions live."
- **Nav group** (L403–440): 9 items. Anatomy: 16 px stroke icon + 13.5 px label, 9/10 px padding,
  6 px radius. States: default `--paper-dim` → hover `--deck-raised` bg + paper text → active
  `--deck-raised-2` bg + **brass-bright** text + 1 px line border.
- **AGENTS quick-list** (L442–449): mono 10 px "AGENTS" label; 5 rows — 7 px color dot + name +
  right-aligned faint role. Dots: CMO `#5DCAA5` · Sales `#D4537E` · Dev `#639922` · COO `#378ADD`
  · Analyst `#EF9F27`. **Click → that agent's skill modal** (§7).
- **Venture switcher** (L451–459): pinned bottom (`margin-top:auto`, top border). Pill: "Venture"
  faint label / "WAAHYU" name + chevron. **As-built: click does nothing** (no handler). SPEC §8.

**Topbar pattern (every page):** left = eyebrow (mono faint uppercase, names context + venture,
e.g. "AGENT NETWORK · WAAHYU") over H1 26 px. Right = status chips (pill, dot + 12 px text) and,
on deck/brief, the live **clock** (mono, ticks 1 s, L708–715).

---

## 3. PAGE — Agents / Command deck (`page-deck`, default view, L466–539) — AS-BUILT

The landing page. Eyebrow "AGENT NETWORK · WAAHYU" · H1 "Command deck" · status chip
"● 5 of 6 on watch" (green dot) · clock.

**Captain card** (L478–494) — full-width hero band, vertical gradient `deck-raised-2 → deck-raised`,
two decorative concentric circles bleeding off the top-right (L120–127). Left→right:
1. **Compass emblem** 64 px — brass ring, radial brass glow, compass-needle SVG.
2. **Body** — "Captain / CEO" H2 22 px + green **"ON WATCH"** badge; description: *"Reads what
   every station learned today, decides what actually needs attention, and hands out the
   follow-ups. Nothing here starts from a blank page."*
3. **Stats** (right-aligned): **6** DECISIONS TODAY · **1,204** RECORDS READ (mono 22 px over
   10 px uppercase labels).
4. **CTA "Open brief →"** — brass fill, `#221803` text, hover brass-bright.
   **Click:** `showPage('brief', …)` → navigates to CEO brief and moves nav active state (L493).

**Stations band** (L496–538): divider label "SIX STATIONS, ONE MEMORY" + hairline. 5-column grid
(`repeat(5,1fr)`), one card per station. Card anatomy: 34 px icon well (brass stroke icon) +
status badge top-right · eyebrow "STATION 0N" · H3 name · uppercase role line · 2-line status note.
**Hover:** border → brass, `translateY(-2px)`. **Click → skill modal** (§7).

| Station | Role | Badge | Note (as-built) |
|---|---|---|---|
| 01 COO | Comms & ops | ON WATCH | Tracking 3 competitor grocery apps launching in DFW this month |
| 02 CMO | Content & intel | ON WATCH | 2 content briefs drafted from this morning's market scan |
| 03 Sales rep | Revenue ops | STANDING BY | 4 leads overdue for follow-up — drafts ready for review |
| 04 Developer | Build system | OFF WATCH | Last ran Monday. Flagged one workflow worth automating |
| 05 Data analyst | Signal layer | ON WATCH | Daily rollup logged: 12 orders, $340 GMV, up 8% WoW |

*(Card 6 is the Captain — the hero band above the grid; "5 of 6 on watch" counts him.)*

---

## 4. PAGE — CEO brief (`page-brief`, L542–616) — AS-BUILT

Eyebrow "CAPTAIN'S CONSOLE · WAAHYU" · H1 "Daily brief" · amber chip "Last brief 6h ago".

**Console** (L554–562) — centered panel: 88 px pulsing compass dial (2.6 s brass glow) · H3
"Talk to the Captain" · helper: *"Say what's on your mind — it gets logged to shared memory and
routed to whichever station should own it."* · input row (placeholder *"e.g. check if the vendor
invoice from Sysco cleared..."*) + brass **Send**. **As-built: Send has no handler** — input is
visual only. **SPEC:** Send → POST to captain thread → optimistic entry in Agent log ("Captain ·
routing…") → captain classifies → routes to a station → log entry updates with the owning station
+ pill `logged`; input clears; errors render an inline red note under the row (never silent).

**Agent log** (L564–614) — "Agent log" H3 + "Last 24" count pill; 5 entries. Row anatomy: brass
agent tag (mono uppercase) · title + meta ("Decision · WAAHYU", "Market memory · WAAHYU") · right:
status pill (`logged`/`completed` green · `needs review` amber) + relative time (2h…9h).
**As-built: rows are not clickable.** **SPEC:** row click → drill into the underlying record in
Knowledge vault (deep-link to its node + file); `needs review` pill click → jumps to the Inbox
delivery it produced.

---

## 5. PAGE — Knowledge vault / The log (`page-log`, L619–690) — AS-BUILT

Eyebrow "SHARED MEMORY · ALL VENTURES" · H1 "The log" · chip "● 1,204 records".

**Search row** (L630–633): magnifier + input *"Search records, ventures, topics..."*.
**As-built: no handler.** **SPEC:** ≥2 chars → dropdown of matching records grouped by node;
Enter → vault filtered view; Esc → clear. Hint line: *"Click a node to inspect it. The center
holds everything every station has ever written."*

**Memory graph** (L637–684): 600×600 radial map. Center node "Helm memory · 1,204 records"
(70 px brass ring + glow) with 6 hairline spokes to satellite nodes (52 px rings, 78 px hit area):
**Ventures** (top) · **Market intel** · **Content engine** · **Pipeline** (bottom) · **Tech
notes** · **Decisions**. Hover/selected: ring + icon → brass. **Click → `selectNode`** (L829–844)
fills the right **detail panel**:
crumb `The log / <node>` (brass leaf) · H3 · meta chips · 2×2 stat tiles · "FILES" list
(name + mono size). Empty state: *"Click a node to inspect it."*

| Node | Meta | Stats | Files (as-built) |
|---|---|---|---|
| Ventures | 4 ventures · Real folder | 4 tracked · 58 records | waahyu.md 2.1 KB · barkback.md 1.4 KB · tadaa.md 0.9 KB · trading-desk.md 3.2 KB |
| Market intel | Written by COO · Local | 3 competitors · 12 scans/mo | competitor-scan-2026-07-28.md · competitor-scan-2026-07-21.md · vendor-renewals.md |
| Content engine | Written by CMO · Local | 2 briefs · 10 hooks | brief-waahyu-launch-recap.md · brief-vendor-story.md · hooks.jsonl |
| Pipeline | Written by Sales rep · Local | 4 need follow-up · 22 total | leads-2026-07-29.md · follow-up-drafts.md |
| Tech notes | Written by Developer · Local | 1 flagged · 6 notes | workflow-audit-2026-07-27.md |
| Decisions | Written by Captain · Real folder | 6 today · 142 total | decision-2026-07-29.md · decision-2026-07-28.md |

**SPEC additions:** file row click → record viewer (rendered markdown, provenance header: author
station, venture, written-at, source run); center node click → unfiltered recent-records list;
graph is decorative-fixed-px in the mockup → production renders it responsive (`viewBox` scale,
`minmax(0,1fr)` grid) with keyboard focus per node (`tabindex=0`, Enter=select).

---

## 6. SPEC — the seven unbuilt pages (from their own orphaned CSS)

Each page below has **zero markup** in the mockup but **complete CSS** (cited). Behavior is
specified to production level; sample data in the mockup's spirit is placeholder, never shipped.

### 6.1 Inbox (`page-inbox`) — CSS `.inbox-list/.inbox-row/...` L306–319
Mail-style triage list: full-width panel, rows = brass unread dot · FROM (110 px, station name) ·
subject (semibold when unread) + one-line faint snippet (ellipsis) · right time. Unread rows get
`rgba(200,155,60,0.04)` wash. **Click-by-click:** row → opens the item's decision surface —
**this page is the Business-OS face of the shipped MissionAlpha Agent Inbox** (deliveries +
review pane + Approve→apply→PR / Request-changes / Reject, risk chips, SLA, typed-confirm on
high). Badge "10" = pending count, SSE-live (`delivery.created/decided`). Filters (All · High
risk · My swarm · External · Failures) carry over. Everything here is already built and
sr-security-approved in MissionAlpha P2–P9 — the mockup's list skin is a reskin, not a rebuild.

### 6.2 Command center (`page-center`) — CSS `.stat-grid/.center-cols/.venture-row` L322–332
The cross-venture dashboard. **Row 1:** 4 stat cards (mono 26 px number, label, green delta) —
Decisions today · Records written · Deliveries approved · Open follow-ups; numbers computed from
the vault + inbox, **never invented** (hallmark honest-copy rule). **Row 2** (1.4fr/1fr): left
"Ventures" panel — one row per venture (name + sub, right brass metric, e.g. GMV WoW), click →
venture switch + drill; right "Needs you" panel — the same `needs review` items as the brief's
log, click → Inbox. Empty states for zero ventures / nothing pending.

### 6.3 Workflows (`page-workflows`) — CSS `.table-wrap/.table-head-row/.table-row` L335–343
Table, 5 columns `1.6fr 1fr 1fr 1fr 0.8fr`: **Workflow** (name, semibold) · **Station** (owner) ·
**Cadence** (mono, "daily · 7am") · **Last run** (mono relative) · **Status** (pill: `on` green /
`paused` faint / `failed` red). Row = one scheduled skill (the 15 in §7 are the seed set). Row
hover raise; **click → drawer**: skill description, run history (last 10 w/ outcome + duration),
next-run countdown, and controls — Run now · Pause/Resume · Edit cadence (F3-style confirm).
A failed run also mints a failure item into the Inbox (never silent — MissionAlpha P4 rule).

### 6.4 Schedule (`page-schedule`) — CSS `.timeline/.tl-*` L346–352
Today's cadence as a vertical timeline: brass mono time (70 px col) · title · faint sub
("COO · scan-competitors"). Renders the same data as Workflows pivoted by time-of-day; day
switcher (‹ today ›) in the topbar; "now" hairline marker; empty state "Nothing scheduled — the
stations rest." Click row → same drawer as §6.3.

### 6.5 Lead pipeline (`page-pipeline`) — CSS `.kanban/.lead-card` L355–362
4-column kanban: **New · Contacted · In talks · Closed** (uppercase col titles + mono counts).
Lead card: name 12.5 px + faint meta (source · value · idle days). **Click:** card → lead drawer
(timeline of touches, Sales-rep drafts awaiting review, "Draft follow-up" action → mints an Inbox
item authored by Sales rep). Drag between columns = stage change, logged to vault Pipeline node.
Sales-rep station skills (`lead-scorer`, `follow-up-drafts`, `pipeline-rollup`) feed this board.

### 6.6 Content (`page-content`) — CSS `.content-grid/.content-card` L365–369
3-column card grid. Card: status pill (`draft` amber / `scheduled` faint / `published` green) ·
title (2-line) · meta (venture · station · date). Fed by CMO briefs (§7). Click → brief editor
(brief body + hook + calendar slot); "Approve brief" routes through the Inbox like any delivery.
Calendar-gap warning chip when >3 days empty (CMO `calendar-sync` skill's output).

### 6.7 Outputs (`page-outputs`) — CSS `.output-row/.output-*` L372–380
Flat list of every artifact the stations produced: 32 px brass icon well · name 13 px · meta
(station · venture · when) · right mono **Download** button (hover → brass). Sources: audit
exports (JSON/CSV), weekly digests, rollups, briefs. Click row → preview; Download → file save.
This is the Business-OS face of MissionAlpha's shipped audit-export endpoint (P8).

---

## 7. Agent skill modals (L696–794) — AS-BUILT, full inventory

Open from: sidebar quick-list **or** station card. Overlay `rgba(6,10,18,0.6)` + 2 px blur;
560 px panel (max 82vh scroll). Anatomy: eyebrow "ROLE · STATUS" · H2 name · ✕ (28 px bordered) ·
description · skill rows (name Space Grotesk 500 · `SKILL` tag · brass `CADENCE` tag · desc).
**Close:** ✕ or backdrop click (`closeModalBg`, L794). *(Mockup lacks ESC-close — production adds
it + focus trap, per shipped ReviewPane.)*

Complete skill matrix — 5 agents × 3 skills:

| Agent | Skill | Cadence | What it does |
|---|---|---|---|
| **COO** — *"Keeps market intel, vendor admin, and inbox triage moving without you touching any of it."* | scan-competitors | daily · 7am | pulls pricing/launch/positioning moves from a configured competitor list → tagged market memories the CMO reads next |
| | vendor-tracker | daily | watches vendor invoices + renewal dates; flags anything due in 14 days |
| | inbox-triage | 2× daily | classifies inbox → action-required / reference / waiting-on |
| **CMO** — *"Turns the COO's market intel and last week's content performance into ready-to-write briefs."* | content-brief-builder | daily · 8am | reads fresh market memories + performance → drafts 1–3 briefs w/ angle + hook |
| | trend-scan | daily | checks category trends against what has/hasn't performed before suggesting a topic |
| | calendar-sync | weekly | lays briefs into the calendar; flags gaps >3 days out |
| **Sales rep** — *"Checks leads and follow-up opportunities so nothing goes cold in the pipeline."* | lead-scorer | daily · 7am | scores inbound leads on engagement + fit; surfaces today's calls |
| | follow-up-drafts | daily | drafts follow-ups for leads idle >5 days, matched to prior tone |
| | pipeline-rollup | weekly | summarizes stage movement; flags deals stuck without a next step |
| **Developer** — *"Reviews the codebase and workflows, proposes fixes, and can hand real builds to Claude Code."* | repo-health-check | weekly · Mon | scans recent commits + issues for patterns worth flagging |
| | workflow-audit | weekly | finds repeated manual steps across agent runs worth automating |
| | claude-code-handoff | on demand | packages a flagged improvement into a ready-to-run Claude Code prompt |
| **Data analyst** — *"Watches performance across every venture and rolls it up so nothing gets missed."* | daily-rollup | daily · EOD | pulls orders/GMV/usage → same-day summary memory |
| | anomaly-flag | daily | flags any metric >20% outside its 14-day baseline |
| | weekly-digest | weekly · Sun | rolls the week up for the Captain's Monday brief |

**SPEC additions:** each skill row gains Run-now + last-run status; modal footer gains "Open in
Workflows". Production renders via React (no innerHTML), ESC-close, focus trap.

---

## 8. Venture switcher — SPEC (as-built: static)

Bottom-pinned pill "Venture / WAAHYU ▾". **Click:** popover listing ventures from the vault's
Ventures node (waahyu · barkback · tadaa · trading-desk) + "All ventures". Selecting scopes every
page (topbar eyebrows, deck notes, brief log, vault filter, pipeline, content) to that venture;
choice persists; "All" restores the cross-venture Command center view. Keyboard: Enter opens,
arrows navigate, Esc closes.

---

## 9. MissionAlpha feature mapping — where Chat · Agents · Board · Agent Factory · Sessions · Roadmap · Settings live

The direct answer to "where are these in the mockup(s)", plus each feature's production home in a
Business-OS build.

| Feature | In **helm-inbox-merged-mockup.html** (P3 design target) | In **helm-business-os-mockup_1.html** (this concept) | Shipped MissionAlpha today | Production home in Business OS (SPEC) |
|---|---|---|---|---|
| **Chat** | Sidebar nav → **stub** ("ChatPane wires here in M1") L182–185 | **Absent.** Closest: "Talk to the Captain" single input on CEO brief (no thread UI) | ChatPane inside Board shell view (boss+agent threads, cli backend) | New nav item under CEO brief, or expand the Captain console into full threads; reuse shipped ChatPane |
| **Agents** | **LIVE** `page-deck` — Captain + **15 dev stations** + modals L186–189, 247–262 | **LIVE** `page-deck` — Captain + **5 business stations** (COO/CMO/Sales/Dev/Analyst) | AgentRoster + AgentDrawer in Board view | Command deck IS the agents surface — merge rosters: business stations and dev swarm are one list with role filters |
| **Board** | Sidebar nav → **stub** ("existing MissionAlpha board mounts here") L190–193 | **Absent.** (Lead pipeline kanban = sales leads, a different thing) | Kanban + heartbeat + feed + globe (Board shell view) | New "Missions" nav item mounting the existing board; Lead pipeline stays a separate sales surface |
| **Agent Factory** | Sidebar nav → **stub** ("BOSS describes a need → Claude authors the spec → you confirm") L194–197 | **Absent** | AgentFactory + CreateAgentFlow (CEO-picks-team), reachable from Board | "+ New station" button on Command deck header → existing factory flow |
| **Sessions** | Sidebar nav → **stub** ("history browser + replay scrubber — M2") L198–201 | **Absent.** Closest: Agent log (last-24) on CEO brief — activity, not replay | Replay button in TitleBar (sessions browser + scrubber, R6) | Nav item under Knowledge vault ("Sessions"); vault stores memories, Sessions stores runs |
| **Roadmap** | **LIVE** `page-roadmap` — delivery-pipeline flow + M0–M8 stages L264–301 | **Absent.** (Schedule = daily cadence timeline, not a roadmap) | Not an app surface — lives in `docs/superpowers/plans/…program-plan.md`; M0–M8 = P0–P10, ALL SHIPPED | Optional read-only page rendering the plan's PROGRAM STATUS; low priority — it's documentation |
| **Settings** | Sidebar nav → **stub** ("risk policy editor, model tiers, repo picker, theme — M3/M4") L206–209 | **Absent entirely — no settings anywhere** | SettingsPanel (TitleBar gear): Workspace/repo picker, PolicyEditor, Adapters, Users, theme, reduced-motion | **Must add** — bottom sidebar item above the venture switcher; mounts the shipped SettingsPanel. A Business OS without policy/user/repo controls is not operable |

**Key insight:** the two mockups are complementary, not competing. The merged mockup stubs
Chat/Board/Factory/Sessions/Settings because the shipped app already has them; the Business OS
mockup drops them because it re-imagines the shell around *business* operations. A production
Business OS = this concept's sidebar + venture layer, with the **shipped** MissionAlpha surfaces
(Inbox engine, Board, Chat, Factory, Sessions, Settings) mounted as nav items — nothing rebuilt.

---

## 10. Defect & gap ledger (mockup → production)

| # | Sev | Finding | Production fix |
|---|---|---|---|
| 1 | **CRIT (mock)** | `showPage()` L701–706 has no null guard → 7 of 10 nav items throw + blank the main area | Guard `if(!page) return` (merged mockup already does this); in production every nav item mounts a real page |
| 2 | MAJOR | 7 nav destinations unbuilt (styled only) | §6 specs each; build order §11 |
| 3 | MAJOR | Tokens `#5D6579`/`#C1554A` fail WCAG AA | Use shipped `#868FA3`/`#D16A5F` (DESIGN-A11Y-AUDIT) |
| 4 | MAJOR | All dynamic DOM via innerHTML template strings | React + text rendering (P3 XSS rule) |
| 5 | MAJOR | No focus-visible styles, no ESC-close, no focus trap, no `<main>`/skip link, inline onclick | Inherit shipped a11y kit (brass ring 9.89:1, ESC, trap, `#ma-main`, skip link) |
| 6 | MINOR | Google Fonts CDN | Offline-first stacks (CSP `font-src 'self'`) |
| 7 | MINOR | Console dial pulses box-shadow (paint) | Opacity-only `helm-breathe`; reduced-motion freeze |
| 8 | MINOR | Graph fixed 600×600 px; stations `repeat(5,1fr)` unresponsive | viewBox-scaled graph; `minmax(0,1fr)` + wrap at ≤768px; 375px floor per hallmark gates 36/59/61 |
| 9 | MINOR | Sample metrics ("1,204 records", "$340 GMV") hard-coded | All numbers computed from real stores; placeholders labeled, never invented (hallmark gate 56) |
| 10 | MINOR | Venture switcher + search + Send are dead controls | §4, §5, §8 specs |
| 11 | NOTE | No light theme | Matches shipped helm: product surface is dark-only by design |

---

## 11. Build path — what exists vs net-new

Already shipped in MissionAlpha (mount, don't rebuild): **Inbox engine** (deliveries, SSE, risk,
policy, SLA, typed-confirm, PR ladder — P2–P6) · **ingestion adapters** (P7) · **usage + audit
export** (P8) · **users/roles** (P9) · **Board/Chat/Factory/Sessions/Settings** surfaces ·
helm skin + a11y kit.

Net-new for Business OS, in ship-alone stages:
**B0** Shell — sidebar + venture switcher + null-guarded router; mount shipped Inbox/Settings
(closes the two worst gaps on day one) →
**B1** Command deck (business-station roster over the existing agent registry; merged w/ dev swarm) →
**B2** Knowledge vault (real store: markdown records + provenance; graph UI) →
**B3** CEO brief (captain console → real routing; agent log ← real events) →
**B4** Workflows + Schedule (cadence scheduler over the existing queue; failure → Inbox) →
**B5** Command center (computed KPIs) →
**B6** Lead pipeline + Content (CRM-lite + brief editor, both deciding through the Inbox) →
**B7** Outputs (artifact registry over audit export).
Every stage: PES gates, sr-security on any new endpoint, no commits until BOSS says.

---

## 12. Delivery report (this spec)

**Done:** every mockup surface documented as-built with line citations; all 7 dead pages specced
from their own CSS; complete skill matrix (15 skills), node inventory (6), station table, shell
placements; the 7 MissionAlpha features located across BOTH mockups + shipped app + given
production homes; 11-item defect ledger; build path staged against what already exists.

**Known gaps & risks:** (1) Business-OS mockup carries pre-a11y-fix tokens — any pixel work from
it must re-apply the shipped fixes (§1 note 1). (2) §6 pages are specs, not builds — no code
exists for them; treating this doc as "built" would violate PES rule 5. (3) The merged-mockup
line citations reference `docs/mockups/helm-inbox-merged-mockup.html` at its 2026-07-30 state.
(4) Roadmap-page mapping marks M0–M8 as shipped = P0–P10 complete per program plan; the
BOSS-operated items (gh, dogfood week, commit, dmg) remain open as recorded there.
