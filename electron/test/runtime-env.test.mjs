// Step 0 ratchet — the picker takes ONLY allow-listed RUNTIME_* keys, process env wins
// over .env, and a .env line that is not on the list is dropped.
// Mutation proof (2026-09-17): removed "RUNTIME_MANAGER_DISPATCH" from RUNTIME_ENV_ALLOW →
//   ✖ RTENV-1  AssertionError: Expected values to be strictly deep-equal:
//              -   RUNTIME_MANAGER_DISPATCH: 'claude',
//   (RTENV-2 and RTENV-3 also red — they read the same key). Restored, md5 617fd06f… matched, 3/3 green.
import { test } from "node:test";
import assert from "node:assert/strict";
import rt from "../runtime-env.cjs";
const { pickRuntimeEnv, RUNTIME_ENV_ALLOW } = rt;

test("RTENV-1: allow-listed .env keys pass through; others are dropped", () => {
  const dotenv = [
    "RUNTIME_MANAGER_DISPATCH=claude",
    "RUNTIME_SANDBOX_IMAGE=node:24-alpine",
    "RUNTIME_STORY_MAX_CONCURRENT=2",
    "NOT_ON_THE_LIST=1",
    "# a comment",
    "",
  ].join("\n");
  const out = pickRuntimeEnv(dotenv, {});
  assert.deepEqual(out, {
    RUNTIME_MANAGER_DISPATCH: "claude",
    RUNTIME_SANDBOX_IMAGE: "node:24-alpine",
    RUNTIME_STORY_MAX_CONCURRENT: "2",
  });
});

test("RTENV-2: process env beats .env for the same key", () => {
  const out = pickRuntimeEnv("RUNTIME_MANAGER_DISPATCH=claude\n", { RUNTIME_MANAGER_DISPATCH: "deterministic" });
  assert.equal(out.RUNTIME_MANAGER_DISPATCH, "deterministic");
});

test("RTENV-3: the allow-list is closed — a key not in RUNTIME_ENV_ALLOW never appears", () => {
  const out = pickRuntimeEnv("RUNTIME_TOKEN_DIR=/tmp/x\n", {});
  assert.equal(out.RUNTIME_TOKEN_DIR, undefined, "TOKEN_DIR is set by main.cjs itself, never from .env");
  assert.ok(RUNTIME_ENV_ALLOW.includes("RUNTIME_MANAGER_DISPATCH"));
});

test("RTENV-4: quoted values are unquoted — a quoted image ref must not reach Docker with quotes", () => {
  // G7 MEDIUM (2026-09-17): the raw value "\"node:24-alpine\"" flowed verbatim to sandbox.mjs:151.
  // Mutation proof: quote strip → no-op → ✖ RTENV-4 actual: '"node:24-alpine"', expected: 'node:24-alpine'. Restored, md5 matched.
  const out = pickRuntimeEnv([
    'RUNTIME_SANDBOX_IMAGE="node:24-alpine"',
    "RUNTIME_MANAGER_DISPATCH='claude'",
  ].join("\n"), {});
  assert.equal(out.RUNTIME_SANDBOX_IMAGE, "node:24-alpine");
  assert.equal(out.RUNTIME_MANAGER_DISPATCH, "claude");
});

test("RTENV-5: `export KEY=` prefix and an inline `# comment` are handled like Node's --env-file", () => {
  const out = pickRuntimeEnv([
    "export RUNTIME_BACKEND=cli",
    "RUNTIME_STORY_MAX_CONCURRENT=2 # prod",
  ].join("\n"), {});
  assert.equal(out.RUNTIME_BACKEND, "cli");
  assert.equal(out.RUNTIME_STORY_MAX_CONCURRENT, "2");
});

// 2026-10-02 — every page said "The runtime did not answer" under `npm run electron:dev`.
// The app calls the runtime through the Vite dev proxy, which reads RUNTIME_PORT and
// RUNTIME_TOKEN_DIR from the repo .env (vite.config.ts, process env winning). Electron's
// supervisor ignored both: it started the runtime on a pinned 3005 with a temp-dir token, so
// the proxy hit an empty port, and on the right port the token was refused (401).
// devRuntimeTarget is the ONE dev resolution both must share; packaged builds keep the pins.
import { loadEnv } from "vite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PINS = { port: 3005, tokenDir: join(tmpdir(), "missionalpha-runtime") };
/** What the Vite dev proxy will use for this .env and process env (the real loadEnv). */
function viteTarget(dotenvText, processEnv) {
  const dir = mkdtempSync(join(tmpdir(), "ma-viteenv-"));
  writeFileSync(join(dir, ".env"), dotenvText);
  const saved = { ...process.env };
  for (const k of ["RUNTIME_PORT", "RUNTIME_TOKEN_DIR"]) delete process.env[k];
  Object.assign(process.env, processEnv);
  try {
    const env = loadEnv("development", dir, "");
    return { port: Number(env.RUNTIME_PORT || "3005"), tokenDir: env.RUNTIME_TOKEN_DIR || PINS.tokenDir };
  } finally { process.env = saved; }
}

for (const [name, dotenv, procEnv] of [
  ["a .env that moves both (the live case)", "RUNTIME_PORT=3006\nRUNTIME_TOKEN_DIR=/Users/x/.missionalpha\n", {}],
  ["no .env values: both keep the pins", "", {}],
  ["the shell beats .env, as in Vite", "RUNTIME_PORT=3006\nRUNTIME_TOKEN_DIR=/a\n", { RUNTIME_PORT: "3007", RUNTIME_TOKEN_DIR: "/b" }],
  ["quoted values, as Node's --env-file reads them", 'RUNTIME_PORT="3008"\nRUNTIME_TOKEN_DIR="/q/dir"\n', {}],
]) {
  test(`RTENV-6: in dev the supervisor targets what the Vite proxy calls — ${name}`, () => {
    assert.deepEqual(rt.devRuntimeTarget(dotenv, procEnv, PINS), viteTarget(dotenv, procEnv));
  });
}

test("RTENV-7: a port that is not a TCP port falls back to the pin", () => {
  for (const bad of ["abc", "0", "70000", "30.5"]) {
    assert.equal(rt.devRuntimeTarget(`RUNTIME_PORT=${bad}\n`, {}, PINS).port, 3005, bad);
  }
});

test("RTENV-8: the supervisor allow-list stays closed — the dev target does not widen it", () => {
  const out = pickRuntimeEnv("RUNTIME_PORT=3006\nRUNTIME_TOKEN_DIR=/x\n", {});
  assert.deepEqual(out, {});
});
