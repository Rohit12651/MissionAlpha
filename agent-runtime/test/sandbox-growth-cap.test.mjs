// Phase 7 · task 7.6 (BOSS-approved 2026-09-04) — the jail's two unreachable-ship defects.
//
// DEFECT 1 — PES addendum #16, verbatim: "a cap that measures the mount measures the repo,
// not the work." The disk cap compared the ABSOLUTE size of the bind-mounted worktree
// against the budget. This repo is 3.79 GiB, so `/work exceeded 1073741824 bytes` fired
// before the deploy had written one byte. No value of the cap could fix that — the number
// being compared was never the work.
//
// DEFECT 2 — `limits.memory` was a hard-coded "512m" with NO env knob (sandbox.mjs:63), and
// `tsc && vite build` OOMs there: V8 died with "Mark-Compact … 254 MB". The ship rung was
// unreachable with defaults, and an operator had no way to raise it.
//
// Both are asserted on PURE functions so this suite needs no Docker.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildDockerArgs, exceedsDiskBudget, dirSizeBytes, DEFAULT_SANDBOX_MEMORY } from "../sandbox.mjs";

const valOf = (args, flag) => args[args.indexOf(flag) + 1];

// ── the growth cap ───────────────────────────────────────────────────────────
test("GROWTH-1: a huge PRE-EXISTING tree does not trip the cap — only what the run WROTE counts", () => {
  // The exact live shape: a 3.79 GiB repo, a 1 GiB budget, and a run that wrote nothing.
  const REPO = 3.79 * 1024 ** 3, CAP = 1024 ** 3;
  assert.equal(exceedsDiskBudget(REPO, REPO, CAP), false,
    "this is the bug: the old check compared 3.79 GiB against 1 GiB and killed every deploy");
});

test("GROWTH-2: growth beyond the budget still trips it — the DoS bound is intact", () => {
  const BASE = 1000;
  assert.equal(exceedsDiskBudget(BASE + 1024, BASE, 1024), false, "exactly at budget is allowed");
  assert.equal(exceedsDiskBudget(BASE + 1025, BASE, 1024), true, "one byte over is refused");
});

test("GROWTH-3: a run that DELETES files never reports negative growth", () => {
  assert.equal(exceedsDiskBudget(500, 1000, 10), false, "shrinking must not underflow into a trip");
});

test("GROWTH-4: an unmeasurable baseline fails CLOSED to absolute size", () => {
  // If the baseline could not be taken, the safe reading is "assume nothing is pre-existing",
  // which is the OLD, stricter behaviour — never "assume unlimited headroom".
  assert.equal(exceedsDiskBudget(2048, null, 1024), true);
  assert.equal(exceedsDiskBudget(2048, undefined, 1024), true);
  assert.equal(exceedsDiskBudget(512, null, 1024), false);
});

// ── the memory knob ──────────────────────────────────────────────────────────
test("MEM-1: the default is unchanged at 512m — this task adds a knob, it does not retune", () => {
  assert.equal(DEFAULT_SANDBOX_MEMORY, "512m");
  const { args } = buildDockerArgs({ worktreeDir: "/tmp/wt", command: "ls", callId: "c1" });
  assert.equal(valOf(args, "--memory"), "512m");
  assert.equal(valOf(args, "--memory-swap"), "512m", "swap must still equal memory — no swap escape");
});

test("MEM-2: an explicit limits.memory still wins", () => {
  const { args } = buildDockerArgs({ worktreeDir: "/tmp/wt", command: "ls", callId: "c", limits: { memory: "3g" } });
  assert.equal(valOf(args, "--memory"), "3g");
  assert.equal(valOf(args, "--memory-swap"), "3g");
});

test("MEM-3: --memory-swap ALWAYS tracks --memory, whatever the source", () => {
  for (const m of ["512m", "1g", "4g"]) {
    const { args } = buildDockerArgs({ worktreeDir: "/w", command: "x", callId: "c", limits: { memory: m } });
    assert.equal(valOf(args, "--memory-swap"), valOf(args, "--memory"),
      "a swap allowance larger than memory is an escape from the memory bound");
  }
});

test("MEM-4: the lockdown flags are untouched by this change", () => {
  const { args } = buildDockerArgs({ worktreeDir: "/tmp/wt", command: "ls", callId: "c1" });
  for (const f of ["--cap-drop", "--security-opt", "--read-only", "--pids-limit", "--user"]) {
    assert.ok(args.includes(f), `${f} must survive 7.6`);
  }
  assert.equal(args.includes("--privileged"), false);
});

// ── the measurement it is wired to ───────────────────────────────────────────
test("GROWTH-5: the REAL measurement feeds the budget — baseline walked, growth walked", () => {
  // A first version of this test built a tree and then hardcoded `const baseline = 200*1024`,
  // never calling dirSizeBytes at all — every assertion was a duplicate of GROWTH-2 and
  // `dirSizeBytes` could have returned 0 forever. Same class as BODY-4 (addendum #22).
  const dir = mkdtempSync(join(tmpdir(), "ma-growth-"));
  mkdirSync(join(dir, "pre"));
  writeFileSync(join(dir, "pre", "big.bin"), Buffer.alloc(200 * 1024));

  const baseline = dirSizeBytes(dir);            // MEASURED, not assumed
  assert.equal(baseline, 200 * 1024, "the baseline walk must see the pre-existing tree");

  // Nothing written yet: a run that writes nothing never trips, whatever the tree weighs.
  assert.equal(exceedsDiskBudget(dirSizeBytes(dir), baseline, 64 * 1024), false);

  // The run writes 100 KB into a 64 KB budget.
  writeFileSync(join(dir, "written.bin"), Buffer.alloc(100 * 1024));
  const after = dirSizeBytes(dir);
  assert.equal(after, baseline + 100 * 1024, "the second walk must see the new bytes");
  assert.equal(exceedsDiskBudget(after, baseline, 64 * 1024), true, "100 KB of growth exceeds a 64 KB budget");
  assert.equal(exceedsDiskBudget(after, baseline, 256 * 1024), false, "the same growth fits a 256 KB budget");
});

test("GROWTH-6: dirSizeBytes stops early at its ceiling — the poll must stay cheap", () => {
  // H2: raising the ceiling to baseline+cap removed the early-out and made every poll walk
  // the whole tree (~436 ms on this repo, every 750 ms, on the single-threaded server loop).
  // The contract that keeps the poll cheap is that the walk bails at the ceiling.
  const dir = mkdtempSync(join(tmpdir(), "ma-growth-ceiling-"));
  for (let i = 0; i < 8; i++) writeFileSync(join(dir, `f${i}.bin`), Buffer.alloc(50 * 1024));
  const full = dirSizeBytes(dir);
  assert.equal(full, 400 * 1024);
  const capped = dirSizeBytes(dir, 100 * 1024);
  assert.ok(capped <= full, "a ceilinged walk never reports more than the true size");
  assert.ok(capped >= 100 * 1024, "it must report at least the ceiling so the caller can compare");
});

// ── the memory knob's own validation (review LOW-2) ──────────────────────────
// `"0"` is a TRUTHY string, so it survived the `||` default and reached Docker as
// `--memory 0 --memory-swap 0`, which Docker reads as UNLIMITED for both. The knob added by
// 7.6 could therefore switch the jail's memory bound off entirely, and nothing validated the
// env value at all.
test("MEM-5: a memory value of 0 is refused and falls back to the default", async () => {
  const { normalizeMemory } = await import("../sandbox.mjs");
  assert.equal(normalizeMemory("0"), "512m", "0 means UNLIMITED to Docker — never accept it");
  assert.equal(normalizeMemory("0m"), "512m");
  assert.equal(normalizeMemory(""), "512m");
  assert.equal(normalizeMemory(undefined), "512m");
});

test("MEM-6: a malformed memory value is refused, not passed through to Docker", async () => {
  const { normalizeMemory } = await import("../sandbox.mjs");
  for (const bad of ["512m --privileged", "lots", "-1", "1e9", "512 m", "m512"]) {
    assert.equal(normalizeMemory(bad), "512m", `${JSON.stringify(bad)} must not reach docker`);
  }
});

test("MEM-7: legitimate forms are preserved, including a bare byte count", async () => {
  const { normalizeMemory } = await import("../sandbox.mjs");
  for (const ok of ["512m", "1g", "2G", "1024k", "536870912"]) {
    assert.equal(normalizeMemory(ok), ok, `${ok} is a valid docker memory value`);
  }
});

test("MEM-8: a bad limits.memory cannot switch the jail's bound off at the call site", async () => {
  const { args } = buildDockerArgs({ worktreeDir: "/w", command: "x", callId: "c", limits: { memory: "0" } });
  assert.equal(valOf(args, "--memory"), "512m");
  assert.equal(valOf(args, "--memory-swap"), "512m");
});
