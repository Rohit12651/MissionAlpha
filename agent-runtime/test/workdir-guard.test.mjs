// PHASE 1 TASK 1.2 — the workdir containment guard, shared by BOTH write paths.
//
// WHY THIS MODULE EXISTS AT ALL. Phase 1 gives a third-party model a tool loop that can
// write files. The plan's rule is "the tools are the EXISTING ones, against the SAME
// workdir and the SAME guards — no second write path". The containment logic was private
// to patch-edit.mjs (`safeDest`), where it protects an OPERATOR's edit of a delivery. If
// the executor had grown its own copy, the two would drift, and the copy protecting the
// untrusted-model path is the worse one to have drift.
//
// So the logic is extracted here verbatim and imported by both. patch-edit.mjs's own 27
// tests are the regression proof that the extraction changed nothing.
//
// The ONE difference the executor needs is `allowCreate`: an operator may only REVISE a
// file the agent already proposed, but an agent must be able to create a new one. That is
// a parameter, not a fork — every containment rule still applies to a created path, and
// the tests below assert exactly that.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveWorkdirDest } from "../workdir-guard.mjs";

function wd() {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "ma-wg-")));
  writeFileSync(join(d, "existing.txt"), "hello\n");
  mkdirSync(join(d, "src"), { recursive: true });
  writeFileSync(join(d, "src", "app.ts"), "export {}\n");
  return d;
}
const clean = (d) => rmSync(d, { recursive: true, force: true });

async function resolve(root, rel, opts = {}) {
  return resolveWorkdirDest({ workdir: root, realRoot: root, rel, ...opts });
}

test("an existing regular file inside the workdir resolves", async () => {
  const d = wd();
  try {
    const r = await resolve(d, "existing.txt");
    assert.equal(r.ok, true);
    assert.equal(r.dest, join(d, "existing.txt"));
  } finally { clean(d); }
});

test("a nested existing file resolves", async () => {
  const d = wd();
  try {
    assert.equal((await resolve(d, "src/app.ts")).ok, true);
  } finally { clean(d); }
});

test("traversal out of the workdir is refused", async () => {
  const d = wd();
  try {
    for (const rel of ["../escape.txt", "src/../../escape.txt", "/etc/passwd"]) {
      const r = await resolve(d, rel, { allowCreate: true });
      assert.equal(r.ok, false, `${rel} was allowed`);
      assert.match(String(r.error), /workdir/i);
    }
  } finally { clean(d); }
});

test("a SYMLINKED FILE destination is refused — never write through a link", async () => {
  const d = wd();
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "ma-wg-out-")));
  try {
    writeFileSync(join(outside, "target.txt"), "victim\n");
    symlinkSync(join(outside, "target.txt"), join(d, "link.txt"));
    const r = await resolve(d, "link.txt");
    assert.equal(r.ok, false);
    assert.match(String(r.error), /symlink/i);
  } finally { clean(d); clean(outside); }
});

test("a SYMLINKED PARENT DIRECTORY is refused — the escape the literal path hides", async () => {
  // The path looks contained; the parent resolves elsewhere. This is the case that a
  // naive startsWith() check passes and that realpath'ing the parent catches.
  const d = wd();
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "ma-wg-out2-")));
  try {
    mkdirSync(join(outside, "real"), { recursive: true });
    writeFileSync(join(outside, "real", "f.txt"), "victim\n");
    symlinkSync(join(outside, "real"), join(d, "linkdir"));
    const r = await resolve(d, "linkdir/f.txt", { allowCreate: true });
    assert.equal(r.ok, false);
    assert.match(String(r.error), /symlink|workdir/i);
  } finally { clean(d); clean(outside); }
});

test("a MISSING file is refused without allowCreate — the operator-edit contract", async () => {
  const d = wd();
  try {
    const r = await resolve(d, "brand-new.txt");
    assert.equal(r.ok, false, "an operator may only revise a file the agent proposed");
  } finally { clean(d); }
});

test("a MISSING file is allowed WITH allowCreate — the agent-tool contract", async () => {
  const d = wd();
  try {
    const r = await resolve(d, "brand-new.txt", { allowCreate: true });
    assert.equal(r.ok, true);
    assert.equal(r.dest, join(d, "brand-new.txt"));
  } finally { clean(d); }
});

test("allowCreate creates missing intermediate directories INSIDE the workdir", async () => {
  const d = wd();
  try {
    const r = await resolve(d, "a/b/c/deep.txt", { allowCreate: true });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.dest, join(d, "a/b/c/deep.txt"));
  } finally { clean(d); }
});

test("allowCreate STILL refuses traversal through not-yet-existing directories", async () => {
  // The dangerous case: the parent does not exist, so there is nothing to realpath. The
  // guard must reason about the literal path before creating anything.
  const d = wd();
  try {
    const r = await resolve(d, "a/../../escape/deep.txt", { allowCreate: true });
    assert.equal(r.ok, false);
  } finally { clean(d); }
});

test("allowCreate refuses to create THROUGH a symlinked ancestor", async () => {
  const d = wd();
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "ma-wg-out3-")));
  try {
    symlinkSync(outside, join(d, "linkdir"));
    const r = await resolve(d, "linkdir/new/deep.txt", { allowCreate: true });
    assert.equal(r.ok, false, "created a file through a symlinked ancestor");
  } finally { clean(d); clean(outside); }
});

test("a directory destination is refused", async () => {
  const d = wd();
  try {
    const r = await resolve(d, "src");
    assert.equal(r.ok, false);
    assert.match(String(r.error), /regular file/i);
  } finally { clean(d); }
});

test("failures carry a code and the offending path for UI binding", async () => {
  const d = wd();
  try {
    const r = await resolve(d, "../escape.txt");
    assert.equal(r.ok, false);
    assert.equal(typeof r.code, "number");
    assert.equal(r.path, "../escape.txt");
  } finally { clean(d); }
});
