// B2 / ADR-055 — the Vault client's PURE layer: the markdown line parser (the thing
// standing between an agent-authored body and the DOM), the node meta table pinned to
// the server's closed taxonomy, the venture-scope helpers and the query builders.
// No DOM, no network — the fetchers are proven at the wire in vault-http.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  VAULT_NODES,
  NODE_META,
  isVaultNode,
  nodeLabel,
  normalizeVenture,
  ventureOptions,
  parseMdLines,
  recordDate,
  recordCountLabel,
  vaultQuery,
  statsQuery,
  VENTURE_STORAGE_KEY,
  type VaultStats,
} from "../vaultClient.ts";

// ── the closed taxonomy (mirrors agent-runtime/vault.mjs VAULT_NODES) ────────

test("VAULT_NODES is EXACTLY the server's six nodes, in the server's order", () => {
  // MUST stay identical to agent-runtime/vault.mjs VAULT_NODES and the migration's
  // CHECK constraint: a node here the server rejects is a filter that silently
  // returns nothing; a node the server has that is missing here is unreachable UI.
  assert.deepEqual([...VAULT_NODES], ["ventures", "market", "content", "pipeline", "tech", "decisions"]);
});

test("every node has a label and a blurb — no fallback path in the graph", () => {
  for (const n of VAULT_NODES) {
    assert.ok(NODE_META[n], n);
    assert.ok(NODE_META[n].label.length > 0, n);
    assert.ok(NODE_META[n].blurb.length > 0, n);
  }
  assert.equal(Object.keys(NODE_META).length, VAULT_NODES.length, "no meta entry for a node that does not exist");
});

test("isVaultNode narrows only the six; nodeLabel degrades to the raw string", () => {
  assert.equal(isVaultNode("market"), true);
  assert.equal(isVaultNode("finance"), false);
  assert.equal(isVaultNode("MARKET"), false, "case matters — the server refuses uppercase");
  assert.equal(isVaultNode("../etc"), false);
  assert.equal(nodeLabel("decisions"), "Decisions");
  assert.equal(nodeLabel("mystery"), "mystery");
});

// ── the markdown parser — the ONLY thing between an agent body and the DOM ───

test("parseMdLines classifies headings, list items, fenced code and paragraphs", () => {
  const body = [
    "# Findings",
    "",
    "Three new entrants.",
    "",
    "## Detail",
    "- one",
    "* two",
    "3. three",
    "```",
    "const x = 1;",
    "",
    "```",
    "tail paragraph",
  ].join("\n");
  assert.deepEqual(parseMdLines(body), [
    { kind: "h1", text: "Findings" },
    { kind: "p", text: "Three new entrants." },
    { kind: "h2", text: "Detail" },
    { kind: "li", text: "one" },
    { kind: "li", text: "two" },
    { kind: "li", text: "three" },
    { kind: "code", text: "const x = 1;" },
    { kind: "code", text: "" },
    { kind: "p", text: "tail paragraph" },
  ]);
});

test("parseMdLines treats ### and deeper as h2 (the viewer has two heading levels)", () => {
  assert.deepEqual(parseMdLines("### deep\n#### deeper"), [
    { kind: "h2", text: "deep" },
    { kind: "h2", text: "deeper" },
  ]);
});

test("parseMdLines returns [] for empty / non-string input (never throws on a bad body)", () => {
  assert.deepEqual(parseMdLines(""), []);
  assert.deepEqual(parseMdLines("\n\n   \n"), []);
  assert.deepEqual(parseMdLines(undefined as unknown as string), []);
  assert.deepEqual(parseMdLines(null as unknown as string), []);
  assert.deepEqual(parseMdLines(42 as unknown as string), []);
});

test("parseMdLines NEVER produces markup — HTML in a body stays literal TEXT", () => {
  // This is the XSS invariant made executable. The parser emits `text`, the viewer
  // renders it as a React text node, so a body carrying a script tag is DISPLAYED.
  const hostile = [
    "<script>alert(1)</script>",
    "# <img src=x onerror=alert(1)>",
    "- <iframe src=javascript:alert(1)></iframe>",
    "<div onclick=\"steal()\">click</div>",
    "[link](javascript:alert(1))",
  ].join("\n");
  const lines = parseMdLines(hostile);
  assert.deepEqual(lines, [
    { kind: "p", text: "<script>alert(1)</script>" },
    { kind: "h1", text: "<img src=x onerror=alert(1)>" },
    { kind: "li", text: "<iframe src=javascript:alert(1)></iframe>" },
    { kind: "p", text: "<div onclick=\"steal()\">click</div>" },
    { kind: "p", text: "[link](javascript:alert(1))" },
  ]);
  // Every field is a plain string — there is no `html` key for a sink to consume.
  for (const l of lines) {
    assert.deepEqual(Object.keys(l).sort(), ["kind", "text"]);
    assert.equal(typeof l.text, "string");
  }
});

test("parseMdLines leaves inline markers verbatim rather than half-rendering them", () => {
  assert.deepEqual(parseMdLines("**bold** and `code` and _em_"), [
    { kind: "p", text: "**bold** and `code` and _em_" },
  ]);
});

test("parseMdLines keeps an unclosed fence as code rather than losing the tail", () => {
  assert.deepEqual(parseMdLines("```\nline one\nline two"), [
    { kind: "code", text: "line one" },
    { kind: "code", text: "line two" },
  ]);
});

// ── venture scope ───────────────────────────────────────────────────────────

test("normalizeVenture accepts a slug, and turns everything else into ALL (null)", () => {
  assert.equal(normalizeVenture("waahyu"), "waahyu");
  assert.equal(normalizeVenture("  orbit  "), "orbit");
  assert.equal(normalizeVenture("all"), null, "the sentinel for no filter");
  assert.equal(normalizeVenture(""), null);
  assert.equal(normalizeVenture(null), null);
  assert.equal(normalizeVenture(undefined), null);
  // A corrupted localStorage value degrades to "all ventures", never to a request the
  // server would refuse — and never to a path component.
  for (const bad of ["../../etc", "/etc", "WAAHYU", "a b", "a/b", "x".repeat(90)]) {
    assert.equal(normalizeVenture(bad), null, bad);
  }
  assert.equal(VENTURE_STORAGE_KEY, "ma.bos.venture");
});

test("ventureOptions lists every scope from byVenture, sorted, with live counts", () => {
  const stats: VaultStats = {
    total: 3,
    byNode: { ventures: 0, market: 2, content: 0, pipeline: 0, tech: 0, decisions: 1 },
    byVenture: { waahyu: 2, orbit: 1, dormant: 0 },
    ventures: [
      { id: "waahyu", name: "WAAHYU", createdAt: "2026-07-01T00:00:00.000Z", records: 2 },
      { id: "orbit", name: "Orbit", createdAt: "2026-07-02T00:00:00.000Z", records: 1 },
    ],
  };
  const opts = ventureOptions(stats);
  assert.deepEqual(opts.map((v) => v.id), ["dormant", "orbit", "waahyu"]);
  assert.equal(opts.find((v) => v.id === "waahyu")?.name, "WAAHYU");
  // A venture present in byVenture but missing from `ventures` still lists (it is a
  // real scope) with its id as the name — never dropped from the switcher.
  assert.equal(opts.find((v) => v.id === "dormant")?.name, "dormant");
  assert.equal(opts.find((v) => v.id === "dormant")?.records, 0);
  assert.deepEqual(ventureOptions(null), []);
});

// ── formatting ──────────────────────────────────────────────────────────────

test("recordDate formats a stamp and degrades to '' on an unparseable one", () => {
  assert.match(recordDate("2026-07-30T14:05:00.000Z"), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(recordDate("not-a-date"), "");
  assert.equal(recordDate(""), "");
});

test("recordCountLabel pluralises and floors at 'no records'", () => {
  assert.equal(recordCountLabel(0), "no records");
  assert.equal(recordCountLabel(1), "1 record");
  assert.equal(recordCountLabel(12), "12 records");
  assert.equal(recordCountLabel(-3), "no records");
  assert.equal(recordCountLabel(NaN), "no records");
});

// ── query builders ──────────────────────────────────────────────────────────

test("vaultQuery emits only the params the server accepts, clamped", () => {
  assert.equal(vaultQuery(), "/runtime/vault");
  assert.equal(vaultQuery({ venture: "waahyu" }), "/runtime/vault?venture=waahyu");
  assert.equal(vaultQuery({ node: "market" }), "/runtime/vault?node=market");
  assert.equal(vaultQuery({ q: "  alpha sweep  " }), "/runtime/vault?q=alpha%20sweep");
  assert.equal(vaultQuery({ limit: 999 }), "/runtime/vault?limit=200", "clamped to the server's max");
  assert.equal(vaultQuery({ limit: 0 }), "/runtime/vault?limit=1");
  assert.equal(vaultQuery({ offset: -5 }), "/runtime/vault?offset=0");
  // A hostile venture/node never reaches the wire — it is dropped, not sent.
  assert.equal(vaultQuery({ venture: "../../etc" }), "/runtime/vault");
  assert.equal(vaultQuery({ node: "finance" as never }), "/runtime/vault");
  assert.equal(vaultQuery({ venture: null, node: null, q: "   " }), "/runtime/vault");
});

test("statsQuery scopes to a venture only when the scope is a real slug", () => {
  assert.equal(statsQuery(), "/runtime/vault/stats");
  assert.equal(statsQuery(null), "/runtime/vault/stats");
  assert.equal(statsQuery("waahyu"), "/runtime/vault/stats?venture=waahyu");
  assert.equal(statsQuery("../../etc"), "/runtime/vault/stats");
});
