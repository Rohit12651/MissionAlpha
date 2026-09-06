// Phase 11 · task 11.3 — SHIP: one branch per job, one commit per task.
//
// BOSS-approved 2026-09-05 (.planning/phases/11-review-ship/PR-LADDER-EDITS.md, Option A).
// pr.mjs is CORE_GUARD and this is its second outbound shape, so every assertion below is
// about the BOUND, not the feature: which ref is written, which paths reach a commit, and
// whether the operator's own tree and index survive untouched.
//
// The decisive constraint, measured before any of this was written: broker.applyChanges copies
// into repoRoot — the OPERATOR'S working tree — and never runs `git add`. That is why
// `write-tree == HEAD^{tree}` has held all session. Committing from there would require
// staging, so ship uses its OWN worktree and never touches the operator's at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { execFileSync, execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPr } from "../pr.mjs";
import { createWorktreeMgr } from "../worktree.mjs";

function realGit(bin, args, opts = {}) {
  try {
    return { ok: true, stdout: String(execFileSync(bin, args, { cwd: opts.cwd, encoding: "utf-8" }) || ""), stderr: "" };
  } catch (e) {
    return { ok: false, stdout: String(e.stdout || ""), stderr: String(e.stderr || e.message) };
  }
}
const ghAbsent = { run: (bin, args, opts) => (bin === "gh" ? { ok: false, stdout: "", stderr: "gh: not found" } : realGit(bin, args, opts)) };
const ghOk = {
  run: (bin, args, opts) => {
    if (bin === "gh" && args[0] === "auth") return { ok: true, stdout: "Logged in", stderr: "" };
    if (bin === "gh" && args[0] === "pr") return { ok: true, stdout: "https://github.com/acme/app/pull/7\n", stderr: "" };
    return realGit(bin, args, opts);
  },
};

/** Runs a real subprocess — the `git` half of a partly-faked gh runner. */
function execRun(bin, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, { ...opts, shell: false, encoding: "utf-8", timeout: 30_000 },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || ""), stderr: String(stderr || "") }));
  });
}

function scaffold({ withRemote = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ma-job-"));
  const repoRoot = join(root, "repo");
  mkdirSync(repoRoot, { recursive: true });
  const g = (args, cwd = repoRoot) => execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.email", "t@t.t"]); g(["config", "user.name", "t"]);
  mkdirSync(join(repoRoot, "src"));
  writeFileSync(join(repoRoot, "src", "a.ts"), "old-a\n");
  writeFileSync(join(repoRoot, "src", "b.ts"), "old-b\n");
  writeFileSync(join(repoRoot, "package.json"), JSON.stringify({ name: "x", scripts: { build: "tsc" } }, null, 2) + "\n");
  g(["add", "-A"]); g(["commit", "-q", "-m", "init"]);
  if (withRemote) {
    const bare = join(root, "remote.git");
    execFileSync("git", ["init", "-q", "--bare", bare]);
    g(["remote", "add", "origin", bare]);
  }
  const wt = createWorktreeMgr({ repoRoot, worktreeRoot: join(root, "wt") });
  const pr = createPr({ repoRoot, worktreeMgr: wt, audit: () => {}, gh: ghOk, scrub: (s) => s, allowed: (p) => !p.startsWith("agent-runtime/") });
  return { root, repoRoot, wt, g, pr, baseSha: g(["rev-parse", "HEAD"]) };
}

/** A task worktree whose seat changed `paths`, plus one file it must NOT be able to sneak. */
function taskWith(s, taskId, edits) {
  const path = s.wt.create(taskId).path ?? s.wt.pathFor(taskId);
  for (const [rel, body] of Object.entries(edits)) writeFileSync(join(path, rel), body);
  return path;
}

test("PJB-1: the job branch is created at the base sha, in its OWN worktree", async () => {
  const s = scaffold();
  const r = await s.pr.createJobBranch("job_abc123", s.baseSha);
  assert.ok(r.ok, r.reason);
  assert.equal(r.branch, "ma/job/job_abc123");
  assert.ok(existsSync(r.worktree), "no worktree was created for the job");
  assert.equal(execFileSync("git", ["-C", r.worktree, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim(), s.baseSha);
});

test("PJB-2: a jobId outside the allow-list is refused before git runs", async () => {
  const s = scaffold();
  // `main` is NOT in this list: a jobId of "main" yields the branch `ma/job/main`, which is
  // namespaced and cannot collide with the real `main`. The hazard is ESCAPING the namespace
  // or smuggling shell/path syntax, not the word itself — asserting otherwise would have been
  // a test of a danger that does not exist.
  for (const bad of ["../../etc", "job with spaces", "job;rm -rf /", "", "JOB_UPPER", "job/../../x", ".."]) {
    const r = await s.pr.createJobBranch(bad, s.baseSha);
    assert.equal(r.ok, false, `createJobBranch accepted ${JSON.stringify(bad)}`);
  }
});

test("PJB-3: an existing job branch is refused by OUR check, not just by git", async () => {
  // Mutating the explicit check out did NOT fail this test at first: `git worktree add -b` also
  // refuses an existing branch, so the outcome was right for the wrong reason. Asserting the
  // REASON is what distinguishes our guard from git's — and our guard is what guarantees the
  // refusal survives a future change of git plumbing.
  const s = scaffold();
  assert.ok((await s.pr.createJobBranch("job_dup", s.baseSha)).ok);
  const again = await s.pr.createJobBranch("job_dup", s.baseSha);
  assert.equal(again.ok, false, "a second ship onto the same branch would rewrite the first");
  assert.match(again.reason, /already exists — refusing to reuse or force/,
    `refused, but by git rather than by our own check: ${again.reason}`);
});

test("PJB-11: a job worktree with something ELSE already staged aborts the commit", async () => {
  // The staged-set == approved-set assertion. Nothing reached it before: every test staged only
  // approved paths, so removing the check failed nothing. A dirty job worktree is the realistic
  // way the sets diverge, and the commit must abort rather than carry a file nobody approved.
  const s = scaffold();
  const jb = await s.pr.createJobBranch("job_drift", s.baseSha);
  writeFileSync(join(jb.worktree, "src", "b.ts"), "staged-by-something-else\n");
  execFileSync("git", ["-C", jb.worktree, "add", "--", "src/b.ts"]);

  taskWith(s, "task_d", { "src/a.ts": "new-a\n" });
  const c = await s.pr.commitTask({ jobWorktree: jb.worktree, taskId: "task_d", paths: ["src/a.ts"], message: "feat: a" });
  assert.equal(c.ok, false, "committed while an unapproved file was staged");
  assert.match(c.reason, /staged set drifted/);
  const log = execFileSync("git", ["-C", jb.worktree, "log", "--format=%H", `${s.baseSha}..HEAD`], { encoding: "utf-8" }).trim();
  assert.equal(log, "", "a commit was created despite the drift");
});

test("PJB-4: a commit carries EXACTLY the approved paths — a sneaked file never lands", async () => {
  const s = scaffold();
  const jb = await s.pr.createJobBranch("job_one", s.baseSha);
  taskWith(s, "task_1", { "src/a.ts": "new-a\n", "src/b.ts": "SNUCK IN\n" });
  const c = await s.pr.commitTask({ jobWorktree: jb.worktree, taskId: "task_1", paths: ["src/a.ts"], message: "feat: a" });
  assert.ok(c.ok, c.reason);
  const stat = execFileSync("git", ["-C", jb.worktree, "show", "--stat", "--name-only", "--format=", c.sha], { encoding: "utf-8" }).trim();
  assert.deepEqual(stat.split("\n").filter(Boolean), ["src/a.ts"], "the commit touched a path nobody approved");
  assert.equal(readFileSync(join(jb.worktree, "src", "b.ts"), "utf-8"), "old-b\n", "the sneaked file reached the job worktree");
});

test("PJB-5: two tasks → TWO commits on ONE branch, each carrying its own files", async () => {
  const s = scaffold();
  const jb = await s.pr.createJobBranch("job_two", s.baseSha);
  taskWith(s, "task_a", { "src/a.ts": "from-a\n" });
  taskWith(s, "task_b", { "src/b.ts": "from-b\n" });
  const c1 = await s.pr.commitTask({ jobWorktree: jb.worktree, taskId: "task_a", paths: ["src/a.ts"], message: "feat: a" });
  const c2 = await s.pr.commitTask({ jobWorktree: jb.worktree, taskId: "task_b", paths: ["src/b.ts"], message: "feat: b" });
  assert.ok(c1.ok && c2.ok, `${c1.reason} ${c2.reason}`);
  const log = execFileSync("git", ["-C", jb.worktree, "log", "--format=%H", `${s.baseSha}..HEAD`], { encoding: "utf-8" }).trim().split("\n");
  assert.equal(log.length, 2, "one commit per task, on one branch");
  const filesOf = (sha) => execFileSync("git", ["-C", jb.worktree, "show", "--stat", "--name-only", "--format=", sha], { encoding: "utf-8" }).trim();
  assert.equal(filesOf(c1.sha), "src/a.ts");
  assert.equal(filesOf(c2.sha), "src/b.ts");
});

test("PJB-6: the OPERATOR'S working tree and index are untouched by a whole ship", async () => {
  // The must-have, and the reason Option A exists at all.
  const s = scaffold();
  const idxBefore = execFileSync("git", ["-C", s.repoRoot, "write-tree"], { encoding: "utf-8" }).trim();
  const headBefore = s.g(["rev-parse", "HEAD"]);
  const aBefore = readFileSync(join(s.repoRoot, "src", "a.ts"), "utf-8");

  const jb = await s.pr.createJobBranch("job_iso", s.baseSha);
  taskWith(s, "task_i", { "src/a.ts": "shipped\n" });
  await s.pr.commitTask({ jobWorktree: jb.worktree, taskId: "task_i", paths: ["src/a.ts"], message: "feat: a" });

  assert.equal(execFileSync("git", ["-C", s.repoRoot, "write-tree"], { encoding: "utf-8" }).trim(), idxBefore,
    "ship mutated the operator's INDEX");
  assert.equal(s.g(["rev-parse", "HEAD"]), headBefore, "ship moved the operator's HEAD");
  assert.equal(readFileSync(join(s.repoRoot, "src", "a.ts"), "utf-8"), aBefore,
    "ship wrote into the operator's WORKING TREE");
});

test("PJB-7: a path the broker would refuse never reaches a commit", async () => {
  const s = scaffold();
  const jb = await s.pr.createJobBranch("job_ref", s.baseSha);
  taskWith(s, "task_r", { "src/a.ts": "ok\n" });
  const c = await s.pr.commitTask({ jobWorktree: jb.worktree, taskId: "task_r", paths: ["agent-runtime/guards.mjs"], message: "feat: x" });
  assert.equal(c.ok, false, "a refused path produced a commit");
  assert.ok((c.refused || []).length, "the refusal was not reported");
});

test("PJB-8: gh absent → the branch stands and says so; it is never reported as a PR", async () => {
  const s = scaffold({ withRemote: true });
  const pr = createPr({ repoRoot: s.repoRoot, worktreeMgr: s.wt, audit: () => {}, gh: ghAbsent, scrub: (x) => x, allowed: () => true });
  const jb = await pr.createJobBranch("job_nogh", s.baseSha);
  taskWith(s, "task_n", { "src/a.ts": "x\n" });
  await pr.commitTask({ jobWorktree: jb.worktree, taskId: "task_n", paths: ["src/a.ts"], message: "feat: a" });
  const out = await pr.openJobPr({ jobWorktree: jb.worktree, branch: jb.branch, title: "t", body: "b" });
  assert.equal(out.mode, "branch");
  assert.equal(out.prUrl, null);
  assert.match(out.reason, /gh/i, "the operator must be told WHY there is no PR");
});

test("PJB-9: with gh present the PR is opened and its URL validated", async () => {
  const s = scaffold({ withRemote: true });
  const jb = await s.pr.createJobBranch("job_pr", s.baseSha);
  taskWith(s, "task_p", { "src/a.ts": "x\n" });
  await s.pr.commitTask({ jobWorktree: jb.worktree, taskId: "task_p", paths: ["src/a.ts"], message: "feat: a" });
  const out = await s.pr.openJobPr({ jobWorktree: jb.worktree, branch: jb.branch, title: "t", body: "b" });
  assert.equal(out.mode, "pr", out.reason);
  assert.match(out.prUrl, /^https:\/\/github\.com\//);
});

test("PJB-10: the push is never a force, and never targets another ref", async () => {
  const s = scaffold({ withRemote: true });
  const seen = [];
  const gh = { run: (bin, args, opts) => { if (bin === "git" && args.includes("push")) seen.push(args); return ghOk.run(bin, args, opts); } };
  const pr = createPr({ repoRoot: s.repoRoot, worktreeMgr: s.wt, audit: () => {}, gh, scrub: (x) => x, allowed: () => true });
  const jb = await pr.createJobBranch("job_push", s.baseSha);
  taskWith(s, "task_z", { "src/a.ts": "x\n" });
  await pr.commitTask({ jobWorktree: jb.worktree, taskId: "task_z", paths: ["src/a.ts"], message: "feat: a" });
  await pr.openJobPr({ jobWorktree: jb.worktree, branch: jb.branch, title: "t", body: "b" });
  for (const args of seen) {
    assert.ok(!args.some((a) => /^(-f|--force|--force-with-lease)$/.test(a)), `force push: ${args.join(" ")}`);
    assert.ok(args.includes(jb.branch), `pushed a ref that is not the job branch: ${args.join(" ")}`);
  }
});

test("PJB-12: the job worktree lives under the WORKTREE ROOT, never beside the repo", async () => {
  // Found by the LIVE run. The fallback was `dirname(repoRoot)`, so with a worktree manager
  // that exposes its root as a VALUE (it does — `worktreeRoot`) rather than a function, the
  // job checkout was created at `~/Downloads/WaahyuFOLDER/job_<id>` — outside the repo,
  // alongside the operator's OTHER projects. It worked, and it put a git worktree somewhere
  // nobody would look for it or clean it up.
  const s2 = scaffold();
  const jb = await s2.pr.createJobBranch("job_where", s2.baseSha);
  assert.ok(jb.ok, jb.reason);
  assert.ok(jb.worktree.startsWith(s2.wt.worktreeRoot),
    `job worktree escaped the worktree root:\n  got  ${jb.worktree}\n  root ${s2.wt.worktreeRoot}`);
});

test("PJB-13: with no worktree root to use, it REFUSES rather than guessing a directory", async () => {
  const s3 = scaffold();
  const pr = createPr({ repoRoot: s3.repoRoot, worktreeMgr: { pathFor: () => null }, audit: () => {}, gh: ghOk, scrub: (x) => x, allowed: () => true });
  const r = await pr.createJobBranch("job_noroot", s3.baseSha);
  assert.equal(r.ok, false, "guessing a location is how a worktree ends up next to the operator's other repos");
  assert.match(r.reason, /worktree root/i);
});

// ── Phase 14 — `mode: "branch"` means four different things ──────────────────
//
// MEASURED LIVE, with a real authenticated `gh` and a local bare repo as origin: the push
// SUCCEEDED (the branch reached origin at the same sha) and `gh pr create` then failed because
// the remote is not a GitHub host. The result read `mode: "branch"` — the same word returned
// when there is no remote at all and nothing ever left this machine.
//
// The `reason` was honest; the mode was ambiguous, and "are these commits published?" is not a
// question an operator should have to parse an error string to answer. `pushed` answers it.
test("PJB-14: a push that lands before the PR fails is REPORTED as pushed", async () => {
  const s = scaffold({ withRemote: true });
  // gh authenticates, git pushes for real, then `gh pr create` refuses — exactly the live shape.
  //
  // DISPATCH ON THE BINARY. `gitPush` routes through this SAME injected runner (it is the one
  // seam for every subprocess here), so a fake that keys off `args[0]` refuses the push too and
  // the test then measures the wrong rung. The first cut of this did exactly that.
  const ghPushNoPr = {
    run: async (bin, args, opts) => {
      if (bin === "git") return execRun("git", args, opts);
      return args[0] === "auth"
        ? { ok: true, stdout: "Logged in", stderr: "" }
        : { ok: false, stdout: "", stderr: "none of the git remotes point to a known GitHub host" };
    },
  };
  const pr = createPr({ repoRoot: s.repoRoot, worktreeMgr: s.wt, audit: () => {}, gh: ghPushNoPr, scrub: (x) => x, allowed: () => true });
  const jb = await pr.createJobBranch("job_pushed", s.baseSha);
  taskWith(s, "task_p", { "src/a.ts": "x\n" });
  await pr.commitTask({ jobWorktree: jb.worktree, taskId: "task_p", paths: ["src/a.ts"], message: "feat: a" });
  const out = await pr.openJobPr({ jobWorktree: jb.worktree, branch: jb.branch, title: "t", body: "b" });

  assert.equal(out.mode, "branch", "no PR opened, so it is not a PR");
  assert.equal(out.prUrl, null);
  assert.equal(out.pushed, true, "the commits ARE on the operator's remote and the report must say so");
});

test("PJB-15: the never-left-this-machine cases are NOT reported as pushed", async () => {
  const s = scaffold({ withRemote: true });
  const pr = createPr({ repoRoot: s.repoRoot, worktreeMgr: s.wt, audit: () => {}, gh: ghAbsent, scrub: (x) => x, allowed: () => true });
  const jb = await pr.createJobBranch("job_nopush", s.baseSha);
  taskWith(s, "task_q", { "src/a.ts": "x\n" });
  await pr.commitTask({ jobWorktree: jb.worktree, taskId: "task_q", paths: ["src/a.ts"], message: "feat: a" });
  const out = await pr.openJobPr({ jobWorktree: jb.worktree, branch: jb.branch, title: "t", body: "b" });
  assert.equal(out.mode, "branch");
  assert.ok(!out.pushed, "gh was unavailable, so nothing was pushed — claiming otherwise is the lie this guards");
});
