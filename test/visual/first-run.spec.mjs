// Landing + Setup (spec docs/superpowers/specs/2026-10-02-landing-setup-spec.md, §8a) — E2E.
// Every test here was written first and seen failing before the code that passes it.
import { test, expect } from "@playwright/test";
import { installHermetic, settle } from "./harness.mjs";
import { installParityFixtures, PARITY_BRIDGE_JS, FIRST_RUN_BRIDGE_JS } from "./parity-fixtures.mjs";


/** A fresh install: the harness marks every page onboarded, so undo that AFTER it. */
async function openFirstRun(page, { scenario = "first-run", reduceMotion = false, before = async () => {} } = {}) {
  if (reduceMotion) await page.emulateMedia({ reducedMotion: "reduce" });
  await installHermetic(page);
  await installParityFixtures(page, scenario);
  await page.addInitScript(FIRST_RUN_BRIDGE_JS);
  await page.addInitScript(() => { try { localStorage.removeItem("ma.onboarded.v1"); } catch { /* storage blocked */ } });
  await before();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
}

const flagOf = (page) => page.evaluate(() => localStorage.getItem("ma.onboarded.v1"));

async function openCockpit(page) {
  await installHermetic(page);
  await installParityFixtures(page);
  await page.addInitScript(PARITY_BRIDGE_JS);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await settle(page);
}

test("no globe is mounted in the cockpit (AC-L7)", async ({ page }) => {
  await openCockpit(page);
  await page.waitForTimeout(3000);
  await expect(page.locator("[aria-label='Live swarm constellation']")).toHaveCount(0);
});

test("flag unset, no account, no workspace → Landing, no cockpit (AC-1)", async ({ page }) => {
  await openFirstRun(page);
  await expect(page.locator("h1#hero-h")).toHaveText("You decide.The team does the rest.");
  await expect(page.locator("#ma-main")).toHaveCount(0);
});

test("no runtime events → the example job plays; Pause stops it (AC-L2, AC-L4, AC-L5)", async ({ page }) => {
  await openFirstRun(page, { reduceMotion: true });
  const msgs = page.locator("#hero-feed li.msg");
  await expect(msgs).toHaveCount(1, { timeout: 5000 });
  await expect(msgs.first().locator(".body")).toHaveText("Proceed. Cheaper option: ship the switch first, persist the choice in a second pass.");
  await expect(page.locator(".live-head .chip")).toHaveText("Example run · simulated");
  await expect(page.locator("#hero-feed .caret")).toHaveCount(0); // reduced motion: no streaming
  await page.locator("#hero-pause").click();
  await expect(page.locator("#hero-pause")).toHaveAttribute("aria-pressed", "true");
  const n = await msgs.count();
  await page.waitForTimeout(2500);
  await expect(msgs).toHaveCount(n);
});

test("a real runtime event replaces the example (AC-L3)", async ({ page }) => {
  await openFirstRun(page, { reduceMotion: true });
  await expect(page.locator("#hero-feed li.msg")).toHaveCount(1, { timeout: 5000 });
  // The stream opens after an async ticket request; fire only once a listener exists.
  await expect.poll(() => page.evaluate(() => window.__fireSSE("task.done", { agentId: "devops", taskId: "task_x" })), { timeout: 10_000 }).toBeGreaterThan(0);
  await expect(page.locator(".live-head .chip")).toHaveCount(0);
  await expect(page.locator("#hero-feed li.msg")).toHaveCount(1);
  await expect(page.locator("#hero-feed li.msg .who b")).toHaveText("DevOps");
});

test("the landing's lower sections: six recipe steps, four promises, an honest footer", async ({ page }) => {
  await openFirstRun(page);
  await expect(page.locator("#recipes article.recipe")).toHaveCount(6);
  await expect(page.locator("#promises .promise-list li")).toHaveCount(4);
  await expect(page.locator("footer.foot .foot-meta .label").last()).toHaveText("Runs on this machine");
});

test("flag set → cockpit without waiting on the runtime (AC-2)", async ({ page }) => {
  // The harness sets the flag; hold the accounts call for 5s — the cockpit must not wait for it.
  await installHermetic(page);
  await installParityFixtures(page);
  await page.addInitScript(FIRST_RUN_BRIDGE_JS);
  await page.route((u) => new URL(u).pathname === "/runtime/accounts", async (r) => { await new Promise((ok) => setTimeout(ok, 5000)); await r.fallback(); });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.locator("#ma-main")).toBeVisible({ timeout: 3000 });
  await expect(page.locator("h1#hero-h")).toHaveCount(0);
});

test("upgrade: an active account and a chosen workspace skip the landing and set the flag (AC-3)", async ({ page }) => {
  await openFirstRun(page, { scenario: "first-run-upgrade" });
  await expect(page.locator("#ma-main")).toBeVisible();
  await expect(page.locator("h1#hero-h")).toHaveCount(0);
  expect(await flagOf(page)).toBe("1");
});

test("runtime unreachable → landing, flag untouched (AC-4)", async ({ page }) => {
  await openFirstRun(page, { scenario: "first-run-upgrade", before: () => page.route((u) => new URL(u).pathname === "/runtime/accounts", (r) => r.abort()) });
  await expect(page.locator("h1#hero-h")).toBeVisible();
  expect(await flagOf(page)).toBeNull();
});

test("while the upgrade check is pending, neither the landing nor the cockpit shows (AC-5)", async ({ page }) => {
  await openFirstRun(page, { scenario: "first-run-upgrade", before: () => page.route((u) => new URL(u).pathname === "/runtime/accounts", async (r) => { await new Promise((ok) => setTimeout(ok, 1500)); await r.fallback(); }) });
  await page.waitForTimeout(700);
  await expect(page.getByRole("status", { name: "Opening MissionAlpha" })).toHaveCount(1);
  await expect(page.locator("h1#hero-h")).toHaveCount(0);
  await expect(page.locator("#ma-main")).toHaveCount(0);
  await expect(page.locator("#ma-main")).toBeVisible({ timeout: 5000 });
});

async function startJob(page, opts = {}) {
  await openFirstRun(page, opts);
  await page.locator(".hero-actions .btn-primary").click();
  await expect(page.locator(".ob[role=dialog]")).toBeVisible();
}

test("Start a job opens Setup step 1 over the cockpit; focus stays inside; Esc closes without the flag (AC-L6, AC-S13, AC-S14)", async ({ page }) => {
  await startJob(page);
  const dlg = page.locator(".ob[role=dialog]");
  await expect(dlg).toHaveAttribute("aria-modal", "true");
  await expect(dlg.locator("p.sub").first()).toHaveText("Setup · step 1 of 5");
  await expect(dlg.locator("#ob-h")).toHaveText("Welcome");
  await expect(page.locator("#ma-main")).toBeVisible(); // the cockpit is underneath
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => !!document.activeElement?.closest(".ob"))).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(dlg).toBeHidden();
  expect(await flagOf(page)).toBeNull();
});

const dlg = (page) => page.locator(".ob[role=dialog]");
const next = (page) => page.locator("#ob-next");

test("Engines: Detect lists the runtime's engines; Next waits for the spawn engine (AC-S2)", async ({ page }) => {
  await startJob(page);
  await next(page).click();
  await expect(dlg(page).locator("#ob-h")).toHaveText("Engines");
  await expect(next(page)).toBeDisabled();
  await page.locator("#ob-detect").click();
  const rows = dlg(page).locator(".list .feed-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("Claude Code CLI · found");
  await expect(rows.nth(1)).toContainText("Codex CLI · not found · optional");
  await expect(next(page)).toBeEnabled();
});

test("Engines: spawn engine missing → Next stays disabled, and the dialog still closes (AC-S2, AC-S3)", async ({ page }) => {
  await startJob(page, { scenario: "first-run-noengine" });
  await next(page).click();
  await page.locator("#ob-detect").click();
  await expect(dlg(page).locator(".list .feed-row")).toContainText("Claude Code CLI · not found");
  await expect(next(page)).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dlg(page)).toBeHidden();
  expect(await flagOf(page)).toBeNull();
});

/** Count write calls the Account step makes, and keep their bodies. */
function spyWrites(page) {
  const calls = { create: [], active: [] };
  page.on("request", (r) => {
    if (r.method() !== "POST") return;
    const p = new URL(r.url()).pathname;
    if (p === "/runtime/accounts") calls.create.push(r.postDataJSON());
    if (p === "/runtime/accounts/active") calls.active.push(r.postDataJSON());
  });
  return calls;
}
/** Next has finished its work: enabled again, no error on screen (Task 10 asserts the advance). */
async function settled(page) {
  await expect(next(page)).toBeEnabled();
  await page.waitForTimeout(300);
  await expect(dlg(page).getByRole("alert")).toHaveCount(0);
}
async function toAccount(page, opts) {
  await startJob(page, opts);
  await next(page).click();
  await page.locator("#ob-detect").click();
  await expect(next(page)).toBeEnabled();
  await next(page).click();
  await expect(dlg(page).locator("#ob-h")).toHaveText("Account");
}

test("Account · create: no subscription account → one create (no secret) + set active (AC-S4, AC-SEC1)", async ({ page }) => {
  const calls = spyWrites(page);
  await toAccount(page);
  await next(page).click();
  await settled(page);
  expect(calls.create).toHaveLength(1);
  expect(calls.create[0]).toEqual({ providerType: "claude", authMethod: "subscription", label: "Claude subscription" });
  expect(Object.keys(calls.create[0])).not.toContain("secret");
  expect(calls.active).toEqual([{ accountId: "new-sub" }]);
});

test("Account · activate: an inactive subscription account is made active, nothing created (AC-S5)", async ({ page }) => {
  const calls = spyWrites(page);
  await toAccount(page, { scenario: "first-run-activate" });
  await next(page).click();
  await settled(page);
  expect(calls.create).toHaveLength(0);
  expect(calls.active).toEqual([{ accountId: "sub1" }]);
});

test("Account · confirm: the subscription account is already active → no write (AC-S6)", async ({ page }) => {
  const calls = spyWrites(page);
  await toAccount(page, { scenario: "first-run-confirm" });
  await next(page).click();
  await settled(page);
  expect(calls.create).toHaveLength(0);
  expect(calls.active).toHaveLength(0);
});

test("Account · later: an API key later writes nothing (AC-S7)", async ({ page }) => {
  const calls = spyWrites(page);
  await toAccount(page);
  await dlg(page).getByLabel(/Add an API key later/).check();
  await next(page).click();
  await settled(page);
  expect(calls.create).toHaveLength(0);
  expect(calls.active).toHaveLength(0);
});

test("Account · failure: the runtime's sentence shows inline and Next does not advance (AC-S8)", async ({ page }) => {
  await toAccount(page);
  await page.route((u) => new URL(u).pathname === "/runtime/accounts", (r) => r.request().method() === "POST"
    ? r.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "label already exists" }) }) : r.fallback());
  await next(page).click();
  await expect(dlg(page).getByRole("alert")).toHaveText("label already exists");
  await expect(dlg(page).locator("#ob-h")).toHaveText("Account");
});

async function toProject(page, opts) {
  await toAccount(page, opts);
  await next(page).click();
  await expect(dlg(page).locator("#ob-h")).toHaveText("Project"); // Account advances (moved from Task 9)
}
function spyWorkspace(page) {
  const posts = [];
  page.on("request", (r) => { if (r.method() === "POST" && new URL(r.url()).pathname === "/runtime/workspace") posts.push(r.postDataJSON()); });
  return posts;
}

test("Project: a path outside the rule shows the rule and calls nothing (AC-S9)", async ({ page }) => {
  const posts = spyWorkspace(page);
  await toProject(page);
  await expect(page.locator("#ob-folder")).not.toHaveAttribute("aria-describedby", /.+/); // no error yet, nothing to describe
  await page.locator("#ob-folder").fill("code/app");
  await next(page).click();
  await expect(page.locator("#ob-folder-err")).toBeVisible();
  await expect(page.locator("#ob-folder")).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator("#ob-folder")).toHaveAttribute("aria-describedby", "ob-folder-err");
  await page.waitForTimeout(300);
  expect(posts).toHaveLength(0);
});

test("Project: a valid path is saved; restartRequired is said, not hidden (AC-S9, spec §5.3)", async ({ page }) => {
  const posts = spyWorkspace(page);
  await toProject(page);
  await page.locator("#ob-folder").fill("~/code/my-app");
  await next(page).click();
  await expect(dlg(page).getByRole("status")).toHaveText("Saved. Takes effect after a runtime restart.");
  expect(posts).toEqual([{ repoPath: "~/code/my-app" }]);
});

test("Project: the runtime's refusal shows inline and the step stays (AC-S8)", async ({ page }) => {
  await toProject(page);
  await page.route((u) => new URL(u).pathname === "/runtime/workspace", (r) => r.request().method() === "POST"
    ? r.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ ok: false, error: "not a directory" }) }) : r.fallback());
  await page.locator("#ob-folder").fill("~/nope");
  await next(page).click();
  await expect(dlg(page).getByRole("alert")).toHaveText("not a directory");
  await expect(dlg(page).locator("#ob-h")).toHaveText("Project");
});

async function toReady(page, opts) {
  await toProject(page, opts);
  await page.locator("#ob-folder").fill("~/code/my-app");
  await next(page).click();
  // Either the runtime asked for a restart (said on this step, then Next advances) or we moved on.
  const said = dlg(page).getByText("Saved. Takes effect after a runtime restart.");
  await expect(said.or(dlg(page).locator("#ob-h", { hasText: "Ready" }))).toBeVisible();
  if (await said.isVisible()) await next(page).click();
  await expect(dlg(page).locator("#ob-h")).toHaveText("Ready");
}

test("Ready lists only what was confirmed; pending restart is never 'active'; finishing lands on Command center (AC-S10, AC-S11, AC-S12)", async ({ page }) => {
  await toReady(page);
  const items = dlg(page).locator(".list li");
  await expect(items.nth(0)).toHaveText("✓ Engine: Claude Code CLI");
  await expect(items.nth(1)).toHaveText("✓ Account: Claude subscription · active");
  await expect(items.nth(2)).toHaveText("· Project: ~/code/my-app · pending restart"); // not confirmed: no ✓
  await expect(items.nth(3)).toHaveText(/^✓ (\d+|—) stations, standing by$/);
  await expect(next(page)).toHaveText("Open the cockpit");
  await next(page).click();
  await expect(dlg(page)).toBeHidden();
  await expect(page.locator("#ma-main h1")).toHaveText(/command center/i);
  expect(await flagOf(page)).toBe("1");
  await expect(page.locator(".toast.on")).toHaveText("Your team is ready · start a job from Missions");
});

test("Ready: an applied project reads active (AC-S10)", async ({ page }) => {
  await toReady(page, { before: () => page.route((u) => new URL(u).pathname === "/runtime/workspace", (r) => r.request().method() === "POST"
    ? r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, repoPath: "~/code/my-app", active: "~/code/my-app", restartRequired: false, envPinned: false }) }) : r.fallback()) });
  await expect(dlg(page).locator(".list li").nth(2)).toHaveText("✓ Project: ~/code/my-app · active");
});

async function runCommand(page, text) {
  await page.keyboard.press("ControlOrMeta+k");
  const input = page.getByPlaceholder("Type a command or search…");
  await expect(input).toBeVisible();
  await input.fill(text);
  await page.keyboard.press("Enter");
}

test("⌘K 'Replay onboarding tour' reopens Setup at step 1 (AC-K1)", async ({ page }) => {
  await openCockpit(page);
  await runCommand(page, "Replay onboarding");
  await expect(page.locator(".ob[role=dialog]")).toBeVisible();
  await expect(page.locator("#ob-h")).toHaveText("Welcome");
});

test("⌘K 'Show the welcome page' shows the Landing (AC-K2)", async ({ page }) => {
  await openCockpit(page);
  await runCommand(page, "Show the welcome");
  await expect(page.locator("h1#hero-h")).toBeVisible();
});

test("Back on step 1 leaves setup (the mockup draws it there); the flag stays unset (AC-S13)", async ({ page }) => {
  await startJob(page);
  await expect(page.locator("#ob-back")).toBeVisible();
  await page.locator("#ob-back").click();
  await expect(page.locator(".ob[role=dialog]")).toBeHidden();
  expect(await flagOf(page)).toBeNull();
});

test("a11y: the dialog is described by its step (4.1.2)", async ({ page }) => {
  await startJob(page);
  await expect(page.getByRole("dialog")).toHaveAccessibleDescription("Setup · step 1 of 5");
});

test("a11y: the landing's recipes scroller is a named region (4.1.2)", async ({ page }) => {
  await openFirstRun(page);
  await expect(page.getByRole("region", { name: "The six steps of a job, scroll sideways" })).toHaveCount(1);
});

// ── Phase 8 review fixes (each written first, seen failing) ─────────────────
test("Engines: after 'not found', Detect again re-asks the runtime (review H1)", async ({ page }) => {
  await startJob(page, { scenario: "first-run-noengine" });
  await next(page).click();
  await page.locator("#ob-detect").click();
  await expect(next(page)).toBeDisabled();
  await page.route((u) => new URL(u).pathname === "/runtime/engines", (r) => r.fulfill({ status: 200, contentType: "application/json",
    body: JSON.stringify({ at: 0, spawnEngine: "claude", engines: [{ id: "claude", label: "Claude Code CLI", bin: "claude", found: true, path: "/usr/local/bin/claude", promptDelivery: "flag", installCommand: null, docsUrl: null }] }) }));
  await page.getByRole("button", { name: "Detect again" }).click();
  await expect(next(page)).toBeEnabled();
});

test("Setup reopened from ⌘K starts fresh: no stale engines or project (review M1)", async ({ page }) => {
  await toReady(page);
  await next(page).click(); // Open the cockpit
  await runCommand(page, "Replay onboarding");
  await next(page).click();
  await expect(page.locator("#ob-detect")).toBeVisible(); // not the previous run's list
  await expect(next(page)).toBeDisabled();
});

test("a transport failure shows the fixed sentence, never the browser's error text (review M2, AC-SEC2)", async ({ page }) => {
  await toAccount(page);
  await page.route((u) => new URL(u).pathname === "/runtime/accounts", (r) => r.abort());
  await next(page).click();
  await expect(dlg(page).getByRole("alert")).toHaveText("The runtime did not answer.");
});

test("a refusal for lack of rights says so (security review)", async ({ page }) => {
  await toAccount(page);
  await page.route((u) => new URL(u).pathname === "/runtime/accounts", (r) => r.request().method() === "POST"
    ? r.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "forbidden" }) }) : r.fallback());
  await next(page).click();
  await expect(dlg(page).getByRole("alert")).toHaveText("The runtime refused this: it needs an approver seat.");
});

test("⌘K 'Show the welcome page' while Setup is open closes it for good (review M3)", async ({ page }) => {
  await openCockpit(page); // onboarded
  await runCommand(page, "Replay onboarding");
  await expect(page.locator(".ob[role=dialog]")).toBeVisible();
  await runCommand(page, "Show the welcome");
  await expect(page.locator("h1#hero-h")).toBeVisible();
  await page.locator(".hero-actions .btn-primary").click(); // onboarded: straight to the cockpit
  await expect(page.locator("#ma-main")).toBeVisible();
  await expect(page.locator(".ob[role=dialog]")).toBeHidden();
});

test("a runtime that never answers the first-run check falls to the landing (review M4)", async ({ page }) => {
  await openFirstRun(page, { before: () => page.route((u) => new URL(u).pathname === "/runtime/accounts", () => { /* never answer */ }) });
  await expect(page.locator("h1#hero-h")).toBeVisible({ timeout: 9000 });
});

test("an env-pinned runtime: the project step says the choice will not apply (security review)", async ({ page }) => {
  await toProject(page, { before: () => page.route((u) => new URL(u).pathname === "/runtime/workspace", (r) => r.request().method() === "POST"
    ? r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, repoPath: "/srv/real", active: "/srv/pinned", restartRequired: true, envPinned: true }) }) : r.fallback()) });
  await page.locator("#ob-folder").fill("~/code/my-app");
  await next(page).click();
  await expect(dlg(page).getByRole("status")).toHaveText("The runtime's folder is pinned by its environment, so this choice will not apply.");
  await next(page).click();
  await expect(dlg(page).locator(".list li").nth(2)).toHaveText("· Project: /srv/real · pinned by the runtime's environment, not applied");
});

test("a failed detect keeps keyboard focus inside the dialog (final review MEDIUM)", async ({ page }) => {
  await startJob(page);
  await next(page).click();
  await page.route((u) => new URL(u).pathname === "/runtime/engines", (r) => r.abort());
  await page.locator("#ob-detect").click();
  await expect(dlg(page).getByRole("alert")).toHaveText("The runtime did not answer.");
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest("[role=dialog]"))).toBe(true);
});

test("Detect again keeps the last result on screen while it asks, and after a failure (final review LOW)", async ({ page }) => {
  await startJob(page, { scenario: "first-run-noengine" });
  await next(page).click();
  await page.locator("#ob-detect").click();
  const rows = dlg(page).locator(".list .feed-row");
  await expect(rows).toContainText("Claude Code CLI · not found");
  let release;
  const held = new Promise((r) => { release = r; });
  await page.route((u) => new URL(u).pathname === "/runtime/engines", async (r) => { await held; await r.abort(); });
  await page.getByRole("button", { name: "Detect again" }).click();
  await expect(dlg(page).getByRole("button", { name: "Detecting…" })).toBeDisabled();
  await expect(rows).toContainText("Claude Code CLI · not found");
  release();
  await expect(dlg(page).getByRole("alert")).toHaveText("The runtime did not answer.");
  await expect(rows).toContainText("Claude Code CLI · not found");
  await expect(dlg(page).getByRole("button", { name: "Detect again" })).toBeEnabled();
});

// Final review LOW: Setup remembered whatever held focus when it opened. From ⌘K that is the
// palette's input, which unmounts a moment later, so closing Setup sent focus to <body>.
const focusSpot = (page) => page.evaluate(() => {
  const a = document.activeElement;
  return !a || a === document.body ? "body" : a.isConnected ? (a.getAttribute("aria-label") || a.textContent || a.tagName).trim().slice(0, 40) : "detached";
});
for (const twice of [false, true]) {
  test(`⌘K Replay${twice ? " while Setup is already open" : ""}, then Esc: focus returns to where it was before ⌘K (final review LOW)`, async ({ page }) => {
    await openCockpit(page);
    const anchor = page.locator("main button:visible").first();
    await anchor.focus();
    const before = await focusSpot(page);
    expect(before).not.toBe("body");
    await runCommand(page, "Replay onboarding");
    await expect(page.locator(".ob[role=dialog]")).toBeVisible();
    if (twice) { await runCommand(page, "Replay onboarding"); await expect(page.locator("#ob-h")).toHaveText("Welcome"); }
    await page.keyboard.press("Escape");
    await expect(page.locator(".ob[role=dialog]")).toBeHidden();
    await expect.poll(() => focusSpot(page)).toBe(before);
  });
}
