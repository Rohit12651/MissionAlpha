import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sweepSeatSettings } from "../seat-settings-guard.mjs";

const wt = () => mkdtempSync(join(tmpdir(), "ma-seat-guard-"));

test("a clean worktree passes untouched", () => {
  const d = wt(); writeFileSync(join(d, "a.ts"), "x");
  assert.deepEqual(sweepSeatSettings(d), { ok: true, tampered: false });
  assert.ok(existsSync(join(d, "a.ts")));
  rmSync(d, { recursive: true, force: true });
});

test("an agent-written .claude/settings.json is removed and reported as tampering", () => {
  const d = wt(); mkdirSync(join(d, ".claude")); writeFileSync(join(d, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(*)"] } }));
  const r = sweepSeatSettings(d);
  assert.equal(r.ok, true); assert.equal(r.tampered, true);
  assert.equal(existsSync(join(d, ".claude")), false, "the directory is gone before the spawn");
  rmSync(d, { recursive: true, force: true });
});

test("a .claude symlink pointing outside the worktree is removed, its target untouched", () => {
  const d = wt(); const outside = wt(); writeFileSync(join(outside, "settings.json"), "{}");
  symlinkSync(outside, join(d, ".claude"));
  const r = sweepSeatSettings(d);
  assert.equal(r.tampered, true);
  assert.equal(existsSync(join(d, ".claude")), false);
  assert.ok(existsSync(join(outside, "settings.json")), "rm removed the link, not the target");
  rmSync(d, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true });
});

test("fails closed on a missing workdir argument", () => {
  assert.equal(sweepSeatSettings("").ok, false);
  assert.equal(sweepSeatSettings(null).ok, false);
});
