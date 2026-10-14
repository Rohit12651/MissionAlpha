// A test that boots the product must not touch the operator's runtime state (PES addendum #82).
//
// Found 2026-09-27: 51 test files boot server.mjs; every one left some durable root at its default
// INSIDE the repo. A test's seeded cadence planted a task in the live engine-store that the real
// runtime then ran as a model turn, and a test rewrote the tracked .claude/agents/notifications-engineer.md.
// fixtures/isolate-state.mjs now redirects every such root; these tests keep it complete and applied.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "acorn";

const RUNTIME = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = join(RUNTIME, "..");
// Read by the runtime, never written — large (the skills library is ~50 MB) and safe to share.
const READ_ONLY = new Set(["RUNTIME_SKILLS_DIR", "RUNTIME_SKILLS_CURATED_DIR", "RUNTIME_QUALITY_FILE"]);

function walk(n, visit) {
  if (!n || typeof n.type !== "string") return;
  visit(n);
  for (const k of Object.keys(n)) { const v = n[k]; if (Array.isArray(v)) v.forEach((c) => walk(c, visit)); else if (v && typeof v.type === "string") walk(v, visit); }
}
const astOf = (p) => parse(readFileSync(p, "utf8"), { ecmaVersion: "latest", sourceType: "module", allowHashBang: true });
const envName = (n) => n?.type === "MemberExpression" && n.object?.type === "MemberExpression"
  && n.object.object?.name === "process" && n.object.property?.name === "env" ? n.property?.name : null;

/** Every `process.env.X || <path expression>` in the modules that pick the runtime's roots. */
function derivedRoots(src) {
  const out = new Set();
  walk(astOf(src), (n) => {
    if (n.type !== "LogicalExpression" || !["||", "??"].includes(n.operator)) return;
    const name = envName(n.left);
    const right = n.right;
    const isPath = right?.type === "CallExpression" && ["join", "resolve"].includes(right.callee?.name);
    if (name && isPath && /^(RUNTIME_|FACTORY_|WAAHYU_)/.test(name)) out.add(name);
  });
  return out;
}

test("STATE-ISO-1: the fixture redirects every durable root the runtime defaults — derived from the code, not listed by hand", async () => {
  const roots = new Set([...derivedRoots(join(RUNTIME, "server.mjs")), ...derivedRoots(join(RUNTIME, "factory.mjs")), ...derivedRoots(join(RUNTIME, "uploads.mjs"))]);
  assert.ok(roots.has("RUNTIME_ENGINE_STORE") && roots.has("RUNTIME_TRUST_FILE") && roots.size >= 20,
    `anti-vacuity: the derivation sees the runtime's roots (${roots.size})`);
  const { ISOLATED_ROOTS } = await import("./fixtures/isolate-state.mjs");
  const missing = [...roots].filter((r) => !READ_ONLY.has(r) && !(r in ISOLATED_ROOTS));
  assert.deepEqual(missing, [], "a root the fixture does not redirect is a root a test writes into the repo");
  for (const [k, v] of Object.entries(ISOLATED_ROOTS)) {
    const rel = relative(REPO, v);
    assert.ok(rel.startsWith("..") || isAbsolute(rel), `${k} must point outside the repo, got ${v}`);
    assert.equal(process.env[k], v, `${k} is set in process.env for the spawned server to inherit`);
  }
});

/** The test files that start the real server, and their spawn calls. */
function serverBootingTests() {
  const out = [];
  for (const dir of ["test", "__tests__"]) {
    let names = [];
    try { names = readdirSync(join(RUNTIME, dir)); } catch { continue; }
    for (const f of names.filter((x) => x.endsWith(".test.mjs"))) {
      const p = join(RUNTIME, dir, f);
      const src = readFileSync(p, "utf8");
      if (!src.includes("server.mjs")) continue;
      const calls = [];
      walk(astOf(p), (n) => {
        if (n.type !== "CallExpression" || !["spawn", "fork"].includes(n.callee?.name)) return;
        const first = n.arguments[0];
        const execPath = first?.type === "MemberExpression" && first.object?.name === "process" && first.property?.name === "execPath";
        if (execPath || n.callee.name === "fork") calls.push(n);
      });
      if (calls.length) out.push({ file: `${dir}/${f}`, p, calls });
    }
  }
  return out;
}

test("STATE-ISO-2: every test that boots server.mjs imports the fixture FIRST and hands the server process.env", () => {
  const booting = serverBootingTests();
  assert.ok(booting.length >= 40, `anti-vacuity: the census sees the server-booting tests (${booting.length})`);
  const problems = [];
  for (const { file, p, calls } of booting) {
    const firstImport = astOf(p).body.find((n) => n.type === "ImportDeclaration");
    if (firstImport?.source?.value !== "./fixtures/isolate-state.mjs") problems.push(`${file}: first import is not ./fixtures/isolate-state.mjs`);
    for (const c of calls) {
      const opts = c.arguments.find((a) => a?.type === "ObjectExpression" && a.properties.some((pr) => pr.key?.name === "env"));
      if (!opts) continue; // no env option ⇒ the child inherits process.env
      const env = opts.properties.find((pr) => pr.key?.name === "env").value;
      const spreads = env?.type === "ObjectExpression" && env.properties.some((pr) => pr.type === "SpreadElement"
        && pr.argument?.type === "MemberExpression" && pr.argument.object?.name === "process" && pr.argument.property?.name === "env");
      if (!spreads) problems.push(`${file}:${c.start} env does not spread process.env — the fixture's roots never reach the server`);
    }
  }
  assert.deepEqual(problems, []);
});
