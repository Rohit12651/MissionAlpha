// Phase 1 / R3 — tier router + codemod tests.
//
// Load-bearing assertions:
//   LAW1-*  — a codemod cannot write outside the worktree, at all, ever.
//   SAFE-*  — the router fails EXPENSIVE (tier 2) rather than wrong.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyTier, estimateSavings, modelForTier, TIERS } from "../router-tier.mjs";
import { removeConsole, varToConst, applyCodemod, isCodemodIntent, MAX_FILE_CHANGES } from "../codemod.mjs";

// ── router ────────────────────────────────────────────────────────────────────

test("codemod intents route to tier 0", () => {
  for (const t of [
    "Remove all console.log statements from the utils file",
    "strip console.debug calls",
    "please delete the console.log lines in src/app.js",
    "convert var to const in the helpers",
  ]) {
    const r = classifyTier(t);
    assert.equal(r.tier, TIERS.CODEMOD, `"${t}" → tier ${r.tier} (${r.reason})`);
  }
});

test("mechanical-but-judgement intents route to tier 1", () => {
  for (const t of ["fix typos in the README", "rename the variable foo to bar", "add a comment explaining this"]) {
    assert.equal(classifyTier(t).tier, TIERS.CHEAP, t);
  }
});

test("SAFE-1: unrecognized tasks fail EXPENSIVE, not wrong", () => {
  for (const t of ["implement the new billing reconciliation flow", "why is the queue stalling", "", null, undefined, 42]) {
    assert.equal(classifyTier(t).tier, TIERS.FULL);
  }
});

test("SAFE-2: sensitive domains are FORCED to full model even when phrased mechanically", () => {
  const cases = [
    "just remove the console.log in the auth middleware",
    "remove console.log from the payment handler",
    "convert var to const in the migration script",
    "strip console.debug from the crypto helper",
  ];
  for (const t of cases) {
    const r = classifyTier(t);
    assert.equal(r.tier, TIERS.FULL, `"${t}" must NOT be cheap — got tier ${r.tier}`);
    assert.match(r.reason, /sensitive-domain/);
  }
});

test("savings estimate never invents a number it did not measure", () => {
  assert.equal(estimateSavings(TIERS.CHEAP).estTokensSaved, null, "cheap-model delta is unmeasured → null, not 0");
  assert.ok(estimateSavings(TIERS.CODEMOD).estTokensSaved > 0);
  assert.equal(estimateSavings(TIERS.FULL).estTokensSaved, 0);
});

test("tier 0 consults no model", () => {
  assert.equal(modelForTier(TIERS.CODEMOD), null);
  assert.equal(modelForTier(TIERS.CHEAP), "haiku");
  assert.equal(modelForTier(TIERS.FULL), "sonnet");
});

// ── remove-console transform ──────────────────────────────────────────────────

test("removeConsole deletes standalone debug logs", () => {
  const r = removeConsole(`const a = 1;
console.log("hi");
console.debug(a);
console.info("x");
const b = 2;`);
  assert.equal(r.changes, 3);
  assert.ok(!r.text.includes("console."));
  assert.ok(r.text.includes("const a = 1;") && r.text.includes("const b = 2;"));
});

test("removeConsole REFUSES console.error and console.warn", () => {
  const src = `console.error("real");\nconsole.warn("real");`;
  const r = removeConsole(src);
  assert.equal(r.changes, 0);
  assert.equal(r.text, src);
});

test("removeConsole REFUSES non-statement uses (meaning would change)", () => {
  const src = `const x = console.log("v");
return console.log(1);
foo(console.log);
if (a) console.log("inline") && b();`;
  const r = removeConsole(src);
  assert.equal(r.changes, 0, "none of these are standalone statements");
});

test("removeConsole REFUSES commented-out and block-comment occurrences", () => {
  const src = `// console.log("nope");
/*
console.log("also nope");
*/
console.log("yes");`;
  const r = removeConsole(src);
  assert.equal(r.changes, 1);
  assert.ok(r.text.includes(`// console.log("nope");`));
  assert.ok(r.text.includes(`console.log("also nope");`), "block comment content preserved");
});

test("removeConsole leaves a multi-line call alone rather than half-eating it", () => {
  const src = `console.log(
  "spanning",
  value
);`;
  assert.equal(removeConsole(src).changes, 0);
});

// ── var-to-const transform ────────────────────────────────────────────────────

test("varToConst rewrites never-reassigned vars", () => {
  const r = varToConst(`var a = 1;\nvar b = 2;\nconsole.log(a + b);`);
  assert.equal(r.changes, 2);
  assert.ok(r.text.startsWith("const a = 1;"));
});

test("varToConst REFUSES reassigned bindings (would be a TypeError at runtime)", () => {
  const r = varToConst(`var count = 0;\ncount = count + 1;`);
  assert.equal(r.changes, 0, "reassigned var must stay var — const would throw");
});

test("varToConst REFUSES ++/-- mutated bindings", () => {
  assert.equal(varToConst(`var i = 0;\ni++;`).changes, 0);
  assert.equal(varToConst(`var n = 5;\nn += 2;`).changes, 0);
});

test("varToConst REFUSES loop headers", () => {
  assert.equal(varToConst(`for (var i = 0; i < 10; i++) {}`).changes, 0);
});

// ── applyCodemod: containment (LAW 1) ─────────────────────────────────────────

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "codemod-"));
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "a.js"), `const x = 1;\nconsole.log(x);\n`, "utf8");
  return dir;
}

test("applyCodemod rewrites files inside the worktree", async () => {
  const dir = await fixture();
  const r = await applyCodemod({ workdir: dir, intent: "remove-console", files: ["src/a.js"] });
  assert.equal(r.ok, true);
  assert.equal(r.filesChanged, 1);
  assert.equal(r.totalChanges, 1);
  assert.ok(!(await readFile(join(dir, "src/a.js"), "utf8")).includes("console.log"));
});

test("LAW1-1: a ../ escape is refused, not written", async () => {
  const dir = await fixture();
  const outside = join(dir, "..", "escape.js");
  await writeFile(outside, `console.log("outside");\n`, "utf8");
  const r = await applyCodemod({ workdir: join(dir, "src"), intent: "remove-console", files: ["../../escape.js"] });
  assert.equal(r.filesChanged, 0);
  assert.ok(r.skipped.some((s) => s.why === "outside worktree"));
  assert.ok((await readFile(outside, "utf8")).includes("console.log"), "file outside the worktree must be untouched");
});

test("LAW1-2: an absolute path is refused", async () => {
  const dir = await fixture();
  const r = await applyCodemod({ workdir: dir, intent: "remove-console", files: ["/etc/hosts"] });
  assert.equal(r.filesChanged, 0);
  assert.ok(r.skipped.some((s) => s.why === "outside worktree"));
});

test("LAW1-3: a symlink is refused (no redirect out of the worktree)", async () => {
  const dir = await fixture();
  const target = join(dir, "..", `link-target-${Date.now()}.js`);
  await writeFile(target, `console.log("target");\n`, "utf8");
  await symlink(target, join(dir, "src", "link.js"));
  const r = await applyCodemod({ workdir: dir, intent: "remove-console", files: ["src/link.js"] });
  assert.equal(r.filesChanged, 0);
  assert.ok(r.skipped.some((s) => s.why === "symlink"));
  assert.ok((await readFile(target, "utf8")).includes("console.log"));
});

test("LAW1-4: extension allow-list holds", async () => {
  const dir = await fixture();
  await writeFile(join(dir, "src", "notes.md"), `console.log("md");\n`, "utf8");
  const r = await applyCodemod({ workdir: dir, intent: "remove-console", files: ["src/notes.md"] });
  assert.equal(r.filesChanged, 0);
  assert.ok(r.skipped.some((s) => s.why === "extension not allowed"));
});

test("a no-op file is not rewritten (no empty-diff churn)", async () => {
  const dir = await fixture();
  await writeFile(join(dir, "src", "clean.js"), `const y = 2;\n`, "utf8");
  let wrote = false;
  const r = await applyCodemod({
    workdir: dir, intent: "remove-console", files: ["src/clean.js"],
    io: { writeFile: async () => { wrote = true; } },
  });
  assert.equal(r.filesChanged, 0);
  assert.equal(wrote, false);
});

test("a runaway file count aborts — that is a human decision", async () => {
  const dir = await fixture();
  const many = Array.from({ length: MAX_FILE_CHANGES + 1 }, (_, i) => `src/f${i}.js`);
  const r = await applyCodemod({ workdir: dir, intent: "remove-console", files: many });
  assert.equal(r.ok, false);
  assert.match(r.error, /not a mechanical task/);
});

test("unknown intent is refused", async () => {
  const dir = await fixture();
  const r = await applyCodemod({ workdir: dir, intent: "rm -rf", files: ["src/a.js"] });
  assert.equal(r.ok, false);
  assert.equal(isCodemodIntent("rm -rf"), false);
  assert.equal(isCodemodIntent("remove-console"), true);
});

test("no workdir is refused", async () => {
  assert.equal((await applyCodemod({ intent: "remove-console", files: ["a.js"] })).ok, false);
});
