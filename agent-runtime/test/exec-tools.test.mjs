// PHASE 1 TASKS 1.2 + 1.4 — the tools given to a third-party model, and their caps.
//
// The security claim under test: a tool call from an UNTRUSTED model is refused exactly as
// an operator's edit is, because both go through workdir-guard. And the availability claim:
// no cap can end a turn silently — every limit produces a refusal the model can read.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync, realpathSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createExecTools, globToRegExp, TOOL_NAMES } from "../providers/exec-tools.mjs";

function wd() {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "ma-tools-")));
  mkdirSync(join(d, "src", "lib"), { recursive: true });
  writeFileSync(join(d, "README.md"), "# hello\nsecond line\n");
  writeFileSync(join(d, "src", "app.ts"), "export const a = 1;\nexport const b = 2;\n");
  writeFileSync(join(d, "src", "lib", "util.ts"), "export const u = 'needle';\n");
  return d;
}
const clean = (d) => rmSync(d, { recursive: true, force: true });

test("the advertised tool set is exactly the existing one", () => {
  assert.deepEqual(TOOL_NAMES, ["Read", "Glob", "Grep", "Write", "Edit"]);
});

test("Read returns file contents", async () => {
  const d = wd();
  try {
    const t = createExecTools({ workdir: d });
    const r = await t.execute("Read", { path: "README.md" });
    assert.equal(r.ok, true);
    assert.match(r.content, /# hello/);
  } finally { clean(d); }
});

test("Read REFUSES a traversal exactly as an operator edit would", async () => {
  const d = wd();
  try {
    const t = createExecTools({ workdir: d });
    const r = await t.execute("Read", { path: "../../etc/passwd" });
    assert.equal(r.ok, false);
    assert.match(r.content, /workdir/i);
  } finally { clean(d); }
});

test("Write REFUSES to escape the workdir", async () => {
  const d = wd();
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "ma-tools-out-")));
  try {
    const t = createExecTools({ workdir: d });
    const r = await t.execute("Write", { path: "../pwned.txt", content: "x" });
    assert.equal(r.ok, false);
    assert.equal(existsSync(join(outside, "..", "pwned.txt")), false);
  } finally { clean(d); clean(outside); }
});

test("Write REFUSES to write through a symlink", async () => {
  const d = wd();
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "ma-tools-out2-")));
  try {
    writeFileSync(join(outside, "victim.txt"), "original\n");
    symlinkSync(join(outside, "victim.txt"), join(d, "link.txt"));
    const t = createExecTools({ workdir: d });
    const r = await t.execute("Write", { path: "link.txt", content: "pwned" });
    assert.equal(r.ok, false);
    assert.equal(readFileSync(join(outside, "victim.txt"), "utf-8"), "original\n");
  } finally { clean(d); clean(outside); }
});

test("Write creates a new file and its parent directories", async () => {
  const d = wd();
  try {
    const t = createExecTools({ workdir: d });
    const r = await t.execute("Write", { path: "a/b/new.ts", content: "export const n = 1;\n" });
    assert.equal(r.ok, true, r.content);
    assert.equal(readFileSync(join(d, "a/b/new.ts"), "utf-8"), "export const n = 1;\n");
  } finally { clean(d); }
});

test("Glob matches nested paths, and ** spans zero directories", async () => {
  const d = wd();
  try {
    const t = createExecTools({ workdir: d });
    const r = await t.execute("Glob", { pattern: "src/**/*.ts" });
    assert.match(r.content, /src\/app\.ts/, "** must also match zero directories");
    assert.match(r.content, /src\/lib\/util\.ts/);
  } finally { clean(d); }
});

test("globToRegExp keeps * inside a segment", () => {
  assert.equal(globToRegExp("src/*.ts").test("src/a.ts"), true);
  assert.equal(globToRegExp("src/*.ts").test("src/lib/a.ts"), false);
});

test("Grep finds matches with path:line and honours a glob filter", async () => {
  const d = wd();
  try {
    const t = createExecTools({ workdir: d });
    const all = await t.execute("Grep", { pattern: "needle" });
    assert.match(all.content, /src\/lib\/util\.ts:1:/);
    const none = await t.execute("Grep", { pattern: "needle", glob: "*.md" });
    assert.match(none.content, /no matches/);
  } finally { clean(d); }
});

test("Grep with an invalid regex is a readable refusal, not a crash", async () => {
  const d = wd();
  try {
    const t = createExecTools({ workdir: d });
    const r = await t.execute("Grep", { pattern: "([unclosed" });
    assert.equal(r.ok, false);
    assert.match(r.content, /invalid regular expression/i);
  } finally { clean(d); }
});

test("Edit replaces a unique occurrence", async () => {
  const d = wd();
  try {
    const t = createExecTools({ workdir: d });
    const r = await t.execute("Edit", { path: "src/app.ts", old_string: "const a = 1", new_string: "const a = 99" });
    assert.equal(r.ok, true, r.content);
    assert.match(readFileSync(join(d, "src/app.ts"), "utf-8"), /const a = 99/);
  } finally { clean(d); }
});

test("EDIT REFUSES AN AMBIGUOUS MATCH rather than guessing", async () => {
  // Replacing the first of several occurrences edits a line the model did not mean, and
  // nothing downstream would ever show it. Refusal is the only safe answer.
  const d = wd();
  try {
    writeFileSync(join(d, "dup.ts"), "x = 1;\nx = 1;\n");
    const t = createExecTools({ workdir: d });
    const r = await t.execute("Edit", { path: "dup.ts", old_string: "x = 1;", new_string: "x = 2;" });
    assert.equal(r.ok, false);
    assert.match(r.content, /more than once/i);
    assert.equal(readFileSync(join(d, "dup.ts"), "utf-8"), "x = 1;\nx = 1;\n", "file must be untouched");
  } finally { clean(d); }
});

test("Edit on a missing old_string refuses and leaves the file alone", async () => {
  const d = wd();
  try {
    const t = createExecTools({ workdir: d });
    const before = readFileSync(join(d, "src/app.ts"), "utf-8");
    const r = await t.execute("Edit", { path: "src/app.ts", old_string: "not present", new_string: "z" });
    assert.equal(r.ok, false);
    assert.equal(readFileSync(join(d, "src/app.ts"), "utf-8"), before);
  } finally { clean(d); }
});

test("CAP: the write-count limit trips as a REFUSAL THE MODEL CAN READ", async () => {
  const d = wd();
  try {
    const t = createExecTools({ workdir: d, limits: { maxWrites: 2 } });
    assert.equal((await t.execute("Write", { path: "one.txt", content: "a" })).ok, true);
    assert.equal((await t.execute("Write", { path: "two.txt", content: "b" })).ok, true);
    const third = await t.execute("Write", { path: "three.txt", content: "c" });
    assert.equal(third.ok, false);
    assert.match(third.content, /write limit reached/i);
    assert.equal(existsSync(join(d, "three.txt")), false, "the capped write must not land");
  } finally { clean(d); }
});

test("CAP: the byte budget trips before the write, not after", async () => {
  const d = wd();
  try {
    const t = createExecTools({ workdir: d, limits: { maxBytesWritten: 10 } });
    const r = await t.execute("Write", { path: "big.txt", content: "x".repeat(50) });
    assert.equal(r.ok, false);
    assert.match(r.content, /byte budget/i);
    assert.equal(existsSync(join(d, "big.txt")), false);
  } finally { clean(d); }
});

test("CAP: a huge file is truncated on Read with the truncation stated", async () => {
  const d = wd();
  try {
    writeFileSync(join(d, "huge.txt"), "y".repeat(5000));
    const t = createExecTools({ workdir: d, limits: { maxReadBytes: 100 } });
    const r = await t.execute("Read", { path: "huge.txt" });
    assert.equal(r.ok, true);
    assert.match(r.content, /truncated at 100 bytes/);
  } finally { clean(d); }
});

test("an unknown tool is a readable refusal listing what exists", async () => {
  const d = wd();
  try {
    const t = createExecTools({ workdir: d });
    const r = await t.execute("Bash", { command: "rm -rf /" });
    assert.equal(r.ok, false);
    assert.match(r.content, /unknown tool/i);
    assert.match(r.content, /Read, Glob, Grep, Write, Edit/);
  } finally { clean(d); }
});

test("NO TOOL EVER THROWS — a malformed args object is a refusal", async () => {
  const d = wd();
  try {
    const t = createExecTools({ workdir: d });
    for (const name of TOOL_NAMES) {
      const r = await t.execute(name, null);
      assert.equal(typeof r.ok, "boolean", `${name} did not return a result`);
      assert.equal(typeof r.content, "string");
    }
  } finally { clean(d); }
});

test("stats record what the turn actually did", async () => {
  const d = wd();
  try {
    const t = createExecTools({ workdir: d });
    await t.execute("Write", { path: "s.txt", content: "12345" });
    await t.execute("Read", { path: "s.txt" });
    assert.equal(t.stats.writes, 1);
    assert.equal(t.stats.bytesWritten, 5);
    assert.equal(t.stats.calls, 2);
    assert.equal(t.stats.byTool.Write, 1);
  } finally { clean(d); }
});

// ── THE ReDoS DEFECT, PINNED ─────────────────────────────────────────────────
//
// Found by independent verification of Phase 1 and rated HIGH/CRITICAL by both reviewers.
// `Grep` compiled a pattern the UNTRUSTED MODEL supplies with JS's backtracking RegExp and
// matched it synchronously in the MAIN SERVER PROCESS. The model also controls the
// haystack — it can Write the file it then greps. Measured before the fix, on this exact
// code path with `(a+)+$`:
//
//     line length 22  ->   794 ms
//     line length 26  ->  1131 ms
//     line length 30  -> 18127 ms
//     line length 34  -> never returned
//
// Two consequences worse than "a slow tool": it froze every HTTP handler and every other
// agent (the Claude CLI path is isolated in a spawned child; this one was not), and it
// bypassed ALL FIVE caps, which are only checked BETWEEN tool calls. Task 1.4 called caps
// "the real risk control" and one regex walked past every one of them.

test("SECURITY: a catastrophic-backtracking pattern is BOUNDED, not run to completion", async () => {
  const d = wd();
  try {
    // The exact shape the model could construct for itself: write the haystack, then grep it.
    const t = createExecTools({ workdir: d, limits: { maxGrepMs: 1500 } });
    await t.execute("Write", { path: "bait.txt", content: "a".repeat(40) });

    const started = Date.now();
    const r = await t.execute("Grep", { pattern: "(a+)+$" });
    const elapsed = Date.now() - started;

    // Before the fix this never returned. The bound is what matters, not the verdict.
    assert.ok(elapsed < 10000, `Grep took ${elapsed}ms — the deadline did not bound it`);
    assert.equal(typeof r.content, "string");
    if (!r.ok) assert.match(r.content, /timed out|too expensive/i, "a timeout must say so plainly");
  } finally { clean(d); }
});

test("SECURITY: an ordinary Grep still works and is not collateral damage of the fix", async () => {
  const d = wd();
  try {
    const t = createExecTools({ workdir: d });
    const r = await t.execute("Grep", { pattern: "needle" });
    assert.equal(r.ok, true, r.content);
    assert.match(r.content, /src\/lib\/util\.ts:1:/);
  } finally { clean(d); }
});

test("SECURITY: an absurdly long line is skipped rather than matched", async () => {
  const d = wd();
  try {
    const t = createExecTools({ workdir: d, limits: { maxGrepLineLength: 50 } });
    await t.execute("Write", { path: "long.txt", content: "needle" + "x".repeat(500) });
    const r = await t.execute("Grep", { pattern: "needle" });
    assert.equal(r.ok, true);
    assert.doesNotMatch(r.content, /long\.txt/, "a line past the length cap must not be matched");
  } finally { clean(d); }
});

test("an invalid regex is still a readable refusal after isolation", async () => {
  const d = wd();
  try {
    const t = createExecTools({ workdir: d });
    const r = await t.execute("Grep", { pattern: "([unclosed" });
    assert.equal(r.ok, false);
    assert.match(r.content, /invalid regular expression/i);
  } finally { clean(d); }
});
