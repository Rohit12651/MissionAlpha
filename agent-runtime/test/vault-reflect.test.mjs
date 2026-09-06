// MUNDER-ADOPTION A4 — condenser ladder invariants, pinned against a REAL vault
// (real sqlite, real files under tmp): backup-proven, verify-don't-trust, abort =
// zero mutation, remove only through the one door, pinned/summary never evicted.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../db.mjs";
import { createVault } from "../vault.mjs";
import { createVaultReflect, extractiveSummary, SUMMARY_PREFIX } from "../vault-reflect.mjs";

function harness({ keepK = 2, budgetBytes = 10, summarizeFn, minCoverage } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ma-reflect-"));
  const h = openDb({ path: join(root, "data", "mission.db"), patchesDir: join(root, "patches") });
  const emitted = [];
  const vault = createVault({ db: h, root: join(root, "vault"), events: { emit: (n, d) => emitted.push({ n, d }) }, scrub: (s) => s });
  vault.createVenture({ id: "waahyu", name: "Waahyu" });
  const reflect = createVaultReflect({
    vault, db: h.db,
    emit: (n, d) => emitted.push({ n, d }),
    keepK, budgetBytes, summarizeFn, minCoverage,
    log: () => {},
  });
  const write = (id, title, body = `Body of ${title}.\nMore.`) =>
    vault.write({ venture: "waahyu", node: "tech", id, title, author: "tester", body });
  return { root, h, vault, reflect, emitted, write, cleanup: () => { try { h.close(); } catch { /* */ } rmSync(root, { recursive: true, force: true }); } };
}

const liveIds = (x) => x.h.db.prepare("SELECT id FROM vault_records ORDER BY created_at").all().map((r) => r.id);

test("a lane under keepK or under byte budget is untouched", () => {
  const x = harness({ keepK: 5, budgetBytes: 1024 * 1024 });
  try {
    x.write("a-1", "First record");
    x.write("a-2", "Second record");
    assert.deepEqual(x.reflect.sweep(), []);
    assert.deepEqual(liveIds(x), ["a-1", "a-2"]);
  } finally { x.cleanup(); }
});

test("over budget: oldest evicted into ONE rolling summary; newest K stay verbatim; cold copies proven", () => {
  const x = harness({ keepK: 2, budgetBytes: 10 });
  try {
    for (let i = 1; i <= 5; i++) x.write(`r-${i}`, `Record number ${i}`);
    const out = x.reflect.sweep();
    assert.equal(out.length, 1);
    assert.equal(out[0].aborted, false);
    assert.equal(out[0].evicted, 3);
    // live lane = newest 2 + the rolling summary
    const ids = liveIds(x);
    assert.ok(ids.includes("r-4") && ids.includes("r-5"));
    assert.ok(ids.includes(`${SUMMARY_PREFIX}waahyu-tech`));
    assert.ok(!ids.includes("r-1") && !ids.includes("r-2") && !ids.includes("r-3"));
    // summary mentions every evicted title
    const sum = x.vault.get(`${SUMMARY_PREFIX}waahyu-tech`);
    for (const t of ["Record number 1", "Record number 2", "Record number 3"]) assert.ok(sum.body.includes(t), t);
    // cold copies exist and carry the original bytes
    const cold = join(x.vault.root, ".cold", "waahyu", "tech");
    assert.deepEqual(readdirSync(cold).sort(), ["r-1.md", "r-2.md", "r-3.md"]);
    assert.match(readFileSync(join(cold, "r-1.md"), "utf8"), /Record number 1/);
    // the bus announced exactly one condensation
    const frames = x.emitted.filter((e) => e.n === "vault.condensed");
    assert.equal(frames.length, 1);
    assert.equal(frames[0].d.evicted, 3);
  } finally { x.cleanup(); }
});

test("rolling: a second sweep folds NEW evictions on top of the existing summary", () => {
  const x = harness({ keepK: 2, budgetBytes: 10 });
  try {
    for (let i = 1; i <= 4; i++) x.write(`r-${i}`, `Record number ${i}`);
    x.reflect.sweep(); // evicts 1,2
    x.write("r-5", "Record number 5");
    x.write("r-6", "Record number 6");
    x.reflect.sweep(); // evicts 3,4 (and 5? live: 3,4,5,6 → keep 5,6, evict 3,4)
    const sum = x.vault.get(`${SUMMARY_PREFIX}waahyu-tech`);
    for (const t of ["Record number 1", "Record number 2", "Record number 3", "Record number 4"]) {
      assert.ok(sum.body.includes(t), `summary keeps ${t}`);
    }
    assert.deepEqual(liveIds(x).filter((i) => i.startsWith("r-")), ["r-5", "r-6"]);
  } finally { x.cleanup(); }
});

test("pinned- records and the summary itself are NEVER evicted", () => {
  const x = harness({ keepK: 1, budgetBytes: 10 });
  try {
    x.write("pinned-law", "Pinned durable fact");
    for (let i = 1; i <= 3; i++) x.write(`r-${i}`, `Record number ${i}`);
    x.reflect.sweep();
    const ids = liveIds(x);
    assert.ok(ids.includes("pinned-law"), "pinned survives");
    x.reflect.sweep(); // summary now exists; must not evict itself
    assert.ok(liveIds(x).includes(`${SUMMARY_PREFIX}waahyu-tech`));
    assert.ok(liveIds(x).includes("pinned-law"));
  } finally { x.cleanup(); }
});

test("VERIFY gate: a low-coverage summary ABORTS with zero mutation (condense-abort law)", () => {
  const x = harness({ keepK: 1, budgetBytes: 10, summarizeFn: () => "useless text mentioning nothing" });
  try {
    for (let i = 1; i <= 3; i++) x.write(`r-${i}`, `Record number ${i}`);
    const before = liveIds(x);
    const out = x.reflect.sweep();
    assert.equal(out[0].aborted, true);
    assert.match(out[0].reason, /coverage/);
    assert.deepEqual(liveIds(x), before, "nothing evicted, nothing written");
    assert.equal(x.emitted.filter((e) => e.n === "vault.condensed").length, 0);
  } finally { x.cleanup(); }
});

test("VERIFY gate: an empty or thrown summary aborts the same way", () => {
  for (const bad of [() => "", () => { throw new Error("model died"); }]) {
    const x = harness({ keepK: 1, budgetBytes: 10, summarizeFn: bad });
    try {
      for (let i = 1; i <= 3; i++) x.write(`r-${i}`, `Record number ${i}`);
      const out = x.reflect.sweep();
      assert.equal(out[0].aborted, true);
      assert.equal(liveIds(x).length, 3);
    } finally { x.cleanup(); }
  }
});

test("extractiveSummary trims whole OLDEST lines to the body cap, never mid-line", () => {
  const evicted = Array.from({ length: 2000 }, (_, i) => ({ title: `T${i} ${"x".repeat(40)}`, createdAt: 1700000000000 + i, firstLine: "y".repeat(60) }));
  const body = extractiveSummary("", evicted);
  assert.ok(body.length <= 32_768);
  assert.match(body, /trimmed to budget/);
  for (const line of body.split("\n")) assert.ok(line.length < 400);
});

test("status() reports config + the last sweep", () => {
  const x = harness({ keepK: 2, budgetBytes: 10 });
  try {
    for (let i = 1; i <= 3; i++) x.write(`r-${i}`, `Record number ${i}`);
    x.reflect.sweep();
    const s = x.reflect.status();
    assert.equal(s.keepK, 2);
    assert.ok(s.last && s.last.results.length === 1);
  } finally { x.cleanup(); }
});

test("vault.remove is guarded: unknown id 404, bad slug 400", () => {
  const x = harness();
  try {
    assert.equal(x.vault.remove("nope-nope").code, 404);
    assert.equal(x.vault.remove("../evil").code, 400);
    x.write("gone-1", "Removable");
    const p = x.h.db.prepare("SELECT path FROM vault_records WHERE id='gone-1'").get().path;
    assert.ok(existsSync(p));
    assert.equal(x.vault.remove("gone-1").removed, true);
    assert.ok(!existsSync(p));
  } finally { x.cleanup(); }
});
