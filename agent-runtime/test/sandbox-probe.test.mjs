// ADR-037 — THE SANDBOX AVAILABILITY PROBE MUST FAIL CLOSED.
//
// Found while running the Phase 0 gate of the autonomy program, not by looking for it:
// `npm run test:runtime` reported 10 failures on a machine with no Docker daemon. Those
// tests carry `{ skip: !DOCKER_UP }` and should have SKIPPED, so the skip predicate was
// returning true with no daemon. It was:
//
//   docker info                              -> exit 1   (daemon down)
//   docker info --format '{{.ServerVersion}}' -> exit 0, EMPTY stdout   (daemon down)
//
// `dockerAvailable()` used the second form and tested only the exit code, so it answered
// TRUE with no daemon running. That is not merely a noisy test run: the same predicate is
// the whole body of `preflight()`, whose own comment says "Fail-closed." — the gate that
// tells the runtime whether it is able to jail an agent's command. A security boundary
// that reports "available" when it cannot verify availability fails OPEN, which is the
// opposite of every other guard in this codebase.
//
// These tests drive the probe through a STUB binary (RUNTIME_DOCKER_BIN) so all three
// daemon states are reproducible on any machine, with or without Docker installed. The
// module reads that env var at import time, so the import is dynamic and comes after the
// stub is written.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "ma-docker-stub-"));

/** Write an executable stub and return its path. */
function stub(name, body) {
  const p = join(DIR, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

// The exact observed behaviour of a real `docker` CLI whose daemon is not running:
// the templated form succeeds and prints nothing.
const DOWN = stub("docker-down", "exit 0");
// A healthy daemon prints its server version.
const UP = stub("docker-up", 'echo "27.3.1"');
// A CLI that is not installed at all.
const MISSING = join(DIR, "docker-does-not-exist");

/** Fresh module instance bound to `bin` (DOCKER is resolved at module scope). */
async function sandboxWith(bin) {
  process.env.RUNTIME_DOCKER_BIN = bin;
  // Cache-bust so each case gets its own module evaluation.
  const mod = await import(`../sandbox.mjs?probe=${encodeURIComponent(bin)}`);
  return mod.createSandbox({ image: "alpine:3" });
}

test("daemon DOWN — the templated probe exits 0 with empty output and must NOT be trusted", async () => {
  const sb = await sandboxWith(DOWN);
  assert.equal(
    await sb.dockerAvailable(),
    false,
    "dockerAvailable() reported a daemon that is not running — exit status alone is not " +
      "proof; `docker info --format '{{.ServerVersion}}'` exits 0 with an empty body when " +
      "the daemon is down",
  );
});

test("daemon DOWN — preflight fails CLOSED, as its own comment promises", async () => {
  const sb = await sandboxWith(DOWN);
  const pf = await sb.preflight();
  assert.equal(pf.ok, false, "preflight must refuse when the sandbox cannot be verified");
  assert.match(String(pf.error), /docker/i);
});

test("daemon UP — a real server version is accepted", async () => {
  const sb = await sandboxWith(UP);
  assert.equal(await sb.dockerAvailable(), true);
  assert.deepEqual(await sb.preflight(), { ok: true });
});

test("CLI absent — the probe refuses rather than throwing", async () => {
  const sb = await sandboxWith(MISSING);
  assert.equal(await sb.dockerAvailable(), false);
  assert.equal((await sb.preflight()).ok, false);
});

test.after(() => {
  delete process.env.RUNTIME_DOCKER_BIN;
  try {
    rmSync(DIR, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});
