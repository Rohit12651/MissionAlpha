// 2026-09-07 — the Roster strip was mounted TWICE: App.tsx (squad board) and
// JobBoard.tsx. It shows the RULE — reference data that changes about once a day — while
// the BREACH now reaches the operator through the queue strip, which is what was actually
// missing. Settings is its single home.
//
// This ratchet counts real JSX usages, NOT prose. A comment naming the component, or an
// import left behind, cannot satisfy it — text matching is how three ratchets in this repo
// shipped vacuous (PES addendum #13).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "../../..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Count `<RosterStrip` element opens — an element, not a mention. */
const mounts = (src: string) => (src.match(/<RosterStrip[\s/>]/g) ?? []).length;

test("RM-1: the roster is mounted exactly once in the app — in Settings", () => {
  assert.equal(
    mounts(read("src/components/settings/SettingsPanel.tsx")),
    1,
    "Settings must mount the roster exactly once",
  );
  assert.equal(mounts(read("src/App.tsx")), 0, "App.tsx must not mount the roster");
  assert.equal(
    mounts(read("src/components/board/JobBoard.tsx")),
    0,
    "JobBoard must not mount the roster",
  );
});

test("RM-2: the counter is not vacuous — it sees a mount in a synthetic source", () => {
  // BAD: a real mount is counted.
  assert.equal(mounts('  <RosterStrip lastEvent={null} />\n'), 1);
  assert.equal(mounts('<RosterStrip/>'), 1);
  // GOOD: prose and imports naming the component are NOT mounts.
  assert.equal(mounts('// the RosterStrip shows each seat\'s writeScope\n'), 0);
  assert.equal(mounts('import { RosterStrip } from "./RosterStrip";\n'), 0);
  // UNRELATED: a different component whose name merely starts the same way.
  assert.equal(mounts('<RosterStripHeader />'), 0);
});
