// #10 — ORPHANED WORKTREE DIRS SURVIVE A HARD KILL, AND NOTHING EVER COLLECTED THEM.
//
// Measured on the live install: 164 directories under the worktree root, ONE of which any
// task still claimed. `git worktree prune` cannot help — it clears metadata for dirs that
// are gone, not dirs whose metadata is gone — so a SIGKILL mid-task, or any crash between
// `create()` and `remove()`, leaks the checkout forever. Post-D3 a checkout is the whole
// working tree rather than a stub, so the per-unit cost of that leak is no longer trivial.
//
// TWO RULES, and both are about not destroying work:
//   • A dir a task still claims (queued / claimed / HELD) is KEPT. A held task's worktree
//     is the operator's only copy of the diff they are being asked to approve.
//   • The reaper uses release(), never remove(): remove() ends in `git branch -D`, and
//     after an approve that branch is the ONLY copy of a commit the operator accepted.
//     Reaping a directory must never be able to delete landed work.
//
// And one about not guessing: if the liveness probe throws, NOTHING is reaped. A reaper
// that treats "I could not tell" as "delete it" is worse than the leak.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWorktreeMgr, liveWorktreeKeys } from "../worktree.mjs";

let root, repoRoot, worktreeRoot;
const git = (args, cwd = repoRoot) => execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ma-wt-reap-"));
  repoRoot = join(root, "repo");
  worktreeRoot = join(root, "worktrees");
  mkdirSync(repoRoot, { recursive: true });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t.t"]);
  git(["config", "user.name", "t"]);
  mkdirSync(join(repoRoot, "src"));
  writeFileSync(join(repoRoot, "src", "App.tsx"), "export const App = () => null;\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "init"]);
});
afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

const mk = () => createWorktreeMgr({ repoRoot, worktreeRoot, log: () => {} });

test("REAP-1: a dir no task claims is collected; a claimed one is left alone", () => {
  const wt = mk();
  const dead = wt.create("task_dead01");
  const held = wt.create("task_held01");
  assert.ok(existsSync(dead.path) && existsSync(held.path));

  const r = wt.reapOrphans((key) => key === "task_held01");

  assert.equal(existsSync(dead.path), false, "the orphan is gone");
  assert.equal(existsSync(held.path), true, "the held task keeps the diff the operator must review");
  assert.deepEqual(r.reaped, ["task_dead01"]);
  assert.equal(r.kept, 1);
});

test("REAP-2: reaping NEVER deletes the branch — it may be the only copy of landed work", () => {
  const wt = mk();
  const w = wt.create("task_landed");
  // Simulate the approve ladder: a real commit on the task branch.
  writeFileSync(join(w.path, "src", "App.tsx"), "export const App = () => 'shipped';\n");
  execFileSync("git", ["add", "-A"], { cwd: w.path });
  execFileSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "feat: landed"], { cwd: w.path });
  const tip = execFileSync("git", ["rev-parse", w.branch], { cwd: repoRoot, encoding: "utf-8" }).trim();

  wt.reapOrphans(() => false);

  assert.equal(existsSync(w.path), false, "the scratch checkout is collected");
  assert.equal(git(["rev-parse", w.branch]), tip, "the commit the operator approved still exists");
});

test("REAP-3: a liveness probe that throws reaps NOTHING", () => {
  const wt = mk();
  const a = wt.create("task_a");
  const r = wt.reapOrphans(() => { throw new Error("queue unreadable"); });
  assert.equal(existsSync(a.path), true, "uncertainty is not a licence to delete");
  assert.deepEqual(r.reaped, []);
  assert.equal(r.error, true);
});

test("REAP-4: the snapshot scratch index is not a worktree and is never touched", () => {
  const wt = mk();
  wt.create("task_x");           // seeds the scratch index + its head marker
  wt.reapOrphans(() => false);
  assert.equal(existsSync(join(worktreeRoot, ".ma-snapshot.index")), true);
  assert.equal(existsSync(join(worktreeRoot, ".ma-snapshot.head")), true);
});

test("REAP-5: a missing worktree root is a no-op, not a crash", () => {
  const wt = createWorktreeMgr({ repoRoot, worktreeRoot: join(root, "never-made"), log: () => {} });
  rmSync(join(root, "never-made"), { recursive: true, force: true });
  const r = wt.reapOrphans(() => false);
  assert.deepEqual(r.reaped, []);
  assert.equal(r.error, false);
});

test("REAP-6: reaping is idempotent — a second pass finds nothing left to do", () => {
  const wt = mk();
  wt.create("task_one");
  assert.equal(mk().reapOrphans(() => false).reaped.length, 1);
  assert.deepEqual(mk().reapOrphans(() => false).reaped, []);
});

test("REAP-7: a dir referenced by a PENDING DELIVERY is kept, even when its task is terminal", () => {
  // Caught by running the reaper against the live install: a task that was cancelled (or
  // failed after its diff was minted) is TERMINAL in the queue, but its Delivery may still
  // be sitting in the Inbox waiting for a decision — and `applyChanges` reads the diff out
  // of that very checkout. Keying liveness on the queue alone reaped the worktree behind a
  // pending approval and turned it into "workdir missing". The Inbox is the second
  // claimant, and the caller has to say so.
  const wt = mk();
  const pendingDiff = wt.create("task_pending01");
  const trulyDead = wt.create("task_dead02");

  const live = new Set(["task_pending01"]); // queue: terminal · inbox: still pending
  const r = wt.reapOrphans((key) => live.has(key));

  assert.equal(existsSync(pendingDiff.path), true, "the operator can still approve it");
  assert.equal(existsSync(trulyDead.path), false);
  assert.deepEqual(r.reaped, ["task_dead02"]);
});

// ── the predicate the CALLER got wrong ───────────────────────────────────────────
test("REAP-8: liveWorktreeKeys counts BOTH claimants — the queue and the Inbox", () => {
  const live = liveWorktreeKeys({
    tasks: [
      { taskId: "task_running", status: "claimed" },
      { taskId: "task_held", status: "held" },
      { taskId: "task_queued", status: "queued" },
      { taskId: "task_done", status: "done" },
      { taskId: "task_failed", status: "failed" },
      { taskId: "task_cancelled", status: "cancelled" },
    ],
    // Terminal in the queue, still awaiting a human in the Inbox. This is the row whose
    // checkout the first version of the caller reaped out from under Approve.
    pendingDeliveries: [{ taskId: "task_cancelled" }, { taskId: null }, {}],
  });
  assert.deepEqual(
    [...live].sort(),
    ["task_cancelled", "task_held", "task_queued", "task_running"],
    "done and failed are collectable; cancelled-but-pending is not",
  );
});

test("REAP-9: liveWorktreeKeys is total — missing or malformed inputs yield an empty set", () => {
  assert.equal(liveWorktreeKeys().size, 0);
  assert.equal(liveWorktreeKeys({ tasks: null, pendingDeliveries: null }).size, 0);
  assert.equal(liveWorktreeKeys({ tasks: [null, undefined, {}] }).size, 0);
});
