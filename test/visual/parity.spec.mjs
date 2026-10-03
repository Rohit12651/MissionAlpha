// Phase G (ADR G-3) — pixel parity between the approved mockup and the app.
//
// The MOCKUP is the baseline, not a recorded app run. Each test first renders the mockup
// (file://) under the harness's own freeze (same Date, same Math.random, same rAF shim,
// same FREEZE_CSS), writes that capture to the exact path `toHaveScreenshot` reads, then
// renders the app hermetically and compares under the unchanged STRICT comparator. The
// baseline is regenerated from the mockup on every run, so an edit to the mockup moves the
// target and an edit to the app is measured against it — neither side can drift alone.
//
// The mockup's view switcher is authoring scaffolding (D-3) and is hidden on capture.

import { test, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { installHermetic, settle, FREEZE_CSS, FREEZE_JS, STUB_SSE_JS } from "./harness.mjs";
import { navigateTo } from "./pages.mjs";
import { STRICT } from "./strict.mjs";
import { installParityFixtures, PARITY_BRIDGE_JS } from "./parity-fixtures.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOCKUP = `file://${join(HERE, "..", "..", "docs", "mockups", "missionalpha-sketchbook.html")}`;
const SNAP_DIR = join(HERE, "parity.spec.mjs-snapshots");
const HIDE_SCAFFOLDING = ".switcher{display:none!important}";

/**
 * Surfaces under parity. Grows story by story (G2…G12); never shrinks. `mask` hides, in
 * BOTH captures, regions owned by a later story — so a story is measured on its own
 * surface, never excused from it. `honesty` is different in kind: text the mockup shows
 * that would be FALSE in the app (its "example data" disclaimers). Those regions are masked
 * too, but every one is written to the test's annotations and listed in Phase G's Known
 * Gaps — a hidden delta is the violation, a disclosed one is the decision.
 */
export const PARITY = [
  // G2 — the shell: title bar, rail, status strip, dock (G11 renderer: DockSwarm; its canvas
  // is hidden by FREEZE_CSS in both captures, like every canvas). Page body is G3+.
  { id: "shell", label: "Command center", nav: "center", mask: [".content"], honesty: [".strip .right"] },
  { id: "center", label: "Command center", nav: "center", mask: [] },
];
export const PARITY_VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "laptop", width: 1024, height: 768 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "mobile", width: 375, height: 812 },
];

/** Drive the mockup from its landing CTA through setup into the cockpit, then pause it. */
async function openMockupCockpit(page) {
  await page.addInitScript(FREEZE_JS);
  await page.addInitScript(STUB_SSE_JS);
  await page.goto(MOCKUP);
  await page.locator(".hero [data-go=app]").click();
  await page.locator("#ob-next").click();
  await page.locator("#ob-detect").click();
  await expect(page.locator("#ob-next")).toBeEnabled();
  await page.locator("#ob-next").click();
  await page.locator("#ob-next").click();
  await page.fill("#ob-folder", "~/code/my-app");
  await page.locator("#ob-next").click();
  // DETERMINISM: the mockup's ambient simulation ticks every 2.6s from page load and skips
  // while the document is hidden. Its phase against this capture is random, so 1 or 2 extra
  // events landed depending on machine load. Hidden from here on: zero ambient ticks, always.
  await page.evaluate(() => Object.defineProperty(document, "hidden", { configurable: true, get: () => true }));
  await page.locator("#ob-next").click();
  await expect(page.locator("#ov-ob")).toBeHidden();
  await page.waitForTimeout(3000); // the ready toast leaves
  // A still frame with the strip still reading "live" (D-4): stop the example simulation's
  // timers instead of pressing its Live toggle, which would repaint the chip as "paused".
  await page.evaluate(() => { const top = setInterval(() => {}, 1e6); for (let i = 1; i <= top; i++) clearInterval(i); });
  await page.addStyleTag({ content: FREEZE_CSS + HIDE_SCAFFOLDING });
}

/**
 * The comparator must be proven to fire (PES addendum: a ratchet is not evidence until it
 * has been watched failing). Each plant is ONE subtle token change applied to the APP
 * capture only, against the shell baseline. `test.fail()` inverts the result: if the
 * comparator ever stops seeing a plant, these go red on every run.
 */
const PLANTS = [
  { id: "plant-colour", css: ".tb-btn{color:var(--ink-3)!important}" },
  { id: "plant-spacing", css: ".sb-link{letter-spacing:.14em!important}" },
];

const RUNS = [
  ...PARITY.flatMap((surface) => PARITY_VIEWPORTS.map((vp) => ({ surface, vp, name: `${surface.id}-${vp.name}`, plant: null }))),
  ...PLANTS.map((plant) => ({ surface: PARITY[0], vp: PARITY_VIEWPORTS[0], name: `${PARITY[0].id}-${PARITY_VIEWPORTS[0].name}`, plant })),
];

for (const { surface, vp, name, plant } of RUNS) {
  {
    test(plant ? `comparator catches ${plant.id}` : `parity ${name}`, async ({ browser, page }) => {
      if (plant) test.fail();
      // 1 — the mockup capture becomes the baseline.
      const mock = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await openMockupCockpit(mock);
      await mock.locator(`#sb-nav [data-nav="${surface.nav}"]`).evaluate((el) => el.click());
      await mock.setViewportSize({ width: vp.width, height: vp.height });
      await mock.waitForTimeout(400);
      await mkdir(SNAP_DIR, { recursive: true });
      const maskOf = (pg) => (surface.mask ?? []).map((sel) => pg.locator(sel));
      // Honesty regions differ in LENGTH by construction, so a mask (which paints the
      // element's own box) would differ too; blank them instead: same layout, no paint.
      const hideHonesty = (pg) => (surface.honesty?.length ? pg.addStyleTag({ content: `${surface.honesty.join(",")}{visibility:hidden!important}` }) : null);
      for (const sel of surface.honesty ?? []) test.info().annotations.push({ type: "honesty-delta", description: sel });
      await hideHonesty(mock);
      await mock.screenshot({ path: join(SNAP_DIR, `${name}-${process.platform}.png`), animations: "disabled", mask: maskOf(mock) });
      await mock.close();

      // 2 — the app, hermetic, measured against it.
      const report = await installHermetic(page);
      const parityServed = await installParityFixtures(page);
      await page.addInitScript(PARITY_BRIDGE_JS);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto("/");
      await settle(page);
      await navigateTo(page, surface.label);
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.waitForTimeout(400);
      await hideHonesty(page);
      if (plant) await page.addStyleTag({ content: plant.css });
      expect(report.missing, "unfixtured data-plane requests").toEqual([]);
      expect(parityServed.size, "no parity fixture was served").toBeGreaterThan(0);
      await expect(page).toHaveScreenshot(`${name}.png`, { ...STRICT, mask: maskOf(page) });
    });
  }
}
