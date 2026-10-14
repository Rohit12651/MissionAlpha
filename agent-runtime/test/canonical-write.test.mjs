// Phase C · task 11 — A WRITE LANDS WHERE THE SCOPE SAID, OR IT DOES NOT LAND.
//
// Codex probes P2/P3. Every writer already refuses a symlink that points OUTSIDE the repo,
// and every writer already realpath's the parent and checks it is still inside the repo.
// Neither check catches the interesting case: a symlink that points somewhere ELSE INSIDE the
// repo. `src/alias -> ../docs` resolves to <repo>/docs, which IS inside the repo, so the
// containment test passes and the write lands in docs/ — while the seat's writeScope, checked
// against the LEXICAL path src/alias/out.txt, said src/** and nothing else.
//
// Containment was never the claim worth making. The claim is that the canonical destination
// is the one the scope was checked against.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBroker } from "../broker.mjs";
import { createPr } from "../pr.mjs";
import { applyCodemod } from "../codemod.mjs";

let root, repoRoot, workdir;
const broker = () => createBroker({ repoRoot, workdirFor: () => workdir, scrub: (s) => s });

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ma-canon-")));
  repoRoot = join(root, "repo");
  workdir = join(root, "work");
  mkdirSync(join(repoRoot, "src"), { recursive: true });
  mkdirSync(join(repoRoot, "docs"), { recursive: true });
  mkdirSync(join(workdir, "src"), { recursive: true });
});
afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

test("CANON-1: a symlinked directory INSIDE the repo does not redirect a scoped write", async () => {
  // Mutation proof (2026-09-17): broker restored to `mkdir` + "realParent inside repoRoot" →
  // ✖ CANON-1 (fail 1). Restored, md5 matched.
  writeFileSync(join(repoRoot, "docs", "keep.md"), "original\n");
  symlinkSync("../docs", join(repoRoot, "src", "alias"));     // inside the repo, still a redirect
  mkdirSync(join(workdir, "src", "alias"), { recursive: true });
  writeFileSync(join(workdir, "src", "alias", "keep.md"), "OVERWRITTEN BY THE SEAT\n");

  const r = await broker().applyChanges("k", ["src/alias/keep.md"]);
  assert.equal(r[0].ok, false, `the write must be refused, got ${JSON.stringify(r[0])}`);
  assert.match(r[0].error, /symlink|canonical|scope/i, "and the refusal must name the reason");
  assert.equal(readFileSync(join(repoRoot, "docs", "keep.md"), "utf-8"), "original\n",
    "docs/ is OUTSIDE the seat's scope and must be untouched");
});

test("CANON-4 (GOOD leg): a real nested directory under scope still writes", async () => {
  mkdirSync(join(repoRoot, "src", "lib", "deep"), { recursive: true });
  mkdirSync(join(workdir, "src", "lib", "deep"), { recursive: true });
  writeFileSync(join(workdir, "src", "lib", "deep", "ok.tsx"), "export const ok = 1;\n");

  const r = await broker().applyChanges("k", ["src/lib/deep/ok.tsx"]);
  assert.equal(r[0].ok, true, `an honest nested path must still write: ${JSON.stringify(r[0])}`);
  assert.equal(readFileSync(join(repoRoot, "src", "lib", "deep", "ok.tsx"), "utf-8"), "export const ok = 1;\n");
});

test("CANON-5: the existing outside-the-repo refusal still holds (no regression)", async () => {
  const outside = join(root, "victim.txt");
  writeFileSync(outside, "victim\n");
  symlinkSync(outside, join(repoRoot, "src", "link.tsx"));
  writeFileSync(join(workdir, "src", "link.tsx"), "pwned\n");
  const r = await broker().applyChanges("k", ["src/link.tsx"]);
  assert.equal(r[0].ok, false);
  assert.equal(readFileSync(outside, "utf-8"), "victim\n");
});

test("CANON-2: commitTask does not write THROUGH a symlinked directory in the job worktree", async () => {
  // Mutation proof (2026-09-17): commitTask restored to writeFileSync(join(jobWorktree, relNorm)) →
  // ✖ CANON-2 (fail 1). Restored, md5 matched. The FIRST version of this test passed against the
  // unfixed code because jobWt was not a git repo — it refused with "no job worktree" and never
  // reached the write. Vacuous, addendum #22; the assertion below now rejects that reason.
  // commitTask copies the file BODY from the task worktree into the assembly worktree. It
  // already refuses a symlink in the SOURCE; the destination parent was never canonicalised,
  // so `jobWorktree/src/alias -> ../docs` redirected an approved src/** commit into docs/.
  const src = join(root, "task");
  const jobWt = join(root, "jobwt");
  mkdirSync(join(src, "src", "alias"), { recursive: true });
  mkdirSync(join(jobWt, "src"), { recursive: true });
  mkdirSync(join(jobWt, "docs"), { recursive: true });
  writeFileSync(join(jobWt, "docs", "keep.md"), "original\n");
  symlinkSync("../docs", join(jobWt, "src", "alias"));
  writeFileSync(join(src, "src", "alias", "keep.md"), "OVERWRITTEN\n");

  // jobWt must be a REAL git repo, or commitTask refuses with "no job worktree" and this test
  // passes without ever reaching the write — the vacuity HIRE-CORR-1 was caught on.
  const g = (args) => execFileSync("git", args, { cwd: jobWt, encoding: "utf-8" });
  g(["init", "-q", "-b", "main"]); g(["config", "user.email", "t@t.t"]); g(["config", "user.name", "t"]);
  g(["add", "-A"]); g(["commit", "-q", "-m", "init"]);

  const pr = createPr({ repoRoot, worktreeMgr: { pathFor: () => src }, applyAllowed: () => true, scrub: (x) => x });
  const out = await pr.commitTask({ jobWorktree: jobWt, taskId: "t1", paths: ["src/alias/keep.md"], message: "m" });

  assert.equal(out.ok, false, `must refuse: ${JSON.stringify(out)}`);
  assert.doesNotMatch(String(out.reason), /no job worktree/,
    "refused for the WRONG reason — the test never reached the write path");
  assert.equal(readFileSync(join(jobWt, "docs", "keep.md"), "utf-8"), "original\n",
    "docs/ was never approved and must be untouched");
});

test("CANON-3: a codemod does not write THROUGH a symlinked parent", async () => {
  // Mutation proof (2026-09-17): removed the canonical check from applyCodemod →
  // ✖ CANON-3 (fail 1), filesChanged:1 into docs/. Restored, md5 matched.
  const wd = join(root, "cm");
  mkdirSync(join(wd, "src"), { recursive: true });
  mkdirSync(join(wd, "docs"), { recursive: true });
  writeFileSync(join(wd, "docs", "victim.ts"), "var a = 1;\n");
  symlinkSync("../docs", join(wd, "src", "alias"));

  const before = readFileSync(join(wd, "docs", "victim.ts"), "utf-8");
  const r = await applyCodemod({ workdir: wd, intent: "var-to-const", files: ["src/alias/victim.ts"] });
  assert.equal(readFileSync(join(wd, "docs", "victim.ts"), "utf-8"), before,
    `docs/ is outside the codemod's path and must be untouched: ${JSON.stringify(r)}`);
});
