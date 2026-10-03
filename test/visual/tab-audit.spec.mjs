// Phase G — tab-by-tab parity AUDIT (evidence, not a gate).
//
// Opt-in: TAB_AUDIT=1 ./node_modules/.bin/playwright test test/visual/tab-audit.spec.mjs
// Skipped otherwise, so the default visual suite is unaffected.
//
// For every page tab the MOCKUP itself declares (its NAV array, read from the file — never
// a hand-written list) and every breakpoint in PARITY_VIEWPORTS it writes:
//   test/visual/__screenshots__/mockup/<tab>-<bp>-<top|end>.png   the mockup's rendering
//   test/visual/__screenshots__/app/<tab>-<bp>-<top|end>.png      the app's (parity fixtures)
//   test/visual/__screenshots__/diff/<tab>-<bp>-<top|end>.png     mockup | app | red-where-differs
// `top` is the first viewport, `end` the page scrolled to its end.
//   test/visual/__screenshots__/results.md + .json      MATCH / NO-MATCH per pair
// The verdict is Playwright's own comparator under STRICT (the same one parity.spec uses);
// the diff image is a viewing aid and always written, so a MATCH carries an artifact too.
// GATE: every frame is journalled first, then the test FAILS on a NO-MATCH outside the
// reviewed allowlist, or on an allowlisted frame that now MATCHes (parity-gate.mjs).
// Excluded from the comparison, and listed per row in the results: the honesty delta
// (`.strip .right`) and each tab's D-7 data deltas (blanked in both captures), and
// app-only surfaces (`[data-app-only]`, removed from the app capture).

import { assertParityGate } from "./parity-gate.mjs";
import { test, expect } from "@playwright/test";
import { mkdir, readFile, writeFile, copyFile, appendFile, readdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { installHermetic, settle, FREEZE_CSS, FREEZE_JS, STUB_SSE_JS } from "./harness.mjs";
import { navigateTo } from "./pages.mjs";
import { STRICT } from "./strict.mjs";
import { installParityFixtures, PARITY_BRIDGE_JS, FIRST_RUN_BRIDGE_JS } from "./parity-fixtures.mjs";

// Same breakpoints as parity.spec.mjs (a spec file cannot import another spec file).
const PARITY_VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "laptop", width: 1024, height: 768 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "mobile", width: 375, height: 812 },
];

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const MOCKUP_FILE = join(ROOT, "docs", "mockups", "missionalpha-sketchbook.html");
const OUT = join(HERE, "__screenshots__");
const SNAP_DIR = join(HERE, "tab-audit.spec.mjs-snapshots");
// One journal per tab, so auditing one tab never erases another tab's evidence.
const JOURNAL_DIR = join(OUT, "journal");
const journalOf = (id) => join(JOURNAL_DIR, `${id}.jsonl`);
const HONESTY = ".strip .right{visibility:hidden!important}";
/**
 * D-7 data deltas per tab: text the app renders from a real field (or an honest "—") where
 * the mockup shows example text. Blanked in BOTH captures (same layout, no paint) and
 * written to the results, so every exclusion is visible next to its verdict.
 */
const DELTAS = {
  center: [
    ".alert.okline .sub", // readiness detail: account · model · spend cap (mockup: CLI detection)
    ".grid2 > .card:first-child .row-btn .sub[style]", // per-venture "N active": no venture column on jobs
    ".pills > .chip:nth-last-child(-n+2)", // "stations on Bypass", "seats": no runtime source
    "details.card > summary .sub", // "example events" disclaimer vs live-stream state
    "ol.stream", // event rows: runtime vocabulary vs the mockup's example sentences
    ".tiles .tile:nth-child(4) .big", // spend: /runtime/spend vs the mockup's simulated running total (timing-dependent)
  ],
  inbox: [
    ".qstrip .card-h .sub:last-child", // "oldest": the real oldest pending item's age vs the mockup's example (BOSS decision 4)
    "details.card > summary .sub", // auto-approved: the runtime's retention-window tally vs the mockup's "N today"
    ".review > ul.list", // the mockup's test checks vs the runtime's risk reasons (the runtime has no checks field)
    ".review .diff-h", // the mockup labels the box "diff · read-only"; the app names the file and offers Edit
  ],
  stories: [
    ".kcard > .meta:last-child", // a story has no owner field: the app shows the real time only, not "<owner> · <ago>"
  ],
  missions: [
    ".kcard > .meta:last-child", // the mockup's loop step vs the agent's real task, and its heartbeat age
    ".meter", // context-window usage: the session's real percent vs the mockup's example 24%
    ".chat-thread", // conversation content: the mockup freezes its greeting mid-typing (a simulation frame)
  ],
  brief: [
    ".console .row .sub", // honesty: the mockup says the Captain answers with a verdict; this Captain routes the order
    ".stream .feed-row .dot", // outcome dots: every titled runtime log event is a delivery (needs review)
  ],
  workflows: [
    "tbody tr:nth-child(2) td:nth-child(2)", // a cadence hour is whole in the runtime: 09:00 for the mockup's 09:30
  ],
  roadmap: [
    ".rm > span:not(.chip)", // phase titles + summaries mirror the program plan; the mockup retells them (codes and statuses compared)
  ],
  accounts: [
    ".stack > .card:first-child .card-h .sub", // the mockup's "(example)" vs which CLI the runtime dispatches through
    "#ac-prov", // provider names: the runtime's presets (Claude, OpenAI, …) vs the mockup's (Anthropic, OpenAI, Google)
    ".grid2 > .card:last-child .seg", ".grid2 > .card:last-child p.sub", // chat answers from an ACCOUNT here, from a model tier in the mockup
    ".acct .ava", ".acct b + .sub", // provider initials; no key fragment ever leaves the runtime, and a Claude account has no probe
    ".acct.active .acts button:first-of-type", // honesty: a Claude account has no endpoint to probe, so its Probe is disabled
    "#ac-key-hint", // the mockup's "nothing is stored or sent" vs where the key is really kept
  ],
  vault: [
    ".node text:not(.n)", ".ntiles .sub", // node names: the runtime's six nodes vs the mockup's six kinds (same places)
    ".vsplit .list .chip", // a record's node (same mapping)
    ".vsplit .list b + .sub", // a record's age: the server lists newest first, the mockup does not
    "[aria-live] .card-h .sub", // the record's real path carries its venture: vault/<venture>/<node>/<id>.md
  ],
  outputs: [
    ".grid2 > .card:first-child .list .sub", // a produced record has no station or size ("—"); its age keeps the server's order
    ".diff-h .mono", // the file the server names (mission-audit-<day>.json) vs the mockup's audit-bundle.json
    ".diff pre", // the bundle's real shape vs the mockup's example events (a preview would record a download)
  ],
  // .tl children: 1 the 02:00 slot, 2 the now line, 3..8 the slots after it.
  schedule: [
    ".tl > :nth-child(3) .chip", // a Monday cadence on a Wednesday: "not today" (the mockup says upcoming)
    ".tl > :nth-child(4) time", // a cadence hour is whole in the runtime: 09:00 for the mockup's 09:30
    ".tl > :nth-child(5) b", // the mockup's story windows are not cadences; a skill id titles the slot
    ".tl > :nth-child(6) b",
    ".tl > :nth-child(7) .chip", // a paused cadence says "paused" (the mockup says upcoming)
  ],
};
/**
 * The state each tab is captured in, when the mockup's initial state is scripted rather
 * than derived (the mockup opens the Inbox with D-30 selected). Reached by interaction.
 */
const PREPARE = {
  inbox: async (page) => {
    await page.locator(".dcard", { hasText: "Cache the vault search results" }).click();
    await expect(page.locator(".review h2")).toHaveText("Cache the vault search results");
  },
};
/** App-only surfaces (D-5): kept in the app, absent from the mockup, so not compared. */
const APP_ONLY = "[data-app-only]{display:none!important}";
/**
 * Deltas inside auto-layout tables and grids: hidden text still sizes its column, so a value of a
 * different width ("09:00" vs "09:30") moves every later column by a sub-pixel and every
 * glyph after it reads as a diff. Collapsed to zero width in BOTH captures. Measured: that
 * one cell moves columns 2-6 by 0.02-0.11px in the mockup itself.
 */
const COLLAPSE = {
  // the activity rows: runtime event words vs the mockup's sentences wrap differently at 375px
  // (`.who` sets its own font-size, so it is collapsed too)
  center: ["ol.stream .feed-row > span:nth-child(2)", "ol.stream .feed-row .who"],
  inbox: [".qstrip .card-h .sub:last-child"],
  workflows: ["tbody tr:nth-child(2) td:nth-child(2)"],
  // a row's "kind · station · age" line and its size column: "—" is narrower than "Docs" and
  // "2.1 KB", so at 375px the app's lines and names wrap on different words than the mockup's
  // and the server's file name (mission-audit-<day>.json) wraps where audit-bundle.json does not
  outputs: [".grid2 > .card:first-child .list .sub", ".diff-h .mono"],
  // the same for the vault's chips, ages and record path
  vault: [".vsplit .list .chip", ".vsplit .list b + .sub", "[aria-live] .card-h .sub"],
  // (a `.seg` button sets its own font-size, so the buttons are collapsed, not the group)
  roadmap: [".rm > span:not(.chip)"],
  accounts: [".stack > .card:first-child .card-h .sub", ".grid2 > .card:last-child .seg button", ".grid2 > .card:last-child p.sub", ".acct b + .sub", "#ac-key-hint"],
};
const blank = (id) => (DELTAS[id] ?? []).map((sel) => `${sel}{visibility:hidden!important}`).join("")
  + (COLLAPSE[id] ?? []).map((sel) => `${sel}{font-size:0!important}`).join("");

/** [id, label, icon, kind] rows of the mockup's `const NAV = [...]`. */
export function mockupNav(html) {
  const block = html.match(/const NAV = \[([\s\S]*?)\];/);
  if (!block) throw new Error("mockup NAV array not found");
  return [...block[1].matchAll(/\["([^"]+)", "([^"]+)", "([^"]+)", "([^"]+)"\]/g)].map((m) => m.slice(1));
}

/** id/label rows of the app's BOS_NAV (src/components/bos/bosNav.ts). */
function appNav(ts) {
  return [...ts.matchAll(/\{ id: "([^"]+)",\s*label: "([^"]+)",[^}]*kind: "(\w+)"/g)].map((m) => m.slice(1));
}

const NAV = mockupNav(readFileSync(MOCKUP_FILE, "utf8"));
const TABS = NAV.filter((r) => r[3] === "page");

test.skip(!process.env.TAB_AUDIT, "opt-in: TAB_AUDIT=1");

async function openMockupCockpit(page) {
  await page.addInitScript(FREEZE_JS);
  await page.addInitScript(STUB_SSE_JS);
  await page.goto(`file://${MOCKUP_FILE}`);
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
  await page.waitForTimeout(3000);
  await page.evaluate(() => { const top = setInterval(() => {}, 1e6); for (let i = 1; i <= top; i++) clearInterval(i); });
  await page.addStyleTag({ content: `${FREEZE_CSS}.switcher{display:none!important}${HONESTY}` });
}

/** mockup | app | diff sheet, drawn in a page so no image dependency is needed. */
async function writeSheet(browser, mockPng, appPng, outPng) {
  const sheet = await browser.newPage();
  const n = await sheet.evaluate(async ([a, b]) => {
    const load = (s) => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = `data:image/png;base64,${s}`; });
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    const w = Math.max(ia.width, ib.width), h = Math.max(ia.height, ib.height);
    const px = (img) => { const c = new OffscreenCanvas(w, h); const x = c.getContext("2d"); x.drawImage(img, 0, 0); return x.getImageData(0, 0, w, h).data; };
    const da = px(ia), db = px(ib);
    const c = document.createElement("canvas"); c.width = w * 3 + 40; c.height = h + 48;
    document.body.style.margin = "0"; document.body.appendChild(c);
    const x = c.getContext("2d");
    x.fillStyle = "#ffffff"; x.fillRect(0, 0, c.width, c.height);
    x.fillStyle = "#000000"; x.font = "bold 22px sans-serif";
    x.fillText("MOCKUP", 8, 30); x.fillText("APP", w + 28, 30); x.fillText("DIFF (red = differs)", 2 * w + 48, 30);
    x.drawImage(ia, 0, 48); x.drawImage(ib, w + 20, 48);
    const d = x.createImageData(w, h); let count = 0;
    for (let i = 0; i < da.length; i += 4) {
      const delta = Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]);
      if (delta > 9) { count++; d.data[i] = 230; d.data[i + 1] = 0; d.data[i + 2] = 0; }
      else { const g = 200 + (da[i] + da[i + 1] + da[i + 2]) / 15; d.data[i] = d.data[i + 1] = d.data[i + 2] = g; }
      d.data[i + 3] = 255;
    }
    x.putImageData(d, 2 * w + 40, 48);
    return count;
  }, [mockPng.toString("base64"), appPng.toString("base64")]);
  await sheet.setViewportSize({ width: 800, height: 600 });
  await sheet.locator("canvas").screenshot({ path: outPng });
  await sheet.close();
  return n;
}

test("tab sets compared 1:1", async () => {
  const app = appNav(await readFile(join(ROOT, "src", "components", "bos", "bosNav.ts"), "utf8"));
  const key = (r) => `${r[0]}|${r[1]}`;
  const appKeys = new Set(app.map(key));
  const mockKeys = new Set(NAV.map(key));
  const onlyMockup = NAV.filter((r) => !appKeys.has(key(r))).map(key);
  const onlyApp = app.filter((r) => !mockKeys.has(key(r))).map(key);
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, "tabset.json"), JSON.stringify({ mockup: NAV, app, onlyMockup, onlyApp }, null, 1));
  // A missing tab is recorded as a defect, not thrown, so the per-tab captures still run.
  if (onlyMockup.length || onlyApp.length) test.info().annotations.push({ type: "tabset-defect", description: JSON.stringify({ onlyMockup, onlyApp }) });
});

for (const [id, label] of TABS) {
  for (const vp of PARITY_VIEWPORTS) {
    const name = `${id}-${vp.name}`;
    test(`audit ${name}`, async ({ browser, page }) => {
      for (const d of ["mockup", "app", "diff", "journal"]) await mkdir(join(OUT, d), { recursive: true });
      const gateRows = [];
      // This pair's previous rows are replaced, never appended to.
      const prior = (await readFile(journalOf(id), "utf8").catch(() => "")).split("\n").filter((l) => l && JSON.parse(l).breakpoint !== vp.name);
      await writeFile(journalOf(id), prior.map((l) => `${l}\n`).join(""));
      await mkdir(SNAP_DIR, { recursive: true });
      // Two frames per pair: the first viewport, and the page scrolled to its end — a page
      // longer than the viewport is otherwise only half compared.
      const FRAMES = [["top", 0], ["end", 1e9]];
      const scrollTo = (pg, y) => pg.evaluate((top) => { const c = document.querySelector(".content"); if (c) c.scrollTop = top; }, y);

      const mock = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await openMockupCockpit(mock);
      // #mtabs carries every NAV id (Inbox included — the rail shows Inbox as a pin, not a link).
      await mock.locator(`#mtabs [data-nav="${id}"]`).evaluate((el) => el.click(), undefined, { timeout: 10_000 });
      await mock.setViewportSize({ width: vp.width, height: vp.height });
      if (blank(id)) await mock.addStyleTag({ content: blank(id) });
      await mock.waitForTimeout(500);
      // A pointer left over a control by the last click paints its hover state: park it.
      await mock.mouse.move(0, 0);
      for (const [frame, y] of FRAMES) {
        await scrollTo(mock, y);
        const mockPath = join(OUT, "mockup", `${name}-${frame}.png`);
        await mock.screenshot({ path: mockPath, animations: "disabled" });
        // The mockup capture is the comparator's baseline.
        await copyFile(mockPath, join(SNAP_DIR, `${name}-${frame}-${process.platform}.png`));
      }
      await mock.close();

      await installHermetic(page);
      await installParityFixtures(page, id);
      await page.addInitScript(PARITY_BRIDGE_JS);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto("/");
      await settle(page);
      await navigateTo(page, label);
      if (PREPARE[id]) await PREPARE[id](page);
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.waitForTimeout(500);
      await page.addStyleTag({ content: HONESTY + blank(id) + APP_ONLY });
      const appOnly = await page.locator("[data-app-only]").evaluateAll((els) => els.map((e) => e.getAttribute("data-app-only")));
      await page.mouse.move(0, 0);
      for (const [frame, y] of FRAMES) {
        await scrollTo(page, y);
        const shot = `${name}-${frame}`;
        const mockPath = join(OUT, "mockup", `${shot}.png`);
        const appPath = join(OUT, "app", `${shot}.png`);
        await page.screenshot({ path: appPath, animations: "disabled" });
        let verdict = "MATCH";
        let detail = "";
        try {
          await expect(page).toHaveScreenshot(`${shot}.png`, { ...STRICT, timeout: 5000 });
        } catch (e) {
          verdict = "NO-MATCH";
          detail = String(e.message).split("\n").find((l) => /pixels|size|differ/i.test(l))?.trim() ?? "comparator failed";
        }
        const diffPath = join(OUT, "diff", `${shot}.png`);
        const redPx = await writeSheet(browser, await readFile(mockPath), await readFile(appPath), diffPath);
        gateRows.push({ tab: id, breakpoint: vp.name, frame, verdict });
        await appendFile(journalOf(id), JSON.stringify({ tab: id, label, breakpoint: vp.name, frame, size: `${vp.width}x${vp.height}`, verdict, detail, redPx, deltas: DELTAS[id] ?? [], appOnly,
          mockup: mockPath.slice(ROOT.length + 1), app: appPath.slice(ROOT.length + 1), diff: diffPath.slice(ROOT.length + 1) }) + "\n");
      }
      assertParityGate(gateRows); // journalled first, so a red run still leaves its evidence
    });
  }
}

// ── Landing + Setup screens (spec docs/superpowers/specs/2026-10-02-landing-setup-spec.md §7–8) ──
// Not NAV tabs: each is reached by the same clicks in both pages. The landing is a document-
// scroll page (top + end frames); a setup state is compared as the dialog element itself —
// the cockpit behind the scrim is the tab audit's job, and the mockup's pre-onboarding cockpit
// would otherwise be in every frame.
const SETUP_ROWS = ".ob .list .feed-row > span:last-child";
/** Data deltas per screen (masked = hidden AND collapsed in both captures). */
const SCREEN_MASKS = {
  landing: [".foot-meta .label:last-child"], // honesty: the mockup says "Mockup · example data only"
  "setup-2b": [SETUP_ROWS, ".ob .list .feed-row > .dot"], // the runtime's engines vs the mockup's "(simulated)" rows
  "setup-5": [".ob .list li"], // what the steps confirmed + the real station count
};
const maskCss = (id) => (SCREEN_MASKS[id] ?? []).map((sel) => `${sel}{visibility:hidden!important;font-size:0!important}`).join("");
// Behind a setup dialog each page has its own cockpit; its rounded corners and anti-aliased
// edges would compare that, not the dialog. One opaque scrim in both makes the backdrop equal.
const SCRIM_CSS = ".scrim{opacity:1!important;visibility:visible!important;background:#14254d!important;-webkit-backdrop-filter:none!important;backdrop-filter:none!important}";

/** The landing in its first-run state: reduced motion, exactly one hero message, then held. */
async function holdHero(pg) {
  await expect(pg.locator("#hero-feed li.msg")).toHaveCount(1, { timeout: 10_000 });
  await pg.evaluate(() => Object.defineProperty(document, "hidden", { configurable: true, get: () => true }));
  await pg.waitForTimeout(2000);
  await expect(pg.locator("#hero-feed li.msg")).toHaveCount(1);
}
/** Walk the setup to a state by the clicks a user makes; identical in both pages. */
async function toSetupState(pg, id) {
  await pg.locator(".hero-actions .btn-primary").click();
  await expect(pg.locator(".ob[role=dialog]")).toBeVisible();
  if (id === "setup-1") return;
  await pg.locator("#ob-next").click();
  if (id === "setup-2") return;
  await pg.locator("#ob-detect").click();
  await expect(pg.locator("#ob-next")).toBeEnabled();
  if (id === "setup-2b") return;
  await pg.locator("#ob-next").click();
  await expect(pg.locator("#ob-h")).toHaveText("Account");
  if (id === "setup-3") return;
  await pg.locator("#ob-next").click();
  await expect(pg.locator("#ob-h")).toHaveText("Project");
  if (id === "setup-4") return;
  await pg.fill("#ob-folder", "~/code/my-app");
  await pg.locator("#ob-next").click();
  const said = pg.getByText("Saved. Takes effect after a runtime restart.");
  await expect(said.or(pg.locator("#ob-h", { hasText: "Ready" }))).toBeVisible();
  if (await said.isVisible()) await pg.locator("#ob-next").click(); // the app says a pending restart first
  await expect(pg.locator("#ob-h")).toHaveText("Ready");
}
async function openMockupLanding(pg) {
  await pg.emulateMedia({ reducedMotion: "reduce" });
  await pg.addInitScript(FREEZE_JS);
  await pg.addInitScript(STUB_SSE_JS);
  await pg.goto(`file://${MOCKUP_FILE}`);
  await pg.addStyleTag({ content: `${FREEZE_CSS}.switcher{display:none!important}` });
}
async function openAppLanding(pg) {
  await pg.emulateMedia({ reducedMotion: "reduce" });
  await installHermetic(pg);
  await installParityFixtures(pg, "first-run");
  await pg.addInitScript(FIRST_RUN_BRIDGE_JS);
  await pg.addInitScript(() => { try { localStorage.removeItem("ma.onboarded.v1"); } catch { /* storage blocked */ } });
  await pg.setViewportSize({ width: 1440, height: 900 });
  await pg.goto("/");
  await expect(pg.locator("h1#hero-h")).toBeVisible();
}
/** Amendment 5: a mask counts only if it hits the same number of elements (> 0) in both pages. */
async function probeMasks(mock, app, id) {
  const count = (pg, sel) => pg.locator(sel).count();
  const out = [];
  for (const sel of SCREEN_MASKS[id] ?? []) out.push({ sel, mockup: await count(mock, sel), app: await count(app, sel) });
  return out;
}

const SCREENS = ["landing", "setup-1", "setup-2", "setup-2b", "setup-3", "setup-4", "setup-5"];
for (const id of SCREENS) {
  for (const vp of PARITY_VIEWPORTS) {
    const name = `${id}-${vp.name}`;
    test(`audit ${name}`, async ({ browser, page }) => {
      for (const d of ["mockup", "app", "diff", "journal"]) await mkdir(join(OUT, d), { recursive: true });
      const gateRows = [];
      const prior = (await readFile(journalOf(id), "utf8").catch(() => "")).split("\n").filter((l) => l && JSON.parse(l).breakpoint !== vp.name);
      await writeFile(journalOf(id), prior.map((l) => `${l}\n`).join(""));
      await mkdir(SNAP_DIR, { recursive: true });
      const isLanding = id === "landing";
      const FRAMES = isLanding ? [["top", 0], ["end", 1e9]] : [["top", 0]];
      const scrollTo = (pg, y) => pg.evaluate((top) => window.scrollTo(0, top), y);
      const shotOf = (pg) => (isLanding ? pg : pg.locator(".ob[role=dialog]"));

      const mock = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await openMockupLanding(mock);
      if (isLanding) await holdHero(mock); else await toSetupState(mock, id);
      await openAppLanding(page);
      if (isLanding) await holdHero(page); else await toSetupState(page, id);
      const masks = await probeMasks(mock, page, id);
      if (masks.some((m) => m.mockup !== m.app || m.mockup === 0)) throw new Error(`mask probe failed: ${JSON.stringify(masks)}`);

      for (const pg of [mock, page]) {
        await pg.setViewportSize({ width: vp.width, height: vp.height });
        if (maskCss(id)) await pg.addStyleTag({ content: maskCss(id) });
        if (!isLanding) await pg.addStyleTag({ content: SCRIM_CSS });
        await pg.addStyleTag({ content: APP_ONLY });
        await pg.waitForTimeout(500);
        await pg.mouse.move(0, 0);
      }
      for (const [frame, y] of FRAMES) {
        const shot = `${name}-${frame}`;
        const mockPath = join(OUT, "mockup", `${shot}.png`);
        const appPath = join(OUT, "app", `${shot}.png`);
        await scrollTo(mock, y);
        await shotOf(mock).screenshot({ path: mockPath, animations: "disabled" });
        await copyFile(mockPath, join(SNAP_DIR, `${shot}-${process.platform}.png`));
        await scrollTo(page, y);
        await shotOf(page).screenshot({ path: appPath, animations: "disabled" });
        let verdict = "MATCH";
        let detail = "";
        try {
          await expect(shotOf(page)).toHaveScreenshot(`${shot}.png`, { ...STRICT, timeout: 5000 });
        } catch (e) {
          verdict = "NO-MATCH";
          detail = String(e.message).split("\n").find((l) => /pixels|size|differ/i.test(l))?.trim() ?? "comparator failed";
        }
        const diffPath = join(OUT, "diff", `${shot}.png`);
        const redPx = await writeSheet(browser, await readFile(mockPath), await readFile(appPath), diffPath);
        gateRows.push({ tab: id, breakpoint: vp.name, frame, verdict });
        await appendFile(journalOf(id), JSON.stringify({ tab: id, label: id, breakpoint: vp.name, frame, size: `${vp.width}x${vp.height}`, verdict, detail, redPx, deltas: SCREEN_MASKS[id] ?? [], appOnly: [], masks,
          mockup: mockPath.slice(ROOT.length + 1), app: appPath.slice(ROOT.length + 1), diff: diffPath.slice(ROOT.length + 1) }) + "\n");
      }
      await mock.close();
      assertParityGate(gateRows);
    });
  }
}

// A worker restarts after any failed test, so results are journalled per test and the
// report is rebuilt from the journal by whichever worker finishes last.
test.afterAll(async () => {
  const files = (await readdir(JOURNAL_DIR).catch(() => [])).filter((f) => f.endsWith(".jsonl"));
  const order = [...TABS.map(([id]) => id), ...SCREENS];
  const results = (await Promise.all(files.map((f) => readFile(join(JOURNAL_DIR, f), "utf8"))))
    .flatMap((t) => t.split("\n").filter(Boolean).map((l) => JSON.parse(l)))
    .sort((a, b) => order.indexOf(a.tab) - order.indexOf(b.tab) || PARITY_VIEWPORTS.findIndex((v) => v.name === a.breakpoint) - PARITY_VIEWPORTS.findIndex((v) => v.name === b.breakpoint) || a.frame.localeCompare(b.frame) * -1);
  if (!results.length) return;
  await writeFile(join(OUT, "results.json"), JSON.stringify(results, null, 1));
  const rows = results.map((r) => `| ${r.tab} | ${r.breakpoint} | ${r.frame} | **${r.verdict}** | ${r.redPx} | ${r.detail} | ${r.deltas.length} data · ${r.appOnly.length} app-only | ${r.diff} |`);
  const md = ["# Tab audit — mockup vs app", "", `STRICT: maxDiffPixels ${STRICT.maxDiffPixels}, threshold ${STRICT.threshold}. redPx = pixels the sheet paints red.`, "",
    "| Tab | Breakpoint | Frame | Verdict | redPx | Comparator | Excluded | Diff |", "|---|---|---|---|---|---|---|---|", ...rows, ""].join("\n");
  await writeFile(join(OUT, "results.md"), md);
});
