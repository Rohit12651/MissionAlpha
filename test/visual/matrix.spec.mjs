import { test, expect } from "@playwright/test";
import { installHermetic, settle } from "./harness.mjs";
import { PAGES, VIEWPORTS, THEMES, NAV_WIDTH, NAV_HEIGHT, navigateTo, setTheme } from "./pages.mjs";
import { STRICT } from "./strict.mjs";

// PHASE 0 TASK 0.3 — the baseline matrix.
// 12 pages × 3 viewports × 2 themes = 72 references. This is the ONLY automated net for
// phases 8-9 (57 component files, zero component tests). Run before and after every batch.
//
// THE COMPARISON OPTIONS LIVE IN strict.mjs — do not re-declare them here. A local
// literal is how the comparator went blind: `{ maxDiffPixels: 0 }` bounds the COUNT of
// differing pixels but leaves pixelmatch's `threshold` at its 0.2 default, which cannot
// resolve this theme's surface steps at all. See strict.mjs for the measured numbers.

for (const { id, label } of PAGES) {
  for (const theme of THEMES) {
    test(`${id} @ ${theme}`, async ({ page }) => {
      // Phase 0-FIX: hermetic — clock, RNG, animation, SSE and the DATA PLANE are all
      // pinned. `report` is asserted below so a missing fixture fails the test rather
      // than quietly capturing an error page.
      const report = await installHermetic(page);
      // Navigate at desktop width — the sidebar does not render below 1024px.
      await page.setViewportSize({ width: NAV_WIDTH, height: NAV_HEIGHT });
      await page.goto("/");
      await settle(page);
      await setTheme(page, theme);
      await navigateTo(page, label);

      expect(report.missing, "unfixtured data-plane requests").toEqual([]);
      expect(report.served, "no data-plane request was served from fixtures").toBeGreaterThan(0);

      for (const vp of VIEWPORTS) {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await page.waitForTimeout(400); // reflow
        // Checked BEFORE each capture, not only at the end. Under --update-snapshots a
        // failing assertion does not un-write a PNG that has already been saved, so a
        // trailing-only check would let one bad frame reach disk before going red.
        // A viewport change can trigger a lazy fetch, so this is not merely belt-and-braces.
        expect(report.missing, `unfixtured request before the ${vp.name} capture`).toEqual([]);
        await expect(page).toHaveScreenshot(`${id}-${vp.name}-${theme}.png`, STRICT);
      }

      expect(report.missing, "unfixtured request appeared during capture").toEqual([]);
    });
  }
}
