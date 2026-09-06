import { test } from "@playwright/test";
import { installFreeze, settle } from "./harness.mjs";
import { PAGES, VIEWPORTS, NAV_WIDTH, NAV_HEIGHT, navigateTo } from "./pages.mjs";
import { recordFixtures, saveFixtures, FIXTURE_FILE } from "./fixtures.mjs";

// Phase 0-FIX — the RECORDER. Not part of the regression run.
//
// Run deliberately, once, against a healthy runtime + dev server:
//     npm run test:visual:record
//
// It walks every BOS page with the network live, stores each data-plane response, and
// writes test/visual/__fixtures__/api.json. Every later `npm run test:visual` replays that
// file and touches no server at all.
//
// GUARD: skipped unless VISUAL_RECORD=1. A recorder that ran inside the regression suite
// would overwrite the fixtures with whatever the runtime happened to be doing — exactly
// the class of silent drift this phase exists to remove.
//
// ⚠ WHAT ENDS UP IN THE FIXTURE FILE. Credentials are redacted (runtime token, SSE
// ticket) and the recording machine's home directory is replaced with a placeholder. But
// the bodies are otherwise the operator's REAL workspace: chat transcripts, vault
// records, brief entries, agent names. That is deliberate — the harness exists to catch
// visual regressions in real content, and synthetic data would not exercise the same
// layouts. It does mean api.json carries whatever was in the workspace at record time.
// Re-record against a scratch workspace before publishing this repo anywhere public.
test.skip(!process.env.VISUAL_RECORD, "set VISUAL_RECORD=1 to re-record the data plane");

test("record the data plane for every BOS surface", async ({ page }) => {
  test.setTimeout(300_000);
  const store = {};
  await recordFixtures(page, store);
  await installFreeze(page);

  await page.setViewportSize({ width: NAV_WIDTH, height: NAV_HEIGHT });
  await page.goto("/");
  await settle(page);

  // TWO passes, and each page is also resized through the capture viewports.
  //
  // The matrix navigates at 1440 then resizes to 768 and 320, and a resize can mount a
  // component (and therefore a fetch) that never ran at desktop width. A single desktop-
  // only pass under-records exactly those requests, and the miss only shows up later as a
  // 503 during capture. The second pass catches anything whose first mount raced the
  // initial navigation.
  for (let pass = 0; pass < 2; pass += 1) {
    for (const { label } of PAGES) {
      await navigateTo(page, label);
      await page.waitForTimeout(1200); // page fetches + one poll cycle
      for (const vp of VIEWPORTS) {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await page.waitForTimeout(400);
      }
      await page.setViewportSize({ width: NAV_WIDTH, height: NAV_HEIGHT }); // nav needs desktop
      await page.waitForTimeout(300);
    }
  }

  const count = await saveFixtures(store);
  // The recorder is an operator tool run by hand; this line is its entire output.
  console.log(`recorded ${count} data-plane responses → ${FIXTURE_FILE}`);
  if (count === 0) throw new Error("recorded ZERO responses — is the runtime up on :3006?");
});
