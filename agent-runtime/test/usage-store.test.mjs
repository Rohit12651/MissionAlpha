// P8 / ADR-030 — persisted usage accumulation + emit-on-persist `usage.tick`.
// Token/context ONLY — asserts NO cost/USD/$ field EVER appears on the wire or at rest.
// Runs over a THROWAWAY temp DB (never the live agent-runtime/data/).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../db.mjs";
import { createUsageStore, usageFromResult, estimateUsage } from "../usage.mjs";

const W = 200000;

// A store over a fresh temp DB, with a capturing emit + a fixed clock. Returns
// { store, emitted, db, cleanup }.
function freshStore({ nowMs = Date.parse("2026-07-30T12:00:00Z") } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ma-usage-store-"));
  const handle = openDb({ path: join(root, "db", "mission.db") });
  const emitted = [];
  const store = createUsageStore({
    db: handle.db,
    emit: (name, data) => emitted.push({ name, data }),
    now: () => nowMs,
  });
  return { store, emitted, db: handle.db, cleanup: () => { handle.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("migration ladder reaches the usage table (v7)", () => {
  const { db, cleanup } = freshStore();
  try {
    const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='usage'").get();
    assert.ok(t, "usage table exists after migrate()");
  } finally { cleanup(); }
});

test("accumulates per agentId × tier × UTC-day; two turns in one bucket sum", () => {
  const { store, db, cleanup } = freshStore();
  try {
    store.record({ agentId: "u1", tier: "sonnet", turn: usageFromResult({ input_tokens: 10, output_tokens: 20 }, "sonnet", W) });
    store.record({ agentId: "u1", tier: "sonnet", turn: usageFromResult({ input_tokens: 5, output_tokens: 7 }, "sonnet", W) });
    const row = db.prepare("SELECT * FROM usage WHERE agentId='u1' AND tier='sonnet'").get();
    assert.equal(row.inputTokens, 15);
    assert.equal(row.outputTokens, 27);
    assert.equal(row.turns, 2, "two turns folded into one bucket");
    assert.equal(row.day, "2026-07-30");
  } finally { cleanup(); }
});

test("different tier → separate row (per-tier accumulation)", () => {
  const { store, db, cleanup } = freshStore();
  try {
    store.record({ agentId: "u1", tier: "sonnet", turn: usageFromResult({ input_tokens: 10 }, "sonnet", W) });
    store.record({ agentId: "u1", tier: "opus", turn: usageFromResult({ input_tokens: 30 }, "opus", W) });
    const rows = db.prepare("SELECT tier, inputTokens FROM usage WHERE agentId='u1' ORDER BY tier").all();
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => [r.tier, r.inputTokens]), [["opus", 30], ["sonnet", 10]]);
  } finally { cleanup(); }
});

test("real cli token fields → estimated=0; chars/4 estimate → estimated=1 (flagged)", () => {
  const { store, db, cleanup } = freshStore();
  try {
    store.record({ agentId: "real", tier: "opus", turn: usageFromResult({ input_tokens: 99 }, "opus", W) });
    store.record({ agentId: "est", tier: "opus", turn: estimateUsage(400, 200, "opus", W) });
    assert.equal(db.prepare("SELECT estimated FROM usage WHERE agentId='real'").get().estimated, 0);
    const e = db.prepare("SELECT estimated, inputTokens, outputTokens FROM usage WHERE agentId='est'").get();
    assert.equal(e.estimated, 1, "estimate flagged at rest");
    assert.equal(e.inputTokens, 100); // 400/4
    assert.equal(e.outputTokens, 50); // 200/4
  } finally { cleanup(); }
});

test("estimated flag is last-turn-wins (real then estimate flips to 1)", () => {
  const { store, db, cleanup } = freshStore();
  try {
    store.record({ agentId: "mix", tier: "sonnet", turn: usageFromResult({ input_tokens: 10 }, "sonnet", W) });
    store.record({ agentId: "mix", tier: "sonnet", turn: estimateUsage(40, 40, "sonnet", W) });
    assert.equal(db.prepare("SELECT estimated FROM usage WHERE agentId='mix'").get().estimated, 1);
  } finally { cleanup(); }
});

test("context% per tier is stored + surfaced from the latest turn (last-wins)", () => {
  const { store, emitted, cleanup } = freshStore();
  try {
    // opus window fill 79821/200000 (cacheCreation counts toward context)
    store.record({ agentId: "c", tier: "opus", turn: usageFromResult({ input_tokens: 9, cache_creation_input_tokens: 79812 }, "opus", W) });
    const tick = emitted.at(-1).data;
    assert.ok(Math.abs(tick.contextPct - (79821 / W)) < 1e-9, "contextPct = contextTokens / window");
    assert.equal(tick.contextWindow, W);
    assert.equal(tick.contextTokens, 79821);
  } finally { cleanup(); }
});

test("emit-once-per-turn: record emits exactly one usage.tick", () => {
  const { store, emitted, cleanup } = freshStore();
  try {
    store.record({ agentId: "u1", tier: "sonnet", turn: usageFromResult({ input_tokens: 1 }, "sonnet", W) });
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].name, "usage.tick");
    store.record({ agentId: "u1", tier: "sonnet", turn: usageFromResult({ input_tokens: 1 }, "sonnet", W) });
    assert.equal(emitted.length, 2, "one tick per record, no double emit");
  } finally { cleanup(); }
});

test("usage.tick payload carries NO cost/USD/$ field (BOSS hard rule)", () => {
  const { store, emitted, cleanup } = freshStore();
  try {
    // even if the cli result smuggles a cost field, it must not surface
    store.record({ agentId: "u1", tier: "opus", turn: usageFromResult({ input_tokens: 1, output_tokens: 1, total_cost_usd: 4.2 }, "opus", W) });
    const json = JSON.stringify(emitted[0].data).toLowerCase();
    assert.ok(!/cost|usd|dollar|price|\$/.test(json), "no cost-shaped key on the tick");
    assert.equal(emitted[0].data.total_cost_usd, undefined);
  } finally { cleanup(); }
});

test("tick tokens are day-cumulative (total spend), context% is the latest window fill", () => {
  const { store, emitted, cleanup } = freshStore();
  try {
    store.record({ agentId: "u1", tier: "sonnet", turn: usageFromResult({ input_tokens: 10, output_tokens: 5 }, "sonnet", W) });
    store.record({ agentId: "u1", tier: "sonnet", turn: usageFromResult({ input_tokens: 4, output_tokens: 3 }, "sonnet", W) });
    const tick = emitted.at(-1).data;
    assert.equal(tick.inputTokens, 14, "cumulative today");
    assert.equal(tick.outputTokens, 8);
    assert.equal(tick.turns, 2);
  } finally { cleanup(); }
});

test("iterateRange filters by UTC day (inclusive); totalsRange aggregates + splits by tier", () => {
  let day = Date.parse("2026-07-28T00:00:00Z");
  const root = mkdtempSync(join(tmpdir(), "ma-usage-range-"));
  const handle = openDb({ path: join(root, "db", "mission.db") });
  const store = createUsageStore({ db: handle.db, emit: () => {}, now: () => day });
  try {
    store.record({ agentId: "a", tier: "sonnet", turn: usageFromResult({ input_tokens: 100, output_tokens: 10 }, "sonnet", W) });
    day = Date.parse("2026-07-29T00:00:00Z");
    store.record({ agentId: "a", tier: "opus", turn: usageFromResult({ input_tokens: 200, output_tokens: 20 }, "opus", W) });
    day = Date.parse("2026-07-30T00:00:00Z");
    store.record({ agentId: "b", tier: "sonnet", turn: usageFromResult({ input_tokens: 300, output_tokens: 30 }, "sonnet", W) });

    const mid = [...store.iterateRange({ from: "2026-07-29T00:00:00Z", to: "2026-07-29T23:59:59Z" })];
    assert.equal(mid.length, 1);
    assert.equal(mid[0].tier, "opus");

    const tot = store.totalsRange({ from: "2026-07-28", to: "2026-07-30" });
    assert.equal(tot.inputTokens, 600);
    assert.equal(tot.outputTokens, 60);
    assert.equal(tot.turns, 3);
    assert.equal(tot.byTier.sonnet.inputTokens, 400); // a(100)+b(300)
    assert.equal(tot.byTier.opus.inputTokens, 200);

    const openRange = [...store.iterateRange({})];
    assert.equal(openRange.length, 3, "no bounds → all rows");
  } finally { handle.close(); rmSync(root, { recursive: true, force: true }); }
});

test("snapshot: per-thread rows + per-agent aggregate for today", () => {
  const { store, cleanup } = freshStore();
  try {
    store.record({ agentId: "a", threadId: "a", tier: "sonnet", turn: usageFromResult({ input_tokens: 10, output_tokens: 2 }, "sonnet", W) });
    store.record({ agentId: "a", threadId: "task_abc123", tier: "opus", turn: usageFromResult({ input_tokens: 5, output_tokens: 1 }, "opus", W) });
    const snap = store.snapshot();
    assert.equal(snap.threads.length, 2, "two threads for agent a");
    const agentA = snap.agents.find((x) => x.agentId === "a");
    assert.equal(agentA.inputTokens, 15, "per-agent aggregate sums its threads");
    assert.equal(agentA.outputTokens, 3);
    assert.equal(agentA.turns, 2);
  } finally { cleanup(); }
});
