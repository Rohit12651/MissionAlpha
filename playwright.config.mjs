import { defineConfig } from "@playwright/test";

import { STRICT } from "./test/visual/strict.mjs";

// Visual-regression config (Phase 0, excellence program). Scoped to test/visual ONLY —
// it does not touch the four node:test suites that form the 1,617-test baseline.
export default defineConfig({
  testDir: "./test/visual",
  // `*.test.mjs` in this directory are node:test suites for the harness itself (run by
  // `npm run test:unit`). Playwright's default testMatch also matches `*.test.*`, so
  // without this it IMPORTS them — executing the node:test suite a second time as a
  // side effect of collection, and registering zero Playwright tests from the file.
  testIgnore: "**/*.test.mjs",
  // Screenshot determinism requires serial execution: parallel workers contend for the
  // single dev server and the shared runtime, which reintroduces the nondeterminism the
  // harness exists to remove.
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  reporter: [["list"]],
  timeout: 90_000,
  // 30s, not 15s. `toHaveScreenshot` polls until the image matches; 15s was enough solo
  // and not enough at the tail of a 30-test serial run, which made two tests look flaky
  // when they were merely slow to settle. `quiesce()` in harness.mjs removes most of the
  // polling; this removes the cliff behind it. It changes only how long the comparison is
  // given to converge, never how strict it is.
  //
  // (This comment used to end "maxDiffPixels stays 0 — the STRICTNESS of the comparison is
  // untouched". That was written when the budget WAS 0 and was not updated when it became
  // 40, eleven lines below. Same mechanism as the comment that let the net stay blind for a
  // whole session. The single source of truth for both numbers is test/visual/strict.mjs;
  // comparator-sensitivity.test.mjs now fails if any comment in this harness quotes a
  // maxDiffPixels or threshold value that disagrees with it.)
  //
  // toHaveScreenshot defaults are set HERE AS WELL as at every call site, deliberately.
  // The suite went blind because one option was absent from a per-call literal: without
  // `threshold`, pixelmatch uses 0.2 and cannot resolve this theme's surface ladder, so a
  // full palette rewrite read as ZERO differing pixels. Defaulting at the config level
  // means a future `toHaveScreenshot()` that forgets to spread STRICT still gets a
  // comparator that can see. Belt and braces, because the failure mode is silent.
  expect: {
    timeout: 30_000,
    toHaveScreenshot: { maxDiffPixels: STRICT.maxDiffPixels, threshold: STRICT.threshold },
  },
  use: {
    baseURL: "http://localhost:3007",
    // Pin everything the OS could otherwise vary.
    colorScheme: "dark",
    timezoneId: "UTC",
    locale: "en-US",
    deviceScaleFactor: 1,
    screenshot: "off",
    video: "off",
    trace: "off",
  },
  // THE PRODUCTION BUILD, not the dev server — and on its own port so a dev server on
  // :3004 can never be picked up by mistake.
  //
  // WHY. Correcting an earlier wrong diagnosis, on the record: the intermittent 50s
  // timeouts were NOT dev-server degradation. They were a bad selector in the harness
  // (`waitForSelector("nav, main")` latching onto a hidden nav — fixed in harness.mjs).
  // The preview build is kept anyway, for two reasons that stand on their own: the
  // regression net should guard WHAT SHIPS rather than what the dev transform produces,
  // and serving static assets takes the module-transform server out of a 30-context
  // serial run entirely.
  //
  // reuseExistingServer stays false: silently reusing a stale build would compare new
  // code against old pixels, which is the exact class of lie this harness exists to stop.
  webServer: {
    command: "npm run build && npm run preview:visual",
    url: "http://localhost:3007",
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
