// 6.2 — A PATH THE SNAPSHOT REFUSED, OR THE OPERATOR EDITED AFTER THE SNAPSHOT, IS
// NEVER ATTRIBUTED TO THE AGENT.
//
// The defect: `listChangesDetailed` diffed the worktree against the LIVE operator tree.
// Two whole classes of path are different between those two for reasons that have
// nothing to do with the agent:
//   (a) a path `snapshotAllowed` REFUSED — it was never staged, so the worktree holds
//       HEAD's copy while the live tree holds the operator's newer one;
//   (b) a path the operator edited AFTER the base snapshot was taken.
// Both read as "the agent proposes to replace your file with an older one". Approving
// such a Delivery REVERTS uncommitted operator work — measured live on 2026-09-02 as a
// 29-file, +445/-368 "revert to HEAD" minted by a one-line docs task.
//
// The invariant this file pins (CORE-GUARD-EDITS §3): Delivery.changedPaths ⊆ paths the
// SEAT wrote. `changes` is now computed against the SNAPSHOT COMMIT the worktree was
// actually built from; (a) and (b) are reported separately under `notAttributed` so the
// operator is told, rather than silently shipped a shorter list.
//
// RATCHET, PROVEN BOTH WAYS IN-FILE (repo PES addendum §13 — a ratchet is not evidence
// until you have watched it fail): BA-2 deletes the manifest and asserts the OLD, WRONG
// answer comes back. That is the mutation, it runs on every CI run, and it fails the
// moment the manifest stops being the thing doing the work.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync, unlinkSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWorktreeMgr } from "../worktree.mjs";
import { createBroker } from "../broker.mjs";

let root, repoRoot, worktreeRoot, wt;
const git = (args, cwd = repoRoot) => execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
const KEY = "task_attr";

// (a) refused by the snapshot deny list AND inside the appliable scope, so without the
//     fix it lands in `changes` — the strongest possible form of the defect.
const REFUSED = "src/secrets.yaml";
// (b) edited by the OPERATOR after the snapshot was taken.
const OPERATOR_LATE = "src/edited-later.ts";
// (c) the only thing the agent actually wrote.
const AGENT = "src/agent.ts";
// A tracked file the operator had already modified BEFORE the snapshot: it IS in the
// snapshot, so worktree content == live content and it is simply not a change.
const PRE_DIRTY = "src/dirty.ts";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ma-broker-attr-"));
  repoRoot = join(root, "repo");
  worktreeRoot = join(root, "worktrees");
  mkdirSync(join(repoRoot, "src"), { recursive: true });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t.t"]);
  git(["config", "user.name", "t"]);
  writeFileSync(join(repoRoot, REFUSED), "api_key: HEAD-VERSION\n");
  writeFileSync(join(repoRoot, OPERATOR_LATE), "export const v = 1;\n");
  writeFileSync(join(repoRoot, PRE_DIRTY), "export const d = 1;\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "init"]);
  // The operator's tree is dirty BEFORE any worktree is made — both a refused path and
  // an ordinary one, exactly like the live install.
  writeFileSync(join(repoRoot, REFUSED), "api_key: OPERATOR-NEWER\n");
  writeFileSync(join(repoRoot, PRE_DIRTY), "export const d = 2;\n");
  wt = createWorktreeMgr({ repoRoot, worktreeRoot, log: () => {} });
});
afterEach(() => {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* */ }
});

/** Build the worktree, then stage (b) and (c). Returns {path, manifest}. */
function scenario() {
  const r = wt.create(KEY);
  const manifest = wt.snapshotManifest(KEY);
  // (b) the OPERATOR edits a source file after the snapshot. mtime is set explicitly
  // rather than slept for: a value assertion, never a timing race.
  writeFileSync(join(repoRoot, OPERATOR_LATE), "export const v = 2; // operator, later\n");
  const later = (manifest.snapshotAt + 5000) / 1000;
  utimesSync(join(repoRoot, OPERATOR_LATE), later, later);
  // (c) the AGENT writes one new file inside its worktree.
  writeFileSync(join(r.path, AGENT), "export const agent = true;\n");
  return { ...r, manifest };
}

const broker = () => createBroker({ repoRoot, workdirFor: () => wt.pathFor(KEY), scrub: (s) => s });
const sortByPath = (a) => [...a].sort((x, y) => x.path.localeCompare(y.path));

test("BA-1: the manifest records what the snapshot refused, and when", () => {
  wt.create(KEY);
  const m = wt.snapshotManifest(KEY);
  assert.ok(m, "a worktree built by create() has a manifest");
  assert.match(m.sha, /^[0-9a-f]{40}$/, "the base is a resolved sha");
  assert.deepEqual(m.refusedPaths, [REFUSED], "the deny list's refusals are recorded, not thrown away");
  assert.ok(Number.isFinite(m.snapshotAt) && m.snapshotAt > 0, "and WHEN the base was taken");
  assert.equal(wt.snapshotManifest("never_made"), null, "unknown key ⇒ null, never a throw");
});

test("BA-2 RATCHET: with the manifest the agent owns ONE path; without it, the old wrong answer", async () => {
  scenario();
  const withManifest = await broker().listChangesDetailed(KEY);
  assert.deepEqual(withManifest.changes.map((c) => c.path), [AGENT], "changes = only the agent's own write");
  assert.deepEqual(
    sortByPath(withManifest.notAttributed),
    [
      { path: OPERATOR_LATE, reason: "operator-edited-after-snapshot" },
      { path: REFUSED, reason: "snapshot-refused" },
    ],
    "and the operator is TOLD about the two paths that are not the agent's",
  );

  // THE MUTATION: remove the manifest → the broker cannot know the baseline and must
  // fall back to the historical behaviour. Both operator paths reappear as "changes",
  // which is precisely the bug. If this block ever stops showing the old answer, the
  // manifest is no longer what makes BA-2's first half true.
  for (const f of readdirSync(worktreeRoot)) {
    if (f.startsWith(".ma-manifest.")) unlinkSync(join(worktreeRoot, f));
  }
  const without = await broker().listChangesDetailed(KEY);
  assert.deepEqual(without.notAttributed, [], "no manifest ⇒ nothing can be attributed away");
  assert.deepEqual(
    without.changes.map((c) => c.path).sort(),
    [AGENT, OPERATOR_LATE, REFUSED].sort(),
    "the pre-fix answer: the operator's own two files blamed on the agent",
  );
});

test("BA-3: a path the operator edited BEFORE the snapshot is not a change and not a report", async () => {
  scenario();
  const d = await broker().listChangesDetailed(KEY);
  const seen = [...d.changes.map((c) => c.path), ...d.notAttributed.map((n) => n.path), ...d.refused];
  assert.equal(seen.includes(PRE_DIRTY), false, "it is IN the snapshot, so there is nothing to say about it");
});

test("BA-4: listChanges keeps its historical contract — the appliable diff and nothing else", async () => {
  scenario();
  const plain = await broker().listChanges(KEY);
  assert.deepEqual(plain.map((c) => c.path), [AGENT]);
  assert.ok(plain.every((c) => "before" in c && "after" in c && "status" in c), "shape unchanged");
});

test("BA-5: the agent editing a REFUSED path is still refused, not laundered into changes", async () => {
  const r = scenario();
  // The seat overwrites the stale copy of a path the snapshot refused. It is still not
  // the seat's to hand over: the baseline it edited was never the operator's file.
  writeFileSync(join(r.path, REFUSED), "api_key: WRITTEN-BY-THE-AGENT\n");
  const d = await broker().listChangesDetailed(KEY);
  assert.equal(d.changes.some((c) => c.path === REFUSED), false, "a refused path can never enter changes");
  // 6.7 (security review) — the seat WROTE it, so it is the seat's out-of-scope write: reported
  // under `refused`, and NOT laundered into notAttributed as if the operator had edited it.
  assert.ok(d.refused.includes(REFUSED), "an agent write to a refused path is reported under refused");
  assert.deepEqual(
    d.notAttributed.filter((n) => n.path === REFUSED),
    [],
  );
});

test("BA-6: a corrupt or hostile manifest degrades to the old behaviour, never a throw", async () => {
  scenario();
  const files = readdirSync(worktreeRoot).filter((f) => f.startsWith(".ma-manifest."));
  assert.equal(files.length, 1, "exactly one manifest per task");
  for (const bad of ["{not json", '{"sha":"--upload-pack=evil","refusedPaths":[],"snapshotAt":1}', '{"sha":"","refusedPaths":"nope"}']) {
    writeFileSync(join(worktreeRoot, files[0]), bad);
    const d = await broker().listChangesDetailed(KEY);
    assert.deepEqual(d.notAttributed, [], `refused to trust: ${bad.slice(0, 24)}`);
    assert.ok(Array.isArray(d.changes), "and still answers");
  }
});

test("BA-7: a missing workdir answers with the full shape, not a partial one", async () => {
  const d = await createBroker({ repoRoot, workdirFor: () => null }).listChangesDetailed("nope");
  assert.deepEqual(d, { changes: [], refused: [], notAttributed: [] });
});

test("BA-8: a PLANTED manifest beside a non-git workdir cannot silence a change", async () => {
  // The copy-sandbox road (server.mjs `sandboxDir`) is a plain directory under the OS
  // temp dir, not a checkout. If something ever managed to drop a manifest next to one,
  // there is no snapshot commit to diff against — so the broker must fall back, not
  // believe it. This is the shape of the only new trust surface 6.2 introduces.
  const sandboxRoot = join(root, "sandboxes");
  const work = join(sandboxRoot, "agent1");
  mkdirSync(join(work, "src"), { recursive: true });
  writeFileSync(join(work, AGENT), "export const agent = true;\n");
  writeFileSync(
    join(sandboxRoot, ".ma-manifest.agent1.json"),
    JSON.stringify({ sha: "0".repeat(40), refusedPaths: [AGENT], snapshotAt: Date.now() }),
  );
  const d = await createBroker({ repoRoot, workdirFor: () => work, scrub: (s) => s }).listChangesDetailed("agent1");
  assert.deepEqual(d.changes.map((c) => c.path), [AGENT], "the agent's write survives a planted baseline");
  assert.deepEqual(d.notAttributed, [], "…and nothing was attributed away on a manifest git cannot corroborate");
});
