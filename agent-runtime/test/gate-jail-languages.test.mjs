// SESSION 16 — THE GATE'S RUNNER MUST BE ABLE TO LOAD THE LANGUAGES THE GATE TARGETS.
//
// The defect this pins. `factory/quality.json` scopes the post-edit unit-test gate to
// `scope.testDirs`, which includes `src/lib/__tests__` — every file there is TypeScript.
// The gate executes `testCmd` (`node --test <targets>`) inside the exec jail, and that
// jail defaulted to `node:20-alpine`. Node 20 has NO TypeScript type stripping (it landed
// in 22.6 and became default-on in 22.18+), so every `.ts` target died with
// `ERR_UNKNOWN_FILE_EXTENSION` before a single assertion ran.
//
// The consequence was a gate that COULD NOT PASS for most frontend work: the seat wrote a
// correct file, the gate failed for a reason that had nothing to do with the diff, the
// engine retried to its budget and blocked the story. That is exactly the failure mode D1
// was created to end ("a gate that can never pass is worse than no gate"), reappearing one
// layer down — D1 fixed WHICH tests run, this is about whether the runner can read them.
//
// It survived because nothing tested the exec image. sandbox.test.mjs pins the container's
// security flags with `alpine:3` and says so in a comment: "exec image (node:20-alpine)
// tested via live broker". It never was.
//
// WHY THIS TEST ACTUALLY RUNS THE IMAGE rather than parsing the tag for a version number:
// the property that matters is a CAPABILITY ("can this runner load this file type"), and a
// tag is not a capability — `node:24-alpine`, `node:lts-alpine` and a pinned digest all say
// different things about the same fact, and a regex over tags would go stale the first time
// someone repoints the image. Skips when docker is unavailable, matching sandbox.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dir, "..", "..");

// RESOLVE THE IMAGE THE WAY THE RUNTIME ACTUALLY DOES. The server is booted with the repo
// `.env` sourced (`set -a; . ./.env; set +a; node agent-runtime/server.mjs`), so the jail it
// really uses is the .env value when one is set, and only otherwise the module default.
// A test that read the bare default would assert against a configuration this install never
// runs — and would then report a fixed jail as broken. Read .env FIRST, then import
// sandbox.mjs, because it captures process.env at module load.
if (!process.env.RUNTIME_SANDBOX_IMAGE) {
  const envPath = join(REPO, ".env");
  if (existsSync(envPath)) {
    const m = /^[ \t]*(?:export[ \t]+)?RUNTIME_SANDBOX_IMAGE[ \t]*=[ \t]*["']?([^"'\s#]+)/m.exec(readFileSync(envPath, "utf-8"));
    if (m) process.env.RUNTIME_SANDBOX_IMAGE = m[1];
  }
}
const { createSandbox, DEFAULT_EXEC_IMAGE } = await import("../sandbox.mjs");

const sb = createSandbox({ image: DEFAULT_EXEC_IMAGE });
const DOCKER_UP = await sb.dockerAvailable();

/** The extensions the gate will actually be pointed at, read from the real config. */
function targetedExtensions() {
  const cfgPath = join(REPO, "factory", "quality.json");
  if (!existsSync(cfgPath)) return [];
  const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
  const dirs = cfg?.scope?.testDirs || [];
  const exts = new Set();
  for (const d of dirs) {
    const abs = join(REPO, d);
    if (!existsSync(abs)) continue;
    for (const f of readdirSync(abs)) {
      const m = /\.(test|spec)\.([a-z]+)$/i.exec(f);
      if (m) exts.add(m[2].toLowerCase());
    }
  }
  return [...exts].sort();
}

test("the configured gate scope targets at least one test file (else the gate is vacuous)", () => {
  assert.ok(targetedExtensions().length > 0, "scope.testDirs resolves to real test files");
});

test("REGRESSION: the exec jail can execute EVERY language the gate scope targets", { skip: !DOCKER_UP && "docker unavailable" }, async () => {
  const exts = targetedExtensions();
  const wt = mkdtempSync(join(tmpdir(), "ma-jail-lang-"));
  try {
    for (const ext of exts) {
      // A trivial, dependency-free test file that only passes if the runner LOADED it.
      // The `.ts` variant carries a type annotation, so a runtime without type stripping
      // cannot execute it — which is precisely the node:20 failure.
      const typed = ext === "ts" || ext === "tsx" || ext === "mts";
      const body = typed
        ? `import test from "node:test";\nimport assert from "node:assert/strict";\nconst id = (s: string): string => s;\ntest("loads", () => { assert.equal(id("ok"), "ok"); });\n`
        : `import test from "node:test";\nimport assert from "node:assert/strict";\ntest("loads", () => { assert.equal(1, 1); });\n`;
      const name = `jailprobe.test.${ext}`;
      writeFileSync(join(wt, name), body);

      // Positional signature: runInSandbox(worktreeDir, command, opts).
      const r = await sb.runInSandbox(wt, `node --test ${name}`, { callId: `jail-${ext}`, network: false });
      const out = `${r.stdout || ""}${r.stderr || ""}`;
      assert.ok(
        !/ERR_UNKNOWN_FILE_EXTENSION/.test(out),
        `the exec jail (${DEFAULT_EXEC_IMAGE}) cannot LOAD a '.${ext}' test file, but factory/quality.json scopes the gate at a directory containing them. ` +
        `Every such target fails before any assertion runs, so the gate can never pass for that work. Output: ${out.slice(0, 400)}`,
      );
      assert.equal(r.exitCode, 0, `a trivial '.${ext}' test must pass in the jail; got exit ${r.exitCode}: ${out.slice(0, 400)}`);
    }
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});
