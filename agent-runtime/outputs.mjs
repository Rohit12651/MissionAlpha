// B7 / outputs — the artifact REGISTRY. One SQLite row per PRODUCED artifact (db.mjs
// migration v13), plus the always-available REAL generators the system can produce on
// demand. The BOSS opens Outputs to download what the mission has produced; the audit
// export (P8) is the one generator that genuinely ships today, so it is ALWAYS listed as
// an available generator and its downloads are recorded here.
//
// HONESTY (the B7 directive): this registry NEVER fabricates a file list. `generators()`
// returns the real, always-available capabilities (currently the single audit export);
// `list()` returns only artifacts the runtime has ACTUALLY produced (rows). An empty
// produced set renders as the generator row + an honest empty state — never a fake file.
//
// SECURITY (carried from the B2/B6 blocking-security posture — label/ref are UNTRUSTED-adjacent):
//   • CONTAINMENT is SLUG-ONLY and CASE-REFUSING. `id`, `kind` and `venture` (when present)
//     each match the vault's SAME /^[a-z0-9][a-z0-9-]{0,63}$/ (imported, not re-declared) —
//     which excludes `.` `/` `\` NUL and every `..` shape — and an UPPERCASE spelling is
//     REFUSED, never folded. `venture` may also be '' (a GLOBAL artifact carries no scope).
//   • LABEL and REF are scrubbed with the server's SHARED scrub AT REST and again on egress.
//     No second SECRET_RE lives here. Control chars are stripped first. `ref` is a LINK only
//     — it is stored + capped + returned, never executed.
//   • Emit-on-persist (ADR-052 §2): the function that WRITES the row is the function that
//     emits `output.created` — no watcher, no dual path. The payload carries identity ONLY
//     ({id,kind,venture}) — never the label or ref, because a bus frame reaches every seat.
//   • record() is idempotent by id (first write wins) — a repeated same-id write returns the
//     stored row WITHOUT a second insert or a second emit, so a same-day re-download of the
//     same audit bundle never spams the table or the bus.

import { randomBytes } from "node:crypto";
import { isSlug } from "./vault.mjs";

/**
 * The P8 audit export — the ONE artifact generator the system genuinely ships today, and
 * therefore ALWAYS available. Mirrored (and pinned by a test) in the client's outputsClient.ts.
 * A second generator is a new real capability + a catalog change here, never a UI fabrication.
 */
export const AUDIT_GENERATOR = Object.freeze({
  kind: "audit",
  label: "Audit bundle",
  ref: "/runtime/audit/export",
  desc: "Date-ranged, scrubbed JSON/CSV export of deliveries, decisions, audit log and usage.",
});

export const MAX_OUTPUT_LABEL = 200;
export const MAX_OUTPUT_REF = 512;
export const MAX_OUTPUT_KIND = 64;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export function createOutputs(deps = {}) {
  const store = deps.db;
  if (!store || !store.db) throw new Error("createOutputs: db handle required");
  const db = store.db;
  const events = deps.events || { emit: () => {} };
  const scrub = deps.scrub || ((s) => s);
  const audit = deps.audit || (() => {});
  const now = deps.now || (() => Date.now());

  // Strip control chars (keeping \t \n \r), run the SHARED scrub, then cap. Scrub-at-rest
  // AND on egress, exactly like vault.mjs / leads.mjs / content.mjs.
  // eslint-disable-next-line no-control-regex
  const CTRL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
  const clean = (s, cap) => scrub(String(s ?? "").replace(CTRL, "")).slice(0, cap);
  const oneLine = (s, cap) => clean(s, cap).replace(/\s+/g, " ").trim().slice(0, cap);

  // Lowercase ULID-ish (slug-shaped by construction, lexicographically time-ordered) — the
  // SAME shape vault/leads/content mint, so a store-minted id always survives isSlug.
  function mintId(ms = now()) {
    const t = Math.max(0, Math.floor(ms)).toString(36).padStart(10, "0").slice(-10);
    return `${t}${randomBytes(9).toString("hex").slice(0, 12)}`;
  }

  const rowById = (id) => db.prepare("SELECT * FROM outputs WHERE id = ?").get(id) || null;

  /** Row → the client-facing shape, scrubbed on the way out. A global artifact (venture '')
   *  hydrates to `venture: null` so the client renders "all ventures" honestly. */
  function hydrate(row) {
    if (!row) return null;
    return {
      id: row.id,
      kind: row.kind,
      venture: row.venture || null,
      label: scrub(row.label || ""),
      ref: scrub(row.ref || ""),
      createdAt: row.created_at,
    };
  }

  /**
   * The REAL, always-available generators. Currently exactly the P8 audit export — the only
   * artifact the system genuinely produces on demand today. This list is honest by
   * construction: it is a fixed set of live capabilities, not a scan of a fabricated folder.
   */
  function generators() {
    return [{ ...AUDIT_GENERATOR }];
  }

  /**
   * Record one PRODUCED artifact. Returns the hydrated row (with `deduped:true` when the id
   * already exists — idempotent by id), or a `{code, error}` verdict. NEVER throws for bad
   * input, so a caller (the audit-export route) can degrade quietly instead of 500-ing.
   */
  function record(input = {}) {
    const kind = oneLine(input.kind ?? "", MAX_OUTPUT_KIND);
    if (!isSlug(kind)) return { code: 400, error: "kind must be a lowercase slug (a-z, 0-9, -)" };
    // venture is OPTIONAL — a GLOBAL artifact (the audit bundle) carries no scope. '' is
    // allowed; anything non-empty must be a slug (case-refusing, like every other scope here).
    const rawV = input.venture;
    const venture = rawV === undefined || rawV === null || rawV === "" ? "" : rawV;
    if (venture !== "" && !isSlug(venture)) return { code: 400, error: "invalid venture (lowercase slug: a-z, 0-9, -)" };
    const id = input.id === undefined || input.id === null ? mintId() : input.id;
    if (!isSlug(id)) return { code: 400, error: "invalid id (lowercase slug: a-z, 0-9, -)" };
    const label = oneLine(input.label ?? "", MAX_OUTPUT_LABEL);
    if (!label) return { code: 400, error: "label required" };
    const ref = oneLine(input.ref ?? "", MAX_OUTPUT_REF);

    const prior = rowById(id);
    if (prior) return { ...hydrate(prior), deduped: true }; // first write wins — no second emit

    const ts = now();
    db.prepare(
      "INSERT INTO outputs(id, kind, venture, label, ref, created_at) VALUES(@id, @kind, @venture, @label, @ref, @ts)",
    ).run({ id, kind, venture, label, ref, ts });
    audit("output.created", { id, kind, venture: venture || null });
    // Emit-on-persist: identity ONLY on the bus (never label/ref). Same function that inserted.
    events.emit("output.created", { id, kind, venture: venture || null });
    return hydrate(rowById(id));
  }

  /** Produced artifacts, venture- and kind-scoped, NEWEST first. Unknown filter → [] (never
   *  a SQL error). LIMIT/OFFSET are floored + finite-checked + clamped (the vault LOW-4 lesson). */
  function list(q = {}) {
    const where = [];
    const args = [];
    if (q.venture) {
      if (!isSlug(q.venture)) return [];
      // A venture scope shows that venture's artifacts AND the GLOBAL (venture '') ones —
      // the audit bundle is cross-venture, so it must never vanish under a named scope.
      where.push("(venture = ? OR venture = '')"); args.push(q.venture);
    }
    if (q.kind) {
      if (!isSlug(q.kind)) return [];
      where.push("kind = ?"); args.push(q.kind);
    }
    const rawLimit = Number(q.limit);
    const rawOffset = Number(q.offset);
    const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? Math.floor(rawLimit) : DEFAULT_LIMIT, 1), MAX_LIMIT);
    const offset = Math.min(Math.max(Number.isFinite(rawOffset) ? Math.floor(rawOffset) : 0, 0), Number.MAX_SAFE_INTEGER);
    const sql = `SELECT * FROM outputs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`;
    return db.prepare(sql).all(...args, limit, offset).map(hydrate);
  }

  /** One produced artifact, scrubbed. A non-slug or unknown id ⇒ null (never a probe). */
  function get(id) {
    if (!isSlug(id)) return null;
    return hydrate(rowById(id));
  }

  return { generators, record, list, get };
}
