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
  });
}
