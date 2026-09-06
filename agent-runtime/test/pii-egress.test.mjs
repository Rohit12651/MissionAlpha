// Phase 3 / R11 — PII on the live egress path.
//
// The two load-bearing claims:
//   EXPORT-*   a bundle LEAVING the machine carries no unmasked personal data.
//   INTERNAL-* the operator's OWN review surface is NOT masked — masking the reviewer's
//              view would hide the content they are being asked to judge.
// Those pull in opposite directions on purpose, which is exactly why the policy is
// per-destination rather than one blanket redaction.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 3992;
const TOK = "piiegresstok";
const BASE = `http://127.0.0.1:${PORT}`;
const H = { Host: `localhost:${PORT}`, "x-runtime-token": TOK };

let proc;
let dbPath;

// The PII we plant. If any of these strings survives into an export, the feature does
// not work — and an empty-DB test would have passed anyway, which is why this is seeded
// rather than assumed.
const PLANTED = {
  email: "rohit.customer@realdomain.io",
  ssn: "123-45-6789",
  card: "4111111111111111",
  phone: "415-555-0132",
};

test.before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "pii-egress-"));
  dbPath = join(dir, "mission.db");
  proc = spawn(process.execPath, [join(ROOT, "agent-runtime", "server.mjs")], {
    env: {
      ...process.env,
      RUNTIME_BACKEND: "mock",
      RUNTIME_PORT: String(PORT),
      RUNTIME_TOKEN: TOK,
      RUNTIME_TOKEN_DIR: dir,
      RUNTIME_DB_PATH: dbPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("server did not start")), 30_000);
    proc.stdout.on("data", (b) => {
      if (String(b).includes(`listening :${PORT}`)) { clearTimeout(t); resolve(); }
    });
    proc.on("exit", (c) => { clearTimeout(t); reject(new Error(`server exited ${c}`)); });
  });

  // Plant a delivery whose free text carries real PII shapes. Seeded directly into the
  // store the running server already opened (WAL, same file) so the export route reads
  // it through its normal path — no special-casing, no test-only branch in production
  // code.
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(dbPath);
  db.prepare(`INSERT INTO deliveries
    (id, agentId, taskId, title, summary, source, kind, diffFiles, diffAdditions,
     diffDeletions, changedPaths, riskScore, riskBand, riskReasons, status, createdAt,
     auditRef)
    VALUES (@id,@agentId,@taskId,@title,@summary,'swarm','code',1,2,0,'["src/a.ts"]',
            10,'low','[]','pending',@createdAt,'pii-seed-audit')`).run({
    id: "pii-seed-1",
    agentId: "senior-web-1",
    taskId: null,
    // ALL of it goes in `title`: the JSON/CSV export payload carries title but NOT
    // summary, so PII placed in summary would never travel and the test would prove
    // nothing while appearing to pass. Discovered by EXPORT-3c.
    title: `Contact ${PLANTED.email} SSN ${PLANTED.ssn} card ${PLANTED.card} phone ${PLANTED.phone}`,
    summary: "shape-only summary",
    createdAt: new Date().toISOString(),
  });
  db.close();
});

test.after(() => { try { proc?.kill(); } catch { /* already gone */ } });

test("EXPORT-1: the JSON audit bundle is reachable and well-formed", async () => {
  const r = await fetch(`${BASE}/runtime/audit/export?format=json`, { headers: H });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(body.meta && Array.isArray(body.deliveries));
});

test("EXPORT-2: the CSV audit bundle is reachable", async () => {
  const r = await fetch(`${BASE}/runtime/audit/export?format=csv`, { headers: H });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") || "", /text\/csv/);
  assert.match(await r.text(), /DELIVERIES/);
});

test("EXPORT-3: PLANTED PII is masked in the JSON bundle", async () => {
  const raw = await (await fetch(`${BASE}/runtime/audit/export?format=json`, { headers: H })).text();
  assert.ok(raw.includes("pii-seed-1"), "precondition: the seeded delivery must be in the export");
  for (const [type, value] of Object.entries(PLANTED)) {
    assert.ok(!raw.includes(value), `unmasked ${type} leaked into the JSON export: ${value}`);
  }
  assert.ok(raw.includes("[PII:"), "masked values must carry their type tag");
});

test("EXPORT-3b: PLANTED PII is masked in the CSV bundle too", async () => {
  const raw = await (await fetch(`${BASE}/runtime/audit/export?format=csv`, { headers: H })).text();
  assert.ok(raw.includes("pii-seed-1"), "precondition: the seeded delivery must be in the export");
  for (const [type, value] of Object.entries(PLANTED)) {
    assert.ok(!raw.includes(value), `unmasked ${type} leaked into the CSV export: ${value}`);
  }
});

test("EXPORT-3c: masking preserves the reconciliation tail, not the whole value", async () => {
  const raw = await (await fetch(`${BASE}/runtime/audit/export?format=json`, { headers: H })).text();
  assert.ok(raw.includes("1111"), "card last-four is kept so a human can reconcile");
  assert.ok(!raw.includes(PLANTED.card));
});

test("EXPORT-4: the secret chain still runs on the export path (not replaced by PII)", async () => {
  const raw = await (await fetch(`${BASE}/runtime/audit/export?format=json`, { headers: H })).text();
  assert.ok(!raw.includes(TOK), "the runtime token must never reach an export");
  assert.ok(!/sk-ant-[A-Za-z0-9_-]{6,}/.test(raw));
  assert.ok(!/gh[pousr]_[A-Za-z0-9]{20,}/.test(raw));
});

test("INTERNAL-1: the Inbox read is NOT PII-masked — the reviewer must see what they judge", async () => {
  const r = await fetch(`${BASE}/inbox`, { headers: H });
  assert.equal(r.status, 200);
  const raw = await r.text();
  assert.ok(!raw.includes("[PII:"), "the operator's own review surface must not be redacted");
});

test("INTERNAL-2: the doctor report is not PII-masked either", async () => {
  const raw = await (await fetch(`${BASE}/runtime/doctor`, { headers: H })).text();
  assert.ok(!raw.includes("[PII:"));
});

test("the export route still refuses an unauthenticated caller", async () => {
  const r = await fetch(`${BASE}/runtime/audit/export?format=json`, { headers: { Host: `localhost:${PORT}` } });
  assert.equal(r.status, 401);
});
