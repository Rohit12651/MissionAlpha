// B5 / Command Center — the cross-venture KPI aggregator.
//
// PURE READ over the delivery DB: no mutation, no emit, no filesystem. One call
// answers the whole Command Center in a single request (server.mjs wires it to
// GET /runtime/bos/kpis). Every number is computed from a real table.
//
// HONEST NUMBERS (hallmark gate 56 — this is the whole point of the phase):
//   • decisionsToday + deliveriesApproved are decided-in-window. They are CROSS-VENTURE:
//     the deliveries table has no venture column (db.mjs), so a decision cannot be
//     attributed to a venture in v1. The payload says so (`crossVenture:true`) and the
//     `venture` scope deliberately does NOT filter them.
//   • recordsWritten is the vault rows written in the window, venture-scoped when a
//     venture is given (vault_records.venture), aggregate otherwise.
//   • openFollowUps is GONE as of S0: its only source was the leads store, which the
//     story-pipeline pivot deleted. The field is REMOVED from the payload rather than
//     shipped as a permanent 0 — a fabricated metric is exactly what this module refuses.
//   • ventures[].records is the venture's LIVE vault size (all-time, matching the
//     switcher); ventures[].pending is the cross-venture pending-delivery count — the
//     same honest caveat as the decision metrics, and the same value on every row.
//   • Empty DB → all zeros, never null. Window is finite + floored + clamped 1h..90d.
//
// Every statement is parameterized; `venture` is validated with the vault's own slug
// primitive before it ever reaches SQL, so a crafted scope degrades to "all", never a
// query error.

import { isSlug } from "./vault.mjs";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MIN_WINDOW = HOUR; // 1h
const MAX_WINDOW = 90 * DAY; // 90d
const DEFAULT_WINDOW = 7 * DAY; // 7d

/**
 * Clamp a window (ms) to [1h, 90d]. A non-finite or non-positive value falls back to
 * the 7d default; a fractional value is floored BEFORE the clamp (so 1.5h stays 1h and
 * a NaN never reaches SQLite as a float).
 */
export function clampWindow(windowMs) {
  if (!Number.isFinite(windowMs)) return DEFAULT_WINDOW;
  const w = Math.floor(windowMs);
  if (w <= 0) return DEFAULT_WINDOW;
  return Math.min(Math.max(w, MIN_WINDOW), MAX_WINDOW);
}

/**
 * kpis({ venture, windowMs, nowMs, db }) → the Command Center payload.
 * `db` is a better-sqlite3 handle (deliveryDb.db). Throws only when it is absent —
 * every other input degrades to a safe default rather than erroring.
 */
export function kpis({ venture, windowMs, nowMs, db } = {}) {
  if (!db || typeof db.prepare !== "function") throw new Error("kpis: db handle required");
  const win = clampWindow(windowMs);
  const at = Number.isFinite(nowMs) ? Math.floor(nowMs) : Date.now();
  const sinceIso = new Date(at - win).toISOString(); // deliveries store createdAt/decidedAt as ISO text
  const sinceMs = at - win; // vault_records store created_at as epoch ms
  const scope = isSlug(venture) ? venture : null; // malformed scope → aggregate, never a SQL error

  // ── deliveries (CROSS-VENTURE — no venture column, v1) ─────────────────────
  // Human decisions decided in the window: approved + rejected + changes_requested.
  // auto_approved is excluded (no human decided it); pending is excluded (no decision yet).
  const decisionsToday = db.prepare(
    `SELECT COUNT(*) n FROM deliveries
       WHERE status IN ('approved','rejected','changes_requested')
         AND decidedAt IS NOT NULL AND decidedAt >= ?`,
  ).get(sinceIso).n;
  const deliveriesApproved = db.prepare(
    `SELECT COUNT(*) n FROM deliveries
       WHERE status = 'approved' AND decidedAt IS NOT NULL AND decidedAt >= ?`,
  ).get(sinceIso).n;
  // Every undecided delivery, regardless of venture (there is none). Doubles as each
  // venture row's `pending` below — labeled cross-venture, not faked per-venture.
  const pendingDeliveries = db.prepare(
    "SELECT COUNT(*) n FROM deliveries WHERE status = 'pending'",
  ).get().n;

  // ── Phase 14 / 14.2 — THE MILESTONE'S NUMBER ───────────────────────────────
  // "≥ 5 jobs shipped as PRs in one week" is what M2-LIVE is measured in, and nothing on the
  // board showed it. Two figures, deliberately separate:
  //   jobsShipped  — every job that reached `shipped` in the window.
  //   prsShipped   — those of them that opened a real PR (`prUrl IS NOT NULL`).
  // Reporting only the first would count a LOCAL BRANCH as a shipped PR, which is exactly the
  // overclaim the ship ladder already refuses to make (`mode: "branch"` is not `mode: "pr"`).
  // On a machine with no `gh`, prsShipped is 0 and jobsShipped is not — and the difference is
  // the honest answer to "did we hit the target?".
  //
  // Guarded: the jobs table arrived in Phase 9 and this same module runs against older stores.
  let jobsShipped = 0;
  let prsShipped = 0;
  try {
    jobsShipped = db.prepare(
      "SELECT COUNT(*) n FROM jobs WHERE status = 'shipped' AND updatedAt >= ?",
    ).get(sinceMs).n;
    prsShipped = db.prepare(
      "SELECT COUNT(*) n FROM jobs WHERE status = 'shipped' AND prUrl IS NOT NULL AND updatedAt >= ?",
    ).get(sinceMs).n;
  } catch { /* no jobs table (pre-Phase-9 store) → zeros, never a thrown KPI page */ }

  // ── vault records written in the window (venture-scoped when given) ────────
  const recordsWritten = scope
    ? db.prepare("SELECT COUNT(*) n FROM vault_records WHERE created_at >= ? AND venture = ?").get(sinceMs, scope).n
    : db.prepare("SELECT COUNT(*) n FROM vault_records WHERE created_at >= ?").get(sinceMs).n;

  // ── per-venture roster ─────────────────────────────────────────────────────
  // records = the venture's live vault size (all-time, matching the sidebar switcher);
  // pending = the cross-venture pending count (same on every row, honestly labeled).
  const recCounts = new Map();
  for (const r of db.prepare("SELECT venture, COUNT(*) n FROM vault_records GROUP BY venture").all()) {
    recCounts.set(r.venture, r.n);
  }
  const ventures = db.prepare("SELECT id, name FROM ventures ORDER BY created_at ASC, id ASC").all()
    .map((v) => ({ id: v.id, name: v.name, records: recCounts.get(v.id) || 0, pending: pendingDeliveries }));

  return {
    windowMs: win,
    since: sinceIso,
    decisionsToday,
    recordsWritten,
    deliveriesApproved,
    jobsShipped,
    prsShipped,
    // deliveries have no venture column in v1; these two are cross-venture, labeled.
    crossVenture: true,
    pendingDeliveries,
    ventures,
  };
}
