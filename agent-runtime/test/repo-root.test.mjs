// F5 — configurable target repo tests (R1 env-timing: env read at module load → cache-bust import).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Fresh guards module with a given env (R1: env read at load → cache-bust the import).
let _n = 0;
async function loadGuards(env) {
  for (const k of ["RUNTIME_REPO_ROOT", "RUNTIME_SEED_DIRS"]) delete process.env[k];
  Object.assign(process.env, env);
  return import(`../guards.mjs?case=${_n++}`);
}

test("unset env → REPO_ROOT defaults to MissionAlpha repo (zero change)", async () => {
  const g = await loadGuards({});
  assert.ok(g.REPO_ROOT.endsWith("/MissonAlpha") || g.REPO_ROOT.includes("MissonAlpha"));
  assert.deepEqual(g.SEED_DIRS, ["src", "public"]);
});

test("RUNTIME_REPO_ROOT points the root at another existing dir", async () => {
  const dir = mkdtempSync(join(tmpdir(), "f5-root-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  const g = await loadGuards({ RUNTIME_REPO_ROOT: dir });
  assert.equal(g.REPO_ROOT, dir);
  // applyAllowed re-derives against the NEW root
  assert.equal(g.applyAllowed("src/app.ts"), true);
  assert.equal(g.applyAllowed("../escape.ts"), false);     // containment vs new root
  assert.equal(g.applyAllowed(".env"), false);             // APPLY_DENY vs new root
});

test("invalid RUNTIME_REPO_ROOT fails closed (throws at load)", async () => {
  await assert.rejects(loadGuards({ RUNTIME_REPO_ROOT: "/no/such/dir/xyz123" }), /does not exist|not a directory/i);
});

test("RUNTIME_SEED_DIRS csv overrides the appliable scope", async () => {
  const dir = mkdtempSync(join(tmpdir(), "f5-seed-"));
  mkdirSync(join(dir, "app"), { recursive: true });
  const g = await loadGuards({ RUNTIME_REPO_ROOT: dir, RUNTIME_SEED_DIRS: "app, lib" });
  assert.equal(g.applyAllowed("app/x.ts"), true);
  assert.equal(g.applyAllowed("lib/y.ts"), true);
  assert.equal(g.applyAllowed("src/z.ts"), false); // src no longer seeded
});
