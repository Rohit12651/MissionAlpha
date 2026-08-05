# Final Sweep — Agent Inbox Program (P0–P10)

**Date:** 2026-07-30 · **Product:** MissionAlpha — The Agent Inbox · **Record type:** PES program delivery record (P10 deliverable).

This is the program-level truth of what was built across P0–P9 and what is carried into
the P10 handoff. Every figure below traces to the live PROGRAM STATUS in
`docs/superpowers/plans/2026-07-30-agent-inbox-program-plan.md`, to the ADRs, or to the
code/tests named. **No commits have been made** — the global no-commit rule (program plan
§4) is still in force; all work sits in the working tree awaiting BOSS's go.

> **Post-sweep update (2026-07-30, resume window):** the two OPTIONAL final-gate depth-items
> flagged in the P10 EXIT "DESIGN-GAUNTLET NOTE" — a standalone `hallmark`+`impeccable` scored
> design audit over the whole app, and a full WCAG 2.2 AA a11y pass — have now been **run and
> closed** for the audited scope. Record: [`DESIGN-A11Y-AUDIT-2026-07-30.md`](./DESIGN-A11Y-AUDIT-2026-07-30.md).
> Outcome: design confirmed ship-grade (hallmark P5 H5 E5 S5 R5 V4, slop-test clean); **3 MAJOR
> WCAG AA fails found + fixed** (2 small-text contrast tokens + a missing `<main>`/skip link),
> surgical 3-file change, all gates re-green (unit 211, build ✓, index 187.33KB gz), every fix
> live-verified. Still BOSS-operated: `gh`/real-PR, dogfood week, commit, dmg build (unchanged).

---

## 1. Phase ledger (what shipped · gates at exit · security · snapshot)

| Phase | Shipped | Gates at exit | Security verdict | Snapshot |
|---|---|---|---|---|
| **P0** Baseline & guardrails | Fixed lint (eslint installed real) + unit runner; wired 297 orphaned runtime tests; regression suite R1–R10 | lint 0/0 · tsc 0 · unit 100 · runtime 329 · vendor 6 · build 5.4s | none new | — |
| **P1** Debt burn-down (7 asks) | Stop button, send-loader, 1800+ skills palette, delete-agent, manual skill add, CEO-picks-team | lint 0/0 · tsc 0 · unit 113 · runtime 335 · vendor 28 · build ✓ | in-lane review APPROVE | `../ma-snapshots/P1-2026-07-30.tgz` |
| **P2** Delivery engine + bus | SQLite deliveries + events_log; SSE bus; inbox routes through broker | lint 0/0 · tsc 0 · unit 113 · runtime 411 · vendor 28 · build 5.06s | **NEEDS-FIX → 2 HIGH fixed (8 fixes + 12 tests) → APPROVED** | P2 |
| **P3** Inbox UI + notifications | Helm Inbox, review pane full-diff, risk chips, SLA timers, typed-confirm, notification + badge, flag-off kill-switch | lint 0/0 · tsc 0 · unit 150 · runtime 414 · vendor 28 · build 5.13s · index 178KB gz | text-diff XSS guard | — |
| **P4** Autonomy | Durable queue, auto-retry, failure Deliveries, auto-chain, MAX_INFLIGHT | lint 0/0 · tsc 0 · unit 178 · runtime 487 · vendor 28 · build 5.03s · 178.28KB gz | **APPROVED** (1 MED + 4 LOW hardened) | P4 |
| **P5** Any repo · worktrees · PRs | Workspace picker, git worktrees, approve→commit→push→`gh pr create` ladder | lint 0/0 · tsc 0 · unit 184 · runtime 606¹ · vendor 28 · build 5.75s · 179.37KB gz | **CRIT + 2 HIGH fixed (10 total) → APPROVED** | P5 |
| **P6** Risk router · policy · SLA | Classifier, deny-by-default per-band policy, un-removable deny-list, SLA sweep | lint 0/0 · tsc 0 · unit 192 · runtime 674 · vendor 28 · build 5.49s · 181.17KB gz | **1 HIGH + 1 MED fixed → APPROVED** | P6 |
| **P7** Universal ingestion | GitHub-PR adapter (2-way, idempotent) + read-only Claude Code adapter; external triple-gated | lint 0/0 · tsc 0 · unit 196 · runtime 709 · vendor 28 · build 4.95s · 183.61KB gz | **APPROVED — no CRIT/HIGH** (LOW + INFO closed) | P7 |
| **P8** Usage meter · audit export | Tokens + context% per agent/thread/tier on bus; scrubbed JSON/CSV export; no dollars | lint 0/0 · tsc 0 · unit 204 · runtime 726 · vendor 28 · build 5.22s · 185.31KB gz | Fable verify (no new endpoint risk) | P8 |
| **P9** Second seat | Users/roles/sessions/assignment; solo zero-login unchanged; ADR-052 052.1 resolved | lint 0/0 · tsc 0 · unit 210 · runtime 765 · vendor 28 · build 6.78s · 187.96KB gz | **3 rounds; 1 HIGH role-gate fixed → APPROVED** | P9 |
| **P10** Dogfood + hardening | ship-grade audits + BOSS-operated dogfood week | **IN PROGRESS** | pending | pending |

¹ **Doc discrepancy flagged:** the P5 PROGRAM STATUS summary line reads `runtime 606`, but the detailed P5 sub-note in the same plan doc reads `runtime 551`. Both are monotonic between P4 (487) and P6 (674); the true count could not be re-derived without running the suite (docs-only lane). Treat P5 runtime as **551–606, unverified here.**

---

## 2. Test-count trajectory

| Gate | P0 | P1 | P2 | P3 | P4 | P5 | P6 | P7 | P8 | P9 |
|---|---|---|---|---|---|---|---|---|---|---|
| unit | 100 | 113 | 113 | 150 | 178 | 184 | 192 | 196 | 204 | **210** |
| runtime | 329 | 335 | 411 | 414 | 487 | 551–606¹ | 674 | 709 | 726 | **765** |
| vendor | 6 | 28 | 28 | 28 | 28 | 28 | 28 | 28 | 28 | **28** |

- **Baseline before P0:** unit was 9/9 **failing** (missing `--experimental-strip-types`), runtime 32/32, vendor 6, and lint could not run (eslint was never installed). P0 turned all of that green and wired in 297 previously-orphaned runtime tests.
- **Bundle:** 236 KB gz at P0 → 175 KB gz after P1's skills refactor → 187.96 KB gz at P9 (budget ≤ 300 KB for an app page; still comfortable).

---

## 3. Security findings ledger (every CRITICAL / HIGH across the program)

| Phase | Sev | Finding | Fix / close |
|---|---|---|---|
| P2 | HIGH ×2 | New mutating inbox endpoints + SSE egress hardening gaps | 8 fixes + 12 tests + RED-proof; live PoC probes → 404/400/401; re-signed APPROVED |
| **P5** | **CRIT** | `workspace.mjs` containment/refusal checks were **case-SENSITIVE on a case-INSENSITIVE FS** — a mixed-case `$HOME` (e.g. `/Users/ROHITANANDESHI`) evaded the "not `$HOME`" guard and could pin `$HOME` as `REPO_ROOT`, giving read-mode agents `~/.ssh`/`~/.aws`/`~/.claude` and write access to `$HOME/src`, `$HOME/package.json` | Case-insensitive containment; independently re-proven by Fable (exact + MIXED-CASE `$HOME`, parent-of-`$HOME`, `/` all refused). Same class swept across `db.mjs`/`deliveries.mjs` → found **fail-safe** (deny-unless-prefix: a case variant makes them refuse *more*) |
| P5 | HIGH ×2 | Two further path/identity gaps in the worktree+PR path | Fixed within the 10 total; 3 MED + 2 LOW residuals closed; MED-1 re-proven safe |
| **P6** | **HIGH** | `policy.mjs` `globToRe` compiled deny globs **case-SENSITIVE** — **same class as the P5 CRIT** — so `src/Secret/x` could slip a `src/secret/**` deny | Deny matching made case-insensitive (over-blocks on a case-sensitive FS, the safe direction) + MED producer-assert; re-signed APPROVED |
| P7 | — | No CRIT/HIGH. All 9 external-ingestion vectors clean | LOW (audit read-path scrub inconsistency) + INFO closed |
| **P9** | **HIGH** | Role-gate **under-scoped**: a `viewer` could reach engine-level mutations the role should forbid | Fixed across 2 re-rounds; server-side role enforcement proven (viewer decide → 403); APPROVED |

### The recurring case-sensitivity pattern

Filesystem case-sensitivity was the program's most persistent security theme. **Two
distinct live defects of this class were found and fixed** — the P5 CRIT (`workspace.mjs`
path containment) and the P6 HIGH (`policy.mjs` deny-list) — each explicitly logged as "same
class." The lesson was applied *forward*: at P5 the same class was proactively swept across
the other path checks (`db.mjs`, `deliveries.mjs`) and confirmed fail-safe, and every risk
classifier / deny pattern now compiles case-insensitive by construction, so an
attacker-chosen case can only ever cause **over-blocking**, never a bypass.

> **Correction to the P10 brief:** the brief described this pattern as recurring "3×." This
> record could corroborate only **two distinct fixed live bugs** (P5 CRIT + P6 HIGH) plus
> **one proactive sweep** (P5, found safe). If a third live case-sensitivity bug exists it
> is not in the SESSION_MEMORY ledger reviewed here — flagged rather than asserted.

---

## 4. Known gaps & risks (carried to handoff)

1. **`gh` is not installed on this machine.** The real-GitHub loop (approve → PR actually
   opened/approved on github.com) and the GitHub-PR **ingestion** adapter are **UNPROVEN
   HERE** — all `gh` interaction runs through an injected/mock runner in tests. Without
   `gh`, approve degrades to a **local branch** (no PR). *Closes with the BOSS action
   below.* (P5, P7.)
2. **Packaged-Electron multi-user is unexercised.** The cross-origin (`127.0.0.1:3005`)
   multi-user session-cookie flow was not run in a packaged build; **solo mode (the Electron
   default) is unchanged and verified.** (P9.)
3. **The dogfood week is BOSS-operated and pending.** P10's exit — 7 consecutive days,
   ≥10 real Deliveries shipped through the Inbox with a scoreboard — has **not** been run.
   P10 is IN PROGRESS.
4. **Sessions are in-memory.** A runtime restart logs everyone out (deliberate: no session
   secret at rest). Solo default is unaffected (zero-login). (P9.)
5. **Packaged runtime stdio hang risk (P10 to fix).** `electron/runtime-supervisor.js:18`
   leaves a child stdio pipe undrained; once ~64 KB of logs buffer, the packaged runtime can
   block on `console.*`. Real hang risk in a long packaged session; not yet fixed.
6. **Electron packaging check outstanding.** `electron:build` / dmg-boot / packaged
   notifications (program plan §5.8) and `ma:open-external` were code-reviewed but **not run
   in a packaged build** in these lanes.
7. **Deferred visual verifications.** `task.done` unproven against a live `cli` agent (P4);
   usage-meter not browser-driven (P8, data path fully tested); playwright e2e harness
   deferred from P3 → P10.
8. **ADR-053 / ADR-054 documentation debt — paid in this sweep.** Both were referenced in
   code (`risk.mjs`, `policy.mjs`, `adapters/*.mjs`) and scoped in the plan (§5.6) but had
   **no ADR file** until P10 created them as as-built records. ADR-051/052 flipped
   PROPOSED → ACCEPTED/IMPLEMENTED with As-built sections.

---

## 5. BOSS action items

1. **`brew install gh && gh auth login`** — the single highest-value unblock: proves the
   real-GitHub PR loop and turns on GitHub-PR ingestion. Everything else is already local.
2. **Decide commit.** Nothing is committed (no-commit rule §4). When ready: one conventional
   commit per phase, in phase order, then snapshot cleanup.
3. **(Optional) Lower `AUTH_ACTIVE_MIN_USERS` to 1** — a one-line constant flip if you want
   login required even with a single account (default is `2`; solo stays zero-login).

---

## 6. Verdict

Feature-complete through P9 with every phase's gates green and every CRITICAL/HIGH security
finding fixed and re-signed. The program is **ship-candidate pending P10**: the dogfood
week, the Electron package check, and the `gh`-dependent real-GitHub proofs are the
remaining work, and the runtime-supervisor stdio drain is the one open hardening bug. No
CRITICAL or HIGH security finding is open. Reserved completion words are withheld from the
`gh`-dependent and packaged-Electron paths because they are **unverified on this machine**,
per the evidence rule.
