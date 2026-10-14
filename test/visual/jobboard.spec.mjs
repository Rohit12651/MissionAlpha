import { test, expect } from "@playwright/test";
import { installHermetic, settle } from "./harness.mjs";
import { NAV_WIDTH, NAV_HEIGHT, THEMES, VIEWPORTS, navigateTo, setTheme } from "./pages.mjs";
import { STRICT } from "./strict.mjs";

// Phase 12 / task 12.2 — the JOB BOARD baseline.
//
// It lives in its own spec rather than in PAGES because the board is a TAB on the Stories deck,
// not a nav destination: the matrix navigates by sidebar label and would land on the Stories
// tab every time. Same hermetic harness, same STRICT comparator, same viewports.
//
// The fixture is deliberately SPREAD across statuses — awaiting-you, building, review, shipped,
// blocked. A baseline in which every card sits in one column cannot see a bucketing regression,
// which is the one thing this board does that could silently go wrong.
for (const theme of THEMES) {
  test(`jobs @ ${theme}`, async ({ page }) => {
    const report = await installHermetic(page);
    await page.setViewportSize({ width: NAV_WIDTH, height: NAV_HEIGHT });
    await page.goto("/");
    await settle(page);
    await setTheme(page, theme);
    await navigateTo(page, "Stories");

    // The tab, by role — the same thing a keyboard user reaches.
    await page.getByRole("tab", { name: "Jobs" }).click();
    await page.locator('[role="tabpanel"]#bos-panel-jobs').waitFor({ state: "visible", timeout: 15000 });
    await settle(page);

    expect(report.missing, "unfixtured data-plane requests").toEqual([]);
    // The board must have actually READ the jobs; an empty-state capture would be a green
    // baseline of the wrong thing.
    await expect(page.getByRole("listitem").filter({ hasText: "Awaiting you" })).toBeVisible();

    for (const vp of VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.waitForTimeout(400); // reflow
      expect(report.missing, `unfixtured request before the ${vp.name} capture`).toEqual([]);
      await expect(page).toHaveScreenshot(`jobs-${vp.name}-${theme}.png`, STRICT);
    }

    expect(report.missing, "unfixtured request appeared during capture").toEqual([]);

    // Phase B · Task 5 — the shipped card says WHAT shipped (Codex F12). Runs AFTER the page
    // captures: scrolling the shipped column into view moves the page, and on the mobile
    // viewport that changed the page snapshot (found on the first run). The SHIPPED column is
    // past the right edge at every viewport, so a page capture never sees this chip:
    // `toHaveText` proves the DOM, `toBeInViewport` proves it can be scrolled to, and the
    // locator-level capture proves the pixels. `toBeVisible` alone passes off-screen.
    await page.setViewportSize({ width: NAV_WIDTH, height: NAV_HEIGHT });
    await page.waitForTimeout(400);
    const outcome = page.getByTestId("ship-outcome");
    await expect(outcome).toHaveText("PR");
    const shippedCard = page.getByRole("button", { name: /^Job Alerting runbook, status shipped, PR/ });
    await shippedCard.scrollIntoViewIfNeeded();
    await expect(outcome).toBeInViewport();
    await expect(shippedCard).toHaveScreenshot(`jobs-shipped-card-${theme}.png`, STRICT);

    // Phase F · Task 20 — the CEO's gate is a COLUMN, and its verdict rides on the card after it.
    // The fixture has one job mid-strategy (no verdict yet — the CEO is still deciding) and one
    // awaiting the BOSS because the CEO said defer. DOM first, then the pixels of each card.
    const strategyCard = page.getByRole("button", { name: /^Job Weekly digest email, status strategy\./ });
    await strategyCard.scrollIntoViewIfNeeded();
    await expect(strategyCard).toBeInViewport();
    await expect(strategyCard.getByTestId("strategy-verdict")).toHaveCount(0);
    await expect(strategyCard).toHaveScreenshot(`jobs-strategy-card-${theme}.png`, STRICT);
    const deferCard = page.getByRole("button", { name: /^Job Relative time in the inbox, status awaiting-you, CEO: defer\./ });
    await deferCard.scrollIntoViewIfNeeded();
    await expect(deferCard.getByTestId("strategy-verdict")).toHaveText("CEO: defer");
    await expect(deferCard).toHaveScreenshot(`jobs-defer-card-${theme}.png`, STRICT);

    // Phase B · Task 6 — a blocked job offers a way back. Opening the card fetches
    // GET /runtime/jobs/:id (fixtured for the blocked job); the detail header must show Resume.
    const blockedCard = page.getByRole("button", { name: /^Job Vendor skill sync, status blocked/ });
    await blockedCard.scrollIntoViewIfNeeded();
    await blockedCard.evaluate((el) => el.click());
    const resume = page.getByTestId("job-resume");
    await expect(resume).toBeVisible({ timeout: 15000 });
    await expect(resume).toHaveText("Resume");
    expect(report.missing, "unfixtured request while opening the blocked job").toEqual([]);
    await expect(page.locator(".bos-story-detail-head")).toHaveScreenshot(`jobs-blocked-detail-head-${theme}.png`, STRICT);
  });
}
