// BOSS decision #1 (2026-09-27) — agent-runtime/ is DENY-BY-DEFAULT.
//
// CORE_GUARD is an allowlist of files that decide what an agent may do. The Phase E security
// passes kept finding control files that were missing from it (61 rows by the last count), and
// the census still left 66 runtime modules appliable. That list can never be finished: every
// module server.mjs imports runs INSIDE the runtime process, with its fs, its env and its token,
// so an agent able to edit `uploads.mjs` or `vault.mjs` can patch anything the process touches.
// "Is this module control?" has one honest answer for code the runtime loads: yes.
//
// So the question is inverted. Under agent-runtime/, the ONLY appliable paths are the two test
// directories the suite runs (package.json `test:runtime`, factory/quality.json testDirs).
// Everything else — code, JSON, a new file, a new directory — is refused for every caller of
// applyAllowed, for every seat, before SEED_DIRS is consulted. Test dirs stay open pending BOSS
// decision #2.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, symlinkSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "acorn";

import { applyAllowed } from "../guards.mjs";
import { isAutoSafe } from "../policy.mjs";
import { createBroker } from "../broker.mjs";
import { createPr } from "../pr.mjs";
import { createWorktreeMgr } from "../worktree.mjs";

const REPO = new URL("../../", import.meta.url).pathname;
const LEGACY = { id: "legacy", role: "manager" }; // a resolved seat that applyAllowed does not narrow
const isTestDir = (p) => /^agent-runtime\/(test|__tests__)\//.test(p);

test("RTF-1: no file under agent-runtime/ outside its test dirs is appliable — the whole tree, not a sample", () => {
  const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "agent-runtime"], { cwd: REPO, encoding: "utf8" })
    .trim().split("\n").filter(Boolean);
  const outside = files.filter((f) => !isTestDir(f));
  assert.ok(outside.length > 100, `premise: the census sees the runtime (${outside.length} files)`);
  assert.ok(outside.includes("agent-runtime/kpis.mjs"), "premise: a module that was appliable before is in the census");
  assert.deepEqual(outside.filter((f) => applyAllowed(f)), []);
  assert.deepEqual(outside.filter((f) => applyAllowed(f, { seat: LEGACY })), []);
});

test("RTF-2: a NEW file anywhere under agent-runtime/ is refused — deny-by-default covers what does not exist yet", () => {
  for (const p of [
    "agent-runtime/new-module.mjs", "agent-runtime/new-dir/helper.mjs", "agent-runtime/NOTES.md",
    "agent-runtime/config.json", "agent-runtime/run.sh", "agent-runtime/Kpis.MJS",
    "agent-runtime/tests/x.test.mjs", "agent-runtime/test-utils.mjs", "agent-runtime/testx/a.mjs",
    "agent-runtime/adapters/__tests__/a.test.mjs", "agent-runtime/src/test/a.mjs",
  ]) {
    assert.equal(applyAllowed(p), false, p);
    assert.equal(applyAllowed(p, { seat: LEGACY }), false, p);
    assert.equal(isAutoSafe(p), false, `auto-apply must refuse ${p}`);
  }
});

test("RTF-3 (GOOD): the two test directories stay appliable (BOSS decision #2 pending), and nothing outside agent-runtime moves", () => {
  for (const p of ["agent-runtime/test/queue.test.mjs", "agent-runtime/test/__fixtures__/a.json", "agent-runtime/__tests__/pool.test.mjs",
    "agent-runtime/test/new-dir/b.test.mjs"]) {
    assert.equal(applyAllowed(p), true, p);
  }
  for (const p of ["src/lib/jobsClient.ts", "src/components/board/JobBoard.tsx", "docs/notes.md", "README.md"]) {
    assert.equal(applyAllowed(p), true, p);
  }
});

test("RTF-4 (premise of the exemption): no runtime module imports from its test directories", () => {
  // The exemption is safe only while the runtime never LOADS what an agent may write there.
  const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "agent-runtime"], { cwd: REPO, encoding: "utf8" })
    .trim().split("\n").filter((f) => /\.(mjs|cjs|js)$/.test(f) && !isTestDir(f));
  assert.ok(files.includes("agent-runtime/server.mjs"), "premise: the census includes the process entry point");
  const offenders = [];
  for (const f of files) {
    const visit = (n) => {
      if (!n || typeof n.type !== "string") return;
      const src = (n.type === "ImportDeclaration" || n.type === "ExportAllDeclaration" || n.type === "ExportNamedDeclaration"
        || n.type === "ImportExpression") ? n.source : (n.type === "CallExpression" && n.callee?.name === "require" ? n.arguments[0] : null);
      if (src?.type === "Literal" && /(^|\/)(test|__tests__)\//.test(String(src.value))) offenders.push(`${f} → ${src.value}`);
      for (const k of Object.keys(n)) { const v = n[k]; if (Array.isArray(v)) v.forEach(visit); else if (v && typeof v === "object") visit(v); }
    };
    visit(parse(readFileSync(join(REPO, f), "utf8"), { ecmaVersion: "latest", sourceType: "module", allowHashBang: true }));
  }
  assert.deepEqual(offenders, []);
});

function brokerFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ma-rtf-")));
  const repoRoot = join(root, "repo"); const work = join(root, "work");
  for (const d of [repoRoot, work]) mkdirSync(join(d, "agent-runtime", "test"), { recursive: true });
  writeFileSync(join(repoRoot, "agent-runtime", "kpis.mjs"), "export const k = 1;\n");
  writeFileSync(join(work, "agent-runtime", "kpis.mjs"), "export const k = 2; // agent edit\n");
  writeFileSync(join(work, "agent-runtime", "test", "kpis.test.mjs"), "// new test\n");
  return { repoRoot, work, broker: createBroker({ repoRoot, workdirFor: () => work, scrub: (s) => s, seatFor: () => LEGACY, strict: true }) };
}

test("RTF-5: the broker refuses a runtime module edit — and writes nothing — while landing the test beside it", async () => {
  const f = brokerFixture();
  const [mod, tst] = await f.broker.applyChanges("k", ["agent-runtime/kpis.mjs", "agent-runtime/test/kpis.test.mjs"]);
  assert.equal(mod.ok, false, JSON.stringify(mod));
  assert.equal(readFileSync(join(f.repoRoot, "agent-runtime", "kpis.mjs"), "utf8"), "export const k = 1;\n");
  assert.equal(tst.ok, true, JSON.stringify(tst));
});

test("RTF-6: the ship ladder refuses to commit a runtime module", async () => {
  const root = mkdtempSync(join(tmpdir(), "ma-rtf-ship-"));
  const repoRoot = join(root, "repo");
  mkdirSync(join(repoRoot, "agent-runtime"), { recursive: true });
  const g = (args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf-8" }).trim();
  g(["init", "-q", "-b", "main"]); g(["config", "user.email", "t@t.t"]); g(["config", "user.name", "t"]);
  writeFileSync(join(repoRoot, "agent-runtime", "kpis.mjs"), "export const k = 1;\n");
  g(["add", "-A"]); g(["commit", "-q", "-m", "init"]);
  const wt = createWorktreeMgr({ repoRoot, worktreeRoot: join(root, "wt") });
  const pr = createPr({ repoRoot, worktreeMgr: wt, audit: () => {}, scrub: (s) => s });
  const jb = await pr.createJobBranch("job_rtf", g(["rev-parse", "HEAD"]));
  const p = wt.create("task_rtf").path ?? wt.pathFor("task_rtf");
  writeFileSync(join(p, "agent-runtime", "kpis.mjs"), "export const k = 2;\n");
  const c = await pr.commitTask({ jobWorktree: jb.worktree, taskId: "task_rtf", paths: ["agent-runtime/kpis.mjs"], message: "feat: x" });
  assert.equal(c.ok, false, `a runtime module reached a commit: ${JSON.stringify(c)}`);
});

// The ship ladder's commitTask copies file BODIES, so it cannot carry a deletion for ANY path — a
// first draft of this test used it and stayed green with the floor removed (addendum #13). The P5
// ladder (`deliverApproved`) runs `git add -- <path>`, which DOES stage a deletion: test it there,
// with a premise arm proving the deletion lands when the gate says yes.
async function deleteRuntimeModule(gate) {
  const root = mkdtempSync(join(tmpdir(), "ma-rtf-del-"));
  const repoRoot = join(root, "repo");
  mkdirSync(join(repoRoot, "agent-runtime"), { recursive: true });
  const g = (args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf-8" }).trim();
  g(["init", "-q", "-b", "main"]); g(["config", "user.email", "t@t.t"]); g(["config", "user.name", "t"]);
  writeFileSync(join(repoRoot, "agent-runtime", "kpis.mjs"), "export const k = 1;\n");
  g(["add", "-A"]); g(["commit", "-q", "-m", "init"]);
  const wt = createWorktreeMgr({ repoRoot, worktreeRoot: join(root, "wt") });
  const w = wt.create("task_rtfdel");
  rmSync(join(w.path ?? wt.pathFor("task_rtfdel"), "agent-runtime", "kpis.mjs"));
  const pr = createPr({ repoRoot, worktreeMgr: wt, audit: () => {}, scrub: (s) => s, ...(gate ? { applyAllowed: gate } : {}) });
  const out = await pr.deliverApproved({ taskId: "task_rtfdel", paths: ["agent-runtime/kpis.mjs"], title: "rm", summary: "", agentId: "a1", kind: "code" });
  const onBranch = out.branch ? g(["ls-tree", "-r", "--name-only", out.branch]).split("\n") : null;
  return { out, onBranch };
}

test("RTF-6b (premise): the P5 ladder CAN commit a deletion when the gate allows the path", async () => {
  const { out, onBranch } = await deleteRuntimeModule(() => true);
  assert.equal(out.mode, "branch", JSON.stringify(out));
  assert.ok(onBranch && !onBranch.includes("agent-runtime/kpis.mjs"), "premise: the deletion reached the branch");
});

test("RTF-6c: DELETING a runtime module is refused — the gate is on the path, not the operation", async () => {
  const { out } = await deleteRuntimeModule(null);
  assert.notEqual(out.mode, "branch", `a runtime module deletion reached a commit: ${JSON.stringify(out)}`);
  assert.ok(out.refused.some((r) => /agent-runtime\/kpis\.mjs/.test(r)), JSON.stringify(out));
});

test("RTF-7 (premise): a symlink inside a test dir cannot carry a write out of it", async () => {
  // The exemption is a PATH prefix. If agent-runtime/test/up -> .. were followed, `test/up/kpis.mjs`
  // would be the module itself. assertCanonicalInside refuses any redirecting symlink; pin it here,
  // next to the rule that depends on it.
  const f = brokerFixture();
  symlinkSync("..", join(f.repoRoot, "agent-runtime", "test", "up"));
  mkdirSync(join(f.work, "agent-runtime", "test", "up"), { recursive: true });
  writeFileSync(join(f.work, "agent-runtime", "test", "up", "kpis.mjs"), "export const k = 3; // via link\n");
  const [r] = await f.broker.applyChanges("k", ["agent-runtime/test/up/kpis.mjs"]);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(readFileSync(join(f.repoRoot, "agent-runtime", "kpis.mjs"), "utf8"), "export const k = 1;\n");
});
