# Phase 3 Strategy Memo — CEO Command Bar · Live SYNC Feed · Heartbeat Timeline

> Author: CEO agent (MissionAlpha) · Date: 2026-06-02 · Audience: USER (Rohit)
> Status: **AWAITING_USER_DECISION** — strategy only, nothing built.
> Scope: Phase 3 of `docs/BUILD-PLAN.md`. Phases 0–2 DONE (scheduler JSON, scaffold+seam, kanban with State↔Pipeline toggle).
> Hard constraints: React19 + Vite + Tailwind + Framer only · dark cinematic default · reads the SAME `agent-status/state.json` (no new backend) · 3D globe + theme toggle stay in Phase 4 · design-skill bar locked = impeccable + soft-skill + emil-design-eng + hallmark.

---

## 1. Headline + Recommendation

Build Phase 3 as a **single top "Mission Strip" + a dock-anchored live feed + an inline heartbeat ribbon** — recommend **Option B (Mission Strip)**: one always-visible status spine that answers "does this need ME, and is the swarm alive" in under 2 seconds, with the feed and heartbeat as calm supporting instruments rather than competing focal points.

## 2. Operator Job-to-be-Done (the WHY the kanban can't satisfy)

The kanban answers **WHERE each agent is** (which column). It does NOT answer the four questions an operator of a 16-agent swarm actually opens the screen for:

1. **"Does anything need ME right now?"** — The CEO agent's `AWAITING_USER_DECISION` is the single highest-value pixel in the whole product. Today it's buried as one card among sixteen. (Live state confirms: `ceo.state` flips to `AWAITING_USER_DECISION` / `MONITORING` and carries a capability-gaps concept.)
2. **"Is the swarm actually alive, or did it silently die?"** — `scheduler.running`, `lastTick`, `staleCount`. A swarm that stalled looks identical to a swarm that's idle on a kanban. The live state already shows `staleCount: 1` and a stale CEO card (`ageSec: 221 > ttlSec: 60`) — exactly the failure the operator must catch instantly.
3. **"What just happened — who told whom what?"** — `feed[]` (from→to→topic→body) is the swarm's nervous system. The kanban shows position, not *flow*. This is the difference between a parking lot (kanban) and air-traffic-control (feed).
4. **"Is throughput healthy or flatlining?"** — `heartbeats[]` over time = the org's pulse. One missed beat is noise; a flat line is a dead swarm.

First-principles atom: **the kanban shows STATE; Phase 3 must show CHANGE, LIVENESS, and DEMAND-ON-ME.** Those three are orthogonal to position. That's why they're a separate phase, not more columns.

## 3. First-Principles Atoms (hard vs soft constraints)

**Hard (unbreakable):**
- One data source, polled — `state.json`. No new backend (USER constraint). Feed and heartbeat arrays are already in the payload; we are *rendering existing data*, not generating it. Idiot-index here is excellent: ~zero raw-data cost, all value is in the render.
- Dark cinematic default; Framer for motion; no Three.js this phase.
- Wall-display-grade: must be glanceable from across a room AND useful up close. (These pull in opposite directions — see options.)

**Soft (assumed, worth challenging):**
- "More feed = better." Likely FALSE. Best-in-class ops UIs (Datadog 5-second rule, Bloomberg) win by *suppressing* noise, not maximizing it. "The best part is no part" → the feed should default to *collapsed/calm* and expand on demand.
- "The heartbeat needs a chart." Possibly over-built. A sparkline ribbon may beat a full recharts timeline for glanceability. Deletion-before-optimization applies.
- "The CEO bar is one component." Actually the demand-on-me signal deserves to be *the* persistent element, separable from CEO metadata.

## 4. Outside-World References (best-in-class real-time ops UIs)

1. **NASA Open MCT** — open-source mission-control telemetry framework; pattern: composable telemetry "objects" with persistent status + drill-down, liveness is first-class. ([github.com/nasa/openmct](https://github.com/nasa/openmct)) — *informs: status-first, drill-down-on-demand.*
2. **Bloomberg Terminal UX** — wins on **information density, instantaneous load, color-coding, and predictability over consumer prettiness**; "well-designed interfaces look boring." ([bloomberg.com/company/stories/how-bloomberg-terminal-ux-designers-conceal-complexity](https://www.bloomberg.com/company/stories/how-bloomberg-terminal-ux-designers-conceal-complexity/)) — *informs: semantic color is the fastest channel; restraint reads as premium; conceal complexity, reveal on demand.*
3. **Bloomberg color-accessibility work** — deliberate color frameworks so status survives color-vision-deficiency; color must be redundant with shape/text. ([bloomberg.com/ux/2021/10/14/designing-the-terminal-for-color-accessibility](https://www.bloomberg.com/ux/2021/10/14/designing-the-terminal-for-color-accessibility/)) — *informs: never encode state in color alone (a11y, locked skill bar agrees).*
4. **Datadog / Grafana dashboard + alerting practice** — the **"5-second rule"** (system health legible in 5s), status overview + active-alert count at top, **alert on symptoms not causes**, favor **fewer high-quality signals**. ([grafana.com/.../best-practices](https://grafana.com/docs/grafana/latest/visualizations/dashboards/build-dashboards/best-practices/), [docs.datadoghq.com/monitors/guide/monitor_best_practices](https://docs.datadoghq.com/monitors/guide/monitor_best_practices/)) — *informs: status spine on top, count of things-needing-attention, suppress low-value events.*
5. **Linear (2025 "bolder linear" trend)** — monochrome base, **even fewer accent colors**, scannable activity feed where event types share a visual "family," low cognitive load via single scan direction. ([linear.app](https://linear.app/), [blog.logrocket.com/ux-design/linear-design](https://blog.logrocket.com/ux-design/linear-design/), [ui-patterns.com/patterns/ActivityStream](https://ui-patterns.com/patterns/ActivityStream)) — *informs: feed rows as a typographic family, restrained color, one scan axis.*

**Cross-cutting synthesis:** every elite real-time ops surface converges on the same three moves — (a) a **persistent status spine** answering "is it healthy / does it need me" at the top, (b) **semantic color + shape** as the fastest perceptual channel, redundantly encoded, and (c) **calm by default, density on demand**. Phase 3 should obey all three. None of them is "a bigger chart."

## 5. Persona Lenses

- **Bezos (customer-obsession):** The customer is Rohit standing up, glancing, sitting back down. Work backwards from that 2-second glance. The single most customer-valuable pixel is "the swarm needs your decision." Build the whole strip around surfacing that, not around showing off the feed.
- **Musk (first-principles / best-part-is-no-part):** We are rendering data that already exists — the expensive part is restraint, not features. Delete the full chart if a sparkline suffices. Don't add a fourth panel. One spine, one feed, one ribbon.
- **Solomon (risk-adjusted):** The asymmetric risk is a **silently dead swarm** read as "idle." Liveness/stale detection is the highest risk-adjusted return in Phase 3 — cheap to build, catastrophic if missing. Weight it above feed aesthetics.
- **Fink (long-duration):** Phase 3 must not paint Phase 4 (3D globe, theme) into a corner. The Mission Strip should be a stable, theme-token-driven spine the globe slots *behind* later — durable, not throwaway.

When personas disagree: Bezos (surface demand-on-me) + Musk (delete excess) dominate this near-term build; Fink's durability constraint is satisfied by token-driving the strip so Phase 4 is additive.

## 6. Options (≥3, distinct)

Scoring key (1–5): **Glance** = operator glanceability · **Premium** = wall-display/Apple-Tesla feel · **Effort** = build cost (lower number = more effort, i.e. 5 = cheap).

### Option A — "Three Instruments" (literal BUILD-PLAN reading)
- **Thesis:** Build exactly what the plan names — a CEO command bar, a side-by-side LiveFeed panel, and a recharts HeartbeatTimeline panel, as three co-equal components in a bottom split row.
- **Bar:** Full-width CEO bar under the stat tiles: CEO avatar, state, current initiative, awaiting-you badge, capability-gaps chip, scheduler dot.
- **Feed:** Left bottom panel, scrolling SYNC_LOG, slide+fade-in newest-on-top, per-agent filter dropdown.
- **Heartbeat:** Right bottom panel, recharts area chart + animated motion sweep line, scheduler tick markers.
- **Motion:** Halo pulse on AWAITING; feed rows slide+fade; chart path-draw sweep.
- **Tradeoffs:** Faithful to plan, but three co-equal focal points fight for attention — violates the Datadog 5-second rule and Bloomberg "conceal complexity." The chart is the heaviest build for the least glance value. Risk: looks like a generic SaaS dashboard (hallmark would flag it).
- **Time-to-value:** Medium. **Optimizes for:** plan-fidelity + completeness.
- **Scores:** Glance **3** · Premium **3** · Effort **3**.

### Option B — "Mission Strip" (RECOMMENDED)
- **Thesis:** One **always-visible status spine** at the very top — the single highest-value real estate — that fuses *demand-on-me + liveness + pulse* into one calm line. Feed and heartbeat become **supporting instruments docked below**, calm by default, expandable on demand. Borrowed straight from Bloomberg (spine + density-on-demand), Datadog (5-second status header), Linear (restraint).
- **Bar (the strip):** A slim, full-width spine pinned top: `[CEO node · state]  ·  ⚠ NEEDS YOU pill (only renders when AWAITING_USER_DECISION — otherwise collapses to nothing)  ·  capability-gaps chip  ·  live pulse ribbon (inline mini-sparkline of heartbeat cadence)  ·  scheduler health dot + lastTick age`. The strip *is* the heartbeat surface — no separate chart needed for the glance case.
- **Feed:** Docked right rail (or bottom drawer on narrow), **collapsed-calm**: shows last 3 events as a quiet typographic family (Linear-style: `from → to` mono, topic chip, relative time), with a "N more" expander. Filter by agent. New event = one soft glow + slide, then settles. No firehose.
- **Heartbeat:** **Inline ribbon** inside the strip (mini sparkline of beats/tick over the recent window) + tick markers; the *full* recharts timeline is an optional expand from the ribbon, not always-on. Deletes the heaviest component from the default view.
- **Motion (emil-design-eng governed):** NEEDS-YOU pill does a **single attention pulse on arrival then a slow steady breathing halo** (≤300ms enter, ease-out, never ease-in); stale scheduler dot breathes red; sparkline animates only the newest point (GPU transform/opacity only); count-ups spring. Reduced-motion → static glow snapshot.
- **Tradeoffs:** Slightly reinterprets the plan (chart demoted to on-demand) — needs USER blessing. Requires disciplined restraint or it collapses back into Option A. Upside: textbook glanceability + premium-by-restraint + Phase-4-durable (globe slots behind the strip).
- **Time-to-value:** Medium (less than A — one heavy chart deferred). **Optimizes for:** the 2-second glance + premium feel + Phase-4 durability.
- **Scores:** Glance **5** · Premium **5** · Effort **3**.

### Option C — "Ambient Command Theater" (maximalist, wall-display-first)
- **Thesis:** Treat the whole screen as an always-on situational-awareness wall. The feed isn't a panel — it's an **ambient ticker** flowing across the top like mission-control telemetry; the heartbeat is a **full-width living EKG strip**; the CEO demand-signal commandeers the *entire* screen state (cinematic takeover) when a decision is pending.
- **Bar:** No discrete bar — CEO state is woven into a global ambient header; on AWAITING the whole viewport dims and a centered cinematic "AWAITING YOUR DECISION" card rises (Crew-Dragon-style takeover).
- **Feed:** Edge-to-edge horizontal **telemetry ticker**, continuous motion, agents color-keyed.
- **Heartbeat:** Full-width animated EKG/waveform across the base, pulsing on each tick.
- **Motion:** Heavy, continuous, cinematic — perpetual motion everywhere.
- **Tradeoffs:** Spectacular as a wall display; **fails up-close operator use** — perpetual motion is fatiguing, ticker is unscannable (violates Linear single-axis scan + Datadog "fewer signals"), and cinematic takeover steals control. Highest build + highest a11y/reduced-motion burden. Real risk of "impressive but ignored / muted." Partly trespasses on Phase 4's motion budget.
- **Time-to-value:** High effort. **Optimizes for:** demo wow / across-the-room spectacle.
- **Scores:** Glance **2** (up close) / 4 (across room) · Premium **4** (cinematic) but slop-risk · Effort **2**.

| Option | Glance | Premium | Effort(↑=cheaper) | Reversibility | Best for |
|---|---|---|---|---|---|
| A Three Instruments | 3 | 3 | 3 | Type 2 | plan fidelity |
| **B Mission Strip** | **5** | **5** | **3** | **Type 2** | **the glance + durability** |
| C Ambient Theater | 2/4 | 4 (slop-risk) | 2 | Type 2 | demo spectacle |

All three are **Type 2 (reversible)** decisions — UI, no backend, swappable. That lowers the cost of choosing and argues for picking the one with the best expected glance value now (B), iterating later.

## 7. Pre-mortem — how Phase 3 UX fails in 12 weeks of real use

1. **The feed becomes wallpaper (noise death).** A firehose of every `from→to` line trains Rohit to ignore it. *Failure mode behind Option A/C.* → **Mitigation (B):** collapsed-calm by default, last-3 only, expand on demand; the demand-on-me pill is the only thing that ever *demands*.
2. **The one pixel that mattered got missed.** `AWAITING_USER_DECISION` rendered as just-another-card; Rohit doesn't notice the swarm is blocked on him. → **Mitigation (B):** NEEDS-YOU pill is the top-priority element with dedicated attention motion; it's the product's reason to exist.
3. **Dead swarm read as idle.** Scheduler stalled, `staleCount` climbs, but nothing screams. (Live data *already* shows a stale CEO + `staleCount:1` — this failure is present today.) → **Mitigation:** scheduler dot + lastTick-age + breathing-red stale must be unmissable and redundant (color + shape + text).
4. **Motion fatigue / looks like AI-slop.** Perpetual animation (Option C) or generic glassmorphism makes it tiring and un-premium; hallmark audit fails. → **Mitigation:** emil-design-eng discipline (≤300ms, ease-out, settle-to-still, reduced-motion), restraint-as-premium, hallmark P/H/E/S/R/V gate.
5. **Phase 4 collision.** Heavy motion/chart now leaves no room for the 3D globe + theme later; rework. → **Mitigation (B):** strip is token-driven and globe-agnostic; heaviest chart deferred; motion budget reserved.
6. **Color-only encoding fails a11y / glance.** State legible only by hue. → **Mitigation:** Bloomberg lesson — every state redundantly shape+text+color.

## 8. CEO Recommended Path + Why

**Recommend Option B — Mission Strip.** It is the only option that passes all four persona lenses simultaneously: Bezos (the 2-second glance + surfacing demand-on-me as the hero), Musk (renders existing data, deletes the heaviest component from the default, best-part-is-no-part), Solomon (liveness/stale = highest risk-adjusted return, cheap to build, catastrophic if absent), and Fink (token-driven, Phase-4-durable spine). It is also the closest to every best-in-class reference: Bloomberg's spine + conceal-complexity, Datadog's 5-second status header, Linear's restrained scannable feed family. It is a Type-2 (reversible) decision, so if the calm-feed proves *too* calm in use, we expand it in a one-component iteration — no rework.

Option A is the safe literal build but risks a generic-SaaS look and spends the most effort on the lowest-glance component (the chart). Option C wins the demo and loses the daily operator. B is the investment-grade middle: maximal glance, premium-by-restraint, durable.

## 9. Open Questions (where CEO is uncertain — name them)

1. **Feed default density:** last-3-collapsed (my pick) vs last-6 vs full-scroll. Operator preference — happy to ship 3 and tune.
2. **Heartbeat: ribbon-only now, or ribbon + on-demand full chart?** I lean ribbon-first, full chart as a stretch within Phase 3 or punt to polish.
3. **Strip placement:** above the stat tiles (truest "spine," my pick) vs replacing/merging with the existing header.
4. **NEEDS-YOU interaction:** purely a *signal* in Phase 3, or does clicking it open a drawer (note: there's no write-back path — it can only *show*, not approve, since one-way `state.json`). Recommend signal-only now.

## 10. Asks of USER — explicit decision

**GO / NO-GO / ITERATE on Option B (Mission Strip).**

- **GO Option B** → I dispatch the build (senior-web) to implement the Mission Strip + collapsed-calm docked feed + inline heartbeat ribbon, dark cinematic, locked skill bar, reading existing `state.json`. Phase 4 (globe/theme) untouched.
- **GO Option A** (literal plan) or **C** (theater) → I redirect accordingly.
- **ITERATE** → tell me which open question (§9) to resolve and I'll return a tightened memo.
- **NO-GO** → Phase 3 parked; kanban (Phase 2) stands.

---

### Appendix — data contract being rendered (already live, no backend change)
- `feed[]`: `{ ts, from, to, topic, ref, body }` (live: 12 events)
- `heartbeats[]`: `{ ts, agent, state }` (live: 20 events)
- `scheduler{}`: `{ running, cadenceSec, lastTick, activeCount, staleCount }`
- `agents[].ceo`: `state ∈ {AWAITING_USER_DECISION, MONITORING, …}`, `ageSec`, `ttlSec`, `stale`, plus capability-gaps concept.
- References: NASA Open MCT, Bloomberg Terminal UX (complexity + color-accessibility), Grafana/Datadog dashboard+alerting best-practices, Linear/Activity-Stream patterns (cited inline §4).
</content>
</invoke>
