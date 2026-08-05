// B5 — kpiClient pure layer: the tile formatter, the trend guard, the ventures empty-
// state selector and the query builder. Zero DOM, zero network, so it runs under
// `node --experimental-strip-types`. These pin the honest-numbers contract at the
// client edge: a pending metric renders "—" (never a fake 0); a delta shows ONLY when a
// real prior-window number exists (never a fabricated +0%).
import { test } from "node:test";
import assert from "node:assert/strict";
import { tile, hasTrend, venturesEmptyState, kpiQuery, type VentureKpi } from "../kpiClient.ts";

// ── tile(value, {pending}) ────────────────────────────────────────────────────
test("tile formats a real integer, and renders 0 honestly", () => {
  assert.equal(tile(5), "5");
  assert.equal(tile(0), "0");
  assert.equal(tile(1234), "1234");
  assert.equal(tile(7.9), "7", "floors rather than rounding up a partial count");
});

test('tile renders "—" for a pending metric — never a fabricated 0', () => {
  assert.equal(tile(0, { pending: true }), "—");
  assert.equal(tile(42, { pending: true }), "—");
});

test('tile renders "—" for a non-finite or impossible value', () => {
  assert.equal(tile(Number.NaN), "—");
  assert.equal(tile(Infinity), "—");
  assert.equal(tile(-3), "—", "a negative count is impossible → unknown, not 0");
});

// ── hasTrend(prior) ───────────────────────────────────────────────────────────
test("hasTrend is true only when a real prior-window number exists", () => {
  assert.equal(hasTrend(10), true);
  assert.equal(hasTrend(0), true, "a real prior of 0 still supports a delta");
  assert.equal(hasTrend(null), false);
  assert.equal(hasTrend(undefined), false);
  assert.equal(hasTrend(Number.NaN), false);
});

// ── venturesEmptyState(ventures) ──────────────────────────────────────────────
const v = (id: string, name: string, records = 0): VentureKpi => ({ id, name, records, pending: 0 });

test("venturesEmptyState names the single venture, and clears once there are two", () => {
  assert.match(venturesEmptyState([v("waahyu", "WAAHYU")]) ?? "", /WAAHYU/);
  assert.match(venturesEmptyState([v("waahyu", "WAAHYU")]) ?? "", /one venture/i);
  assert.equal(venturesEmptyState([v("waahyu", "WAAHYU"), v("acme", "Acme")]), null, "a real list is not an empty state");
});

test("venturesEmptyState has an honest copy when there are no ventures at all", () => {
  const s = venturesEmptyState([]);
  assert.ok(typeof s === "string" && s.length > 0);
});

// ── kpiQuery(venture, window) ─────────────────────────────────────────────────
test("kpiQuery omits the venture param for the all-ventures scope", () => {
  assert.equal(kpiQuery(null, "1d"), "/runtime/bos/kpis?window=1d");
});

test("kpiQuery includes a slug venture and a valid window", () => {
  assert.equal(kpiQuery("waahyu", "7d"), "/runtime/bos/kpis?venture=waahyu&window=7d");
});

test("kpiQuery drops a non-slug venture rather than sending it to the server", () => {
  assert.equal(kpiQuery("Bad Venture!", "1d"), "/runtime/bos/kpis?window=1d");
  assert.equal(kpiQuery("../etc", "1d"), "/runtime/bos/kpis?window=1d");
});

test("kpiQuery falls back to a safe window when handed a malformed one", () => {
  assert.equal(kpiQuery(null, "bogus"), "/runtime/bos/kpis?window=1d");
  assert.equal(kpiQuery(null, "999d"), "/runtime/bos/kpis?window=999d");
});
