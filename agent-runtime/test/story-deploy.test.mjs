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
import { createStoryDeploy, changedPathsForStory } from "../story-deploy.mjs";

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


// Phase 6.4 — runDeploy hands the story's changed paths to the executor through an injected
// `changedPathsFor(storyId)` seam (default: none → the executor runs the full command).
test("6.4: runDeploy passes changedPathsFor(storyId) to the executor", async () => {
  const calls = [];
  const stories = { getStory: () => ({ id: "story_x", stage: "deploy-watch", status: "active" }), update: () => {}, advance: () => ({}) };
  const deliveries = { mintGate: () => ({ id: "g" }), listGates: () => [] };
  const deployExecutor = { run: async (args) => { calls.push(args); return { deployed: true, healthy: null }; } };
  const sd = createStoryDeploy({ stories, deliveries, deployExecutor, changedPathsFor: (id) => (id === "story_x" ? ["agent-runtime/a.mjs"] : []) });
  await sd.runDeploy("story_x");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].changedPaths, ["agent-runtime/a.mjs"]);
});


// Phase 6.4 — the pure helper server.mjs wires into `changedPathsFor`: the union of
// changedPaths across the story's APPROVED code Deliveries (matched by the story's task ids
// from the build aggregate). Pending/rejected rows and other stories' rows never count.
test("6.4: changedPathsForStory unions approved deliveries of the story's tasks only", () => {
  const aggregate = (sid) => (sid === "story_x"
    ? { goals: [{ tasks: [{ taskId: "t1" }, { taskId: "t2" }] }], counts: {}, total: 2 }
    : { goals: [], counts: {}, total: 0 });
  const deliveries = { list: ({ status }) => (status === "approved" ? [
    { id: "d1", taskId: "t1", kind: "code", status: "approved", changedPaths: ["agent-runtime/a.mjs", "src/lib/b.ts"] },
    { id: "d2", taskId: "t2", kind: "code", status: "approved", changedPaths: ["src/lib/b.ts", "docs/c.md"] },
    { id: "d3", taskId: "t9", kind: "code", status: "approved", changedPaths: ["src/other.ts"] },
    { id: "d4", taskId: "t1", kind: "failure", status: "approved", changedPaths: [] },
  ] : []) };
  const out = changedPathsForStory("story_x", { aggregate, deliveries });
  assert.deepEqual(out, ["agent-runtime/a.mjs", "docs/c.md", "src/lib/b.ts"]);
  assert.deepEqual(changedPathsForStory("story_none", { aggregate, deliveries }), []);
  assert.deepEqual(changedPathsForStory("story_x", { aggregate: () => { throw new Error("boom"); }, deliveries }), [], "a faulty aggregate yields [] (full command), never throws");
});
