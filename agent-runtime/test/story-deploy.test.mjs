// Story-Pipeline S5 — the DEPLOY-WATCH stage driver. Uses the REAL story store (faithful stage
// machine) + fake deliveries/vault/executor. Proves: docs-writer → release notes → release gate
// (payload carries the NETWORK flag); APPROVE → jailed deploy → healthy → advance to accept
// (shipped); deploy/health fail → block + alert; REJECT → bounce back to review-qa; idempotency.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../db.mjs";
import { createStories } from "../stories.mjs";
import { createStoryDeploy } from "../story-deploy.mjs";

const SECRET_RE = /sk-ant-[A-Za-z0-9_-]{6,}/g;
const scrub = (s) => (typeof s === "string" ? s.replace(SECRET_RE, "[redacted]") : s);

function harness(over = {}) {
  const root = mkdtempSync(join(tmpdir(), "ma-storydeploy-"));
  const h = openDb({ path: join(root, "data", "mission.db") });
  const stories = createStories({ db: h.db, scrub, emit: () => {} });
  const gates = [];
  const deliveries = {
    minted: gates,
    listGates: (sid, kind) => gates.filter((g) => g.storyId === sid && g.kind === kind && g.status === "pending"),
    mintGate: (g) => { const row = { id: `d_${gates.length}`, status: "pending", ...g }; gates.push(row); return row; },
  };
  const vault = { records: [], write(r) { this.records.push(r); return { id: r.id }; } };
  const alerts = [];
  const deploy = createStoryDeploy({
    stories, deliveries, vault,
    docsDispatch: async () => ({ text: "# Release notes\n\nShip it. leaked sk-ant-SECRETVALUE token" }),
    aggregate: () => ({ goals: [{ seat: "sr-backend", state: "done", steps: ["a"], tasks: [{ result: "applied 1: services/x.py" }] }], total: 1 }),
    deployRoot: "/repo",
    mintAlert: (info) => alerts.push(info),
    scrub, vaultVenture: "waahyu",
    loadDeployConfig: over.loadDeployConfig || (() => ({ config: { network: false, healthUrl: null } })),
    deployExecutor: over.deployExecutor || { run: async () => ({ deployed: true, healthy: null, network: false, tail: "built" }) },
    ...over.deploy,
  });
  // Walk a fresh story to deploy-watch.
  const story = stories.createStory({ title: "Ship feature", idea: "an idea" });
  for (let i = 0; i < 6; i++) stories.advance(story.id, {}); // idea→…→deploy-watch
  return { root, h, stories, deliveries, vault, alerts, deploy, storyId: story.id, gates, cleanup: () => { h.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("enterDeployWatch drafts release notes + mints a release gate carrying the network flag", async () => {
  const t = harness();
  try {
    const out = await t.deploy.enterDeployWatch(t.storyId);
    assert.equal(out.status, "waiting-you");
    assert.equal(t.gates.length, 1);
    assert.equal(t.gates[0].kind, "release-approval");
    assert.match(t.gates[0].body, /network: none/i, "the isolated-network line is surfaced");
    assert.ok(!t.gates[0].body.includes("sk-ant-SECRETVALUE"), "release notes scrubbed in the gate body");
    assert.equal(t.stories.getStory(t.storyId).status, "waiting-you");
  } finally { t.cleanup(); }
});

test("enterDeployWatch surfaces the network:true opt-in LOUDLY", async () => {
  const t = harness({ loadDeployConfig: () => ({ config: { network: true, healthUrl: "http://127.0.0.1:3016/health" } }) });
  try {
    await t.deploy.enterDeployWatch(t.storyId);
    assert.match(t.gates[0].body, /NETWORK: ENABLED/i, "an egress deploy is called out loudly");
  } finally { t.cleanup(); }
});

test("enterDeployWatch is idempotent (an open release gate short-circuits)", async () => {
  const t = harness();
  try {
    await t.deploy.enterDeployWatch(t.storyId);
    const again = await t.deploy.enterDeployWatch(t.storyId);
    assert.equal(again.deduped, true);
    assert.equal(t.gates.length, 1, "no double mint");
  } finally { t.cleanup(); }
});

test("APPROVE → deploy runs, healthy, story ADVANCES to accept (shipped) — the 2nd human tap", async () => {
  const ran = [];
  const t = harness({ deployExecutor: { run: async (a) => { ran.push(a); return { deployed: true, healthy: true, network: false, tail: "ok" }; } } });
  try {
    await t.deploy.enterDeployWatch(t.storyId);
    const out = await t.deploy.onReleaseDecided({ kind: "release-approval", storyId: t.storyId }, { status: "approved" });
    assert.equal(out.shipped, true);
    assert.equal(ran.length, 1, "the executor ran exactly once");
    assert.equal(ran[0].deployRoot, "/repo", "cwd-locked to the deploy root");
    const s = t.stories.getStory(t.storyId);
    assert.equal(s.stage, "accept");
    assert.equal(s.status, "shipped");
  } finally { t.cleanup(); }
});

test("APPROVE with no health URL (healthy=null) still ships on a successful deploy", async () => {
  const t = harness({ deployExecutor: { run: async () => ({ deployed: true, healthy: null, network: false, tail: "built" }) } });
  try {
    await t.deploy.enterDeployWatch(t.storyId);
    await t.deploy.onReleaseDecided({ kind: "release-approval", storyId: t.storyId }, { status: "approved" });
    assert.equal(t.stories.getStory(t.storyId).status, "shipped");
  } finally { t.cleanup(); }
});

test("APPROVE but deploy FAILS → story blocks + one alert (no silent ship)", async () => {
  const t = harness({ deployExecutor: { run: async () => ({ deployed: false, healthy: null, network: false, tail: "npm ERR!", reason: "deploy-failed" }) } });
  try {
    await t.deploy.enterDeployWatch(t.storyId);
    const out = await t.deploy.onReleaseDecided({ kind: "release-approval", storyId: t.storyId }, { status: "approved" });
    assert.equal(out.blocked, true);
    const s = t.stories.getStory(t.storyId);
    assert.equal(s.status, "blocked");
    assert.equal(s.stage, "deploy-watch", "stays at deploy-watch, never advanced");
    assert.equal(t.alerts.length, 1);
    assert.equal(t.alerts[0].kind, "deploy-failed");
  } finally { t.cleanup(); }
});

test("APPROVE, deploy ok but health UNHEALTHY → story blocks (honest)", async () => {
  const t = harness({ deployExecutor: { run: async () => ({ deployed: true, healthy: false, network: false, tail: "503", reason: "health-failed" }) } });
  try {
    await t.deploy.enterDeployWatch(t.storyId);
    const out = await t.deploy.onReleaseDecided({ kind: "release-approval", storyId: t.storyId }, { status: "approved" });
    assert.equal(out.blocked, true);
    assert.equal(t.stories.getStory(t.storyId).status, "blocked");
    assert.equal(t.alerts[0].kind, "health-failed");
  } finally { t.cleanup(); }
});

test("REJECT / request-changes bounces the story back to review-qa (STORY_BACK)", async () => {
  const t = harness();
  try {
    await t.deploy.enterDeployWatch(t.storyId);
    const out = await t.deploy.onReleaseDecided({ kind: "release-approval", storyId: t.storyId }, { status: "changes_requested", feedback: "needs a rollback plan" });
    assert.equal(out.toStage, "review-qa");
    assert.equal(t.stories.getStory(t.storyId).stage, "review-qa");
  } finally { t.cleanup(); }
});

test("onReleaseDecided ignores a non-release row (design gate routes elsewhere)", async () => {
  const t = harness();
  try {
    const out = await t.deploy.onReleaseDecided({ kind: "design-approval", storyId: t.storyId }, { status: "approved" });
    assert.equal(out.skipped, true);
  } finally { t.cleanup(); }
});
