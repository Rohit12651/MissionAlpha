// P7 / ADR-054 — adapter lifecycle + config manager. Adapters are STUBBED (start/stop
// observed) so the manager's contract is isolated from gh/fs. Proves: fail-closed config,
// per-adapter enable flags drive startAll, strict save validation + hot-reload, and
// decide routing to the github adapter.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAdapters, normalizeAdapterConfig } from "../adapters/index.mjs";

const deliveries = { /* the manager only forwards this to the adapters */ };

function stub(name) {
  const events = [];
  const make = (o) => ({
    name, opts: o,
    start() { events.push(`${name}:start`); },
    stop() { events.push(`${name}:stop`); },
    status() { return { adapter: name, enabled: !!o.enabled }; },
    decideExternal: async (a) => ({ ok: true, from: name, verb: a.verb }),
  });
  return { make, events };
}

function boot(fileContent) {
  const root = mkdtempSync(join(tmpdir(), "ma-p7-ix-"));
  const file = join(root, "adapters.json");
  if (fileContent !== undefined) writeFileSync(file, fileContent);
  const gh = stub("github");
  const cc = stub("claude-code");
  const mgr = createAdapters({ deliveries, file, makeGithub: gh.make, makeClaude: cc.make });
  return { root, file, mgr, gh, cc, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// ── pure validator ──────────────────────────────────────────────────────────
test("normalizeAdapterConfig defaults to all-disabled and clamps the poll interval", () => {
  const c = normalizeAdapterConfig({});
  assert.equal(c.github.enabled, false);
  assert.equal(c.claudeCode.enabled, false);
  const clamped = normalizeAdapterConfig({ github: { pollIntervalMs: 10 } }); // lenient: below floor → default
  assert.equal(clamped.github.pollIntervalMs, 60_000);
});

test("strict validation rejects enabling an adapter without its required config", () => {
  assert.throws(() => normalizeAdapterConfig({ github: { enabled: true, botAuthors: [] } }, { strict: true }), /botAuthor/);
  assert.throws(() => normalizeAdapterConfig({ claudeCode: { enabled: true, workspaceSlug: "" } }, { strict: true }), /workspaceSlug/);
  assert.throws(() => normalizeAdapterConfig({ github: { enabled: true, botAuthors: ["x"], pollIntervalMs: 5 } }, { strict: true }), /pollIntervalMs/);
});

// ── lifecycle ─────────────────────────────────────────────────────────────────
test("no config file → all disabled, valid true, startAll starts nothing", () => {
  const { mgr, gh, cc, cleanup } = boot(); // no file
  try {
    const st = mgr.status();
    assert.equal(st.valid, true);
    assert.equal(st.github.enabled, false);
    assert.equal(st.claudeCode.enabled, false);
    mgr.startAll();
    assert.deepEqual([...gh.events, ...cc.events].filter((e) => e.endsWith(":start")), []);
  } finally { cleanup(); }
});

test("a corrupt config file fails closed to all-disabled with valid=false", () => {
  const { mgr, cleanup } = boot("{ not json");
  try {
    assert.equal(mgr.valid(), false);
    assert.equal(mgr.status().github.enabled, false);
  } finally { cleanup(); }
});

test("an enabled github config makes startAll start ONLY github", () => {
  const { mgr, gh, cc, cleanup } = boot(JSON.stringify({ github: { enabled: true, botAuthors: ["cursor"] } }));
  try {
    mgr.startAll();
    assert.ok(gh.events.includes("github:start"));
    assert.ok(!cc.events.includes("claude-code:start"));
  } finally { cleanup(); }
});

test("save validates, persists to disk, and hot-reloads (stop → rebuild → start enabled)", () => {
  const { mgr, file, gh, cleanup } = boot();
  try {
    const saved = mgr.save({ github: { enabled: true, botAuthors: ["cursor", "devin"], pollIntervalMs: 30_000 }, claudeCode: { enabled: false } });
    assert.equal(saved.github.enabled, true);
    assert.deepEqual(saved.github.botAuthors, ["cursor", "devin"]);
    assert.ok(existsSync(file), "persisted");
    const onDisk = JSON.parse(readFileSync(file, "utf-8"));
    assert.equal(onDisk.github.pollIntervalMs, 30_000);
    // the new github adapter was started as part of the hot-reload
    assert.ok(gh.events.includes("github:start"));
    // an invalid save never touches the reloaded state (throws before persist)
    assert.throws(() => mgr.save({ github: { enabled: true, botAuthors: [] } }), /botAuthor/);
  } finally { cleanup(); }
});

test("decideExternal routes to the github adapter", async () => {
  const { mgr, cleanup } = boot(JSON.stringify({ github: { enabled: true, botAuthors: ["x"] } }));
  try {
    const r = await mgr.decideExternal({ verb: "approve", meta: { prNumber: 1 } });
    assert.equal(r.from, "github");
    assert.equal(r.verb, "approve");
  } finally { cleanup(); }
});
