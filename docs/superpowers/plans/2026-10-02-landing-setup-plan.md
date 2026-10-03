# Landing + Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **No commits** (BOSS rule): every "commit" step is replaced by a STATUS.md entry via the logbook skill.

**Goal:** A first launch shows the mockup's landing; "Start a job" opens a 5-step setup over the cockpit whose every claim comes from the runtime.

**Architecture:** App holds a view state (`loading | landing | cockpit`) decided by pure rules in `src/lib/firstRun.ts`; `<Landing/>` and `<Setup/>` are presentational components that call existing runtime clients. Spec: `docs/superpowers/specs/2026-10-02-landing-setup-spec.md` (ADRs in §12).

**Tech Stack:** React 18 + Vite + TypeScript, `src/theme/sketchbook.css` (mockup CSS, already ported), node:test (`npm run test:unit`), Playwright (`./node_modules/.bin/playwright`), the tab-audit parity harness.

**Commands used everywhere**
- unit: `node --experimental-strip-types --test src/lib/__tests__/firstRun.test.ts`
- e2e: `./node_modules/.bin/playwright test test/visual/first-run.spec.mjs --reporter=list`
- parity: `TAB_AUDIT=1 ./node_modules/.bin/playwright test test/visual/tab-audit.spec.mjs --grep "<screen>" --timeout 300000 --retries 1 --reporter=list`
- results are read from a redirected log + `echo EXIT=$?` (CLAUDE.md addendum §24), never through a pipe.

**Per-screen design gate (Phase 4), before the build of each screen task:** hallmark structure pass → ui-ux-pro-max interaction check → a11y review (focus trap, Esc, order, contrast, labels) → emil (motion, reduced motion) → build → impeccable polish. Notes go under the task's "Design notes".

---

## File map

| File | Responsibility | Task |
|---|---|---|
| `src/lib/firstRun.ts` (new) | pure rules: `ONBOARDED_KEY`, `readFlag`, `writeFlag`, `firstRunView`, `accountPlan`, `folderOk`, `readyLines`, `HERO_SCRIPT` | 1 |
| `src/lib/__tests__/firstRun.test.ts` (new) | unit tests for every rule | 1 |
| `src/App.tsx` (modify) | unmount PulseGlobe; `view` + `setupOpen`; ⌘K entries | 2, 6, 12 |
| `src/components/landing/Landing.tsx` (new) | `#v-landing` markup | 3, 5 |
| `src/components/landing/HeroFeed.tsx` (new) | live card feed, Pause, reduced motion | 4 |
| `src/components/onboarding/Setup.tsx` (new) | 5-step `.ob` dialog | 7–11 |
| `src/components/onboarding/Onboarding.tsx` (delete) | old tour | 12 |
| `test/visual/first-run.spec.mjs` (new) | E2E flows | 6–12 |
| `test/visual/parity-fixtures.mjs` (modify) | `first-run` fixture scenario | 13 |
| `test/visual/tab-audit.spec.mjs` (modify) | landing + setup screens, masks | 13 |

---

### Task 1: Pure first-run rules (`firstRun.ts`)

**Files:** Create `src/lib/firstRun.ts`, `src/lib/__tests__/firstRun.test.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/__tests__/firstRun.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { firstRunView, accountPlan, folderOk, readyLines, HERO_SCRIPT } from "../firstRun.ts";

const acct = (id: string, providerType: string, authMethod: string) => ({ id, providerType, authMethod });
const ws = (configured: string | null, envPinned = false) => ({ configured, envPinned });

test("flag set → cockpit, whatever the runtime says", () => {
  assert.equal(firstRunView({ flag: "1", accounts: null, workspace: null }), "cockpit");
});
test("flag unset, no active account → landing", () => {
  assert.equal(firstRunView({ flag: null, accounts: { accounts: [], activeAccountId: null }, workspace: ws("/r") }), "landing");
});
test("upgrade path: active account AND a configured workspace → cockpit", () => {
  assert.equal(firstRunView({ flag: null, accounts: { accounts: [acct("a", "claude", "subscription")], activeAccountId: "a" }, workspace: ws("/r") }), "cockpit");
});
test("upgrade path: an env-pinned workspace counts", () => {
  assert.equal(firstRunView({ flag: null, accounts: { accounts: [acct("a", "claude", "subscription")], activeAccountId: "a" }, workspace: ws(null, true) }), "cockpit");
});
test("active account but no workspace → landing", () => {
  assert.equal(firstRunView({ flag: null, accounts: { accounts: [acct("a", "claude", "subscription")], activeAccountId: "a" }, workspace: ws(null) }), "landing");
});
test("runtime unreachable (nulls) → landing", () => {
  assert.equal(firstRunView({ flag: null, accounts: null, workspace: null }), "landing");
});

test("accountPlan: no Claude subscription account → create", () => {
  assert.deepEqual(accountPlan({ accounts: [acct("k", "openai", "api_key")], activeAccountId: "k" }), { kind: "create" });
});
test("accountPlan: a subscription account that is not active → activate it", () => {
  assert.deepEqual(accountPlan({ accounts: [acct("s", "claude", "subscription"), acct("k", "openai", "api_key")], activeAccountId: "k" }), { kind: "activate", id: "s" });
});
test("accountPlan: the subscription account is already active → confirm", () => {
  assert.deepEqual(accountPlan({ accounts: [acct("s", "claude", "subscription")], activeAccountId: "s" }), { kind: "confirm", id: "s" });
});
test("accountPlan: a Claude API-key account is not a subscription", () => {
  assert.deepEqual(accountPlan({ accounts: [acct("c", "claude", "api_key")], activeAccountId: "c" }), { kind: "create" });
});

test("folderOk: the mockup's rule", () => {
  for (const ok of ["/xy", "~/x", "~/code/my-app", " /srv/app "]) assert.equal(folderOk(ok), true, ok);
  for (const bad of ["x", "/", "/x", "~", "", "code/app"]) assert.equal(folderOk(bad), false, bad);
});

test("readyLines: pending restart is never called active", () => {
  const l = readyLines({ engine: "Claude Code CLI", account: "subscription", project: { path: "~/a", restartRequired: true }, stations: 10 });
  assert.ok(l.some((x) => x === "Project: ~/a · pending restart"));
  assert.ok(!l.some((x) => x.includes("active") && x.startsWith("Project")));
});
test("readyLines: applied project reads active; unknown station count reads —", () => {
  const l = readyLines({ engine: "Claude Code CLI", account: "later", project: { path: "~/a", restartRequired: false }, stations: null });
  assert.deepEqual(l, ["Engine: Claude Code CLI", "Account: API key, later (add one in Accounts)", "Project: ~/a · active", "— stations, standing by"]);
});

test("HERO_SCRIPT is the mockup's six-message job", () => {
  assert.equal(HERO_SCRIPT.length, 6);
  assert.deepEqual(HERO_SCRIPT[0], ["ceo", "Proceed. Cheaper option: ship the switch first, persist the choice in a second pass."]);
});
```

- [ ] **Step 2: Run, expect FAIL** — `Cannot find module '../firstRun.ts'`.

- [ ] **Step 3: Minimal implementation**

```ts
// src/lib/firstRun.ts — the first-run rules (spec §5, ADR-LS2). Pure: no DOM, no network.
export const ONBOARDED_KEY = "ma.onboarded.v1"; // the old tour's key, kept so its users stay onboarded

interface AcctLike { id: string; providerType: string; authMethod: string }
interface AcctsLike { accounts: AcctLike[]; activeAccountId: string | null }
interface WsLike { configured: string | null; envPinned: boolean }

export function readFlag(): string | null { try { return localStorage.getItem(ONBOARDED_KEY); } catch { return "1"; /* storage blocked: never nag */ } }
export function writeFlag(): void { try { localStorage.setItem(ONBOARDED_KEY, "1"); } catch { /* storage blocked */ } }

/** Spec §5.1: flag → cockpit; else the upgrade path; else (including an unreachable runtime) landing. */
export function firstRunView(i: { flag: string | null; accounts: AcctsLike | null; workspace: WsLike | null }): "cockpit" | "landing" {
  if (i.flag === "1") return "cockpit";
  const active = i.accounts?.activeAccountId ?? null;
  const hasWs = !!i.workspace && (i.workspace.configured !== null || i.workspace.envPinned);
  return active !== null && hasWs ? "cockpit" : "landing";
}

export type AccountPlan = { kind: "create" } | { kind: "activate"; id: string } | { kind: "confirm"; id: string };
export function accountPlan(r: AcctsLike): AccountPlan {
  const sub = r.accounts.find((a) => a.providerType === "claude" && a.authMethod === "subscription");
  if (!sub) return { kind: "create" };
  return r.activeAccountId === sub.id ? { kind: "confirm", id: sub.id } : { kind: "activate", id: sub.id };
}

/** The mockup's folder rule: starts with / or ~ and is longer than 2 characters. */
export const folderOk = (p: string): boolean => /^[/~]/.test(p.trim()) && p.trim().length > 2;

export function readyLines(c: { engine: string; account: "subscription" | "later"; project: { path: string; restartRequired: boolean }; stations: number | null }): string[] {
  return [
    `Engine: ${c.engine}`,
    c.account === "subscription" ? "Account: Claude subscription · active" : "Account: API key, later (add one in Accounts)",
    `Project: ${c.project.path} · ${c.project.restartRequired ? "pending restart" : "active"}`,
    `${c.stations ?? "—"} stations, standing by`,
  ];
}

/** The mockup's example job (mockup lines 1233–1240), played only when the runtime has no events. */
export const HERO_SCRIPT: readonly (readonly [string, string])[] = [
  ["ceo", "Proceed. Cheaper option: ship the switch first, persist the choice in a second pass."],
  ["mgr", "Two tasks. sr-frontend owns the switch; sr-backend owns the saved setting."],
  ["fe", "@sr-backend what shape is the saved setting? I need the key and the default."],
  ["be", "Key `theme`, values `light` | `dark`, default follows the system."],
  ["fe", "Thanks. Wiring the switch to that now."],
  ["qa", "Both tasks green. Handing the diff to the BOSS for a yes."],
];
```

- [ ] **Step 4: Run, expect PASS** (14/14). **Step 5:** mutation-prove `accountPlan` (swap the active check) and `readyLines` (drop the restart branch) → red; restore md5-identical.
- [ ] **Step 6:** STATUS.md entry. **Done when:** both runs shown (red, green), mutation reds shown.

---

### Task 2: Unmount PulseGlobe (ADR-LS5)

**Files:** Modify `src/App.tsx` (the `PulseGlobe` lazy import ~L149, `globeReady` state ~L232 + its idle effect, `globeNowMs` ~L377, the mount block ~L750).

- [ ] **Step 1: Failing test** — add to `test/visual/first-run.spec.mjs` (created here):

```js
import { test, expect } from "@playwright/test";
import { installHermetic, settle } from "./harness.mjs";
test("no globe is mounted in the cockpit (AC-L7)", async ({ page }) => {
  await installHermetic(page);
  await page.goto("/"); await settle(page); await page.waitForTimeout(3000);
  await expect(page.locator("[aria-label='Live swarm constellation']")).toHaveCount(0);
});
```

- [ ] **Step 2:** run → FAIL (count 1). **Step 3:** delete the four App pieces listed; keep `src/components/PulseGlobe.tsx` and `src/components/globe/*`. **Step 4:** run → PASS; typecheck 0. **Step 5:** STATUS.md. **Done when:** red→green shown; `grep -n PulseGlobe src/App.tsx` empty.

---

### Task 3: Landing — top (nav + hero + live card frame)

**Files:** Create `src/components/landing/Landing.tsx`.

**Markup source (verbatim):** mockup lines 781–827 — `header.site-nav`, `section.hero` with the blob/sprig SVGs, `.hero-grid`, the `figure.live-card` (head, `ol.live-feed` slot filled by Task 4, foot), `a.scroll-cue`. `class` → `className`; inline `style` strings → objects; `<use href>` unchanged (SketchSprite already defines `sprig`, `seed`, `arrow`, `chev`). Every `data-go="app"` button becomes `onClick={onStart}`; the "The cockpit" link also calls `onStart`.

```tsx
export interface LandingProps { onStart: () => void; events: readonly ActivityRow[] }
export function Landing({ onStart, events }: LandingProps) {
  return (<div className="view on" id="v-landing">{/* lines 781–827 transcribed 1:1 (class→className, style→object, data-go→onClick={onStart}); the live card's <ol> slot is <HeroFeed events={events}/> */}</div>);
}
```
The markup is a 1:1 transcription of the cited mockup lines — the source of truth is those lines, not prose here.

- [ ] **Step 1: Failing E2E** — `flag unset, no account → Landing (AC-1)`: fixture accounts `{accounts:[],activeAccountId:null}`, no `ma.onboarded.v1`; expect `h1#hero-h` "You decide." visible and no `#ma-main`.
- [ ] **Step 2:** run → FAIL. **Step 3:** build Landing (shown by Task 6's view state; in this task mount it behind the same flag check only). **Step 4:** PASS.
- [ ] **Design notes (Phase 4):** recorded here after the gate.
- [ ] **Done when:** red→green shown; Landing top parity runs in Task 13.

---

### Task 4: Hero live feed (`HeroFeed.tsx`)

**Files:** Create `src/components/landing/HeroFeed.tsx`.

Behaviour (spec §5.2): `events.length > 0` → latest 8 real rows (newest first), chip omitted, foot reads "Live events from this machine"; else loop `HERO_SCRIPT`: one message every 1700 ms (3200 ms after the sixth), max 8 kept, prepend; pause when `paused`, `document.hidden`, or the card is off-screen (IntersectionObserver); reduced motion (`matchMedia('(prefers-reduced-motion: reduce)')`) → text whole, no `data-entering`. Message markup = the mockup's `li.msg` (`span.seat` initials, `.who b` + `span.ai-tag` "AI agent", `.body`). Seats: ceo "CEO", mgr "MG", fe "FE", be "BE", qa "QA" (mockup `SEATS`, lines ~1190–1200). Pause button: `aria-pressed`, label Pause/Resume.

- [ ] **Step 1: Failing E2E** — first-run fixture, reduced motion: within 2 s exactly one `li.msg` whose body is `HERO_SCRIPT[0][1]`; chip "Example run · simulated" visible; click Pause → after 2.5 s still one message; `aria-pressed="true"`. Second test (AC-L3): ⌘K "Show the welcome page" after one SSE activity row is dispatched on the stub → the card shows that row and NO "Example run · simulated" chip.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS. **Done when:** red→green; reduced-motion path asserted (no `.caret`).

---

### Task 5: Landing — end (band, recipes, promises, footer)

**Files:** Modify `src/components/landing/Landing.tsx`.

**Markup source:** mockup lines 829–874 + the recipe cards rendered by lines 1255–1269 (six `article.recipe`, data in `RECIPE`, fills `["#ffc400","#a2d3a6","#ed7328","#d2b68c","#6aa8dc","#a2d3a6"]`). **Honesty:** the footer's "Mockup · example data only" is false in the app → "Runs on this machine" (declared as an honesty delta in Task 13).

- [ ] **Step 1: Failing E2E** — Landing has 6 `article.recipe` and `#promises .promise-list li` count 4.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Done when:** red→green.

---

### Task 6: App first-run view state

**Files:** Modify `src/App.tsx`.

```tsx
const [view, setView] = useState<"loading" | "landing" | "cockpit">(() => (readFlag() === "1" ? "cockpit" : "loading"));
const [setupOpen, setSetupOpen] = useState(false);
useEffect(() => {
  if (view !== "loading") return;
  let live = true;
  Promise.allSettled([getAccounts(), getWorkspace()]).then(([a, w]) => {
    if (!live) return;
    const v = firstRunView({ flag: readFlag(), accounts: a.status === "fulfilled" ? a.value : null, workspace: w.status === "fulfilled" ? w.value : null });
    if (v === "cockpit") writeFlag();
    setView(v);
  });
  return () => { live = false; };
}, [view]);
const startJob = () => { setView("cockpit"); if (readFlag() !== "1") setSetupOpen(true); };
```
`view === "loading"` renders the existing neutral `<div role="status">` placeholder; `"landing"` renders `<Landing onStart={startJob} events={activity}/>` instead of the shell.

- [ ] **Step 1: Failing E2E (5 tests)** — AC-1 (Landing), AC-2 (flag set → cockpit, and **zero** requests to `/runtime/accounts` before first paint), AC-3 (upgrade → cockpit + flag `"1"` in localStorage), AC-4 (accounts route aborted → Landing), AC-5 (accounts route held 1.5 s → during the hold neither `h1#hero-h` nor `#ma-main` exists).
- [ ] **Step 2–4:** FAIL → implement → PASS. **Done when:** 4 reds then 4 greens shown.

---

### Task 7: Setup shell + step 1 Welcome

**Files:** Create `src/components/onboarding/Setup.tsx`; App mounts `<Setup open={setupOpen} onClose={() => setSetupOpen(false)} onDone={finish}/>`.

Markup: mockup renderer lines 2188–2190 — `div.ob[role=dialog][aria-modal=true][aria-labelledby=ob-h]`, `p.sub` "Setup · step N of 5", `h2#ob-h` (inline style from the mockup), `div#ob-body`, row with Back (hidden on step 1) / Next, `div.ob-dots[aria-hidden]` with `i.on`. Welcome body = mockup line 2179. Focus trap (Tab cycles within), Esc → `onClose`, focus to the step's first control on open (the mockup's `openOv`, lines 1485–1491). Overlay = the mockup's mechanics: always render `div.scrim` + `div.ob` and toggle their `hidden` attribute — `sketchbook.css` L631–632 / L681–683 animate `[hidden]` (opacity + a 0.97 scale), and L688 already drops the transform under reduced motion, so no new motion code is needed.

- [ ] **Step 1: Failing E2E** — Start a job → dialog "Setup · step 1 of 5", title "Welcome"; Tab ×10 never leaves the dialog; Esc closes it and `ma.onboarded.v1` is still unset (AC-S13, AC-S14).
- [ ] **Step 2–4:** FAIL → implement → PASS. **Done when:** red→green.

---

### Task 8: Setup step 2 Engines

Body: before detect = the mockup's text + `button#ob-detect` "Detect engines"; after = `ul.list` of `li.feed-row` (dot `ok`/`muted`, `"<label> · found"` / `"<label> · not found"` + `" · optional"` when not the spawn engine). `getCliEngines()`; throw → inline "The runtime did not answer." + Retry. Next disabled until `engines.find(e => e.id === spawnEngine)?.found`.

- [ ] **Step 1: Failing E2E** — engines fixture with spawn engine NOT found → Next disabled after detect, dialog still closable (AC-S2, AC-S3); with it found → Next enabled.
- [ ] **Step 2–4:** FAIL → implement → PASS.

---

### Task 9: Setup step 3 Account

Body: the mockup's fieldset (line 2181): two `label.check` radios, subscription default. Next with subscription → `getAccounts()` → `accountPlan()` → create (`addAccount({providerType:"claude", authMethod:"subscription", label:"Claude subscription"})` then `setActiveAccount(id)`), activate (`setActiveAccount(id)`), confirm (no call). `{error}` / throw → inline sentence, stay on step. "later" → no call.

- [ ] **Step 1: Failing E2E (3 cases + later + failure)** — route spies count POSTs to `/runtime/accounts` and `/runtime/accounts/active`: create → 1 + 1 and the create body has no `secret` key (AC-SEC1); activate → 0 + 1; confirm → 0 + 0; later → 0 + 0; create answering `{error:"label already exists"}` → that sentence inline and the dialog still on step 3 (AC-S8).
- [ ] **Step 2–4:** FAIL → implement → PASS.

---

### Task 10: Setup step 4 Project

Body: the mockup's field (line 2182): `label.label[for=ob-folder]` "Project folder", `input#ob-folder` placeholder `~/code/my-app`, `p#ob-folder-err` hidden. Next: `folderOk` false → show the mockup's rule text, `aria-invalid`, no call; true → `setWorkspace(path)`; `{ok:false,error}` → that sentence; `{ok:true, restartRequired:true}` → "Saved. Takes effect after a runtime restart." then advance.

- [ ] **Step 1: Failing E2E** — invalid path → 0 POSTs + error visible; valid → 1 POST `{repoPath}`; 400 → runtime sentence shown, still on step 4.
- [ ] **Step 2–4:** FAIL → implement → PASS.

---

### Task 11: Setup step 5 Ready + finish

Body: `ul.list` of `readyLines(...)` items prefixed "✓ " (mockup line 2183 shape) + the mockup's `p.sub` hint. Stations = `state?.agents.length ?? null`. "Open the cockpit" → `writeFlag()`, close, `setBosPage("center")`, toast "Your team is ready · start a job from Missions". No activity row is written.

- [ ] **Step 1: Failing E2E** — full happy path ends on Command center (`h1` "Command center") with `ma.onboarded.v1 === "1"` (AC-S12); `restartRequired:true` fixture → Ready shows "pending restart" (AC-S10).
- [ ] **Step 2–4:** FAIL → implement → PASS.

---

### Task 12: ⌘K entries + delete the old tour

**Files:** Modify `src/App.tsx` (palette commands ~L445, `Onboarding` import L15, `onboardingOpen` L384, mount L1068); delete `src/components/onboarding/Onboarding.tsx` after `grep -rn "onboarding/Onboarding" src test` shows only App.

- "Replay onboarding tour" → `setView("cockpit"); setSetupOpen(true)`.
- "Show the welcome page" (new, group Settings) → `setView("landing")`.

- [ ] **Step 1: Failing E2E** — ⌘K → type "Replay onboarding" → Enter → Setup step 1 visible (AC-K1); ⌘K → "Show the welcome" → `h1#hero-h` visible (AC-K2).
- [ ] **Step 2–4:** FAIL → implement → PASS; zero-importer grep shown; typecheck 0.

---

### Task 13: Parity — landing + setup screens

**Files:** Modify `test/visual/parity-fixtures.mjs` (`tab === "first-run"`: accounts empty, workspace `configured:null`, engines `[claude "Claude Code CLI" found (spawn), codex "Codex CLI" not found]`, POST answers for account/workspace), `test/visual/tab-audit.spec.mjs`.

- A new `SCREENS` list beside `NAV`: `landing` (mockup: load, reduced motion, wait for one `li.msg`, then `document.hidden`; app: no flag, first-run fixture, same) and `setup-1…setup-5` + `setup-2b` (detected), reached by the same clicks in both (spec §8). Top/end frames × 4 breakpoints for `landing`; top frame for each setup state.
- Masks (spec §7) as `DELTAS` + `COLLAPSE` entries: `.ob .list .feed-row > span:last-child`, `.ob .list .feed-row > .dot`, Ready `.ob .list li`; honesty: `.foot-meta .label:last-child`.
- **Mask verification (amendment 5):** before trusting a run, a probe prints, per mask, the element count and text in BOTH pages; counts must be equal and > 0.
- Per-screen loop: ≤ 3 fix cycles with new evidence each, then escalate with a handoff prompt.
- **Done when:** every landing/setup frame MATCH or escalated; mask probe output shown.

---

### Task 14: Full gates + regression

- lint, typecheck, test:unit, test:runtime, test:electron, build — exit codes shown.
- Full 12-tab audit + landing/setup screens; totals recomputed from `results.md` (≥ 86/96 for the tabs).
- **Done when:** all exit 0 and totals pasted.

---

## Phase 4 design notes (recorded 2026-10-02)

- **Structure (hallmark):** Landing = the mockup markup 1:1 inside a `<main aria-label="Welcome">` landmark the mockup lacks (no visual change); one `h1`. Setup = the mockup's `.scrim` + `.ob`, toggled by `hidden` (the CSS animates it; its reduced-motion override already exists).
- **Interaction (ui-ux-pro-max):** every "Start a job" is a `<button>`; Esc works from anywhere while Setup is open (T8 found focus falling to `<body>` when Detect unmounted); Back on step 1 leaves setup (the mockup draws Back there — never a dead control); validation runs on Next with the runtime's own sentence.
- **A11y audit (design:accessibility-review, WCAG 2.1 AA):** contrast — every text element ≥ 6.16:1 (lowest: 10px `.sub`; highest 21:1); landing tab order logical, 11 stops; dialog Tab cycles Close setup → Back → Next and never escapes; dialog named by its title and (fixed) described by its step; radio group named by its legend; dots `aria-hidden`; radios' hit area is the whole 279×63 label. Fixed test-first: recipes scroller now `role="region"` (its label was not announced); `aria-describedby` on the dialog. Logged, not changed (mockup-defined): the hero feed streams text inside an `aria-live="polite"` list; "The cockpit" nav item is an `<a href="#">` that acts.
- **Motion (emil):** the mockup's own mechanics — 2–4 chars / 22 ms with a caret, `data-entering` removed after two frames; reduced motion → text whole, no slide; the loop holds when paused, hidden or off-screen. No new motion was invented.
- **Polish (impeccable):** no em dashes in new copy; no banned patterns; states designed — "Detecting…" busy, inline errors + Retry, a missing-engine hint naming ⌘K as the way back.
