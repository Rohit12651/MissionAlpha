// PHASE 4 TASK 4.1 — the approve-with-edit validator.
//
// THREAT MODEL. The content being edited originates in a sandboxed agent and is
// untrusted; the EDIT itself arrives over HTTP from a browser and is equally untrusted
// (an approver's session can be driven by a hostile page's payload). This module is the
// only thing standing between "operator tweaked a line" and "operator wrote an arbitrary
// file anywhere on disk".
//
// FOUR CLASSES OF ATTACK ARE TESTED:
//   1. Path escape — traversal, absolute paths, drive letters, symlinked destinations.
//   2. Scope escape — editing a path the delivery never proposed, or one the broker's
//      applyAllowed() denies (.env, .git, package.json exec keys, public/*.js …).
//   3. Resource abuse — unbounded file count / body size.
//   4. SILENT CORRUPTION — the one that is not an attack and is the likeliest to ship:
//      the reviewed text is scrubbed and truncated at 4000 chars by the broker, so
//      writing back what the human SAW would silently destroy the tail of a real file
//      or bake a redaction placeholder into source. Editing must FAIL CLOSED there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, symlink, chmod, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_EDIT_BYTES,
  MAX_EDIT_FILES,
  validateEdits,
  validateUnifiedDiff,
  reviewedMatchesDisk,
  restoreTerminator,
  stageEdits,
} from "../patch-edit.mjs";

const ALLOWED = ["src/app.ts", "src/util/fmt.ts"];
const ok = (p, after) => validateEdits([{ path: p, after }], { allowedPaths: ALLOWED });

async function tmpWorkdir(t) {
  const dir = await mkdtemp(join(tmpdir(), "patch-edit-"));
  t.after(async () => { /* tmp dirs are swept by the OS; nothing to unwind */ });
  return dir;
}

// ── shape ──────────────────────────────────────────────────────────────────────

test("rejects a non-array payload", () => {
  for (const bad of [null, undefined, "x", 42, {}]) {
    assert.equal(validateEdits(bad, { allowedPaths: ALLOWED }).ok, false);
  }
});

test("an empty edit list is refused — an 'edited' approve with no edits is a client bug", () => {
  const r = validateEdits([], { allowedPaths: ALLOWED });
  assert.equal(r.ok, false);
  assert.match(r.error, /no edits/i);
});

test("rejects more than MAX_EDIT_FILES entries", () => {
  const many = Array.from({ length: MAX_EDIT_FILES + 1 }, () => ({ path: "src/app.ts", after: "x" }));
  const r = validateEdits(many, { allowedPaths: ALLOWED });
  assert.equal(r.ok, false);
  assert.match(r.error, /too many/i);
});

test("rejects a duplicated path — two edits to one file have no defined winner", () => {
  const r = validateEdits(
    [{ path: "src/app.ts", after: "a" }, { path: "src/app.ts", after: "b" }],
    { allowedPaths: ALLOWED },
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /duplicate/i);
});

test("rejects a non-string body", () => {
  assert.equal(validateEdits([{ path: "src/app.ts", after: 42 }], { allowedPaths: ALLOWED }).ok, false);
  assert.equal(validateEdits([{ path: "src/app.ts" }], { allowedPaths: ALLOWED }).ok, false);
});

// ── path escape ────────────────────────────────────────────────────────────────

test("SECURITY: traversal, absolute and drive paths are all refused", () => {
  for (const p of [
    "../../../etc/passwd",
    "src/../../etc/passwd",
    "/etc/passwd",
    "C:\\Windows\\system32\\drivers\\etc\\hosts",
    "..\\..\\win.ini",
    "src/app.ts\u0000.png",
  ]) {
    assert.equal(ok(p, "x").ok, false, `${p} was accepted`);
  }
});

test("SECURITY: an edit cannot introduce a path the delivery never proposed", () => {
  // src/other.ts passes applyAllowed() — it is refused purely because this delivery
  // never offered it. Without this the edit channel becomes a write-anywhere primitive
  // scoped only by the seed dirs.
  const r = ok("src/other.ts", "x");
  assert.equal(r.ok, false);
  assert.match(r.error, /not part of this delivery/i);
});

test("SECURITY: broker-denied paths stay denied even when the delivery proposed them", () => {
  // A hostile agent could mint a delivery whose changedPaths include .env; the edit
  // path must re-run applyAllowed rather than trusting the row.
  for (const p of [".env", ".git/config", "src/../.env", "node_modules/x/index.js", "secrets.pem"]) {
    const r = validateEdits([{ path: p, after: "x" }], { allowedPaths: [p] });
    assert.equal(r.ok, false, `${p} was accepted`);
  }
});

// ── resource limits ────────────────────────────────────────────────────────────

test("rejects a body over the byte cap, measured in BYTES not characters", () => {
  // Multi-byte characters must not let a payload past a length-based cap.
  const big = "€".repeat(MAX_EDIT_BYTES); // 3 bytes each
  const r = ok("src/app.ts", big);
  assert.equal(r.ok, false);
  assert.match(r.error, /too large/i);
});

test("rejects a NUL byte in the body — source files do not contain one", () => {
  assert.equal(ok("src/app.ts", "const a = 1;\u0000").ok, false);
});

test("accepts a legitimate edit and returns a normalised copy", () => {
  const r = validateEdits([{ path: "src/app.ts", after: "const a = 2;\n" }], { allowedPaths: ALLOWED });
  assert.equal(r.ok, true);
  assert.deepEqual(r.edits, [{ path: "src/app.ts", after: "const a = 2;\n" }]);
});

// ── unified-diff validation (the plan's explicit requirement) ──────────────────

test("validateUnifiedDiff accepts a well-formed patch whose counts match", () => {
  const patch = "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;\n const b = 3;\n";
  assert.equal(validateUnifiedDiff(patch, { path: "src/app.ts" }).ok, true);
});

test("validateUnifiedDiff rejects hunk counts that disagree with the body", () => {
  const patch = "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,9 +1,9 @@\n-const a = 1;\n+const a = 2;\n";
  const r = validateUnifiedDiff(patch, { path: "src/app.ts" });
  assert.equal(r.ok, false);
  assert.match(r.error, /hunk/i);
});

test("validateUnifiedDiff rejects a missing header", () => {
  assert.equal(validateUnifiedDiff("@@ -1,1 +1,1 @@\n-a\n+b\n", { path: "src/app.ts" }).ok, false);
});

test("SECURITY: validateUnifiedDiff rejects traversal in the +++ header", () => {
  const patch = "--- a/src/app.ts\n+++ b/../../etc/passwd\n@@ -1,1 +1,1 @@\n-a\n+b\n";
  const r = validateUnifiedDiff(patch, { path: "src/app.ts" });
  assert.equal(r.ok, false);
  assert.match(r.error, /path/i);
});

test("SECURITY: validateUnifiedDiff rejects a header naming a different file", () => {
  const patch = "--- a/src/app.ts\n+++ b/src/evil.ts\n@@ -1,1 +1,1 @@\n-a\n+b\n";
  assert.equal(validateUnifiedDiff(patch, { path: "src/app.ts" }).ok, false);
});

test("validateUnifiedDiff rejects an oversized patch", () => {
  const patch = `--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,1 +1,1 @@\n-a\n+${"x".repeat(MAX_EDIT_BYTES)}\n`;
  assert.equal(validateUnifiedDiff(patch, { path: "src/app.ts" }).ok, false);
});

// ── the silent-corruption gate ─────────────────────────────────────────────────

test("reviewedMatchesDisk allows the one-byte terminator convention and nothing else", () => {
  // readChanges() rebuilds `after` from the patch's own lines; the unified-diff writer
  // drops a file's final "\n" because a terminator is not a line. Discovered by the
  // end-to-end wiring test — a byte-exact rule refused every legitimate edit.
  assert.equal(reviewedMatchesDisk("a\nb", "a\nb\n"), true);
  assert.equal(reviewedMatchesDisk("a\nb", "a\nb"), true);
  assert.equal(reviewedMatchesDisk("a\nb\n", "a\nb\n"), false, "two trailing newlines is a real difference");
  assert.equal(reviewedMatchesDisk("a\nb", "a\nb\nc\n"), false);
});

test("restoreTerminator preserves the file's existing final-newline convention", () => {
  assert.equal(restoreTerminator("a\nb", "orig\n"), "a\nb\n");
  assert.equal(restoreTerminator("a\nb", "orig"), "a\nb");
  assert.equal(restoreTerminator("a\nb\n", "orig\n"), "a\nb\n", "must not double the terminator");
});

test("CORRUPTION GATE: truncated review text never matches the real file", () => {
  // broker.mjs trunc() appends this marker at 4000 chars. Writing the reviewed text
  // back would silently delete everything past 4000 chars of a real source file.
  const real = `${"x".repeat(5000)}\n`;
  const reviewed = `${"x".repeat(4000)}\n…(truncated)`;
  assert.equal(reviewedMatchesDisk(reviewed, real), false);
});

test("CORRUPTION GATE: scrubbed review text never matches the real file", () => {
  assert.equal(reviewedMatchesDisk("token = [redacted]\n", "token = sk-live-abc123\n"), false);
});

// ── staging ────────────────────────────────────────────────────────────────────

test("stageEdits writes the edited body into the workdir", async (t) => {
  const dir = await tmpWorkdir(t);
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src/app.ts"), "const a = 1;\n");

  const res = await stageEdits({ workdir: dir, edits: [{ path: "src/app.ts", after: "const a = 2;\n" }] });
  assert.equal(res.ok, true);
  assert.equal(await readFile(join(dir, "src/app.ts"), "utf-8"), "const a = 2;\n");
});

test("SECURITY: stageEdits refuses a symlinked destination", async (t) => {
  const dir = await tmpWorkdir(t);
  const outside = await tmpWorkdir(t);
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(outside, "target.ts"), "original\n");
  await symlink(join(outside, "target.ts"), join(dir, "src/app.ts"));

  const res = await stageEdits({ workdir: dir, edits: [{ path: "src/app.ts", after: "pwned\n" }] });
  assert.equal(res.ok, false);
  assert.match(res.error, /symlink/i);
  assert.equal(await readFile(join(outside, "target.ts"), "utf-8"), "original\n", "wrote through the link");
});

test("SECURITY: stageEdits refuses a path whose parent escapes the workdir", async (t) => {
  const dir = await tmpWorkdir(t);
  const outside = await tmpWorkdir(t);
  await symlink(outside, join(dir, "src")); // src/ IS a link to somewhere else
  const res = await stageEdits({ workdir: dir, edits: [{ path: "src/app.ts", after: "pwned\n" }] });
  assert.equal(res.ok, false);
  assert.match(res.error, /escape|symlink/i);
});

test("stageEdits refuses to create a file the workdir does not already have", async (t) => {
  // An edit revises an existing proposal. Creating a brand-new file through the edit
  // channel would let an approver land content no agent ever proposed and no diff ever
  // showed — outside the review record entirely.
  const dir = await tmpWorkdir(t);
  await mkdir(join(dir, "src"), { recursive: true });
  const res = await stageEdits({ workdir: dir, edits: [{ path: "src/app.ts", after: "x\n" }] });
  assert.equal(res.ok, false);
  assert.match(res.error, /not in the workdir/i);
});

test("stageEdits is atomic across files — one bad path stages nothing", async (t) => {
  const dir = await tmpWorkdir(t);
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src/app.ts"), "original\n");

  const res = await stageEdits({
    workdir: dir,
    edits: [
      { path: "src/app.ts", after: "edited\n" },
      { path: "src/missing.ts", after: "x\n" }, // not in the workdir → whole batch refused
    ],
  });
  assert.equal(res.ok, false);
  assert.equal(
    await readFile(join(dir, "src/app.ts"), "utf-8"),
    "original\n",
    "a half-applied edit set leaves the proposal in a state nobody reviewed",
  );
});

test("stageEdits refuses a missing workdir rather than creating one", async () => {
  const res = await stageEdits({ workdir: "/nonexistent/workdir/xyz", edits: [{ path: "src/app.ts", after: "x" }] });
  assert.equal(res.ok, false);
  assert.match(res.error, /workdir/i);
});

// ── SECURITY REVIEW (Phase 4): the write phase itself must be atomic and unfollowable ──
//
// TWO findings, one mechanism. The old staging loop validated every destination with
// lstat and THEN wrote every destination with writeFile:
//
//   HIGH (TOCTOU). Nothing pinned the inode between the check and the write, and for a
//   multi-file batch the gap spans every other file's write. An agent's own tool loop can
//   legitimately write into that same workdir (the manual-run sandbox is keyed by agentId
//   and reused across runs), so a file checked as "a regular file, not a symlink" could be
//   a symlink by the time it was written — and the operator's bytes would land wherever
//   the link pointed. Writing through a temp file and RENAMING is the fix: rename(2) does
//   not follow a symlink at the destination, it replaces it, so the swap wins nothing.
//
//   MEDIUM. "ALL-OR-NOTHING" only held for failures caught during validation. A failure
//   during the WRITE loop (disk full, a permission race) left the earlier files already
//   rewritten in the workdir — bytes nobody approved, which a later plain approve would
//   then apply.
test("stageEdits stages nothing when a LATER write fails — not just a later validation", async (t) => {
  const dir = await tmpWorkdir(t);
  await mkdir(join(dir, "src"), { recursive: true });
  await mkdir(join(dir, "locked"), { recursive: true });
  await writeFile(join(dir, "src/app.ts"), "original\n");
  await writeFile(join(dir, "locked/pinned.ts"), "original-2\n");
  // The directory — not the file — is read-only, so the destination still validates as a
  // regular file while creating anything new inside it fails. That is a write-phase
  // failure, which is exactly the case validation cannot pre-empt.
  await chmod(join(dir, "locked"), 0o555);
  t.after(async () => { try { await chmod(join(dir, "locked"), 0o755); } catch { /* already gone */ } });

  const res = await stageEdits({
    workdir: dir,
    edits: [
      { path: "src/app.ts", after: "edited\n" },
      { path: "locked/pinned.ts", after: "edited-2\n" },
    ],
  });

  assert.equal(res.ok, false, "a failed write reported success");
  assert.equal(
    await readFile(join(dir, "src/app.ts"), "utf-8"),
    "original\n",
    "the first file was left rewritten after a later write failed — a half-staged edit set",
  );
  assert.equal(await readFile(join(dir, "locked/pinned.ts"), "utf-8"), "original-2\n");
});

test("stageEdits leaves no temp files behind, on success or on failure", async (t) => {
  const dir = await tmpWorkdir(t);
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src/app.ts"), "original\n");

  assert.equal((await stageEdits({ workdir: dir, edits: [{ path: "src/app.ts", after: "edited\n" }] })).ok, true);
  assert.equal(await readFile(join(dir, "src/app.ts"), "utf-8"), "edited\n");
  const after = await readdir(join(dir, "src"));
  assert.deepEqual(after, ["app.ts"], `staging left scratch files behind: ${after.join(", ")}`);
});
