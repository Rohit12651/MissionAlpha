// Deterministic screenshot harness (Phase 0, excellence program).
//
// PURPOSE: phases 8-9 rewrite the token layer across 3 CSS files and 57 component files.
// There are ZERO component/DOM tests in this repo, so screenshot diffing is the ONLY
// regression net for that work. A screenshot net is worthless unless an unchanged app
// reproduces the same image every run — hence this file.
//
// NOT "byte-identical", which is what this line used to say. Byte-identity is the wrong
// bar and this repo proved it: an identical DOM produced PNGs differing by exactly one
// byte (see determinism.spec.mjs), which is encoder and compositor variance, not
// application nondeterminism. The bar in force is "identical within a MEASURED noise
// floor" — test/visual/strict.mjs holds the numbers and how they were measured.
//
// WHAT IS FROZEN, and why each one is a real risk here:
//   1. CSS animation + transition — 78 declarations across the three theme files.
//   2. Date / Date.now — 8 components render relative time (SlaTimer, AgentLog,
//      MissionStrip, LiveFeed, AuditTrailPanel, LoopStream, ...). "3m ago" ticking to
//      "4m ago" mid-run would flap every capture.
//   3. setInterval — src/lib/ticker.tsx runs `setInterval(() => setNow(Date.now()))`.
//      Pinning Date.now() makes the tick a no-op repaint instead of a visual change.
//   4. Math.random — any jitter/seed.
//   5. requestAnimationFrame — GlobeScene drives WebGL from rAF.
//
// WHAT IS EXCLUDED, disclosed rather than hidden:
//   The <canvas> swarm globe is a DECORATIVE backdrop (App.tsx renders it aria-hidden at
//   opacity 0.1). WebGL output is not reliably byte-stable across runs even with a pinned
//   clock — driver scheduling alone can shift a pixel. It is hidden for capture. This
//   means the globe itself is NOT covered by visual regression. That is an accepted,
//   documented gap, not an oversight: no phase in this program modifies the globe.
//
// PHASE 0-FIX: the DATA plane is frozen too — see fixtures.mjs. Captures no longer depend
// on a live runtime, its SQLite state or its auth token, and a request with no fixture
// fails the test instead of silently rendering an error page into a baseline.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { installFixtures, newReport } from "./fixtures.mjs";
import { computeSourceId, BUILD_ID_META } from "../../scripts/lib/build-id.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Kills every time-based visual, plus the caret, plus the decorative WebGL canvas. */
export const FREEZE_CSS = `
  *, *::before, *::after {
    animation-play-state: paused !important;
    animation-delay: -1ms !important;
    animation-duration: 1ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0ms !important;
    transition-delay: 0ms !important;
    caret-color: transparent !important;
    scroll-behavior: auto !important;
  }
  /* Decorative WebGL backdrop — see header note. */
  canvas { visibility: hidden !important; }

  /* TEXT RASTERISATION — the last source of cross-run pixel churn, measured not guessed.
   *
   * With the comparator's colour threshold finally set correctly (strict.mjs), two
   * captures of the UNCHANGED app from two browser launches still differed on ~86 pixels,
   * every one of them on a glyph edge, and the per-channel deltas were UNEQUAL
   * (e.g. r+4 g+7 b+5). Unequal per-channel movement on a glyph edge is the signature of
   * SUBPIXEL (LCD) antialiasing: the rasteriser weights the R, G and B subpixels
   * separately, and the weighting is not stable across processes.
   *
   * "antialiased" forces GRAYSCALE antialiasing, so a coverage difference moves all three
   * channels together and by far less. "geometricPrecision" stops hinting from snapping
   * glyph advances to the pixel grid, which is the other half of the churn.
   *
   * This is a capture-time override on top of the app's own rendering, exactly like the
   * animation freeze above — it does not change what ships.
   *
   * PLATFORM CAVEAT, disclosed because it decides where this suite may run.
   * "-webkit-font-smoothing" is a non-standard, OS-CONDITIONAL property: in Chromium it
   * affects rendering on macOS and is a no-op on Linux. The 86 -> 22 pixel improvement above
   * was measured on macOS and does NOT necessarily transfer. The 75 committed baselines are
   * macOS artefacts by construction — Playwright suffixes every snapshot with the platform
   * ("...-darwin.png"), so a Linux runner would look for "-linux.png", find nothing, write
   * new files and fail. Running this suite in CI therefore means a macOS runner AND a
   * fresh noise-floor measurement on it; it is not a matter of adding a job. See the
   * Phase 0 delivery report's Known Gaps for the recommendation. */
  *, *::before, *::after {
    -webkit-font-smoothing: antialiased !important;
    -moz-osx-font-smoothing: grayscale !important;
    text-rendering: geometricPrecision !important;
  }
`;

/**
 * Pins the clock, RNG and rAF BEFORE any app code runs. Must be installed via
 * page.addInitScript so it lands ahead of React's first render, not after.
 */
export const FREEZE_JS = `
  (() => {
    const FIXED = 1786500000000; // 2026-08-10T12:40:00.000Z — arbitrary, but constant
    const RealDate = Date;
    class FrozenDate extends RealDate {
      constructor(...args) {
        return args.length ? new RealDate(...args) : new RealDate(FIXED);
      }
      static now() { return FIXED; }
      static parse(s) { return RealDate.parse(s); }
      static UTC(...a) { return RealDate.UTC(...a); }
    }
    globalThis.Date = FrozenDate;
    Math.random = () => 0.42;
    // rAF: run the callback once on a macrotask with a fixed timestamp, so anything
    // driven by rAF settles instead of animating.
    globalThis.requestAnimationFrame = (cb) => globalThis.setTimeout(() => cb(FIXED), 0);
    globalThis.cancelAnimationFrame = (id) => globalThis.clearTimeout(id);
  })();
`;

// Phase 0-FIX — the SSE stub.
//
// `useRuntimeEvents` mints a ticket then opens an EventSource against /runtime/events.
// That stream is the last live dependency in a capture: a `task.started` frame arriving
// mid-screenshot repaints badges and counters. It also cannot be fixtured through
// page.route — route.fetch() on a text/event-stream never resolves.
//
// So EventSource is replaced in page context with a stub that OPENS and then stays
// silent forever. The app reports "connected" (no reconnect banner, which is what the
// live captures showed) and receives exactly zero events. Deterministic and hermetic.
// Any test that needs a real event can dispatch one on the stub directly.
export const STUB_SSE_JS = `
  (() => {
    class StubEventSource {
      constructor(url) {
        this.url = String(url);
        this.readyState = 1; // OPEN
        this.withCredentials = false;
        this.onopen = null; this.onerror = null; this.onmessage = null;
        this._listeners = new Map();
        globalThis.setTimeout(() => {
          if (this.readyState !== 1) return;
          const ev = new Event("open");
          try { this.onopen && this.onopen(ev); } catch { /* app handler threw */ }
          for (const fn of this._listeners.get("open") || []) fn(ev);
        }, 0);
      }
      addEventListener(name, fn) {
        if (!this._listeners.has(name)) this._listeners.set(name, []);
        this._listeners.get(name).push(fn);
      }
      removeEventListener(name, fn) {
        const l = this._listeners.get(name);
        if (l) this._listeners.set(name, l.filter((f) => f !== fn));
      }
      dispatchEvent() { return true; }
      close() { this.readyState = 2; }
    }
    StubEventSource.CONNECTING = 0;
    StubEventSource.OPEN = 1;
    StubEventSource.CLOSED = 2;
    globalThis.EventSource = StubEventSource;
  })();
`;

// Onboarding gate. src/components/onboarding/Onboarding.tsx shows a full-screen modal
// (`fixed inset-0 z-[90]`) once per browser, keyed on localStorage `ma.onboarded.v1`.
// A fresh Playwright context has empty localStorage, so WITHOUT this seed every capture
// is a picture of the onboarding modal and every nav click is intercepted by its overlay.
// Discovered the hard way: `document.elementFromPoint` over the sidebar returned the
// modal backdrop, not the nav button.
export const ONBOARDED_KEY = "ma.onboarded.v1";

// ── Diagnostics ──────────────────────────────────────────────────────────────
//
// WHY THIS EXISTS. The shell-never-laid-out failure reported only `{"found":false}` —
// i.e. "there is no <main>" — which is true of THREE completely different states:
// React never mounted, a Suspense fallback is still pending (every page's <main> lives
// INSIDE its Suspense boundary in App.tsx), or AppErrorBoundary caught a render crash.
// A message that cannot distinguish those three caused two wrong fixes in a row, both
// timeout bumps. So the page's console errors, uncaught exceptions and failed requests
// are collected from the moment the context is prepared and attached to the throw.
const DIAG = new WeakMap();

/** Start collecting console errors / page errors / failed requests for `page`. */
export function watchPage(page) {
  const d = { consoleErrors: [], pageErrors: [], failedRequests: [] };
  DIAG.set(page, d);
  page.on("console", (m) => {
    if (m.type() === "error") d.consoleErrors.push(m.text().slice(0, 400));
  });
  page.on("pageerror", (e) => d.pageErrors.push(String(e?.message ?? e).slice(0, 400)));
  page.on("requestfailed", (r) =>
    d.failedRequests.push(`${r.method()} ${r.url()} — ${r.failure()?.errorText ?? "?"}`),
  );
  return d;
}

/** Whatever has been collected for `page` so far, or null if it is not watched. */
export function diagFor(page) {
  return DIAG.get(page) ?? null;
}

/** Install the freeze + SSE stub + skip first-run modals. Call BEFORE page.goto(). */
export async function installFreeze(page) {
  watchPage(page);
  await page.addInitScript(FREEZE_JS);
  await page.addInitScript(STUB_SSE_JS);
  await page.addInitScript(([k]) => {
    try { localStorage.setItem(k, "1"); } catch { /* storage blocked; modal will show */ }
  }, [ONBOARDED_KEY]);
}

/**
 * Phase 0-FIX — the full hermetic setup: freeze + SSE stub + recorded data plane.
 * Returns the fixture report; the caller MUST assert `report.missing` is empty, which is
 * what makes a broken environment fail loudly instead of producing a wrong baseline.
 */
export async function installHermetic(page) {
  const report = newReport();
  await installFixtures(page, report);
  await installFreeze(page);
  return report;
}

/**
 * Wait for the app shell to be laid out, and say WHY if it is not.
 *
 * History, because the wrong fix was applied twice before this one. The original wait was
 * `waitForSelector("nav, main")`. A comma selector resolves to the FIRST match in DOM
 * order and then waits for THAT element to become visible; the shell renders more than
 * one <nav> and the first is hidden below 1024px (src/theme/bos.css `.bos-side`). So the
 * wait could sit on a permanently invisible element while <main> was painted the whole
 * time. Switching to `locator("main").first()` fixed that, and still timed out
 * occasionally — because Playwright's "visible" means a non-empty bounding box, and a
 * flex `main` can legitimately measure zero for a frame or two during shell layout.
 *
 * So: poll the real geometry, and when it does not settle, throw an error carrying the
 * element's actual display / height / child count. A timeout that says nothing is how the
 * first two wrong diagnoses happened.
 */
export async function waitForShell(page, timeout = 45000) {
  const deadline = Date.now() + timeout;
  let last = null;
  for (;;) {
    last = await page.evaluate(() => {
      const el = document.querySelector("#ma-main") || document.querySelector("main");
      if (!el) {
        // NOT ENOUGH TO SAY "no main". Every page's <main> lives inside a Suspense
        // boundary, so a pending lazy chunk, a crashed render and an unmounted React
        // root all look identical from the outside. Name which one it is.
        const root = document.getElementById("root");
        const status = document.querySelector('[role="status"]');
        const alert = document.querySelector('[role="alert"]');
        return {
          found: false,
          readyState: document.readyState,
          rootChildren: root ? root.childElementCount : -1,
          bodyHtmlLength: document.body ? document.body.innerHTML.length : -1,
          // The Suspense fallbacks read "opening the …"; the error boundary reads
          // "Command tower hit a snag". Either one identifies the state outright.
          suspenseFallback: status ? status.textContent.trim().slice(0, 120) : null,
          alertText: alert ? alert.textContent.trim().slice(0, 160) : null,
          // AppErrorBoundary's exact heading (src/components/AppErrorBoundary.tsx). Matched
          // on the string rather than on role="alert" alone, because other surfaces render
          // legitimate alerts and a false positive here would fail a healthy page.
          crashed: document.body
            ? document.body.innerText.includes("Command tower hit a snag")
            : false,
          bodyText: document.body ? document.body.innerText.trim().slice(0, 240) : "",
        };
      }
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        found: true,
        width: Math.round(r.width),
        height: Math.round(r.height),
        display: cs.display,
        visibility: cs.visibility,
        children: el.childElementCount,
        label: el.getAttribute("aria-label"),
      };
    });
    if (last.found && last.width > 0 && last.height > 0 && last.visibility !== "hidden") return last;
    // FAIL FAST ON A CRASH. AppErrorBoundary is a TERMINAL state — it re-renders its panel
    // for as long as the page lives, so waiting the full 45s for a <main> that can never
    // appear buys nothing and reports nothing. This is not a shortened timeout: the
    // deadline below is unchanged for every state that can still resolve.
    if (!last.found && last.crashed) {
      const d = diagFor(page);
      throw new Error(
        `app crashed into AppErrorBoundary before the shell laid out — ` +
          `${JSON.stringify(last)} · pageErrors: ${JSON.stringify(d?.pageErrors ?? [])} · ` +
          `consoleErrors: ${JSON.stringify((d?.consoleErrors ?? []).slice(-5))}`,
      );
    }
    if (Date.now() > deadline) {
      const d = diagFor(page);
      const diag = d
        ? ` — pageErrors: ${JSON.stringify(d.pageErrors)} · consoleErrors: ` +
          `${JSON.stringify(d.consoleErrors.slice(-5))} · failedRequests: ` +
          `${JSON.stringify(d.failedRequests.slice(-5))}`
        : "";
      throw new Error(
        `app shell never laid out within ${timeout}ms — last seen: ${JSON.stringify(last)}${diag}`,
      );
    }
    await page.waitForTimeout(150);
  }
}

/**
 * PHASE 0 TASK 0.4 — refuse to capture a bundle that is not this tree's build.
 *
 * WHAT THE HAZARD ACTUALLY IS — narrowed by independent verification, because the first
 * version of this note overstated it. `reuseExistingServer: false` does NOT silently reuse
 * a squatter: on the installed Playwright (1.62.1) a stale `vite preview` holding :3007 at
 * suite start makes Playwright refuse to run outright, with "http://localhost:3007 is
 * already used". That was observed directly, not reasoned about.
 *
 * The real window is narrower and still real: the webServer command is
 * `npm run build && vite preview --port 3007 --strictPort`, and the build takes about a
 * minute. A process that grabs :3007 AFTER Playwright's pre-check and BEFORE the preview
 * binds makes `--strictPort` exit, and the suite then proceeds against the squatter. One
 * stale preview was found and killed during this program's triage; nothing in the harness
 * would have said so.
 *
 * So: `vite build` stamps a hash of every build input into index.html, and this recomputes
 * it from the working tree. A mismatch names BOTH hashes and fails; a page with no stamp
 * at all means the suite is pointed at the dev server, and says exactly that.
 *
 * This is a separate defect from the one that made the net blind (pixelmatch's `threshold`
 * — see strict.mjs). Both are fixed; neither substitutes for the other.
 */
export async function assertBuildIdentity(page) {
  const served = await page.evaluate((name) => {
    const el = document.querySelector(`meta[name="${name}"]`);
    return el ? el.getAttribute("content") : null;
  }, BUILD_ID_META);
  const expected = computeSourceId(REPO_ROOT);
  if (served === expected) return expected;
  if (served === null) {
    throw new Error(
      `the served page carries no ${BUILD_ID_META} stamp. The visual suite must run ` +
        `against the PRODUCTION build (npm run build && npm run preview:visual on :3007); ` +
        `a dev server is not stamped. Expected build id ${expected}.`,
    );
  }
  throw new Error(
    `STALE BUNDLE — the page on :3007 was built from different sources than the working ` +
      `tree. served=${served} workingTree=${expected}. Something else is holding the ` +
      `port (vite preview uses --strictPort and exits silently when it is taken, and ` +
      `Playwright then reuses whatever answers). Kill it and re-run; do NOT re-baseline.`,
  );
}

/** Apply freeze CSS + wait for the shell. Call AFTER page.goto(). */
export async function settle(page) {
  await page.addStyleTag({ content: FREEZE_CSS });
  // THE SELECTOR IS THE FIX, and the earlier timeout bumps were treating a symptom.
  //
  // This used to be `waitForSelector("nav, main")`. A comma selector resolves to the
  // FIRST match in DOM order and then waits for THAT element to become visible. The shell
  // renders more than one <nav>, and the one that comes first is hidden at some widths
  // (src/theme/bos.css hides `.bos-side` below 1024px). So the wait sat on a permanently
  // invisible element while `<main>` had been rendered and painted the whole time — the
  // failing run's own page snapshot showed `main "Inbox"` present in the tree.
  //
  // It looked like load-dependent flake because which nav renders first shifts with
  // route and viewport, so it moved around between runs and passed in isolation. Waiting
  // on `main` explicitly, first match, removes the ambiguity entirely.
  await waitForShell(page);
  // Checked here, in the ONE function every spec calls after goto(), so no capture path
  // can bypass it. Placed after waitForShell so a genuinely broken page still reports the
  // shell diagnostics first rather than a confusing "no stamp" on a blank document.
  await assertBuildIdentity(page);
  // Let lazy chunks + the idle-deferred globe mount, then let the freeze apply to them.
  await page.waitForTimeout(1500);
  await page.addStyleTag({ content: FREEZE_CSS });
  await page.evaluate(() => document.fonts?.ready);
  await quiesce(page);
}

/**
 * Wait until the page has stopped fetching.
 *
 * WHY THIS EXISTS — the flake it fixes, root-caused rather than papered over. In a full
 * serial run two tests would occasionally fail while passing in isolation, and the
 * offenders took 35s against a 6s solo baseline. That profile is not nondeterminism: it
 * is `toHaveScreenshot` POLLING. The comparator re-captures until the image matches or
 * `expect.timeout` expires, so a page whose content lands late burns retries and, under
 * load, runs out of them — then passes on a re-run once the machine is quieter.
 *
 * Every data-plane response is now served from memory, so networkidle is reached almost
 * immediately and the comparator matches on its first attempt. Failing to reach idle is
 * itself worth knowing about, but it must not be fatal here: the fixture report is the
 * authority on data-plane correctness, and a stray long-poll should not fail a capture.
 */
export async function quiesce(page) {
  // NOT networkidle. Measured, then corrected: this app is a cockpit and polls forever —
  // /api/state.json every 2s, plus 3s / 4s / 30s pollers on other panels. There is never
  // a 500ms window with zero in-flight requests, so `waitForLoadState("networkidle")`
  // always ran to its full timeout and added ~30s per test for no information at all.
  //
  // Every data-plane response is now served from memory by the fixture layer, so what
  // actually needs waiting for is React's commit after those responses resolve — two
  // animation frames plus a short margin. Correctness is gated by the fixture report and
  // by the pixel comparator, not by this wait.
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))),
  );
  await page.waitForTimeout(250);
}
