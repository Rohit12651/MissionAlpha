// Phase 3 / R11 — PII detector tests.
// Load-bearing: FP-* (the false-positive budget — a noisy detector gets ignored) and
// POLICY-* (the operator's own review surface is never masked; exports always are).

import test from "node:test";
import assert from "node:assert/strict";
import { scanPii, redactPii, applyPiiPolicy, luhn, validSsn, PII_TYPES } from "../pii-detect.mjs";

const types = (t) => [...new Set(scanPii(t).hits.map((h) => h.type))].sort();

test("Luhn separates real card numbers from digit runs", () => {
  assert.equal(luhn("4111111111111111"), true);
  assert.equal(luhn("4111 1111 1111 1111"), true);
  assert.equal(luhn("1234567812345678"), false);
  assert.equal(luhn("123"), false);
});

test("SSN structural validity rejects never-issued ranges", () => {
  assert.equal(validSsn("123-45-6789"), true);
  assert.equal(validSsn("000-45-6789"), false);
  assert.equal(validSsn("666-45-6789"), false);
  assert.equal(validSsn("900-45-6789"), false);
  assert.equal(validSsn("123-00-6789"), false);
  assert.equal(validSsn("123-45-0000"), false);
});

test("detects each supported type", () => {
  assert.deepEqual(types("contact rohit.a@gmail.com"), ["email"]);
  assert.deepEqual(types("card 4111 1111 1111 1111"), ["card"]);
  assert.deepEqual(types("ssn 123-45-6789"), ["ssn"]);
  assert.deepEqual(types("call 415-555-0132"), ["phone"]);
  assert.deepEqual(types("from 8.8.8.8"), ["ip"]);
  assert.deepEqual(types("at 1600 Pennsylvania Avenue"), ["address"]);
});

test("every declared type is reachable", () => {
  const corpus = "a@b.co 4111111111111111 123-45-6789 415-555-0132 8.8.8.8 221 Baker Street";
  const found = new Set(scanPii(corpus).hits.map((h) => h.type));
  for (const t of PII_TYPES) assert.ok(found.has(t), `${t} never fires`);
});

// ── false-positive budget ─────────────────────────────────────────────────────

test("FP-1: version strings and IDs are not phone numbers or cards", () => {
  for (const t of [
    "bumped to v1.2.3 today",
    "commit 1234567812345678 landed",
    "port 3005 and 3004 are free",
    "issue #1234 fixed in 2026",
    "the timeout is 60000 ms",
  ]) {
    assert.equal(scanPii(t).total, 0, `false positive on: ${t} → ${JSON.stringify(types(t))}`);
  }
});

test("FP-2: documentation and fixture emails are not personal data", () => {
  for (const t of ["user@example.com", "test@test", "noreply@corp.io", "a@localhost"]) {
    assert.equal(scanPii(t).total, 0, t);
  }
});

test("FP-3: loopback and RFC1918 addresses are infrastructure, not people", () => {
  for (const t of ["127.0.0.1", "10.0.0.5", "192.168.1.1", "172.16.0.9"]) {
    assert.equal(scanPii(t).total, 0, t);
  }
  assert.equal(scanPii("999.1.1.1").total, 0, "invalid octets are not IPs");
});

test("FP-4: a repeated-digit placeholder is not a phone number", () => {
  assert.equal(scanPii("000-000-0000").total, 0);
});

test("FP-CARD: adjacent identifiers must NOT be fused into an invented credit card", () => {
  // A permissive (?:\d[ -]?){13,19} pattern spans "123-45-6789 415-555-0132" as one run,
  // and Luhn over that soup can pass by coincidence — inventing a card from an SSN plus a
  // phone number and masking both. This is the exact defect strict grouping removed.
  const r = scanPii("ssn 123-45-6789 phone 415-555-0132");
  assert.equal(r.counts.card, undefined, `invented a card: ${JSON.stringify(r.hits)}`);
  assert.equal(r.counts.ssn, 1);
  assert.equal(r.counts.phone, 1);
});

test("FP-CARD-2: real cards still detect in both accepted shapes", () => {
  assert.equal(scanPii("4111111111111111").counts.card, 1, "bare run");
  assert.equal(scanPii("4111 1111 1111 1111").counts.card, 1, "space-grouped");
  assert.equal(scanPii("4111-1111-1111-1111").counts.card, 1, "dash-grouped");
});

test("FP-5: a realistic engineering paragraph produces zero hits", () => {
  const prose = `Refactor the queue in agent-runtime/queue.mjs. The retry backoff is
  2000ms base with a 60000ms ceiling. See issue #1669 and ADR-052. Ports 3004/3005.
  Coverage went from 1490 to 1583 tests across v1.2.3.`;
  assert.equal(scanPii(prose).total, 0, JSON.stringify(types(prose)));
});

// ── non-overlap / priority ────────────────────────────────────────────────────

test("a card is claimed by the card detector, never split by phone", () => {
  const r = scanPii("4111 1111 1111 1111");
  assert.equal(r.total, 1);
  assert.equal(r.hits[0].type, "card");
});

test("spans never overlap", () => {
  const r = scanPii("a@b.com 4111111111111111 123-45-6789 8.8.8.8");
  for (let i = 1; i < r.hits.length; i++) {
    assert.ok(r.hits[i].span[0] >= r.hits[i - 1].span[1], "overlapping spans would double-redact");
  }
});

// ── redaction ─────────────────────────────────────────────────────────────────

test("redaction masks values and tags the type", () => {
  const r = redactPii("email rohit.a@gmail.com card 4111111111111111");
  assert.ok(!r.text.includes("rohit.a@gmail.com"));
  assert.ok(!r.text.includes("4111111111111111"));
  assert.match(r.text, /\[PII:email\]/);
  assert.match(r.text, /\[PII:card\]/);
  assert.match(r.text, /1111$/, "last four preserved for reconciliation");
  assert.equal(r.total, 2);
});

test("redaction of multiple hits keeps every span correct", () => {
  const r = redactPii("a@b.com then c@d.com then e@f.com");
  assert.equal(r.counts.email, 3);
  assert.ok(!/\b[a-z]@[a-z]\.com\b/.test(r.text), `leaked: ${r.text}`);
});

test("SSN is fully masked — no last-four for an SSN", () => {
  assert.match(redactPii("ssn 123-45-6789").text, /\*\*\*-\*\*-\*\*\*\*/);
  assert.ok(!redactPii("ssn 123-45-6789").text.includes("6789"));
});

// ── destination policy ────────────────────────────────────────────────────────

test("POLICY-1: exports REDACT", () => {
  for (const dest of ["export", "audit", "federation"]) {
    const r = applyPiiPolicy("mail rohit.a@gmail.com", dest);
    assert.equal(r.action, "redact");
    assert.ok(!r.text.includes("rohit.a@gmail.com"), dest);
  }
});

test("POLICY-2: the operator's own review surface PASSES with a count", () => {
  for (const dest of ["ui", "sse", "internal"]) {
    const r = applyPiiPolicy("mail rohit.a@gmail.com", dest);
    assert.equal(r.action, "count");
    assert.ok(r.text.includes("rohit.a@gmail.com"), "masking the reviewer's own view hides what they must judge");
    assert.equal(r.total, 1);
  }
});

test("POLICY-3: an unknown destination FAILS SAFE to redact", () => {
  const r = applyPiiPolicy("mail rohit.a@gmail.com", "some-new-sink");
  assert.equal(r.action, "redact");
  assert.ok(!r.text.includes("rohit.a@gmail.com"));
});

// ── robustness ────────────────────────────────────────────────────────────────

test("never throws on malformed input", () => {
  for (const bad of [null, undefined, 42, {}, [], "", "x".repeat(50_000)]) {
    assert.doesNotThrow(() => scanPii(bad));
    assert.doesNotThrow(() => redactPii(bad));
    assert.doesNotThrow(() => applyPiiPolicy(bad, "export"));
  }
});

test("repeated scans are stable (no regex lastIndex leak)", () => {
  const t = "a@b.co and 415-555-0132";
  assert.equal(scanPii(t).total, scanPii(t).total);
});

test("redaction is idempotent — re-redacting does not double-tag", () => {
  const once = redactPii("mail rohit.a@gmail.com").text;
  const twice = redactPii(once).text;
  assert.equal((twice.match(/\[PII:email\]/g) || []).length, 1);
});
