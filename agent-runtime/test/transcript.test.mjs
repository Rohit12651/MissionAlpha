// MUNDER-ADOPTION A3 — transcript usage invariants, pinned. Real tmp dirs (the module's
// job IS the filesystem contract), no network, no live ~/.claude.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  projectKey, legacyProjectKey, transcriptDirs, parseTranscriptUsage, createTranscriptUsage,
} from "../transcript.mjs";

const row = (usage, extra = {}) => JSON.stringify({ type: "assistant", message: { usage }, timestamp: "2026-08-20T01:00:00Z", ...extra });

test("projectKey dashes EVERY non-alphanumeric, leading slash included (the current rule)", () => {
  assert.equal(projectKey("/Users/me/App.v2"), "-Users-me-App-v2");
  assert.equal(projectKey("C:\\Users\\me\\app"), "C--Users-me-app");
});

test("legacyProjectKey keeps dots and drops only the leading slash (the pre-2026 rule)", () => {
  assert.equal(legacyProjectKey("/Users/me/App.v2"), "Users-me-App.v2");
});

test("the two keys DIVERGE for dotted paths — the exact silent-miss the source repo shipped", () => {
  const cwd = "/Users/me/MDv0.3.0";
  assert.notEqual(projectKey(cwd), legacyProjectKey(cwd));
});

test("parseTranscriptUsage sums assistant rows, keeps LAST context, skips torn/foreign lines", () => {
  const text = [
    row({ input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 }),
    JSON.stringify({ type: "user", message: { content: "hi" } }),
    "{not json",
    row({ input_tokens: 50, output_tokens: 30, cache_read_input_tokens: 2000, cache_creation_input_tokens: 500 }),
    "",
  ].join("\n");
  const u = parseTranscriptUsage(text);
  assert.equal(u.turns, 2);
  assert.equal(u.inputTokens, 150);
  assert.equal(u.outputTokens, 50);
  assert.equal(u.cacheReadTokens, 3000);
  assert.equal(u.contextTokens, 50 + 2000 + 500); // last row, not the sum
  assert.ok(u.lastTs > 0);
});

test("dollars are structurally unreadable: total_cost_usd never appears in any output", () => {
  const text = row({ input_tokens: 1, output_tokens: 1 }, { total_cost_usd: 9.99 });
  const flat = JSON.stringify(parseTranscriptUsage(text));
  assert.ok(!/cost|usd|\$/i.test(flat));
});

// ── filesystem contract ───────────────────────────────────────────────────────

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "ma-transcript-"));
  const cwd = "/Users/me/MDv0.3.0"; // dotted on purpose: current ≠ legacy
  const base = join(home, ".claude", "projects");
  return { home, cwd, base, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

test("an absent directory reads as ZERO sessions — never an error (silent-miss surface)", () => {
  const f = fixture();
  try {
    const t = createTranscriptUsage({ cwd: f.cwd, home: f.home });
    const snap = t.scan();
    assert.equal(snap.totals.sessions, 0);
    assert.deepEqual(snap.dirs, []);
  } finally { f.cleanup(); }
});

test("the CURRENT key dir is found; the LEGACY dir is ALSO read when it exists (both probed)", () => {
  const f = fixture();
  try {
    const cur = join(f.base, projectKey(f.cwd));
    const leg = join(f.base, legacyProjectKey(f.cwd));
    mkdirSync(cur, { recursive: true });
    mkdirSync(leg, { recursive: true });
    writeFileSync(join(cur, "s1.jsonl"), row({ input_tokens: 10, output_tokens: 5 }) + "\n");
    writeFileSync(join(leg, "s2.jsonl"), row({ input_tokens: 20, output_tokens: 7 }) + "\n");
    const t = createTranscriptUsage({ cwd: f.cwd, home: f.home });
    const snap = t.scan();
    assert.equal(snap.totals.sessions, 2);
    assert.equal(snap.totals.inputTokens, 30);
    assert.equal(snap.totals.outputTokens, 12);
    assert.deepEqual(snap.dirs.map((d) => d.key), ["current", "legacy"]);
    assert.deepEqual(transcriptDirs(f.cwd, { home: f.home }).map((d) => d.key), ["current", "legacy"]);
  } finally { f.cleanup(); }
});

test("incremental: an unchanged file is not re-read; a grown file is; emission is change-only", () => {
  const f = fixture();
  try {
    const cur = join(f.base, projectKey(f.cwd));
    mkdirSync(cur, { recursive: true });
    const p = join(cur, "s1.jsonl");
    writeFileSync(p, row({ input_tokens: 10, output_tokens: 5 }) + "\n");
    utimesSync(p, new Date(1_700_000_000_000), new Date(1_700_000_000_000));

    const emitted = [];
    let reads = 0;
    const t = createTranscriptUsage({
      cwd: f.cwd, home: f.home,
      emit: (name, data) => emitted.push({ name, data }),
      fs: { readFileSync: (...a) => { reads += 1; return readFileSyncReal(...a); } },
    });
    t.scan();
    assert.equal(reads, 1);
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].name, "usage.transcript");
    assert.equal(emitted[0].data.outputTokens, 5);

    t.scan(); // nothing moved
    assert.equal(reads, 1, "unchanged file must not be re-read");
    assert.equal(emitted.length, 1, "no change → no frame");

    writeFileSync(p, row({ input_tokens: 10, output_tokens: 5 }) + "\n" + row({ input_tokens: 4, output_tokens: 6 }) + "\n");
    utimesSync(p, new Date(1_700_000_999_000), new Date(1_700_000_999_000));
    t.scan();
    assert.equal(reads, 2, "grown file re-read once");
    assert.equal(emitted.length, 2);
    assert.equal(emitted[1].data.outputTokens, 11);
  } finally { f.cleanup(); }
});
import { readFileSync as readFileSyncReal } from "node:fs";

test("a rotated-away file leaves the totals (cursor pruned)", () => {
  const f = fixture();
  try {
    const cur = join(f.base, projectKey(f.cwd));
    mkdirSync(cur, { recursive: true });
    const p = join(cur, "s1.jsonl");
    writeFileSync(p, row({ input_tokens: 10, output_tokens: 5 }) + "\n");
    const t = createTranscriptUsage({ cwd: f.cwd, home: f.home });
    assert.equal(t.scan().totals.sessions, 1);
    rmSync(p);
    assert.equal(t.scan().totals.sessions, 0);
  } finally { f.cleanup(); }
});
