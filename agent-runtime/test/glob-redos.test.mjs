// Phase 7 review follow-up — a roster glob must not be able to hang the runtime.
//
// THE DEFECT, confirmed by probe before this test was written:
//   matchesWriteScope("src/" + "a/".repeat(24) + "nope.txt", ["src/" + "**/".repeat(12) + "x.tsx"])
// did not return within 6 s (the probe hit its timeout and had to be killed). Twelve adjacent
// `(?:[^/]+/)*` groups over the same language backtrack catastrophically.
//
// WHY IT MATTERS MORE THAN A SLOW REQUEST: matchesWriteScope runs inside applyAllowed, which
// runs per-file inside the broker's listing loop, on the single-threaded server. One such glob
// hangs the whole runtime, not one request. Phase 10 (HR) is an AGENT writing roster entries,
// so this sits directly in front of the write path (addendum #15, availability flavour).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRoster, matchesWriteScope } from "../roster.mjs";
import { SEED_DIRS } from "../guards.mjs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SKILLS = new Set(["repo-read", "research-brief", "ui", "api", "db", "test", "notifications"]);
const seedFile = new URL("../roster.json", import.meta.url).pathname;

function load(writeScope) {
  const dir = mkdtempSync(join(tmpdir(), "ma-redos-"));
  const f = join(dir, "roster.json");
  writeFileSync(f, JSON.stringify({ version: 1, members: [{
    id: "x", name: "X", seat: "ui", role: "worker", skills: ["ui"],
    writeScope, tools: ["Read"], createdBy: "seed", createdAt: "2026-09-04T00:00:00.000Z",
  }] }));
  return createRoster({ file: f, validSkills: SKILLS, seedDirs: SEED_DIRS });
}

test("REDOS-1: a glob with many adjacent ** segments is REFUSED at load", () => {
  assert.throws(() => load(["src/" + "**/".repeat(12) + "x.tsx"]), /adjacent|too many|\*\*/i);
});

test("REDOS-2: a segment stuffed with wildcards is REFUSED at load", () => {
  assert.throws(() => load(["src/" + "*".repeat(24) + ".tsx"]), /wildcard/i);
});

test("REDOS-3: two ADJACENT ** segments are refused even when the total is small", () => {
  assert.throws(() => load(["src/**/**/x.tsx"]), /adjacent/i);
});

test("REDOS-4: an absurdly long entry is refused", () => {
  assert.throws(() => load(["src/" + "a".repeat(400) + ".tsx"]), /too long|length/i);
});

test("REDOS-5: the SHIPPED roster still loads — the bound must not refuse a real seat", () => {
  // qa legitimately holds TWO **-rooted globs. A naive
  // "at most one **" rule would throw at module scope and stop the server binding its
  // port — the exact failure this repo already had once (roster.mjs load() notes).
  const r = createRoster({ file: seedFile, validSkills: SKILLS, seedDirs: SEED_DIRS });
  assert.equal(r.all().length, 12);
  assert.deepEqual(r.get("qa").writeScope, ["**/__tests__/**", "**/*.test.*"]);
  assert.deepEqual(r.get("sr-backend").writeScope, ["src/lib/**", "agent-runtime/**"]);
});

test("REDOS-6: every shipped glob matches a hostile path in bounded time", () => {
  const r = createRoster({ file: seedFile, validSkills: SKILLS, seedDirs: SEED_DIRS });
  const hostile = "src/" + "a/".repeat(30) + "nope.txt";
  for (const m of r.all()) {
    const t0 = Date.now();
    matchesWriteScope(hostile, m.writeScope);
    const ms = Date.now() - t0;
    assert.ok(ms < 250, `${m.id}: matching took ${ms}ms — that is a stalled runtime, not a slow match`);
  }
});
