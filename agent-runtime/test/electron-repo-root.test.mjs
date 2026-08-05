// sr-security P5 re-review — BLOCKER #3: the Electron `ma:set-repo-root` gate.
//
// The IPC handler used to accept ANY existing path, and the RUNTIME_REPO_ROOT it
// pins outranks the validated persisted config (guards.mjs L39-41). setRepoRoot("/")
// therefore made the whole filesystem the apply-broker's target on the next
// supervisor restart. main.cjs now routes the choice through the runtime's OWN
// validateWorkspace and uses ONLY the repoPath that comes back.
//
// The gate lives in electron/repo-root-guard.cjs precisely so it is testable without
// booting Electron — this file exercises the exact function main.cjs calls. It sits
// under agent-runtime/test/ because that is the `npm run test:runtime` glob.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir, homedir } from "node:os";
import guard from "../../electron/repo-root-guard.cjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = join(__dir, "..", "workspace.mjs");
const check = (p) => guard.validateRepoRoot(p, WORKSPACE);

test("#3 setRepoRoot('/') is REJECTED (was: pins the whole filesystem as REPO_ROOT)", async () => {
  const r = await check("/");
  assert.equal(r.ok, false);
  assert.match(r.error, /filesystem root/i);
});

test("#3 setRepoRoot($HOME) is REJECTED (~/.ssh, ~/.aws, ~/.claude stay out of scope)", async () => {
  const r = await check(homedir());
  assert.equal(r.ok, false);
  assert.match(r.error, /home directory/i);
});

test("#3 a parent of $HOME and a non-git folder are REJECTED too", async () => {
  assert.equal((await check(dirname(homedir()))).ok, false);
  assert.equal((await check(mkdtempSync(join(tmpdir(), "ma-el-plain-")))).ok, false);
});

test("#3 empty / non-string / non-existent input is REJECTED without throwing", async () => {
  for (const bad of ["", "   ", null, undefined, 42, {}, join(tmpdir(), "no-such-dir-el-xyz")]) {
    const r = await check(bad);
    assert.equal(r.ok, false, `must refuse ${JSON.stringify(bad)}`);
    assert.equal(typeof r.error, "string");
  }
});

test("#3 a valid throwaway git repo is ACCEPTED and returns the VALIDATED realpath", async () => {
  const box = realpathSync(mkdtempSync(join(tmpdir(), "ma-el-repo-")));
  const repo = join(box, "project");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  const r = await check(repo);
  assert.equal(r.ok, true);
  assert.equal(r.repoPath, realpathSync(repo), "main persists the validator's realpath, never the raw input");
});

test("#3 the gate fails CLOSED when the validator module cannot be loaded", async () => {
  const r = await guard.validateRepoRoot("/tmp", join(__dir, "no-such-workspace-module.mjs"));
  assert.equal(r.ok, false);
  assert.match(r.error, /validator unavailable/i);
});
