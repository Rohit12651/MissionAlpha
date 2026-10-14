import { test, expect } from "@playwright/test";
import { installHermetic, settle } from "./harness.mjs";
import { NAV_WIDTH, NAV_HEIGHT, THEMES, navigateTo, setTheme } from "./pages.mjs";
import { STRICT } from "./strict.mjs";
import { loadFixtures, fixtureKey } from "./fixtures.mjs";

// #4 (2026-09-27) — a JOB's questions are answered on their Inbox card.
//
// The pane used to render a job's clarify gate with the STORY answer box, which could only fail
// ("this delivery is not a story question"); nothing in the UI reached /runtime/jobs/:id/answer.
// The card now asks exactly the job's own questions, one field each, and Submit stays disabled until
// every one is answered. The shared fixture is left alone: this spec layers three routes over it
// (Playwright matches the LAST registered route first), so no other baseline moves.
const JOB = "job_fixture0q01";
const GATE = "01M3JQFIXTUREQUESTION0001";
const QUESTIONS = [
  "Should the footer links open in a new tab?",
  "Keep the legacy 'Contact' link, or drop it?",
];
const ROW = {
  id: GATE, agentId: "tech-lead", taskId: `${JOB}-q`, title: "Questions about: Move the footer links",
  summary: QUESTIONS.map((q, i) => `${i + 1}. ${q}`).join("\n"), source: "swarm", kind: "question",
  diffstat: { files: 0, additions: 0, deletions: 0 }, diffFiles: 0, diffAdditions: 0, diffDeletions: 0,
  changedPaths: [], risk: { score: 100, band: "high", reasons: ["high: question — needs your decision"] },
  status: "pending", slaDeadline: null, createdAt: "2026-09-27T12:00:00.000Z", decidedAt: null, decidedBy: null,
  feedback: null, auditRef: `delivery:${GATE}`, mode: null, branch: null, prUrl: null, slaState: null,
  externalKey: null, externalMeta: null, assignee: null, storyId: null, jobId: JOB,
};

async function layerJobGate(page) {
  const base = await loadFixtures();
  const list = JSON.parse(base["GET /inbox?limit=100"].body);
  const extra = {
    "GET /inbox?limit=100": { ...list, deliveries: [ROW, ...list.deliveries] },
    [`GET /inbox/${GATE}`]: { ...ROW, changes: [] },
    [`GET /runtime/jobs/${JOB}`]: {
      job: { id: JOB, title: "Move the footer links", status: "awaiting-you", questions: QUESTIONS, answers: null,
        prUrl: null, blockedOn: null, summary: null, createdAt: 1, updatedAt: 2 },
      tasks: [], gates: [{ id: GATE, kind: "question", title: ROW.title, status: "pending" }], log: [],
    },
  };
  await page.route((url) => Object.hasOwn(extra, fixtureKey("GET", url.href)), async (route) => {
    const req = route.request();
    if (req.method() !== "GET") return route.fallback();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(extra[fixtureKey("GET", req.url())]) });
  });
}

for (const theme of THEMES) {
  test(`inbox job questions @ ${theme}`, async ({ page }) => {
    const report = await installHermetic(page);
    await layerJobGate(page);
    await page.setViewportSize({ width: NAV_WIDTH, height: NAV_HEIGHT });
    await page.goto("/");
    await settle(page);
    await setTheme(page, theme);
    await navigateTo(page, "Inbox");
    await page.getByText(ROW.title).first().click();

    const form = page.getByTestId("job-answer-form");
    await form.waitFor({ state: "visible", timeout: 15000 });
    expect(report.missing, "unfixtured data-plane requests").toEqual([]);
    // DOM first: the job's OWN questions, one field each — not the story answer box.
    for (const q of QUESTIONS) await expect(form.getByText(q)).toBeVisible();
    const fields = form.getByRole("textbox");
    await expect(fields).toHaveCount(QUESTIONS.length);
    const submit = form.getByRole("button", { name: "Submit answers" });
    await expect(submit).toBeDisabled();
    await fields.nth(0).fill("Yes");
    await expect(submit).toBeDisabled(); // one answer is not every answer
    await fields.nth(1).fill("Drop it");
    await expect(submit).toBeEnabled();
    await settle(page);

    const pane = page.getByLabel("Delivery review");
    await expect(pane).toHaveScreenshot(`inbox-job-questions-${theme}.png`, STRICT);
    expect(report.missing, "unfixtured request appeared during capture").toEqual([]);
  });
}
