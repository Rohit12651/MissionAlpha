// P7 / ADR-054 — Claude Code sessions adapter. Real throwaway fs (no ~/.claude touched).
// Proves: transcript parsing, read-only ingestion, per-session idempotency, the
// stable-mtime "finished" gate, and debounce coalescing (many fs events → one scan).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../db.mjs";
import { createDeliveries } from "../deliveries.mjs";
import { createClaudeSessionsAdapter, parseTranscript } from "../adapters/claude-sessions.mjs";

function boot() {
  const root = mkdtempSync(join(tmpdir(), "ma-p7-cc-"));
  const projectsDir = join(root, "projects");
  const slug = "-Users-x-repo";
  const dir = join(projectsDir, slug);
  mkdirSync(dir, { recursive: true });
  const db = openDb({ path: join(root, "m.db"), patchesDir: join(root, "patches") });
  const deliveries = createDeliveries({ db, events: { emit: () => {} }, audit: () => {}, scrub: (s) => s, slaFor: () => 3_600_000 });
  return { root, dir, slug, projectsDir, deliveries, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// write a jsonl session file and age its mtime so the stable-gate treats it as finished.
function writeSession(dir, id, lines, ageMs = 10_000) {
  const full = join(dir, `${id}.jsonl`);
  writeFileSync(full, lines.map((l) => JSON.stringify(l)).join("\n"));
  const t = (Date.now() - ageMs) / 1000;
  utimesSync(full, t, t);
  return full;
}

const SESSION = [
  { type: "user", message: { role: "user", content: [{ type: "text", text: "add a login page" }] } },
  { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Edit", input: { file_path: "/Users/x/repo/src/Login.tsx" } }] } },
  { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Done — added Login.tsx" }] } },
];

test("parseTranscript pulls first user text, last assistant text, and edited paths", () => {
  const p = parseTranscript(SESSION.map((l) => JSON.stringify(l)).join("\n"));
  assert.equal(p.firstUser, "add a login page");
  assert.equal(p.lastAssistant, "Done — added Login.tsx");
  assert.deepEqual(p.paths, ["/Users/x/repo/src/Login.tsx"]);
});

test("scan ingests a finished session as a READ-ONLY claude-code delivery, idempotently", () => {
  const { dir, slug, projectsDir, deliveries, cleanup } = boot();
  try {
    writeSession(dir, "sess-abc", SESSION);
    const ad = createClaudeSessionsAdapter({ deliveries, enabled: true, config: { workspaceSlug: slug, projectsDir, stableMs: 50 } });
    assert.equal(ad.scan().minted, 1);
    const rows = deliveries.list({});
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, "claude-code");
    assert.equal(rows[0].externalKey, "ccsession:sess-abc");
    assert.equal(rows[0].externalMeta.readOnly, true);
    assert.equal(rows[0].title, "add a login page");
    assert.deepEqual(rows[0].changedPaths, ["/Users/x/repo/src/Login.tsx"]);
    // a second scan re-reads the dir but mints nothing new
    assert.equal(ad.scan().minted, 0);
    assert.equal(deliveries.list({}).length, 1);
  } finally { cleanup(); }
});

test("a still-writing session (fresh mtime) is skipped until it settles past the stable window", () => {
  const { dir, slug, projectsDir, deliveries, cleanup } = boot();
  try {
    writeSession(dir, "sess-live", SESSION, 0); // mtime = now
    const ad = createClaudeSessionsAdapter({ deliveries, enabled: true, config: { workspaceSlug: slug, projectsDir, stableMs: 100_000 } });
    assert.equal(ad.scan().minted, 0, "fresh file not ingested");
    assert.equal(deliveries.list({}).length, 0);
  } finally { cleanup(); }
});

test("debounce coalesces a burst of fs events into a single scan", async () => {
  const { dir, slug, projectsDir, deliveries, cleanup } = boot();
  try {
    writeSession(dir, "sess-deb", SESSION);
    const ad = createClaudeSessionsAdapter({ deliveries, enabled: true, config: { workspaceSlug: slug, projectsDir, stableMs: 50, debounceMs: 100 } });
    for (let i = 0; i < 6; i++) ad.onFsEvent(); // a macOS-style event burst
    await new Promise((r) => setTimeout(r, 220)); // > the 100ms debounce floor
    assert.equal(ad.status().counts.scans, 1, "six events → exactly one scan");
    assert.equal(deliveries.list({}).length, 1);
  } finally { cleanup(); }
});

test("start/stop are safe; a config with no workspace slug reports an error state, not a crash", () => {
  const { deliveries, cleanup } = boot();
  try {
    const ad = createClaudeSessionsAdapter({ deliveries, enabled: true, config: { workspaceSlug: "" } });
    ad.start(); // no slug → no watch, records the reason
    assert.equal(ad.status().state, "error");
    assert.match(ad.status().lastError, /no workspace slug/);
    ad.stop(); // idempotent, no throw
  } finally { cleanup(); }
});
