// Security review 2026-09-24 (MEDIUM): task-diff.mjs ran `git read-tree`, `git add -N` and
// `git diff` in a SEAT WORKTREE with no GIT_SAFE_ARGS. A workspace can carry a hostile
// `.git/config` (worktree.mjs says so itself); `core.fsmonitor=<cmd>` in it is EXECUTED by
// `add`/`diff`, and `diff.external` can name a program too. The reviewer named one file; the
// census below found six unhardened `git` spawns (addendum #11), and pins that there are none left.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, existsSync, readFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "acorn";

import { taskDiff } from "../task-diff.mjs";

test("GITSAFE-1: the review diff of a seat worktree never runs the worktree's own fsmonitor", () => {
  const dir = mkdtempSync(join(tmpdir(), "ma-gitsafe-"));
  const g = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf-8" });
  g(["init", "-q"]); g(["config", "user.email", "t@t.t"]); g(["config", "user.name", "t"]);
  writeFileSync(join(dir, "a.txt"), "a\n"); g(["add", "-A"]); g(["commit", "-qm", "init"]);
  const marker = join(dir, "FSMONITOR_FIRED");
  const hook = `${dir}-hook.sh`;
  writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`); chmodSync(hook, 0o755);
  g(["config", "core.fsmonitor", hook]);
  writeFileSync(join(dir, "new.txt"), "brand new\n");
  const diff = taskDiff(dir, ["new.txt"]);
  assert.match(diff, /brand new/, "precondition: the diff still describes the created file");
  assert.equal(existsSync(marker), false, "the review diff executed the worktree's core.fsmonitor");
});

// Every call whose FIRST argument is the literal "git" must pass `...GIT_SAFE_ARGS` first.
// One reviewed exception: pr.mjs reads the operator's GLOBAL credential helpers
// (`git config --global`), which never consults a repo's config — and its runner's environment
// carries the same hardening (PR-GITENV-1/2).
const EXEMPT = new Set(["pr.mjs:config --global"]);

function sources(dir, rel = "") {
  const out = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (f === "test" || f === "node_modules" || f === "data") continue;
    if (statSync(p).isDirectory()) out.push(...sources(p, `${rel}${f}/`));
    else if (f.endsWith(".mjs")) out.push({ p, name: `${rel}${f}` });
  }
  return out;
}

test("GITSAFE-2: no runtime module spawns git without GIT_SAFE_ARGS", () => {
  const offenders = [];
  const root = new URL("../", import.meta.url).pathname;
  for (const { p, name } of sources(root)) {
    const src = readFileSync(p, "utf8");
    const walk = (n) => {
      if (!n || typeof n.type !== "string") return;
      if (n.type === "CallExpression" && n.arguments[0]?.type === "Literal" && n.arguments[0].value === "git") {
        const args = n.arguments[1];
        const first = args?.type === "ArrayExpression" ? args.elements[0] : null;
        const hardened = first?.type === "SpreadElement" && first.argument?.name === "GIT_SAFE_ARGS";
        const sub = args?.type === "ArrayExpression" ? args.elements.slice(0, 2).map((e) => e?.value).join(" ") : "";
        if (!hardened && !EXEMPT.has(`${name}:${sub}`)) offenders.push(`${name}:${n.loc.start.line} git ${sub}`);
      }
      for (const k of Object.keys(n)) { const v = n[k]; if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") walk(v); }
    };
    walk(parse(src, { ecmaVersion: "latest", sourceType: "module", locations: true }));
  }
  assert.deepEqual(offenders, []);
});

test("GITSAFE-3: the review diff does not run a repo's clean filter or textconv (re-review 2026-09-24)", () => {
  // GIT_SAFE_ARGS stops fsmonitor/hooks/external diff, but a repo config can still name a
  // `filter.<x>.clean` or `diff.<x>.textconv` COMMAND that git runs while diffing any path
  // .gitattributes (or $GIT_DIR/info/attributes) maps to <x>. taskDiff now neutralises every
  // filter/textconv the repo's config defines, and passes --no-textconv.
  const dir = mkdtempSync(join(tmpdir(), "ma-filter-"));
  const g = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf-8" });
  g(["init", "-q"]); g(["config", "user.email", "t@t.t"]); g(["config", "user.name", "t"]);
  writeFileSync(join(dir, ".gitattributes"), "x.txt filter=evil diff=evil\n");
  writeFileSync(join(dir, "x.txt"), "old\n"); g(["add", "-A"]); g(["commit", "-qm", "init"]);
  const clean = join(dir, "CLEAN_FIRED"); const conv = join(dir, "TEXTCONV_FIRED");
  const cleanSh = `${dir}-clean.sh`; const convSh = `${dir}-conv.sh`;
  writeFileSync(cleanSh, `#!/bin/sh\ntouch '${clean}'\ncat\n`); chmodSync(cleanSh, 0o755);
  writeFileSync(convSh, `#!/bin/sh\ntouch '${conv}'\ncat "$1"\n`); chmodSync(convSh, 0o755);
  g(["config", "filter.evil.clean", cleanSh]);
  g(["config", "diff.evil.textconv", convSh]);
  writeFileSync(join(dir, "x.txt"), "new\n");
  execFileSync("git", ["diff"], { cwd: dir }); // premise: the traps are live
  assert.ok(existsSync(clean) && existsSync(conv), "premise: a plain git diff fires both");
  rmSync(clean); rmSync(conv);
  const diff = taskDiff(dir, ["x.txt"]);
  assert.match(diff, /\+new/, "precondition: the change is still described");
  assert.equal(existsSync(clean), false, "the review diff ran the repo's clean filter");
  assert.equal(existsSync(conv), false, "the review diff ran the repo's textconv");
});
