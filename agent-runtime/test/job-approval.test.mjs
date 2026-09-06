// Phase 11 · task 11.2 — `job-approval`: ONE decision from the BOSS per job.
//
// The Job's own gate kind. It is diff-less like `question` / `design-approval` /
// `release-approval` — the diff lives on the tasks; this row is the single yes that ships all
// of them. Adding a kind is a COORDINATED change across four places (deliveries.KINDS,
// deliveries.GATE_KINDS, risk.GATE_KINDS, and the client's mirror), and nothing pinned that
// those four agree — the drift this file closes as well as the feature it adds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createDeliveries, KINDS, GATE_KINDS } from "../deliveries.mjs";
import { classify } from "../risk.mjs";
import { openDb } from "../db.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function store() {
  const dir = mkdtempSync(join(tmpdir(), "ja-"));
  const db = openDb({ path: join(dir, "mission.db"), patchesDir: join(dir, "patches") });
  return createDeliveries({ db, scrub: (t) => t, events: { emit: () => {} }, audit: () => {} });
}

test("JA-1: `job-approval` is a known kind AND a diff-less gate kind", () => {
  assert.ok(KINDS.includes("job-approval"), "not in KINDS — mint/store would refuse it");
  assert.ok(GATE_KINDS.has("job-approval"), "not in GATE_KINDS — it would be treated as a diff row");
});

test("JA-2: the DB accepts it — the CHECK constraint was widened by a migration", () => {
  const d = store();
  const row = d.mintGate({
    kind: "job-approval", agentId: "tech-lead", jobId: "job_1", slot: "job_1-ship",
    title: "Ship: add a formatter", body: "2 tasks, 3 files, tests re-run green.",
  });
  assert.ok(row?.id, "mintGate returned no row");
  assert.equal(row.kind, "job-approval");
  assert.equal(row.jobId, "job_1");
  assert.equal(row.storyId, null, "a JOB gate must not claim a story");
});

test("JA-3: it can only be minted as a GATE — never as a diff delivery", () => {
  const d = store();
  // `source` is validated BEFORE the gate-kind check, so it must be supplied or the throw
  // comes from the wrong guard and the test proves nothing (the first version of this test
  // did exactly that and passed for the wrong reason).
  assert.throws(
    () => d.mint({ kind: "job-approval", source: "swarm", agentId: "tech-lead", title: "t", summary: "s" }),
    /diff-less gate|minted only via mintGate/i,
    "a job-approval with a diff would mean two sources of truth for what ships");
});

test("JA-4: risk bands it HIGH — one yes ships every task, so it never gets buried", () => {
  const out = classify({ kind: "job-approval" });
  assert.equal(out.band, "high",
    "band here is needs-you URGENCY, not code danger: this is the decision that lands N diffs at once");
});

test("JA-5: HIGH band grants nothing — it can never auto-apply", () => {
  // The whole point of the gate is that a person says yes. If any path could auto-approve it,
  // the Manager would be able to ship its own work.
  const out = classify({ kind: "job-approval" });
  assert.notEqual(out.autoApprove, true, "a job-approval must NEVER auto-apply");
});

// ── the drift this kind could have introduced ────────────────────────────────
test("JA-6: risk.mjs and deliveries.mjs agree on the gate kinds", () => {
  // Two private GATE_KINDS sets in two modules. If they disagree, a kind is a gate in one
  // half of the runtime and a diff row in the other — and nothing was checking.
  const src = readFileSync(join(REPO, "agent-runtime", "risk.mjs"), "utf-8");
  const m = /const GATE_KINDS = Object\.freeze\(new Set\(\[([^\]]*)\]\)\)/.exec(src);
  assert.ok(m, "could not read risk.mjs GATE_KINDS");
  const riskKinds = [...m[1].matchAll(/"([a-z-]+)"/g)].map((x) => x[1]).sort();
  assert.deepEqual(riskKinds, [...GATE_KINDS].sort(),
    "risk.mjs and deliveries.mjs disagree about which kinds are diff-less human gates");
});

test("JA-7: the CLIENT mirror agrees too — the type and the runtime list", () => {
  // src/lib/inboxClient.ts carries its own copies. A kind the server mints and the client does
  // not know is a row the Inbox cannot render; the reverse is a dead branch. Read the real
  // file rather than restating the list, so this cannot pass while the mirror rots.
  const src = readFileSync(join(REPO, "src", "lib", "inboxClient.ts"), "utf-8");

  const kindType = /export type DeliveryKind =([^;]+);/.exec(src);
  assert.ok(kindType, "could not read DeliveryKind");
  const clientKinds = [...kindType[1].matchAll(/"([a-z-]+)"/g)].map((x) => x[1]).sort();
  assert.deepEqual(clientKinds, [...KINDS].sort(),
    "DeliveryKind does not mirror deliveries.mjs KINDS");

  const gate = /export const GATE_KINDS: readonly DeliveryKind\[\] = \[([^\]]*)\]/.exec(src);
  assert.ok(gate, "could not read the client GATE_KINDS");
  const clientGates = [...gate[1].matchAll(/"([a-z-]+)"/g)].map((x) => x[1]).sort();
  assert.deepEqual(clientGates, [...GATE_KINDS].sort(),
    "the client's GATE_KINDS does not mirror deliveries.mjs GATE_KINDS");
});
