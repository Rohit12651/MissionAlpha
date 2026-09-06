# Excellence Manifesto — Four-Lens Review (rev 3)

**Date:** 2026-08-10
**Branch:** `feat/multi-provider-credentials` (at `05e8dbd`, pushed)
**Lenses:** `sp-using-superpowers`, `sp-brainstorming`, `/plan-ceo-review`, `engineering:architecture`
**Status:** Proposed — awaiting scope decision. **No code changed.**

**Revision note.** Rev 1 scored 6/10 in adversarial review; **seventeen** findings were
corrected in rev 2 (marked **[R2]**), including a critical scoping error that under-sized
the recommended work ~4x. Rev 2 scored 8/10 and surfaced **nine further defects the
revision itself introduced** — including a fabricated blockquote — corrected in rev 3
(marked **[R3]**). Full record: §11.

---

## 0. Measurement method (disclosed — rev 1 did not do this)

**[R2]** Rev 1 used a different, undisclosed counting method for each of four counts.
That is how the §5 scoping error survived. Every number below states its command and
scope. All counts are **occurrences** (`grep -o`) unless labeled *files* or *declarations*.

```bash
# accent occurrences, theme CSS
grep -rhoE 'helm-brass[a-z-]*' src/theme/bos.css | wc -l      # 88
grep -rhoE 'helm-brass[a-z-]*' src/theme/helm.css | wc -l     # 18

# sub-12px CSS declarations. [R3] A1's surface is 3 files: src/theme/{bos,helm}.css
# PLUS src/index.css (which holds 1 more, at :252). Rev 2 scoped this to src/theme/ only.
grep -ohE 'font-size:\s*(1[01](\.[0-9]+)?|[0-9](\.[0-9]+)?)px' src/theme/*.css src/index.css | wc -l   # 94

# accent occurrences in components  [R3] — rev 2 double-counted these
grep -rhoE 'ceo-gold[a-z-]*' src --include='*.tsx' | wc -l    # 37 (24 are tok("ceo-gold"), a SUBSET)
grep -rhoE 'brass[a-z-]*'    src --include='*.tsx' | wc -l    # 25

# sub-12px, Tailwind arbitrary utilities in components   <-- MISSED IN REV 1
grep -rhoE 'text-\[([0-9]|1[01])(\.[0-9]+)?px\]' src --include='*.tsx' | wc -l           # 368
grep -rlE  'text-\[([0-9]|1[01])(\.[0-9]+)?px\]' src --include='*.tsx' | wc -l           # 57 files
```

Contrast ratios are WCAG relative-luminance on the literal hex in `src/theme/helm.css`.
**[R3]** Two independent reviewers recomputed the ladder: one got 1.07/1.12/13.60, the
second 1.089/1.094/1.112 and 13.81. This document states **1.09 / 1.09 / 1.11** and
**13.81**. All three agree to the second decimal on the conclusion — the steps are far
below any perceptible threshold. **[R3]** Rev 2's §0 preamble mistakenly transcribed the
ladder as "1.09 / 1.11 / 13.82", mixing a step ratio with a text ratio; §3.1 was correct.

**[R3] Honest limit of this section.** Rev 2 promised "every number below states its
command." It delivered commands for 5 of ~20. The un-disclosed accent count was the one
that turned out wrong. Commands are now given for the numbers that drive scope decisions
(above). Counts still lacking a published command — 543/61/16/21 type-size figures, 45
custom properties, 100 components — are stated as measured but are **not independently
reproducible from this document**, and should be re-derived before anyone acts on them
alone.

---

## 1. System audit

| Signal | Measurement | Read |
|---|---|---|
| Branch | `05e8dbd`, pushed, tree clean | Safe |
| **Tests, all four suites** **[R2]** | runtime 1208 · unit 372 · vendor 28 · electron 9 = **1,617, all green** | Rev 1 reported only 2 of 4 suites |
| **Component / DOM tests** **[R2]** | **0** (`find src -name '*.test.tsx'`) | **Logic net only — covers none of the proposed work** |
| Typecheck / lint | 0 / 0 | Clean |
| TODO/FIXME/HACK in source | **0** | Exceptional discipline |
| Components | 100 `.tsx` | Large, organized |
| Theme CSS | 3,693 lines / 3 files | Concentrated |
| Files with inline 6-digit hex | 6 | Color discipline largely held |
| Distinct CSS custom properties | **[R3] 45** across the 3 files (27 in `src/theme/` alone) | Real token vocabulary exists |
| **Visual-regression harness** **[R2]** | **none** (no playwright/puppeteer/percy dep) | Must be built; it is a prerequisite, not a mitigation |

**Finding:** not a codebase in distress. Zero debt markers, 1,617 green tests. The
manifesto's "your architecture is a toy" framing is unsupported.

**Counter-finding [R2]:** the green suite is a *logic* net. Zero component tests means
Approach A2 (below) has no automated safety net at all.

---

## 2. Premise challenge

"Helm doesn't feel alive" is real. But the manifesto bundles three distinct problems:

1. **Visual craft** — real, measurable, addressed by A1/A2.
2. **Presence / liveness** — partly real, partly already built.
3. **Runtime architecture** — asserted without evidence, contradicted by §1.

**Do nothing?** Product keeps working; no user blocked. This is quality investment, which
means it must be sequenced against the one live defect (§6).

**Proxy skepticism.** "10,000/10" and "holy shit once per session" are unmeasurable.
Contrast ratios and size counts are. **[R2]** Rev 1 opened with its own unmeasured
"40% / 30% / 30%" — the same sin.

**[R3] Derived split, all four categories** (rev 2 fixed the numerator but kept a
three-category denominator after creating a fourth):

| Category | Items | Share |
|---|---|---|
| Confirmed, actionable (§3.1) | 5 | 28% |
| Already built (§3.2) | 5 | 28% |
| Rejected (§3.3) | **6** | 33% |
| Open / deferred, not rejected (§3.4, §9 diff-highlighting) | 2 | 11% |
| **Total** | **18** | |

---

## 3. Claim-by-claim verdict

### 3.1 Confirmed and measured — with acceptance targets **[R2]**

Rev 1 gave no targets, so none of this was executable.

| # | Defect | Measured now | Target | Where |
|---|---|---|---|---|
| 1 | Accent is a theme, not an accent | **[R3]** CSS: 88 in `bos.css` + 18 in `helm.css` = **106**. TSX: 37 `ceo-gold` (of which 24 are `tok("ceo-gold")`, a subset) + 25 `brass` = **62**. **Total 168 sites.** | Reduce to **3 roles**: active-nav, primary CTA, focus/selection ring. All else monochrome or semantic. | A1 + A2 |
| 2 | Surface ladder flat | adjacent steps **1.09 / 1.09 / 1.11 : 1** | **≥1.25:1** per adjacent step | A1 (3 files) |
| 3 | Type scale isn't a scale | **21** distinct sizes in theme CSS; **16** distinct `text-[Npx]` in tsx; **543** total utility occurrences | Single scale, **9 steps**, ~1.2 ratio | A1 + **A2** |
| 4 | Sub-12px floor violated | **93** CSS declarations + **368** tsx utilities = **461 sites**; floor at 8px | **12px absolute floor**, no exceptions | A1 + **A2** |
| 5 | Cockpit theme discontinuity | sidebar `rgb(18,27,46)` vs cockpit `oklch(0.98 0.005 90)`, no mediating frame | Cockpit adopts dark tokens (dark is the product identity) | A1 |

**[R2]** Rev 1 listed "Inbox cards over-dense (8 fields)" inside this table with the note
*"judgment, not measurement."* It has been moved out — a judgment call does not belong in
a table headed "measured." It is now a candidate in Approach C.

### 3.2 Already built — existence confirmed, quality unassessed **[R2]**

Rev 1 titled this "claims are factually wrong." That over-claims: existence rebuttals
cannot refute *quality* assertions, and §10 admits the quality was never evaluated.

| Manifesto claim | Existence check |
|---|---|
| "No command palette" | **Exists.** `CommandPalette.tsx`, wired `App.tsx:1036`. **[R2] 7 static base commands** (not 9) across **7 groups** (not 6) + all 16 nav entries, fuzzy subsequence matcher, unit-tested. |
| "No empty / loading / error states" | Exists: `inbox/EmptyState.tsx`, `ErrorState.tsx`, `SseDisconnectedBanner.tsx` |
| "No time travel" | Exists: `TimeScrubber.tsx`, `lib/replay.ts`, `SessionsBrowser.tsx` |
| "Agents feel dead" | Primitives exist: `TtlRing`, `StateBadge`, `HeartbeatRibbon`, `PulseGlobe`. **Whether they feel alive is untested — see §10.** |
| "No keyboard shortcuts" | ⌘K bound `App.tsx:436`; Escape/Enter/Arrow/Tab/Home/End handled across the app |

**[R2] Self-correction.** Rev 1's "9 commands / 6 groups" was read off a **stale type
comment** at `paletteCommands.ts:8` naming `"Navigate"` and `"Connectors"` — neither
exists in the code. Reading a comment instead of the code is precisely the error this
document charges the manifesto with. Corrected above; the stale comment should be fixed.

### 3.3 Rejected

| Proposal | Why |
|---|---|
| **LLM self-reported confidence, and false precision ("87%")** **[R2]** | LLMs emit no calibrated confidence. A fabricated number on a security-approval screen is invention presented as fact. **Narrowed in rev 2** — see §3.5. |
| **Ghost cursor / "agent spent 4 min here"** | Requires attention telemetry that does not exist. Same fabrication class. |
| **Collapse sidebar to 3 items** | `bosNav.ts` is a closed typed union (unbuilt page = compile error). **[R3]** Hiding **13 of 16** surfaces behind ⌘K makes Accounts/Vault/Workflows undiscoverable. Linear has 5 items because it is *one workflow*; Helm is an OS with 16 surfaces. |
| **LangGraph orchestration** | ADR-057-B. Python-first library into a Node/Electron CLI-spawn engine. |
| **Docker container per agent** | ADR-057-C. Destroys the local-first promise that is the product's differentiator. |
| **Geist / Inter fonts** **[R2]** | Self-contradicting: the doc warns against generic AI-design defaults, then names the two most generic. *Rev 1 also cited the F4 offline constraint — **withdrawn**, both families self-host fine. F4 rules out CDN fonts, not these families.* |

**[R3]** Rev 2 left *"diff syntax highlighting"* in this rejected table while §4.4 and §9
had already reclassified it as **deferred with a known safe design**. Row removed; see
§3.4 and §4.4.

### 3.4 Downgraded from rejected to open **[R2]**

**SSE → WebSocket.** Rev 1 bundled this with LangGraph and Docker and scored the bundle
1/5 reversible. In isolation it is far more reversible: transport sits behind ADR-052's
closed event catalog. Still **not recommended** (no evidence of need; rewrites solved
auth/reconnect), but it is a two-way door and should be reconsidered if a feature ever
genuinely needs client→server streaming mid-task. See ADR-057-A.

### 3.5 Where rev 1 was unfair to the manifesto **[R2]**

Rev 1 banned "confidence scoring" as a whole category. **The codebase already ships the
honest form of exactly that idea.** `RiskChip.tsx` renders a *banded* risk signal on the
same approval screen, and `inboxClient.ts:223` handles the unknown case explicitly:

```ts
/** `unrated` while P2 leaves the band null — never an invented band. */
```

That is banded rather than falsely precise, computed rather than self-reported, with an
explicit unrated state — the ADR-053 pattern. The rejection is therefore narrowed to
**LLM self-reported confidence and any false-precision percentage**. A computed, banded
confidence signal following ADR-053 is a legitimate future option.

---

## 4. Architecture decisions

**[R2]** Rev 1 bundled three proposals into one ADR and scored the bundle by its worst
member. Unbundled below. **[R2]** Also renumbered: highest existing is ADR-056 and
ADR-057 is already referenced, so this takes **058**, not the 060 rev 1 claimed.

### ADR-057-A: SSE → WebSocket — **not now, revisit on need**
Current: SSE down + REST POST up, single-use signed ticket auth (ADR-052).
Reversibility **4/5** — transport is abstracted behind a closed event catalog.
Rejected on *absence of need*, not on risk. Revisit if live code streaming or typing
indicators become a committed requirement.

### ADR-057-B: LangGraph orchestration — **reject**
Python-first library; engine spawns the Claude CLI from Node/Electron. Adopting it is a
ground-up rewrite of the execution model. Reversibility **1/5**. No evidence of need.

### ADR-057-C: Docker container per agent — **reject**
Kills `npm install` and go. Local-first with no cloud dependency is the stated
differentiator. Reversibility **2/5**.

### 4.4 CRITICAL — the diff viewer is a security control

`src/components/inbox/ReviewPane.tsx:41-45`, quoted verbatim **[R3]**:

> SECURITY (P3 exit criterion): the diff is rendered as TEXT NODES ONLY. Every
> line goes through React's normal child escaping. There is no innerHTML and no
> dangerouslySetInnerHTML anywhere in this file or its siblings — the mockup's
> innerHTML pattern deliberately does not ship. Diff content originates in a
> sandboxed agent's output, so it is untrusted by definition.

**[R3] Rev 2 misquoted this.** It rendered the passage as *"Every innerHTML pattern
deliberately does not ship,"* splicing "Every" from the preceding sentence onto a clause
whose actual subject is "the mockup's". A fabricated quotation inside a blockquote, in a
document whose authority rests on measurement discipline. Corrected above.

Verified repo-wide: `grep -rn "dangerouslySetInnerHTML\|innerHTML" src/` returns **only
comments** — **[R3] 20 matches across 15 files** (rev 2 said 17 files).

The comment names *sandboxed agent output* as the untrusted source. **[R3]** The
additional external-PR vector is this document's **inference** from `ReviewPane.tsx:244`
(`delivery.source === "github-pr"`), not a claim the comment makes.

The manifesto calls this "1990s" and demands syntax highlighting. Executed naively that
means `dangerouslySetInnerHTML` and reintroduces the exact XSS the control prevents.

**[R2] Disposition, made explicit:** highlighting is achievable safely — Shiki emits a
token array rendered as React elements, never raw HTML. **That is the design.** It is
deferred on cost, not blocked on unknowns. Anyone building it must first restate the P3
criterion as a test.

---

## 5. Approaches — rescoped **[R2]**

Rev 1's Approach A claimed "concentrated in 3 CSS files" while its own §1 recorded 66
component files as the real surface. Corrected: **~80% of defects #3 and #4 live in
component files.** Split accordingly.

### A1 — CSS token layer
**Surface:** 3 files, 3,693 lines. Surface ladder, accent reduction in CSS, theme-CSS
type scale, cockpit unification.
**Fixes:** defect #2 fully, #5 fully, #1 partially (106 of 167 accent sites), #3/#4
partially (93 of 461 sub-12px sites).
**Effort:** human ~2-3 days / CC ~1-2 hours. **Risk: Low. Reversibility 5/5.**
**Safety net:** none automated, but blast radius is one layer and text contrast already
passes AA (5.30–13.82:1), so contrast cannot silently regress.

### A2 — Component utility sweep
**Surface:** **57 files, 368 sub-12px occurrences** (543 total `text-[Npx]` across 61
files), plus 61 accent sites in `.tsx`.
**Fixes:** the remaining ~80% of #3, #4, and #1.
**Effort:** human ~1-2 weeks / CC ~4-8 hours. **Risk: Medium. Reversibility 4/5.**
**Blocked on:** a visual-regression harness that **does not exist** (§1). Building it is
unestimated and gates A2 entirely.

### A0 — Screenshot harness (prerequisite, was mis-filed as "mitigation" in rev 1)
Playwright + deterministic screenshots at 320/768/1440, both themes, per BOS page.
**Effort:** human ~1-2 days / CC ~1-2 hours. Unlocks A2 and every future UI change.

### C — Honest liveness subset (deferred, not scoped here)
Activity stream (a *consumer* of `task.*` / `agent.state` / `usage.tick`, which ADR-052
already fans out — verified), richer agent status from real state, progressive-disclosure
Inbox cards. **[R2]** Rev 1 gave these three one shared effort number, which is the same
mega-bundling it charges the manifesto with. **Not estimated here.** Each needs its own
scoping pass after the §6 re-audit.

### B — Manifesto verbatim
human ~3 months / CC ~3-4 weeks. Reversibility 1/5. Ships fabricated confidence, risks
the §4.4 XSS regression, rewrites a green 1,617-test system with no evidence of need.

---

## 6. THE recommendation — stated once **[R2]**

Rev 1 stated three incompatible recommendations across §0, §5 and §6. One, here:

> **Ship edit-account → build A0 → execute A1 → execute A2 → re-audit → then scope C.**

| # | Step | Effort (human / CC) | Gate |
|---|---|---|---|
| 1 | **edit-account** — closes a live shipping lie | ~1-2 days / ~1 hr | TDD; security review (handles API keys); all 4 suites |
| 2 | **A0** harness | ~1-2 days / ~1-2 hr | Baseline screenshots committed |
| 3 | **A1** CSS tokens | ~2-3 days / ~1-2 hr | Targets in §3.1 met; screenshots diffed |
| 4 | **A2** component sweep | ~1-2 wks / ~4-8 hr | 12px floor absolute; 9-step scale; screenshots |
| 5 | **re-audit** the real app | ~0.5 day / ~30 min | Measure, don't assume |
| 6 | **scope C** | — | Separate decision |

**Why this order.** Step 1 is the only item that fixes something users hit today. Step 2
before 3-4 because there is no component test coverage — without screenshots, A2 is
unverifiable. Step 5 before 6 because rev 1 proved that reasoning about this app from
anything other than direct measurement produces errors.

---

## 7. §6.1 — the live defect

`agent-runtime/server.mjs:1007` streams to the user:

> "This account has no model set — **edit the account** and add a model id (e.g. nvidia/…:free)."

`src/components/bos/AccountsPage.tsx` `AccountRow` renders only **Set active** and
**Remove**. There is no edit affordance. The runtime instructs the user to perform an
action the UI does not offer; the only recovery is delete-and-re-add, which destroys the
sealed secret. This is shipping today and outranks every item in §3.

---

## 8. Risks

| Risk | Sev | Mitigation |
|---|---|---|
| **A2 has zero automated coverage** | **High** | A0 harness is a hard prerequisite. Do not start A2 without it. |
| A0 itself is unestimated | Med | Timebox to 2 days; if it overruns, A1 still ships standalone |
| Surface-ladder change harms contrast | Low | All text tokens 5.30–13.82:1 today; re-measure and gate on AA |
| Cockpit unification touches the light swarm view | Med | Isolate behind the `data-theme` seam; screenshot both themes |
| Scope creep back toward B | Med | §3.3 rejections stand absent explicit override |
| Safe diff highlighting drifts to `innerHTML` | **High** | Restate the P3 criterion as a test *before* any highlighting work |

---

## 9. NOT in scope

LLM self-reported confidence and false-precision percentages · ghost cursors / attention
heatmaps · LangGraph · Docker-per-agent · sidebar collapse · font-family change · voice
input · diff syntax highlighting (deferred, design known, not blocked) · SSE→WebSocket
(open, not rejected — ADR-057-A).

---

## 10. Known gaps

- **The manifesto and the reviewed mockup are not in this repo.** **[R2]** The mockup was
  session-local (my scratchpad), not a committed artifact. Rev 1's load-bearing claim
  ("it audited a mockup, not the app") therefore has **no citation a reader can check** —
  and it was written by the mockup's author. Treat it as disclosed self-interest.
- **`ReviewPane` visual quality unaudited.** Its security contract was read; its design was not.
- **Liveness primitives: existence verified, quality not.** §3.2 proves they exist, not that they work well.
- **Competitor palette values (Linear/Raycast hex) unverified** and used as the basis for nothing here.
- **Light cockpit theme's internal token discipline never audited.**
- Effort figures are judgment, not measured throughput; the human/CC ratios vary (~13x, ~7x, ~3x) and that model is not defended.

---

## 11. Adversarial review record

Rev 1 was reviewed by an independent agent with fresh context, which verified claims
against the codebase. **Score 6/10.** Verdict: *"Do not execute Approach A against the
effort estimate as written."*

Findings and disposition:

| # | Finding | Disposition |
|---|---|---|
| 5.1 | **CRITICAL** — A sized against 3 CSS files; 368 sub-12px sites live in 57 tsx files | **Fixed** — split A1/A2/A0, §5 |
| 1.1 | Central premise uncited; no repo mockup matches | **Disclosed** as a gap, §10 |
| 1.3 | Only 2 of 4 test suites reported | **Fixed** — 1,617 across 4, §1 |
| 1.4 | "Strong regression net" — but 0 component tests | **Fixed** — §1 counter-finding |
| 1.5 | F4 font objection not dispositive | **Withdrawn**, §3.3 |
| 2.1 | §1 and §5 contradict on surface size | **Fixed**, §5 |
| 2.2 | Three incompatible recommendations | **Fixed** — one, §6 |
| 2.3 | Unmeasured 40/30/30 | **Fixed** — derived 29/29/41, §2 |
| 2.4 | Judgment item inside a "measured" table | **Fixed** — moved to C, §3.1 |
| 3.1 | No acceptance thresholds | **Fixed** — target column, §3.1 |
| 3.3 | Diff-highlighting disposition ambiguous | **Fixed**, §4.4 |
| 3.4 | Approach C bundled under one estimate | **Fixed** — de-scoped, §5 |
| 4.2 | ADR bundles 3 decisions, scored by worst | **Fixed** — 058-A/B/C, §4 |
| F1 | Confidence ban broader than its argument; `RiskChip` ships the honest form | **Fixed** — narrowed, §3.5 |
| — | "9 commands / 6 groups" read off a stale comment | **Fixed** — 7/7, §3.2 |
| — | ADR-060 collides; 057 already referenced | **Fixed** — 058 |
| 4.1 | `TODOS.md` proposal is scope creep | **Removed** |

Reviewer findings **upheld against** this document: the `ReviewPane` security finding,
the edit-account finding, and the ADR-052 argument were all independently verified as
correct.

### Rev 2 → rev 3 **[R3]**

Rev 2 scored **8/10**. The reviewer verified 15 of 17 claimed fixes as genuine ("not a
fix-washing document"), reproduced every headline count exactly, and confirmed all four
`file:line` citations land on the exact lines with the exact text. It then found **nine
defects the revision itself introduced**:

| Finding | Disposition in rev 3 |
|---|---|
| **§4.4 blockquote was fabricated** — "Every innerHTML pattern" spliced from a different sentence; actual subject is "the mockup's" | **Fixed** — full verbatim quote, misquote disclosed |
| §3.1 accent decomposition double-counted 24 sites and omitted 25; right total by luck | **Fixed** — 106 CSS + 62 TSX = 168, commands published |
| Line 8 said "thirteen findings"; §11 listed 17 | **Fixed** — seventeen |
| §3.3 still listed diff-highlighting as *rejected* after §4.4/§9 deferred it | **Fixed** — row removed |
| §2 percentages used a 3-category denominator after rev 2 created a 4th | **Fixed** — 18 items, 4 categories |
| ADR-058 claimed; 057 is actually free (only a conditional "if wanted" note) | **Fixed** — renumbered 057 |
| §0 scoped CSS to `src/theme/` (2 files) while A1's surface is 3 | **Fixed** — 93 → 94 |
| §4.4 "17 files" of innerHTML comments | **Fixed** — 20 matches / 15 files |
| §3.3 "12 of 16" surfaces hidden by a 3-item sidebar | **Fixed** — 13 of 16 |
| §1 "44 custom properties" | **Fixed** — 45 |

**Open, accepted as limits (not fixed):**

- **A0 determinism is unproven.** The reviewer's sharpest unaddressed point: screenshots
  must be made deterministic against `HeartbeatRibbon`, `PulseGlobe`, `TtlRing` and live
  SSE. §8 timeboxes A0's *duration* but never establishes its *feasibility*. **Do not
  commit to the A0 estimate until this is proven.**
- **The 16 → 9 type-size mapping does not exist.** A2 cannot finish without it. That
  mapping is a decision this document does not make.
- **edit-account scope undefined** — model id only, or key/label/providerType too? §7
  implies the sealed secret must survive, by inference only.
- **§2.1 was resolved by deletion, not reconciliation.** Rev 2 removed rev 1's
  component-file row from §1 rather than reconciling it with §5; §1 read alone still says
  "Concentrated."
- **§10's first bullet is disclosure without resolution.** It states the load-bearing
  mockup claim is uncheckable and author-written, then does not say what the reader should
  do with that. If the mockup-vs-app distinction cannot be verified, it weakens §3.2's
  rebuttals — and this document does not resolve that.

**Reviewer verdict on rev 2:** *"Act on it: ship edit-account and A1 now, but do not
commit to the A0 timebox until someone has proven screenshots can be made deterministic
against the live-animating agent primitives, and settle the 16→9 size mapping before A2
opens."*
