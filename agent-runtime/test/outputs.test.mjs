// B7 / outputs — the artifact registry store: the always-available REAL generators, a SQLite
// row per PRODUCED artifact, venture scoping (with GLOBAL '' artifacts), scrub-at-rest + on
// egress, CASE-REFUSING slug-only containment on id/kind/venture, idempotent record-by-id, and
// emit-on-persist for every recorded artifact.
//
// The HTTP surface (viewer gate, GET shape, record-on-audit-export + SSE emit) is proven in
// outputs-http.test.mjs. This file pins the pure store.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../db.mjs";
import {
  createOutputs,
  AUDIT_GENERATOR,
  MAX_OUTPUT_LABEL,
  MAX_OUTPUT_REF,
} from "../outputs.mjs";

const SECRET_RE = /sk-ant-[A-Za-z0-9_-]{6,}/g;
const scrub = (s) => (typeof s === "string" ? s.replace(SECRET_RE, "[redacted-secret]") : s);

function harness(over = {}) {
  const root = mkdtempSync(join(tmpdir(), "ma-outputs-"));
  const h = openDb({ path: join(root, "data", "mission.db") });
  const events = { emitted: [], emit(name, data) { this.emitted.push({ name, data }); } };
  const audits = [];
  const o = createOutputs({ db: h, scrub, events, audit: (action, meta) => audits.push({ action, meta }), ...over });
  return { root, h, o, events, audits, cleanup: () => { h.close(); rmSync(root, { recursive: true, force: true }); } };
}

// ── migration v13 ───────────────────────────────────────────────────────────
test("db reaches v13 and the outputs table exists", () => {
  const { h, cleanup } = harness();
  try {
    assert.ok(h.version() >= 13, `expected >= v13, got ${h.version()}`);
    const cols = h.db.prepare("PRAGMA table_info(outputs)").all().map((c) => c.name).sort();
    assert.deepEqual(cols, ["created_at", "id", "kind", "label", "ref", "venture"]);
  } finally { cleanup(); }
});

// ── generators (the honest, always-available capability list) ─────────────────
test("generators() ALWAYS lists the audit export (kind:'audit', ref:'/runtime/audit/export')", () => {
  const { o, cleanup } = harness();
  try {
    const gens = o.generators();
    const audit = gens.find((g) => g.kind === "audit");
    assert.ok(audit, "audit generator must always be present");
    assert.equal(audit.ref, "/runtime/audit/export");
    // The exported constant is the single source; generators() returns a copy of it.
    assert.equal(AUDIT_GENERATOR.kind, "audit");
    assert.equal(AUDIT_GENERATOR.ref, "/runtime/audit/export");
  } finally { cleanup(); }
});

test("an EMPTY produced set is honest: generators present, list() is []", () => {
  const { o, cleanup } = harness();
  try {
    assert.ok(o.generators().length >= 1);
    assert.deepEqual(o.list({}), []);
    assert.deepEqual(o.list({ venture: "waahyu" }), []);
  } finally { cleanup(); }
});

// ── record (emit-on-persist, slug id, scrub) ──────────────────────────────────
test("record() persists, mints a slug id, and emits output.created{id,kind,venture}", () => {
  const { o, events, audits, cleanup } = harness();
  try {
    const row = o.record({ kind: "audit", venture: "waahyu", label: "Audit bundle · 2026-07-30", ref: "/runtime/audit/export?format=json" });
    assert.ok(/^[a-z0-9][a-z0-9-]{0,63}$/.test(row.id));
    assert.equal(row.kind, "audit");
    assert.equal(row.venture, "waahyu");
    assert.equal(row.label, "Audit bundle · 2026-07-30");
    assert.equal(row.ref, "/runtime/audit/export?format=json");
    const ev = events.emitted.find((e) => e.name === "output.created");
    assert.ok(ev, "output.created must be emitted");
    assert.deepEqual(ev.data, { id: row.id, kind: "audit", venture: "waahyu" });
    assert.ok(audits.some((a) => a.action === "output.created"));
  } finally { cleanup(); }
});

test("a GLOBAL artifact carries no venture: '' persists and hydrates to null", () => {
  const { o, events, cleanup } = harness();
  try {
    const row = o.record({ kind: "audit", label: "Audit bundle · all time", ref: "/runtime/audit/export" });
    assert.equal(row.venture, null);
    const ev = events.emitted.find((e) => e.name === "output.created");
    assert.deepEqual(ev.data, { id: row.id, kind: "audit", venture: null });
  } finally { cleanup(); }
});

test("record() requires a label; an empty label is a 400 verdict", () => {
  const { o, cleanup } = harness();
  try {
    assert.equal(o.record({ kind: "audit", label: "" }).code, 400);
    assert.equal(o.record({ kind: "audit", label: "   " }).code, 400);
  } finally { cleanup(); }
});

test("record() requires a slug kind; a non-slug/UPPERCASE kind is a 400", () => {
  const { o, cleanup } = harness();
  try {
    assert.equal(o.record({ kind: "", label: "x" }).code, 400);
    assert.equal(o.record({ kind: "AUDIT", label: "x" }).code, 400);
    assert.equal(o.record({ kind: "au/dit", label: "x" }).code, 400);
  } finally { cleanup(); }
});

// ── idempotency (no per-GET spam) ─────────────────────────────────────────────
test("record() is idempotent by id: a re-record dedupes and does NOT emit again", () => {
  const { o, events, cleanup } = harness();
  try {
    const a = o.record({ id: "audit-2026-07-30-all-all-json", kind: "audit", label: "first", ref: "/x" });
    const b = o.record({ id: "audit-2026-07-30-all-all-json", kind: "audit", label: "second", ref: "/y" });
    assert.equal(b.deduped, true);
    assert.equal(b.id, a.id);
    assert.equal(b.label, "first"); // first write wins
    const emits = events.emitted.filter((e) => e.name === "output.created");
    assert.equal(emits.length, 1, "a deduped re-record must not emit a second frame");
    assert.equal(o.list({}).length, 1);
  } finally { cleanup(); }
});

// ── security: slug containment ────────────────────────────────────────────────
test("a non-slug or UPPERCASE venture/id is REFUSED (400), never folded", () => {
  const { o, cleanup } = harness();
  try {
    assert.equal(o.record({ kind: "audit", venture: "../etc", label: "x" }).code, 400);
    assert.equal(o.record({ kind: "audit", venture: "WAAHYU", label: "x" }).code, 400);
    assert.equal(o.record({ id: "Audit-1", kind: "audit", label: "x" }).code, 400);
    assert.equal(o.record({ id: "a/../b", kind: "audit", label: "x" }).code, 400);
  } finally { cleanup(); }
});

// ── security: scrub at rest AND on egress ─────────────────────────────────────
test("a secret in label/ref is scrubbed at rest and on egress", () => {
  const { o, h, cleanup } = harness();
  try {
    const secret = "sk-ant-abc123DEF456";
    const row = o.record({ kind: "audit", label: `bundle ${secret}`, ref: `/runtime/audit/export?x=${secret}` });
    assert.equal(row.label.includes(secret), false);
    assert.equal(row.ref.includes(secret), false);
    const raw = h.db.prepare("SELECT label, ref FROM outputs WHERE id = ?").get(row.id);
    assert.equal(raw.label.includes(secret), false);
    assert.equal(raw.ref.includes(secret), false);
  } finally { cleanup(); }
});

// ── caps ──────────────────────────────────────────────────────────────────────
test("label/ref are capped at their limits", () => {
  const { o, cleanup } = harness();
  try {
    const row = o.record({ kind: "audit", label: "l".repeat(500), ref: "r".repeat(900) });
    assert.equal(row.label.length, MAX_OUTPUT_LABEL);
    assert.equal(row.ref.length, MAX_OUTPUT_REF);
  } finally { cleanup(); }
});

// ── list (venture/kind scoped, newest first) ──────────────────────────────────
test("list() is venture- and kind-scoped; unknown filter → []", () => {
  const { o, cleanup } = harness();
  try {
    o.record({ kind: "audit", venture: "waahyu", label: "A" });
    o.record({ kind: "audit", venture: "acme", label: "B" });
    o.record({ kind: "digest", venture: "waahyu", label: "C" });
    assert.equal(o.list({ venture: "waahyu" }).length, 2);
    assert.equal(o.list({ venture: "waahyu", kind: "audit" }).length, 1);
    assert.equal(o.list({ venture: "../x" }).length, 0);
    assert.equal(o.list({ kind: "AUDIT" }).length, 0);
    assert.equal(o.list({}).length, 3);
  } finally { cleanup(); }
});

test("list() under a venture scope INCLUDES global ('') artifacts (audit bundle is cross-venture)", () => {
  const { o, cleanup } = harness();
  try {
    o.record({ kind: "audit", label: "global audit" });          // venture '' → global
    o.record({ kind: "digest", venture: "waahyu", label: "wa" }); // venture-scoped
    o.record({ kind: "digest", venture: "acme", label: "ac" });   // other venture
    const rows = o.list({ venture: "waahyu" });
    const labels = rows.map((r) => r.label).sort();
    assert.deepEqual(labels, ["global audit", "wa"], "waahyu scope shows its own row + the global one, not acme's");
    assert.ok(rows.some((r) => r.venture === null), "the global row hydrates to venture null");
  } finally { cleanup(); }
});

test("list() returns produced outputs NEWEST first", () => {
  let t = 1_000;
  const { o, cleanup } = harness({ now: () => (t += 1000) });
  try {
    const a = o.record({ kind: "audit", venture: "waahyu", label: "oldest" });
    const b = o.record({ kind: "audit", venture: "waahyu", label: "middle" });
    const c = o.record({ kind: "audit", venture: "waahyu", label: "newest" });
    const ids = o.list({ venture: "waahyu" }).map((r) => r.id);
    assert.deepEqual(ids, [c.id, b.id, a.id]);
  } finally { cleanup(); }
});

// ── get ────────────────────────────────────────────────────────────────────
test("get() returns a hydrated row or null; a non-slug id is null", () => {
  const { o, cleanup } = harness();
  try {
    const row = o.record({ kind: "audit", venture: "waahyu", label: "A" });
    assert.equal(o.get(row.id).id, row.id);
    assert.equal(o.get("../etc"), null);
    assert.equal(o.get("nope"), null);
  } finally { cleanup(); }
});
