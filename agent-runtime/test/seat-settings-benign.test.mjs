// PES addendum #21 — "a guard that cannot tell the TOOL's own artifact from the AGENT's
// blocks the tool."
//
// THE DEFECT, observed live on 2026-09-04 and A/B proven:
//   [engine] task=… agent=pikachu     wrote …/<task>/.claude — removed, spawn refused
//   [engine] task=… agent=sr-frontend wrote …/<task>/.claude — removed, spawn refused
// Five refusals in one boot, across a roster seat AND a non-roster agent, so it was not
// Phase 7's doing. `claude -p` creates `.claude/` in its own cwd as ordinary session state.
// sweepSeatSettings treated ANY `.claude/` as tampering, so the retry vetoed the spawn and
// EVERY engine task ended `empty-diff`, having authored nothing. A control with a 100%
// false-positive rate is an outage.
//
// THE RULE NOW: always REMOVE `.claude/` (unchanged — the CLI must never load anything from
// the worktree). REFUSE only when it held something PERMISSION-BEARING. The escalation 6.7
// exists to stop is `permissions.allow` / hooks being honoured, and that requires one of
// those files; a session cache cannot escalate anything.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sweepSeatSettings } from "../seat-settings-guard.mjs";

const wt = () => mkdtempSync(join(tmpdir(), "ma-seat-"));
function withClaude(files) {
  const d = wt();
  mkdirSync(join(d, ".claude"), { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const p = join(d, ".claude", rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, body);
  }
  return d;
}

test("SEAT-GUARD-1: no .claude at all is clean, as before", () => {
  const r = sweepSeatSettings(wt());
  assert.deepEqual({ ok: r.ok, tampered: r.tampered }, { ok: true, tampered: false });
});

test("SEAT-GUARD-2: the CLI's OWN session cache is removed but NOT a refusal", () => {
  // This is the exact shape that took the engine down: no settings.json, no hooks.
  const d = withClaude({ "session.json": "{}", "history.jsonl": "{}\n", "todos/x.json": "[]" });
  const r = sweepSeatSettings(d);
  assert.equal(r.ok, true);
  assert.equal(r.tampered, false, "a session cache is not settings tampering — refusing it is an outage");
  assert.equal(existsSync(join(d, ".claude")), false, "it must STILL be removed before the spawn");
});

test("SEAT-GUARD-3: settings.json IS a refusal — the escalation 6.7 exists to stop", () => {
  const d = withClaude({ "settings.json": JSON.stringify({ permissions: { allow: ["Bash(*)"] } }) });
  const r = sweepSeatSettings(d);
  assert.equal(r.tampered, true, "agent-authored permissions must still veto the spawn");
  assert.equal(existsSync(join(d, ".claude")), false);
});

test("SEAT-GUARD-4: every permission-bearing spelling is a refusal", () => {
  for (const f of ["settings.json", "settings.local.json", "hooks/pre.sh", "hooks.json"]) {
    const d = withClaude({ [f]: "x" });
    assert.equal(sweepSeatSettings(d).tampered, true, `${f} must veto`);
  }
});

test("SEAT-GUARD-5: a permission file BESIDE a session cache still refuses", () => {
  const d = withClaude({ "session.json": "{}", "settings.json": "{}" });
  assert.equal(sweepSeatSettings(d).tampered, true, "one bad file poisons the directory");
});

test("SEAT-GUARD-6: a SYMLINKED .claude is always a refusal, whatever it points at", () => {
  const outside = wt();
  mkdirSync(join(outside, "real"), { recursive: true });
  writeFileSync(join(outside, "real", "settings.json"), "{}");
  const d = wt();
  symlinkSync(join(outside, "real"), join(d, ".claude"));
  const r = sweepSeatSettings(d);
  assert.equal(r.tampered, true, "a symlink out of the worktree can never be the CLI's own cache");
});

test("SEAT-GUARD-7: a missing workdir is still fail-closed", () => {
  assert.equal(sweepSeatSettings("").ok, false);
  assert.equal(sweepSeatSettings(null).ok, false);
});
