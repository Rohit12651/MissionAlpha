# Agent Inbox — P10 Code-Hardening (deferred-debt closeout) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.
> **COMMIT POLICY OVERRIDE (program §4 / BOSS point 5):** NO `git commit` / `git push`. Every "commit" step is REPLACED by **Checkpoint** = `git add -A && git status` review, leave staged. Working tree IS the deliverable.

**Goal:** Close the 6 deferred hardening items collected across P0–P9 (electron pipe-hang, bundle/globe lazy-load, usage-meter empty-state, empty/loading/error audit, dogfood scoreboard, dev-store reset) without changing any proven behavior; keep the full regression green.

**Architecture:** Surgical, additive changes. Backend adds ONE pure read (`deliveries.scoreboard`) + ONE gated GET route. Frontend adds ONE glanceable Scoreboard corner + defers the ambient 3D globe off the initial-paint critical path + fills two missing settings load-states. A throwaway-spawn test proves the electron pipe fix. A documented `reset:dev` script provides a clean-dogfood mechanism (not run against the live repo).

**Tech Stack:** Node 20 (mjs) · better-sqlite3 · React 19 · Vite 5 · TS strict · node:test.

**Baseline (measured this session):** index-fbYUbNRF.js **187,592 gz** · GlobeCanvas **226,032 gz** (already its own lazy chunk) · GlobeScene 9,072 gz · missionSkills 112,884 gz. Gates at P9 exit: lint 0/0 · tsc 0 · unit 210 · runtime 765 · vendor 28 · build ✓.

---

## Item 1 — Electron pipe-hang (REAL prod bug)

**Root cause (confirmed):** `electron/runtime-supervisor.js:18` spawns the runtime with `stdio: ["ignore","pipe","pipe"]` and NOTHING reads stdout/stderr. Once the ~64KB OS pipe buffer fills, the child BLOCKS on `console.*` forever. Health signalling rides HTTP (`waitHealthy()` → `fetch(healthUrl)`), NOT stdout — verified: nothing in the supervisor or `main.cjs` reads `child.stdout`/`child.stderr`. So draining is safe.

**Fix:** attach a bounded ring-buffer drain to stdout+stderr in `spawnChild()`. Drains the pipe (no hang) AND keeps a capped tail (default 64KB) for crash diagnostics. Guard for a missing `.stdout` (the DI test mock is a bare EventEmitter).

**Files:**
- Modify: `electron/runtime-supervisor.js`
- Test: `electron/test/runtime-supervisor-drain.test.mjs` (new — real `spawn`, throwaway script)
- Modify: `package.json` (add `test:electron` script — electron tests are currently orphaned)

- [ ] **Step 1 — Write the failing test** (`electron/test/runtime-supervisor-drain.test.mjs`): a throwaway script that writes >128KB to stdout then writes a DONE marker file in the write-callback; supervisor with REAL `spawn` + injected `fetch:()=>({ok:true})`; assert the DONE file appears within a timeout. Without draining, the write callback never fires (pipe full) → DONE never written → test times out.
- [ ] **Step 2 — Run it against the UNMODIFIED supervisor**: `node --test electron/test/runtime-supervisor-drain.test.mjs` → expected FAIL/timeout (proves the hang).
- [ ] **Step 3 — Implement the drain** in `runtime-supervisor.js`: a `LOG_CAP=64*1024` ring buffer; `drain(stream)` guards `!stream` then `stream.on("data", …)` appending to the capped tail and swallows `error`; reset the tail per spawn; call `drain(child.stdout); drain(child.stderr)` right after spawn; expose `tail()` and pass the tail as an optional 2nd arg to crash callbacks (additive, backward-compatible).
- [ ] **Step 4 — Run the new test + all 4 existing supervisor tests**: `node --test electron/test/*.test.mjs` → expected PASS (mock-child tests still pass because `drain` guards the missing stream).
- [ ] **Step 5 — Wire `"test:electron": "node --test electron/test/*.test.mjs"`** in package.json; run `npm run test:electron`.
- [ ] **Step 6 — Checkpoint.**

---

## Item 2 — Bundle size / lazy-load the 3D globe

**Finding:** `App.tsx` statically imports `PulseGlobe` (line 11) and renders it as an always-on ambient backdrop (line 423-427, `opacity:0.1`, aria-hidden) whenever `state` loads — in BOTH inbox and board views. `PulseGlobe` mounts `<GlobeCanvas>` immediately, so the 226KB gz three.js chunk (+9KB GlobeScene) is fetched on the initial-paint critical path even though the default view is the Inbox.

**Fix:** make `PulseGlobe` a `lazy()` import in `App.tsx` (moves the PulseGlobe subtree out of the index chunk) AND gate its mount behind a post-first-paint idle flag (`requestIdleCallback` → `setTimeout` fallback), Suspense fallback `null` (decorative, aria-hidden). Result: three.js is NOT requested at initial paint; the ambient globe streams in a beat later (imperceptible for a 0.1-opacity backdrop). Behavior end-state identical.

**Files:**
- Modify: `src/components/PulseGlobe.tsx` (add `export default PulseGlobe` alongside the named export so `lazy(() => import(...))` works)
- Modify: `src/App.tsx` (swap static import → `lazy`; add `globeReady` idle flag; wrap ambient globe in `<Suspense fallback={null}>` gated on `state && globeReady`)

- [ ] **Step 1** — In `PulseGlobe.tsx`, add `export default PulseGlobe;` at the end (keep the named export for existing imports/tests).
- [ ] **Step 2** — In `App.tsx`, replace `import { PulseGlobe } from "./components/PulseGlobe";` with `const PulseGlobe = lazy(() => import("./components/PulseGlobe").then((m) => ({ default: m.PulseGlobe })));`.
- [ ] **Step 3** — Add a `globeReady` state that flips true on `requestIdleCallback(cb, {timeout:1500})` (fallback `setTimeout(cb, 200)`) after mount.
- [ ] **Step 4** — Gate the ambient backdrop: `{state && globeReady && (<Suspense fallback={null}><PulseGlobe .../></Suspense>)}`.
- [ ] **Step 5 — Build + measure**: `npm run build`; gzip-measure `dist/assets/index-*.js` and confirm GlobeCanvas remains its OWN chunk and index gz did not grow (target: ≤187,592 gz, ideally lower). Record before/after.
- [ ] **Step 6** — `npm run typecheck` (0).
- [ ] **Step 7 — Checkpoint.**

---

## Item 3 — Usage-meter empty state (P8 deferred)

**Finding:** `UsageOverview` (in `src/components/workspace/UsageMeter.tsx:128`) ALREADY renders an empty state (`rolls.length === 0` → "No usage yet…", line 136-137); `rollUsage([])` returns `[]` safely; App feeds it `Object.values(usageByThread)` which is `[]` when empty — no crash. The reducer `applyUsageTick` ALREADY has an empty→populated test (`usageTick.test.ts:9`, folds a tick into `{}`).

**Fix:** the code is already correct. Strengthen with ONE explicit pure test asserting the empty→populated transition returns a FRESH map (immutability — not currently asserted) and that the empty-input identity path holds. `rollUsage` lives in a `.tsx` (JSX) so it cannot be imported by the strip-types unit runner — the reducer (`.ts`, no JSX) is the correct pure target.

**Files:**
- Modify: `src/lib/__tests__/usageTick.test.ts` (add 1 test)

- [ ] **Step 1** — Add test: `applyUsageTick({}, tick(...))` returns a NEW object (`assert.notEqual(next, input)`) AND the populated row is present — the explicit empty→populated transition + immutability guarantee.
- [ ] **Step 2** — `npm run test:unit` → expected PASS (211).
- [ ] **Step 3 — Checkpoint.**

---

## Item 4 — Empty/loading/error audit (7 Inbox surfaces)

**Audit result (this session):** 6 of 8 surfaces already complete —
- InboxPanel: list error/loading/empty + SSE banner + detail states ✓
- ReviewPane: loading/error/empty (no-selection) + viewer role ✓
- QueueStrip: empty ("idle — nothing queued"); error = `!reachable → null` (deliberate: an optional strip on an older runtime should not fabricate a queue) ✓
- AutoApprovedStrip: off/loading/empty-open ✓
- UsageOverview: empty ("No usage yet") ✓
- PolicyEditor: gold-standard `!bands ? "Reading the policy…"/error : form` + empty deny-list + corrupt alert ✓

**Two gaps to fix:**
- **AdapterSettings**: renders the form with all-off defaults during the initial `getAdapters()` fetch (can flash stale toggles); no initial load gate.
- **UserManagement**: no loading state (flashes "solo mode" during load) AND `reload()` swallows an initial `listUsers()` failure (no catch → silent).

**Files:**
- Modify: `src/components/settings/AdapterSettings.tsx`
- Modify: `src/components/auth/UserManagement.tsx`

- [ ] **Step 1 — AdapterSettings**: add a `loaded` flag; while `!loaded && !error` show a `role="status"` "Reading adapters…" note before the form (mirror PolicyEditor's `!bands` gate); if the initial load errored with no status, show the error + a Retry that calls `load()`.
- [ ] **Step 2 — UserManagement**: add a `loading` flag; while loading and `rows.length === 0` show "Reading accounts…" instead of "No local accounts — solo mode"; add `.catch()` to `reload()` that sets `error` (close the silent failure).
- [ ] **Step 3** — `npm run typecheck` (0) + `npm run build` (✓).
- [ ] **Step 4 — Checkpoint.**

---

## Item 5 — Dogfood scoreboard

**Metric:** "N deliveries approved ÷ human-minutes" over a 7d window. `deliveries` rows carry `createdAt` + `decidedAt`; per-delivery review latency = `decidedAt − createdAt`. Sum over human-approved (`status='approved'`) rows decided in the window = human-minutes; `auto_approved` reported separately (shipped without you). Statuses confirmed in `db.mjs:24`.

**Files:**
- Modify: `agent-runtime/deliveries.mjs` (add pure `scoreboard({windowMs,nowMs})`; add to the store return object)
- Modify: `agent-runtime/server.mjs` (add `/runtime/scoreboard` to `needsAuth`; add `GET /runtime/scoreboard?window=7d` handler — viewer-readable, NOT approver-gated)
- Modify: `src/lib/inboxClient.ts` (add `getScoreboard` + `Scoreboard` type)
- Create: `src/components/inbox/Scoreboard.tsx` (calm/glanceable corner)
- Modify: `src/components/inbox/InboxPanel.tsx` (mount Scoreboard in the top-right header)
- Test: `agent-runtime/test/deliveries.test.mjs` (+scoreboard pure tests), `agent-runtime/test/inbox-http.test.mjs` (+route 401/shape)

- [ ] **Step 1 — Failing pure tests** in `deliveries.test.mjs`: empty DB → `{approved:0, humanMinutes:0}`; two approved rows with known createdAt/decidedAt → correct count + summed minutes; a `pending`/`rejected` row excluded; a row decided BEFORE the window excluded; a malformed/negative-latency timestamp skipped.
- [ ] **Step 2 — Run** `node --test agent-runtime/test/deliveries.test.mjs` → FAIL (`scoreboard` undefined).
- [ ] **Step 3 — Implement `scoreboard`** in deliveries.mjs: SQL `SELECT createdAt,decidedAt,status FROM deliveries WHERE status IN ('approved','auto_approved') AND decidedAt IS NOT NULL AND decidedAt >= @since`; fold approved→count+latency, auto_approved→count; `humanMinutes = round(totalMs/60000,1)`; `perHour`/`avgMinutes` derived (null when 0); return `{windowMs, since, approved, autoApproved, humanMinutes, avgMinutes, perHour}`. Add `scoreboard` to the store return.
- [ ] **Step 4 — Run** the pure tests → PASS.
- [ ] **Step 5 — Route**: add `url.pathname === "/runtime/scoreboard"` to `needsAuth`; handler parses `window` (`^\d+(h|d)$`, default 7d, clamp ≤ 90d) → windowMs; `ok2(res, deliveries.scoreboard({windowMs}))`. GET only (405 else).
- [ ] **Step 6 — HTTP tests** in `inbox-http.test.mjs`: no-token → 401; token → 200 with `{approved, humanMinutes}` keys. Run → PASS.
- [ ] **Step 7 — Client + UI**: `getScoreboard(window="7d")` in inboxClient; `Scoreboard.tsx` self-fetches, renders nothing while loading, a compact `N shipped · ~M min/decision` chip on success, nothing on error (glanceable, never noisy); mount in InboxPanel header top-right beside the pending/live chips.
- [ ] **Step 8** — `npm run typecheck` + `npm run build` + `npm run test:runtime`.
- [ ] **Step 9 — Checkpoint.**

---

## Item 6 — Dev-store hygiene (reset mechanism)

**Finding:** gitignored `agent-runtime/data/` (mission.db + patches) and `agent-runtime/engine-store/` accumulate test-run residue. Provide a documented reset; **do NOT wipe now** (gitignored, harmless).

**Files:**
- Create: `scripts/reset-dev.mjs`
- Modify: `package.json` (add `"reset:dev": "node scripts/reset-dev.mjs"`)
- Modify: `README.md` — **SKIPPED (docs lane owns README).** Document the script via a header comment inside `reset-dev.mjs` + the P10 exit note in SESSION_MEMORY.

- [ ] **Step 1 — Write `scripts/reset-dev.mjs`**: resolve the two dirs relative to the repo root; refuse to run if a path escapes the repo (guard); `fs.rmSync(dir, {recursive:true, force:true})` then recreate empty; print what was cleared; a `--dry-run` flag lists without deleting.
- [ ] **Step 2 — Wire `reset:dev`** in package.json.
- [ ] **Step 3 — Prove it on a THROWAWAY $TMPDIR copy** (never the live repo): create a temp dir tree, point the script at it via an env override, run, assert the dirs are emptied. Do NOT run `npm run reset:dev` in the live repo.
- [ ] **Step 4 — Checkpoint.**

---

## Final gate (all items)

- [ ] `npm run lint` → 0/0
- [ ] `npm run typecheck` → 0
- [ ] `npm run test:unit` → 211+
- [ ] `npm run test:runtime` → 772+
- [ ] `npm run test:vendor` → 28
- [ ] `npm run test:electron` → 5 (4 existing + 1 new drain)
- [ ] `npm run build` → ✓, index gz ≤ 187,592 (ideally lower)
- [ ] Regression (§6 R1–R10) unaffected — no runtime/UI behavior changed except the disclosed idle-deferred globe.
- [ ] SESSION_MEMORY P10 hardening exit appended.

## Self-review

- **Spec coverage:** 6/6 scope items each own a section with exact files + TDD steps. ✓
- **Placeholder scan:** none — every step names the file + concrete change. ✓
- **Type consistency:** `scoreboard()` shape (`approved/autoApproved/humanMinutes/avgMinutes/perHour`) used identically in deliveries.mjs, the route, `getScoreboard`, and `Scoreboard.tsx`. ✓
- **Commit override:** all steps use Checkpoint, not commit (program §4). ✓
