// Story-Pipeline S4 — the FULL stage flow, in-process end to end: a real engine + real queue +
// worktree + broker + stories + vault, storyBuild wired to storyReviewQa. A story is driven
// through build (writing dispatch, the unit-test gate PASSES) → build completes → the review-QA
// driver fires: reviewer PASSES (mock) → QA is honestly SKIPPED (no e2eCmd) → PR is honestly
// SKIPPED (gh unauthed) → the story advances into deploy-watch. This is the deterministic wire
// proof of the S4 stage flow (the real execFile test-run against a live repo is environment-
// dependent and proven separately by the injected-runner integration + quality runner tests).
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createQueue } from "../queue.mjs";
import { createPolicy } from "../policy.mjs";
import { createWorktreeMgr } from "../worktree.mjs";
import { createBroker } from "../broker.mjs";
import { createScheduler } from "../scheduler.mjs";
import { createEngine } from "../engine.mjs";
import { openDb } from "../db.mjs";
import { createStories } from "../stories.mjs";
import { createStoryBuild } from "../story-build.mjs";
import { createStoryReviewQa } from "../story-reviewqa.mjs";
import { createVault } from "../vault.mjs";

let root, repoRoot, storeDir, dbh, clock;
const git = (args, cwd = repoRoot) => execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
const until = async (fn, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 5)); } return false; };

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ma-s4-flow-")));
  repoRoot = join(root, "repo"); storeDir = join(root, "store");
  mkdirSync(join(repoRoot, "src"), { recursive: true });
  git(["init", "-q", "-b", "main"]); git(["config", "user.email", "t@t.t"]); git(["config", "user.name", "t"]);
  writeFileSync(join(repoRoot, "seed.txt"), "seed\n"); git(["add", "-A"]); git(["commit", "-q", "-m", "init"]);
  dbh = openDb({ path: join(root, "data", "mission.db"), patchesDir: join(root, "patches") });
  clock = 1_700_000_000_000;
});
afterEach(() => { try { dbh.close(); } catch { /* */ } try { rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

test("FULL FLOW: build (test gate green) → reviewer pass → qa-skipped → pr-skipped → deploy-watch", async () => {
  const now = () => clock;
  const queue = createQueue({ dir: storeDir, now, maxPerAgent: 2 });
  const policy = createPolicy({ file: join(storeDir, "policy.json"), token: "tk" });
  policy.setLevel("sr-backend", "auto-safe");
  const worktreeMgr = createWorktreeMgr({ repoRoot, worktreeRoot: join(root, "wt") });
  const broker = createBroker({ repoRoot, workdirFor: (id) => worktreeMgr.pathFor(id), scrub: (s) => s });
  let inUse = 0;
  const scheduler = createScheduler({ tryAcquireSlot: () => (inUse >= 2 ? false : (inUse++, true)), releaseSlot: () => { inUse = Math.max(0, inUse - 1); }, claimNext: () => queue.claimNext() });
  const stories = createStories({ db: dbh.db, scrub: (s) => s });
  const vault = createVault({ db: dbh, root: join(root, "vault"), scrub: (s) => s });

  let sb, rq;
  const engine = createEngine({
    queue, policy, worktreeMgr, scheduler, broker,
    dispatchFn: async (ctx) => { const dest = join(ctx.workdir, "src", "impl.ts"); mkdirSync(dirname(dest), { recursive: true }); writeFileSync(dest, `export const impl = ${JSON.stringify(String(ctx.task).slice(0, 40))};\n`); return { acc: "wrote" }; },
    testGateFn: async () => ({ pass: true }),          // the unit-test gate GREEN
    now, goalsDir: join(storeDir, "goals"), jitter: () => 0,
    onDone: (task) => { if (task.storyId && sb) sb.onTerminalTask(task.storyId); },
    onTerminalFailure: (task) => { if (task.storyId && sb) sb.onTerminalTask(task.storyId); },
  });
  sb = createStoryBuild({ goals: () => engine._goalPlans.values(), queue, stories, onEnterReviewQa: (sid) => rq.run(sid) });
  rq = createStoryReviewQa({
    stories, vault,
    reviewerDispatch: async () => ({ verdict: "pass", blockers: [] }),   // reviewer PASS
    aggregate: (sid) => sb.aggregate(sid),
    enqueueGoal: (a) => engine.enqueueGoal(a),
    sandbox: { dockerAvailable: async () => true, runInSandbox: async () => ({ exitCode: 0 }) },
    loadQualityConfig: () => ({ config: { e2eCmd: null, timeoutMs: 1000 } }),  // e2e NOT configured → skip (sandbox unused)
    qaCwd: repoRoot,
    pr: { ghStatus: async () => ({ authenticated: false, installed: false }) },  // gh unauthed → skip
    scrub: (s) => s, vaultVenture: "waahyu",
  });
  engine.start();

  const s = stories.createStory({ title: "Ship it", idea: "the whole S4 flow" });
  for (let i = 0; i < 4; i++) stories.advance(s.id, {}); // → build
  engine.enqueueGoal({ agentId: "sr-backend", storyId: s.id, steps: ["implement the feature"] });

  const reached = await until(() => stories.getStory(s.id).stage === "deploy-watch", 6000);
  assert.ok(reached, "the story advanced all the way to deploy-watch");

  const log = stories.getLog(s.id).map((r) => r.event);
  assert.ok(log.includes("build-complete"), "build completed");
  assert.ok(log.includes("qa-skipped"), "QA honestly skipped (no e2eCmd)");
  assert.ok(log.includes("pr-skipped"), "PR honestly skipped (gh unauthed)");
  assert.ok(log.includes("review-qa-complete"), "review-qa completed");

  // The reviewer verdict artifact landed in the vault.
  const verdict = vault.get(`review-${s.id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 56)}`);
  assert.ok(verdict && /verdict/i.test(verdict.body), "reviewer verdict artifact persisted");
});
