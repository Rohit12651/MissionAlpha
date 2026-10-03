# Landing + Setup — spec

Status: approved design (approach A) + 6 BOSS amendments, 2026-10-02. Phase G follow-on.
Mockup: `docs/mockups/missionalpha-sketchbook.html` — `#v-landing` (lines 780–907) and the
onboarding dialog `#ov-ob` (renderer at lines 2177–2201). Parity rule: the app matches the
mockup exactly, except where this spec says otherwise.

## 1. Problem

A fresh install opens straight onto a cockpit full of empty panels, with nothing that says
what MissionAlpha is or what it needs to work (a CLI engine, an account, a project folder).
The approved mockup answers both with a landing splash and a 5-step setup; the app has
neither. Today's first-run surface is an old cockpit tour that explains panels but checks
nothing, so a user can finish it with no engine, no account and no workspace and only find
out when their first job fails.

## 2. Goals

1. A first launch shows the mockup's landing; "Start a job" leads into a setup that checks or
   configures every real prerequisite before the cockpit.
2. Every claim the setup makes ("found", "active", the project path) comes from a runtime
   response, never from the mockup's simulated text.
3. Existing users are never sent back through first run.
4. Nobody is trapped: setup can always be closed, and closing it is not treated as finishing.
5. Pixel parity with the mockup for the landing (top/end × 4 breakpoints) and every setup
   state, with real-data elements declared as data deltas.

## 3. Non-goals

- **No globe** on the landing or the cockpit (BOSS: the mockup has none, and a backdrop
  changes every frame). `PulseGlobe` stays in code, unmounted.
- **Inbox and Missions** are with a separate review agent; their files are not touched.
- No new runtime endpoints, no `agent-runtime/` edits, no new dependencies.
- No marketing analytics or telemetry on the landing.
- No re-design of the mockup's copy; the landing's text is the mockup's, verbatim.

## 4. Users and stories

- As a **new operator** on a fresh install, I want to see what the product does and start it
  in one click, so that I am not dropped into an empty cockpit.
- As a **new operator**, I want setup to detect my CLI engine, sign me in with my Claude
  subscription and point the team at my repo, so that my first job can actually run.
- As a **new operator with no engine installed**, I want to close setup and still use the
  app, so that I am not stuck behind a dialog I cannot finish.
- As an **existing operator** (who saw the old tour, or already has an active account and a
  workspace), I want the app to open straight to the cockpit, so that an upgrade changes
  nothing for me.
- As any operator, I want to reopen the welcome page or setup from ⌘K, so that I can re-run
  setup after changing machines or engines.

## 5. Design (approach A)

### 5.1 First-run state (App)

- `ma.onboarded.v1` (localStorage, the same key the old tour used) is the flag.
- **Pure decision** `firstRunView({ flag, accounts, workspace })` → `"cockpit" | "landing"`:
  - flag `"1"` → cockpit (synchronous; no network).
  - else, **upgrade path (amendment 1):** `activeAccountId !== null` AND
    (`workspace.configured !== null` OR `workspace.envPinned`) → cockpit, and the flag is set
    so the next launch is synchronous.
  - else → landing. A runtime that cannot be reached also → landing (setup cannot be skipped
    on a guess).
- While the upgrade check is in flight (flag unset only), the app shows a neutral loading
  state, never the landing then a jump to the cockpit.

### 5.2 Landing

- `#v-landing` markup verbatim, with the classes already ported in `src/theme/sketchbook.css`:
  site nav (wordmark, section links, "Start a job"), hero (blob + sprig art, display headline,
  script line, lede, "Start a job" + "See how a job runs"), the live card, the orange
  "how a job runs" band, the promises section, the footer.
- **Live card:** title "The team, right now".
  - Runtime has events → the latest real events (newest first, max 8, as the mockup trims),
    chip reads what they are (no "simulated").
  - No events (true first run) → the mockup's `HERO_SCRIPT` (6 messages, "Dark mode for
    settings"), chip **"Example run · simulated"**.
  - Pause/Resume button (`aria-pressed`) stops and resumes either feed.
  - The loop pauses when the document is hidden, the card is off-screen, or Pause is on —
    the mockup's own guards.
  - **Reduced motion (amendment 6):** no character streaming, no entering transition; a
    message appears whole.
- "Start a job" → cockpit; if not onboarded, Setup opens over it (the mockup's `showView("app")`).
- **No globe.**

### 5.3 Setup dialog

The mockup's `.ob` dialog: "Setup · step N of 5", display-font step title, body, Back
(hidden on step 1) / Next ("Open the cockpit" on step 5), progress dots. `role="dialog"`,
`aria-modal`, labelled by the title, focus trapped, focus moves to the step's first control,
**Esc and a close control always work (amendment 2).**

| # | Step | Real wiring | Next allowed when |
|---|---|---|---|
| 1 | Welcome | static copy (mockup text) | always |
| 2 | Engines | "Detect engines" → `GET /runtime/engines`; one row per engine: dot ok/muted + `"<label> · found"` / `"<label> · not found"` (+ `· optional` when it is not the spawn engine) | the spawn engine (`spawnEngine`) is found |
| 3 | Account | radios "Use my Claude subscription" (default) / "Add an API key later"; on Next with subscription: `accountPlan(accounts)` | the plan's calls succeeded (or "later" chosen) |
| 4 | Project | folder field (mockup rule: starts with `/` or `~`, length > 2) → `POST /runtime/workspace {repoPath}`; when the response has `restartRequired: true` the step says **"Saved. Takes effect after a runtime restart."** | the runtime accepted the path |
| 5 | Ready | summary of what steps 2–4 **confirmed** + `N stations, standing by` from runtime state | always ("Open the cockpit") |

- **accountPlan(response)** (pure) → one of:
  - `create` — no Claude **subscription** account exists → `POST /runtime/accounts`
    `{providerType:"claude", authMethod:"subscription", label:"Claude subscription"}` (no secret),
    then `POST /runtime/accounts/active` for the new id (always: idempotent, and it avoids a
    re-read to learn whether the runtime auto-activated it — ADR-LS3);
  - `activate` — one exists but is not active → `POST /runtime/accounts/active`;
  - `confirm` — one exists and is active → no call.
  "Add an API key later" calls nothing and says where to add one (Accounts).
- Engines/Account/Project failures are shown inline with the runtime's own sentence (or
  "The runtime did not answer.") and block Next.
- **Ready (amendment 3):** Project line reads `"<path> · active"` only when the runtime's
  `restartRequired` is false; otherwise `"<path> · pending restart"` — never "active".
- **Finishing:** "Open the cockpit" sets `ma.onboarded.v1`, closes Setup, shows the Command
  center, toasts "Your team is ready · start a job from Missions". It does NOT write a fake
  activity row (the mockup's `act("tech-lead", …)` is a simulation).
- **Early close (amendment 2):** Esc / close never sets the flag. The user stays in the
  cockpit; the next launch is first-run again (Landing, whose "Start a job" reopens Setup).

### 5.4 ⌘K entries

- "Replay onboarding tour" → opens Setup at step 1 (replaces the old tour).
- "Show the welcome page" → shows the Landing; "Start a job" from it returns to the cockpit
  (Setup only if not onboarded).

### 5.5 Removals

- `src/components/onboarding/Onboarding.tsx` (old cockpit tour) — deleted after a
  zero-importer grep; its walkthrough content is removed (logged in Phase G).
- `PulseGlobe` — unmounted from App; component kept; logged as an app-only visual held back
  for parity.

## 6. Acceptance criteria

### First run
- AC-1 Flag unset + runtime without (active account AND workspace) → Landing is shown, no cockpit.
- AC-2 Flag `"1"` → cockpit on first paint; no network call is made to decide.
- AC-3 Flag unset + active account + `configured` workspace (or `envPinned`) → cockpit, and the flag becomes `"1"`.
- AC-4 Flag unset + runtime unreachable → Landing.
- AC-5 While the AC-3 check is pending, neither Landing nor cockpit flashes.

### Landing
- AC-L1 Top frame and end frame MATCH the mockup at 1440 / 1024 / 768 / 375 (data deltas declared).
- AC-L2 With no runtime events, the live card plays `HERO_SCRIPT` and shows "Example run · simulated".
- AC-L3 With runtime events, the card shows real events and not the simulated chip.
- AC-L4 Pause stops new messages; Resume continues; `aria-pressed` reflects it.
- AC-L5 Reduced motion: messages appear whole, no streaming, no entering transition.
- AC-L6 "Start a job" (hero and nav) opens the cockpit with Setup over it when not onboarded.
- AC-L7 No `<canvas>` globe is mounted anywhere.

### Setup
- AC-S1 Each of the 5 steps (and Engines before/after detect) MATCHES the mockup state at 4 breakpoints (data deltas declared).
- AC-S2 Engines: Next is disabled until the spawn engine is reported found; rows come from `GET /runtime/engines`.
- AC-S3 Engines: a failed detect shows an inline error; the dialog can still be closed.
- AC-S4 Account `create`: no subscription account → one POST (no `secret` field) + active.
- AC-S5 Account `activate`: subscription account exists, inactive → only the set-active call.
- AC-S6 Account `confirm`: subscription account exists and active → no write call.
- AC-S7 Account "Add an API key later" → no call; Ready says where to add one.
- AC-S8 Account/Project failures show the runtime's sentence inline and block Next.
- AC-S9 Project: an invalid path shows the mockup's rule message and makes no call; a valid one is POSTed.
- AC-S10 Ready shows "pending restart" when `restartRequired`, "active" only otherwise.
- AC-S11 Ready's station count is the runtime's real count ("—" when unknown).
- AC-S12 "Open the cockpit" sets the flag and lands on Command center.
- AC-S13 Esc / close at any step does not set the flag.
- AC-S14 Focus is trapped in the dialog; Esc closes; every control is keyboard-reachable; dots are `aria-hidden`; the dialog is labelled by its title.

### ⌘K
- AC-K1 "Replay onboarding tour" opens Setup at step 1.
- AC-K2 "Show the welcome page" shows the Landing.

### Security
- AC-SEC1 The Account step never sends, stores or logs a secret; its request body has no `secret` key.
- AC-SEC2 Error text shown to the user is the runtime's sentence or a fixed fallback; no stack, path internals or token.

### Regression
- AC-R1 Full 12-tab audit stays ≥ 86/96, plus the new Landing/Setup frames.
- AC-R2 lint, typecheck, unit, runtime, electron, build all exit 0.

## 7. Parity: data-delta mask list (amendment 5)

Every mask must be verified to hit the **same element in both screenshots** before it counts
(the Inbox "oldest" lesson). Masked = hidden AND collapsed in both captures.

| Screen / state | Mask | Why |
|---|---|---|
| Landing | none — the feed is pinned to the same single message in both (§8) | — |
| Setup · Engines (detected) | each row's text `.ob .list .feed-row > span:last-child` | runtime engine labels vs the mockup's "(simulated)" text |
| Setup · Engines (detected) | each row's dot `.ob .list .feed-row > .dot` | real found / not-found state |
| Setup · Account | any inline status/error line (not present in the captured state) | runtime outcome |
| Setup · Ready | Engine, Account, Project and stations lines `.ob .list li` | real confirmed values + real station count |
| Setup · Project | none — the capture types the mockup's own `~/code/my-app` in both | — |

## 8. Capture method (determinism)

- Landing first-run fixture: no runtime events → example script. Both captures: reduced motion,
  wait for exactly one message (`ceo`: "Proceed. Cheaper option: …"), then mark the document
  hidden (the mockup's own pause guard) so no second message lands.
- Engines fixture returns the mockup's two engines (Claude Code CLI found = spawn engine;
  Codex CLI not found), so row count and layout match.
- Setup is reached in both by the same clicks: Start a job → Next → Detect → Next → (Account
  default) → Next → type `~/code/my-app` → Next → Ready.

## 8a. Test map (amendment 4)

| Required test | Kind | Covers |
|---|---|---|
| flag unset → Landing | unit (`firstRunView`) + E2E | AC-1 |
| flag set → cockpit, no network | unit + E2E | AC-2 |
| upgrade: active account + workspace → cockpit, flag set | unit (`firstRunView`) | AC-3 |
| runtime unreachable → Landing | unit | AC-4 |
| accountPlan → create / activate / confirm (one test each) | unit | AC-S4–S6 |
| create request has no `secret` key | unit | AC-SEC1 |
| folder rule (accept `/xy`, `~/x`; refuse `x`, `/`, `/x`, `~`) | unit | AC-S9 |
| Engines blocks Next until spawn engine found | E2E | AC-S2 |
| step 5 sets the flag and lands on Command center | E2E | AC-S12 |
| early close does not set the flag | E2E | AC-S13 |
| ⌘K "Replay onboarding tour" reopens Setup | E2E | AC-K1 |
| ⌘K "Show the welcome page" shows Landing | E2E | AC-K2 |
| Ready shows "pending restart" when `restartRequired` | unit (summary builder) | AC-S10 |
| parity frames | tab audit | AC-L1, AC-S1 |

Every test is written first and shown failing before the code that passes it.

## 9. Success metrics

- Leading: share of fresh installs reaching "Open the cockpit" (target ≥ 80% in dogfood);
  setup steps where Next is blocked (instrumented later — P2).
- Lagging: first job failures caused by a missing engine / account / workspace → 0.

## 10. Open questions

- None blocking. Interpretation recorded: "Setup reappears next launch" (amendment 2) is met
  by the first-run state — the next launch opens Landing, whose "Start a job" reopens Setup.

## 11. Timeline / phasing

Phases 1–8 per the BOSS brief, tracked in `STATUS.md`. P2 (not now): setup-step telemetry,
engine install hints with copy buttons.

## 12. Architecture (ADRs)

Module boundaries:

| Module | Kind | Owns |
|---|---|---|
| `src/lib/firstRun.ts` | pure, no DOM/network | `ONBOARDED_KEY`, `firstRunView`, `accountPlan`, `folderOk`, `readyLines`, `HERO_SCRIPT` |
| `src/lib/__tests__/firstRun.test.ts` | node:test | every pure rule above |
| `src/components/landing/Landing.tsx` | view | the mockup's `#v-landing` markup |
| `src/components/landing/HeroFeed.tsx` | view + timer | the live card: real events or the example script; Pause; reduced motion |
| `src/components/onboarding/Setup.tsx` | view + runtime calls | the 5-step `.ob` dialog; each step's calls via existing clients |
| `src/App.tsx` | container | `view: "loading" \| "landing" \| "cockpit"`, `setupOpen`, the two ⌘K entries |
| `test/visual/first-run.spec.mjs` | Playwright E2E | the flows in §8a |
| `test/visual/tab-audit.spec.mjs` | parity | new `landing` and `setup-*` entries |

Existing clients reused, none added: `getCliEngines`, `getAccounts`, `addAccount`,
`setActiveAccount` (`src/lib/accounts.ts`), `getWorkspace`, `setWorkspace`
(`src/lib/workspaceClient.ts`). Real hero events come from App's existing `activity` state
(`ActivityRow[]`, fed by the SSE stream) — i.e. events received since launch; no new fetch.

### ADR-LS1: First-run state lives in App as a view state
**Status:** Accepted · **Date:** 2026-10-02 · **Deciders:** BOSS (approved approach A)

**Context.** The landing must replace the whole shell on first run; the setup must sit over
the cockpit (the mockup's `showView("app")` then `openOb()`).

**Options.**
- *A — App view state* (`loading | landing | cockpit`) — complexity low; reuses the one
  React tree, the palette and the toast; no IPC.
- *B — separate Electron window* — real isolation, but a second window, IPC and CSP work
  outside scope.
- *C — a sidebar page* — wrong model: the mockup's landing has no sidebar.

**Decision.** A. **Consequences.** Easier: ⌘K can flip views; tests drive one page. Harder:
App grows by one state and two handlers (kept small; the logic lives in `firstRun.ts`).

### ADR-LS2: The rules are pure functions in `src/lib/firstRun.ts`
**Status:** Accepted

**Context.** Every amendment is a rule (upgrade path, early close, pending restart, account
plan). Rules buried in components are only testable through a browser.

**Decision.** `firstRunView({flag, accounts, workspace})`, `accountPlan(accounts)`,
`folderOk(path)` and `readyLines(confirmed)` are pure and unit-tested under node:test
(the repo's pattern, e.g. `cadenceClient`). Components only call them and perform I/O.

**Consequences.** Each amendment has a red-then-green unit test. The E2E layer only proves
wiring (flag written / not written, ⌘K, Next blocked).

### ADR-LS3: Runtime calls and failure shapes per step

| Step | Call | Success | Failure the UI shows |
|---|---|---|---|
| boot (flag unset) | `getAccounts` + `getWorkspace` | `firstRunView` decides | either throws → landing (no guess) |
| Engines | `getCliEngines` | rows; Next iff `engines[spawnEngine].found` | throw → "The runtime did not answer." + Retry |
| Account · create | `addAccount({providerType:"claude", authMethod:"subscription", label:"Claude subscription"})` then `setActiveAccount(id)` | Next | `{error}` → that sentence; throw → fixed fallback |
| Account · activate | `setActiveAccount(id)` | Next | as above |
| Account · confirm | none | Next | — |
| Project | `setWorkspace(path)` | `{ok:true, restartRequired}` | 400 `{ok:false, error}` → that sentence; throw → fallback |

All bodies are built in code; none carries a `secret`. Errors render the runtime's own
sentence or a fixed fallback — never `e.stack` or a raw response body.

### ADR-LS4: Delete the old cockpit tour (`Onboarding.tsx`)
**Status:** Accepted (BOSS) · **Context.** Two first-run flows would compete; the tour checks
nothing. **Decision.** Delete after a zero-importer grep; keep `ma.onboarded.v1` (same key)
so everyone who saw the tour stays onboarded; point ⌘K "Replay onboarding tour" at Setup.
**Consequences.** The cockpit walkthrough copy (chat, model per chat, connectors, Team board)
is gone — logged in Phase G. Its "Try a first goal" button goes with it.

### ADR-LS5: Unmount PulseGlobe; keep the component
**Status:** Accepted (BOSS) · **Context.** The mockup defines no globe; a WebGL backdrop
changes every frame. Root cause of "invisible" recorded in Phase G (it renders; mounted as
a 0.1-opacity hero band under opaque surfaces). **Decision.** Remove its mount, lazy import,
idle-ready state and `globeNowMs` from App; keep `src/components/PulseGlobe.tsx` and
`src/components/globe/*`. **Consequences.** The three.js chunk is no longer fetched at
runtime. Re-mounting needs a mockup-defined place.

