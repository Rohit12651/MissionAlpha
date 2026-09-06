// Phase 1 / R4 (UI) — what the cockpit shows from a doctor report.
//
// `doctor.status` has been LIVE on the wire since session 3 and NOTHING rendered it. The
// comment in useRuntimeEvents even claimed "the readiness banner reacts to it" — it did
// not. A health report nobody can see is the same silence the doctor was built to end.
//
// The load-bearing group is DEDUPE-*. The Command Center ALREADY renders a readiness
// banner, and readiness is one of the doctor's own checks. Showing both means the operator
// reads "no active account" twice, stacked — and the readiness banner's own header warns
// exactly why that is harmful: "noise is how an operator learns to skip the line that
// matters."

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  worstCheck,
  visibleFailures,
  doctorTone,
  READINESS_OWNED,
  type DoctorReport,
} from "../doctorStatus.ts";

const check = (id: string, status: "ok" | "warn" | "fail", over: Record<string, unknown> = {}) => ({
  id, label: id, status, detail: `${id} detail`, ...over,
});

const report = (checks: ReturnType<typeof check>[]): DoctorReport => ({
  status: checks.some((c) => c.status === "fail") ? "fail" : checks.some((c) => c.status === "warn") ? "warn" : "ok",
  checks,
  summary: {
    ok: checks.filter((c) => c.status === "ok").length,
    warn: checks.filter((c) => c.status === "warn").length,
    fail: checks.filter((c) => c.status === "fail").length,
  },
});

test("HEALTHY-1: an all-ok report surfaces nothing — silence is the correct render", () => {
  const r = report([check("node", "ok"), check("db", "ok")]);
  assert.deepEqual(visibleFailures(r), []);
  assert.equal(worstCheck(r), null);
});

test("SEVERITY-1: a FAIL outranks a WARN even when the warn comes first", () => {
  const r = report([check("gh", "warn"), check("db", "fail")]);
  assert.equal(worstCheck(r)?.id, "db");
});

test("SEVERITY-2: with no fail, the first WARN is surfaced", () => {
  const r = report([check("gh", "warn"), check("encryption", "warn")]);
  assert.equal(worstCheck(r)?.id, "gh");
});

test("DEDUPE-1: the account check is NEVER surfaced — the readiness banner owns it", () => {
  // Stacking "no active account" under a banner that already says it is the exact noise
  // the banner's own header refuses. One fault, one line.
  const r = report([check("account", "fail"), check("gh", "warn")]);
  assert.deepEqual(visibleFailures(r).map((c) => c.id), ["gh"]);
  assert.equal(worstCheck(r)?.id, "gh", "a readiness-owned FAIL must not outrank a real warn");
});

test("DEDUPE-2: a report whose ONLY problem is readiness-owned surfaces nothing", () => {
  const r = report([check("account", "fail"), check("db", "ok")]);
  assert.deepEqual(visibleFailures(r), []);
  assert.equal(worstCheck(r), null, "the banner is already saying this; do not say it twice");
});

test("DEDUPE-3: every owned id is a REAL doctor check id, read from the runtime source", () => {
  // This test exists because the first version of READINESS_OWNED contained
  // "active-account" — an id I INVENTED. It matched nothing, so the dedupe silently did
  // not dedupe, and every unit test still passed because they asserted against the same
  // invention. The lesson is the program's own: derive a constant from the code it grades,
  // never from an assumption about what that code probably calls things.
  //
  // Same technique as the runtime's LAW4-FLOOR test, which reads deliveries.mjs source to
  // prove a producer-side refusal still exists.
  const src = readFileSync(new URL("../../../agent-runtime/doctor.mjs", import.meta.url), "utf8");
  const real = new Set([...src.matchAll(/mk\("([a-z0-9-]+)"/g)].map((m) => m[1]));
  assert.ok(real.size >= 8, `expected the real check ids, found ${real.size}`);
  for (const id of READINESS_OWNED) {
    assert.ok(real.has(id), `READINESS_OWNED has '${id}' which is not a doctor check id`);
  }
});

test("FIX-1: the fix text rides along when the runtime supplied one", () => {
  const r = report([check("gh", "fail", { fix: "brew install gh && gh auth login" })]);
  assert.equal(worstCheck(r)?.fix, "brew install gh && gh auth login");
});

test("FIX-2: a check with NO fix is still surfaced — an unfixable fault is not a hidden one", () => {
  const r = report([check("disk", "fail")]);
  assert.equal(worstCheck(r)?.id, "disk");
  assert.equal(worstCheck(r)?.fix, undefined);
});

test("TONE-1: fail → error, warn → warn, clean → ok", () => {
  assert.equal(doctorTone(report([check("db", "fail")])), "error");
  assert.equal(doctorTone(report([check("gh", "warn")])), "warn");
  assert.equal(doctorTone(report([check("db", "ok")])), "ok");
});

test("TONE-2: tone follows what is VISIBLE, not the report's own headline status", () => {
  // The report says "fail" because of the account. The strip shows nothing, so it must not
  // paint the cockpit red for a fault it is not displaying.
  const r = report([check("account", "fail"), check("db", "ok")]);
  assert.equal(r.status, "fail");
  assert.equal(doctorTone(r), "ok");
});

test("ROBUST-1: a malformed or absent report never throws", () => {
  for (const bad of [null, undefined, {}, { checks: null }, { checks: "nope" }]) {
    assert.deepEqual(visibleFailures(bad as unknown as DoctorReport), []);
    assert.equal(worstCheck(bad as unknown as DoctorReport), null);
    assert.equal(doctorTone(bad as unknown as DoctorReport), "ok");
  }
});

test("ROBUST-2: a check with an unknown status is treated as neither fail nor warn", () => {
  const r = { status: "ok", checks: [{ id: "x", label: "x", status: "weird", detail: "" }], summary: {} };
  assert.deepEqual(visibleFailures(r as unknown as DoctorReport), []);
});
