// The visual-regression matrix (Phase 0 Task 0.3).
//
// Every BOS surface × 3 viewports × 2 themes — the regression net that gates phases 8-9.
// Ids/labels mirror BOS_NAV in src/components/bos/bosNav.ts. If someone adds a page and
// forgets to add it here, its tokens ship unverified — keep the two in sync.
//
// TWO REAL CONSTRAINTS discovered while building this, both load-bearing:
//
// 1. NO TEST HOOKS. The shipped sidebar renders `<button class="bos-item">` with the
//    label inside `<span class="bos-item-label">`. There is no data-nav / data-testid.
//    We select by exact label text rather than adding attributes to production markup
//    purely for tests.
//
// 2. THE SIDEBAR IS DESKTOP-ONLY. src/theme/bos.css hides `.bos-side` and only shows it
//    at `min-width: 1024px`. So a 320px or 768px capture CANNOT navigate — the nav does
//    not exist at that width. Every capture therefore navigates at 1440px FIRST, then
//    resizes to the target viewport before shooting. That mirrors how a real user reaches
//    those layouts (resize / device rotation), and is the only way to reach a BOS page
//    below 1024px at all.

import { quiesce, FREEZE_CSS } from "./harness.mjs";

/** nav id -> exact sidebar label (from BOS_NAV). */
export const PAGES = [
  { id: "center", label: "Command center" },
  { id: "inbox", label: "Inbox" },
  { id: "stories", label: "Stories" },
  { id: "missions", label: "Missions" },
  { id: "brief", label: "CEO brief" },
  { id: "deck", label: "Agents" },
  { id: "workflows", label: "Workflows" },
  { id: "schedule", label: "Schedule" },
  { id: "outputs", label: "Outputs" },
  { id: "vault", label: "Knowledge vault" },
  { id: "accounts", label: "Accounts" },
  { id: "roadmap", label: "Roadmap" },
];

export const VIEWPORTS = [
  { name: "mobile", width: 320, height: 800 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1440, height: 900 },
];

export const THEMES = ["dark", "light"];

/** Width at which the sidebar exists. Navigation must happen here. */
export const NAV_WIDTH = 1440;
export const NAV_HEIGHT = 900;

/**
 * Click a sidebar entry by its exact label.
 *
 * Scoped to `button.bos-item` so the "Agents" NAV BUTTON is not confused with the
 * "Agents" GROUP HEADING (a <span class="bos-label">) or a roster row.
 *
 * WHY el.click() INSTEAD OF locator.click():
 * Playwright's actionability check hit-tests the point it is about to click. Any
 * transient full-screen layer (onboarding, preflight, a modal) makes that check fail
 * with a bare "Timeout exceeded" that says nothing about the real cause. The harness
 * already seeds `ma.onboarded.v1` to suppress the known one, but dispatching the click
 * on the element itself is immune to *any* future overlay, and React still receives the
 * bubbled event. Trading synthetic-input fidelity for determinism is the right call in a
 * screenshot harness — we are verifying pixels, not input plumbing.
 */
export async function navigateTo(page, label) {
  // Inbox is NOT a .bos-item — BosSidebar renders it separately as `.bos-inbox-pin`
  // above the "Workspace" group (it carries the pending badge). Match both classes.
  const sel = "button.bos-item, button.bos-inbox-pin";
  const btn = page.locator(sel, { hasText: new RegExp(`^${label}(\\s*\\d+)?$`) }).first();
  try {
    await btn.waitFor({ state: "attached", timeout: 15000 });
  } catch (err) {
    // A BARE "Timeout 15000ms exceeded" is the same information vacuum that caused two
    // wrong fixes in the shell wait. Say what the rail actually contained, and at what
    // width — Playwright's text matching follows innerText semantics, so a rail that is
    // `display:none` (below 1024px) reports EMPTY text on every button and matches
    // nothing, which is indistinguishable from "the button is gone" without this dump.
    const seen = await page.evaluate((s) => {
      const rail = document.querySelector("nav.bos-side");
      return {
        viewport: `${window.innerWidth}x${window.innerHeight}`,
        railPresent: Boolean(rail),
        railDisplay: rail ? getComputedStyle(rail).display : null,
        buttons: [...document.querySelectorAll(s)].map((b) => ({
          text: b.textContent.trim().slice(0, 40),
          innerText: b.innerText.trim().slice(0, 40),
        })),
      };
    }, sel);
    throw new Error(
      `sidebar entry "${label}" never attached — ${JSON.stringify(seen)} (${err?.message ?? err})`,
    );
  }
  await btn.evaluate((el) => el.click());
  await page.waitForTimeout(700); // lazy chunk mount
  // Then wait for the page's own fetches to settle — see quiesce() for why polling the
  // screenshot comparator instead is what made this suite look flaky.
  await quiesce(page);
}

/**
 * Set the app theme the way the app itself does: [data-theme] on <html>.
 *
 * WHY THIS DOES MORE THAN SET AN ATTRIBUTE. The browser context is created with
 * `colorScheme: "dark"`, so `setTheme(page, "dark")` is a no-op and its captures were
 * always fast and stable. `setTheme(page, "light")` is a REAL state change, and it showed
 * up as a clean asymmetry in a full run: every light capture took 38–96s against a 5–21s
 * dark baseline, and several exhausted the comparator's retry budget. That is not flake —
 * a capture that slow is `toHaveScreenshot` polling while the page is still changing.
 *
 * A theme flip can pull in a font face the dark theme never needed and can mount elements
 * the freeze stylesheet has not been applied to. So: flip, let fonts resolve, let the
 * network go quiet, and re-assert the freeze over anything that mounted. Then capture.
 */
export async function setTheme(page, theme) {
  await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
  await page.evaluate(() => document.fonts?.ready);
  await quiesce(page);
  await page.addStyleTag({ content: FREEZE_CSS });
  await page.waitForTimeout(250);
}
