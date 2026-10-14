// Open MEDIUM from the Phase E security pass — `gh pr create` runs its OWN git commands.
//
// Every git the ladder runs directly carries GIT_SAFE_ARGS (`-c core.fsmonitor=`, `-c
// core.hooksPath=/dev/null`, …), because a worktree of an archive-sourced repo can carry
// `core.fsmonitor=<cmd>` in `.git/config` and git EXECUTES it on status/diff/add. `gh` spawns git
// itself, without those flags. Whether `gh pr create` reaches a status call could not be proven
// without a real GitHub credential (the probe stopped at 401), so this closes the class instead:
// the runner's ENVIRONMENT carries the same config as GIT_CONFIG_COUNT/KEY/VALUE, which git
// honours at command-line precedence — so any git started by anything the runner starts is
// hardened, gh's included.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, existsSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultRunner } from "../pr.mjs";

function trappedRepo() {
  const dir = mkdtempSync(join(tmpdir(), "ma-fsmon-"));
  const g = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf-8" });
  g(["init", "-q"]); g(["config", "user.email", "t@t.t"]); g(["config", "user.name", "t"]);
  writeFileSync(join(dir, "a.txt"), "a"); g(["add", "-A"]); g(["commit", "-qm", "init"]);
  writeFileSync(join(dir, "dirty.txt"), "x");
  const marker = join(dir, "FSMONITOR_FIRED");
  const hook = join(dir, "..", `${dir.split("/").pop()}-hook.sh`);
  writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`); chmodSync(hook, 0o755);
  g(["config", "core.fsmonitor", hook]);
  return { dir, marker };
}

test("PR-GITENV-0 (premise): the trap is real — a plain `git status` in that repo runs the planted command", () => {
  const r = trappedRepo();
  execFileSync("git", ["status", "--porcelain"], { cwd: r.dir });
  assert.ok(existsSync(r.marker), "without this, the tests below prove nothing");
});

test("PR-GITENV-1: a git the RUNNER starts does not run the repo's fsmonitor", async () => {
  const r = trappedRepo();
  const out = await defaultRunner().run("git", ["status", "--porcelain"], { cwd: r.dir });
  assert.ok(out.ok, out.stderr);
  assert.equal(existsSync(r.marker), false, "the runner's git executed the repo's core.fsmonitor");
});

test("PR-GITENV-2: a git started by a CHILD of the runner (how gh works) is hardened too", async () => {
  const r = trappedRepo();
  const fakeGh = join(r.dir, "..", `${r.dir.split("/").pop()}-gh.sh`);
  writeFileSync(fakeGh, "#!/bin/sh\ngit status --porcelain >/dev/null 2>&1\necho done\n"); chmodSync(fakeGh, 0o755);
  rmSync(r.marker, { force: true });
  const out = await defaultRunner().run(fakeGh, [], { cwd: r.dir });
  assert.ok(out.ok, out.stderr);
  assert.equal(existsSync(r.marker), false, "gh's own git would have executed the repo's core.fsmonitor");
});

test("PR-GITENV-3: a child's git does not run the repo's own hooks either (core.hooksPath)", async () => {
  const r = trappedRepo();
  const hookMarker = join(r.dir, "HOOK_FIRED");
  writeFileSync(join(r.dir, ".git", "hooks", "pre-commit"), `#!/bin/sh\ntouch '${hookMarker}'\n`);
  chmodSync(join(r.dir, ".git", "hooks", "pre-commit"), 0o755);
  execFileSync("git", ["-c", "core.fsmonitor=", "commit", "--allow-empty", "-qm", "premise"], { cwd: r.dir });
  assert.ok(existsSync(hookMarker), "premise: the planted hook runs on a plain commit");
  rmSync(hookMarker, { force: true });
  const fakeGh = join(r.dir, "..", `${r.dir.split("/").pop()}-gh2.sh`);
  writeFileSync(fakeGh, "#!/bin/sh\ngit commit --allow-empty -qm via-child\necho done\n"); chmodSync(fakeGh, 0o755);
  const out = await defaultRunner().run(fakeGh, [], { cwd: r.dir });
  assert.ok(out.ok, out.stderr);
  assert.equal(existsSync(hookMarker), false, "a child's git ran the repo's pre-commit hook");
});
