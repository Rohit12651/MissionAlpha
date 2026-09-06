import { test, expect } from "@playwright/test";
import { installHermetic, settle } from "./harness.mjs";
import { STRICT } from "./strict.mjs";

// PHASE 0 TASK 0.2 — THE GO/NO-GO.
//
// If these fail, the screenshot harness cannot gate Phase 9 (57 component files, zero
// component tests) and the program must be re-scoped. Per the plan: escalate.
//
// The board is deliberately the subject: TTL rings, heartbeat ribbon, live counts and
// SSE-driven state badges — the most animation-dense surface in the app.
//
// WHY PIXEL COMPARISON, NOT BYTE COMPARISON:
// The first version of this spike asserted Buffer.compare(a, b) === 0 across a reload and
// failed. Diagnosis (test/visual/_diag.spec.mjs) showed the DOM was IDENTICAL —
// same innerText, same innerHTML length, no differing line — while the PNG differed by
// exactly 1 byte (99083 vs 99084). That is PNG encoder / GPU compositing variance, not
// application nondeterminism. Byte-identity is the wrong bar for GPU-composited output;
// zero differing PIXELS is the right one, and is what Playwright's image comparator does.
//
// PHASE 0-FIX: these now run hermetically (installHermetic). Previously they proved only
// that the app was stable WHILE the live runtime happened to be stable — which is a much
// weaker claim than it read as, and was false the moment the environment wobbled.
//
// AUTONOMY-PROGRAM PHASE 0 — a correction to the paragraph above, and then a correction to
// the correction, because the first version of this note repeated the original sin.
//
// What was wrong: "zero differing pixels" was NOT what the suite measured. `maxDiffPixels: 0`
// alone leaves pixelmatch's `threshold` at its 0.2 default, which treats a pixel as
// identical unless its YIQ distance exceeds 1408.6. Every surface step in this theme scores
// ~30, so a full palette rewrite read as zero.
//
// What is in force NOW — read strict.mjs, not this paragraph, for the authority:
// `threshold: 0.012` (cutoff 5.07) and `maxDiffPixels: 40`. It is NOT a pixel-exact bar.
// `threshold: 0` was tried first and measured: it failed 4 of 30 tests on an UNCHANGED app.
// The bar is "identical within a measured noise floor", which is why the first test below
// is named that way.
//
// This paragraph previously claimed `threshold: 0` was in force and that these three tests
// proved a pixel-exact bar achievable. Both were false, and the original blind net survived
// for exactly that reason — a comment ("maxDiffPixels: 0 — strict") asserting a property the
// code did not have. Caught in independent verification of this phase. If you change
// strict.mjs, change this note in the same edit or delete it.

// The title says "within the noise floor", not "identical", because that is what it
// asserts. The floor is 17 pixels of rounded-corner antialiasing on a translucent chip
// fill, measured and bounded in strict.mjs — not a comfort margin.
test("two consecutive captures of the same surface match within the noise floor", async ({ page }) => {
  const report = await installHermetic(page);
  await page.goto("/");
  await settle(page);
  expect(report.missing, "unfixtured data-plane requests").toEqual([]);

  await expect(page).toHaveScreenshot("board-stable.png", STRICT);
  await page.waitForTimeout(1500); // give any un-frozen timer a real chance to fire
  await expect(page).toHaveScreenshot("board-stable.png", STRICT);
  // Checked AGAIN after the wait. FREEZE_JS pins Date/Math.random/rAF but NOT
  // setInterval, and several panels poll on a real wall-clock interval. A poller that
  // first fires inside that 1500ms window and hits an unfixtured endpoint would render
  // the same 503 state in BOTH captures — pixel-identical, so the strict comparator
  // would pass it. That is precisely the baked-in-error failure this phase exists to
  // kill, so the check has to bracket the wait, not precede it. (Found in review.)
  expect(report.missing, "an unfixtured request fired after the first capture").toEqual([]);
});

test("a full reload reproduces the same pixels", async ({ page }) => {
  const report = await installHermetic(page);
  await page.goto("/");
  await settle(page);
  await expect(page).toHaveScreenshot("board-reload.png", STRICT);

  await page.reload();
  await settle(page);
  await expect(page).toHaveScreenshot("board-reload.png", STRICT);
  expect(report.missing).toEqual([]);
});

test("a fresh browser context reproduces the same pixels", async ({ browser }) => {
  // Harder than reload: new context = cold cache, fresh lazy-chunk fetch order.
  //
  // FIXED after adversarial review: this previously asserted only that the two PNG byte
  // LENGTHS were within 2048 of each other, while its own comment claimed it compared via
  // the image comparator. Two visually different screenshots passed that trivially — a
  // fake assertion inside the go/no-go suite. It now runs the real pixel comparator.
  const ctx = await browser.newContext({ colorScheme: "dark", timezoneId: "UTC", locale: "en-US" });
  const page = await ctx.newPage();
  const r1 = await installHermetic(page);
  await page.goto("/");
  await settle(page);
  await expect(page).toHaveScreenshot("board-coldcontext.png", STRICT);
  expect(r1.missing).toEqual([]);
  await ctx.close();

  const ctx2 = await browser.newContext({ colorScheme: "dark", timezoneId: "UTC", locale: "en-US" });
  const page2 = await ctx2.newPage();
  const r2 = await installHermetic(page2);
  await page2.goto("/");
  await settle(page2);
  await expect(page2).toHaveScreenshot("board-coldcontext.png", STRICT);
  expect(r2.missing).toEqual([]);
  await ctx2.close();
});

test("the clock is genuinely pinned", async ({ page }) => {
  await installHermetic(page);
  await page.goto("/");
  const [t1, t2] = await page.evaluate(async () => {
    const a = Date.now();
    await new Promise((r) => setTimeout(r, 350));
    return [a, Date.now()];
  });
  expect(t1, "Date.now() advanced — relative timestamps will flap between captures").toBe(t2);
});

// PHASE 0-FIX — the loud-failure proof.
//
// This is the test Fable's finding actually demands: it is not enough that captures are
// hermetic, the harness must FAIL when the data plane is not there. Without this, a future
// change that silently drops fixture coverage looks exactly like success.
test("a missing fixture is reported, not silently rendered", async ({ page }) => {
  const report = await installHermetic(page);
  await page.goto("/");
  await settle(page);
  expect(report.missing).toEqual([]);

  // Ask for a path that is data-plane but deliberately has no fixture.
  const status = await page.evaluate(async () => {
    const r = await fetch("/runtime/__no_such_fixture__");
    return r.status;
  });
  expect(status, "an unfixtured request must be refused, not proxied").toBe(503);
  expect(report.missing, "the harness must record what it could not serve")
    .toEqual(["GET /runtime/__no_such_fixture__"]);
});

// The SSE stub must genuinely be in place: a live stream is the one remaining source of
// mid-capture repaints, and a regression here would be invisible in the pixels until the
// day an event happens to land during a screenshot.
test("EventSource is stubbed — no live stream can repaint mid-capture", async ({ page }) => {
  await installHermetic(page);
  await page.goto("/");
  await settle(page);
  const stubbed = await page.evaluate(() => {
    const es = new EventSource("/runtime/events?ticket=x");
    return { name: es.constructor.name, readyState: es.readyState };
  });
  expect(stubbed.name).toBe("StubEventSource");
  expect(stubbed.readyState).toBe(1);
});
