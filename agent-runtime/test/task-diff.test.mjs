// Phase C · task 10 — WHAT THE REVIEW TURN IS SHOWN.
//
// Probe P-F11: `git diff -- <paths>` shows neither a NEW file nor a staged-only change, so a
// task whose whole output is a new file was reviewed as an empty diff and approved on nothing.
//
// Proven against a THROWAWAY git repo in $TMPDIR. No network, no real worktree manager.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse } from "acorn";

import { taskDiff } from "../task-diff.mjs";

function repo() {
  const root = mkdtempSync(join(tmpdir(), "ma-diff-"));
  const g = (args) => execFileSync("git", args, { cwd: root, encoding: "utf-8" }).trim();
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.email", "t@t.t"]);
  g(["config", "user.name", "t"]);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "old.ts"), "one\n");
  g(["add", "-A"]); g(["commit", "-q", "-m", "init"]);
  return { root, g };
}

test("DIFF-1: a NEW untracked file appears in the diff the reviewer is shown", () => {
  // Mutation proof (2026-09-17), each reddening exactly ONE test, so none is redundant:
  //   plain `git diff -- paths` (the P-F11 shape)        → ✖ DIFF-1 (fail 1)
  //   intent-to-add written to the REAL index            → ✖ DIFF-4 (fail 1)
  //   server.mjs diffFor returns "" instead of calling   → ✖ DIFF-WIRED-1 (fail 1)
  // All restored, md5 matched, 6/6 green.
  const { root } = repo();
  writeFileSync(join(root, "src", "new.ts"), "export const x = 1;\n");
  const d = taskDiff(root, ["src/new.ts"]);
  assert.match(d, /src\/new\.ts/, "the reviewer must see the file exists");
  assert.match(d, /export const x = 1/, "and its CONTENT — a filename alone approves nothing");
});

test("DIFF-2: a staged-only change appears", () => {
  const { root, g } = repo();
  writeFileSync(join(root, "src", "old.ts"), "two\n");
  g(["add", "--", "src/old.ts"]);
  const d = taskDiff(root, ["src/old.ts"]);
  assert.match(d, /-one/);
  assert.match(d, /\+two/);
});

test("DIFF-4: the real index is NOT mutated — a diff is a read", () => {
  // `git add -N` would register intent-to-add in the worktree's own index. diffFor runs on a
  // live seat worktree; a read must not leave a mark that a later commit path can trip over.
  const { root, g } = repo();
  writeFileSync(join(root, "src", "new.ts"), "x\n");
  taskDiff(root, ["src/new.ts"]);
  const status = g(["status", "--porcelain"]);
  assert.match(status, /^\?\? src\/new\.ts$/m, "the file must still read as UNTRACKED after the diff");
  assert.equal(g(["diff", "--cached", "--name-only"]), "", "nothing may be staged by a diff");
});

test("DIFF-5: pathspec is still scoped — an unlisted file is not shown", () => {
  const { root } = repo();
  writeFileSync(join(root, "src", "new.ts"), "x\n");
  writeFileSync(join(root, "src", "secret.ts"), "SNUCK IN\n");
  const d = taskDiff(root, ["src/new.ts"]);
  assert.doesNotMatch(d, /SNUCK IN/, "the 3082-file blowup this scoping exists to prevent");
});

test("DIFF-6: a hostile pathspec is refused, not passed to git", () => {
  const { root } = repo();
  assert.equal(taskDiff(root, ["--output=/tmp/pwn"]), "");
  assert.equal(taskDiff(root, []), "");
});

test("DIFF-WIRED-1: server.mjs's diffFor actually CALLS taskDiff", () => {
  // SEAT-12's lesson, applied forward: a helper lifted out of server.mjs is only worth its
  // tests while the call site still points at it. Asserted on the AST, never on source text.
  const src = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  const ast = parse(src, { ecmaVersion: "latest", sourceType: "module" });
  let called = false;
  (function walk(n) {
    if (!n || typeof n.type !== "string" || called) return;
    if (n.type === "CallExpression" && n.callee?.name === "taskDiff") { called = true; return; }
    for (const k of Object.keys(n)) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object" && typeof v.type === "string") walk(v);
    }
  })(ast);
  assert.ok(called, "diffFor must call taskDiff — otherwise DIFF-1..6 prove nothing about the running server");
});
