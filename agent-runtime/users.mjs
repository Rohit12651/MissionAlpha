// P9 — Second seat. Local login accounts (scrypt) + an in-memory session store.
// This module is AUTH PRIMITIVES ONLY: no HTTP, no cookies (server.mjs owns those),
// no product logic. It sits ON TOP of the runtime token — it never replaces it.
//
// SECURITY (the review will hammer these):
//   • Passwords are scrypt-hashed (N=16384, r=8, p=1, 16-byte random salt, 64-byte
//     key) and stored as a self-describing string. The plaintext is used only to
//     derive/verify and is NEVER logged, returned, or emitted.
//   • verifyPassword is constant-time (timingSafeEqual) AND non-enumerating: an
//     unknown user still runs a full scrypt against a fixed dummy hash, so a missing
//     account is indistinguishable — by result AND by timing — from a wrong password.
//   • listUsers / any egress shape NEVER carries `hash`.
//   • Session ids are 32 opaque random bytes, compared timing-safe, revocable, TTL'd,
//     and held in memory only (no session secret is ever written to disk).

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

// scrypt work factors (ADR-052-class entropy for the salt; OWASP-recommended N).
export const SCRYPT = Object.freeze({ N: 16384, r: 8, p: 1, keyLen: 64, saltLen: 16, maxmem: 64 * 1024 * 1024 });
export const ROLES = Object.freeze(["approver", "viewer"]);
const NAME_RE = /^[A-Za-z0-9 ._@-]{1,64}$/;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 200; // bound the scrypt input (a megabyte password is a DoS)

// One fixed dummy hash, derived once at load, for the no-such-user path so its timing
// matches a real verify. The password is random and unrecoverable — it can never match.
const DUMMY_HASH = hashPassword(randomBytes(24).toString("hex"));

function scryptOne(password, salt) {
  return scryptSync(Buffer.from(String(password), "utf8"), salt, SCRYPT.keyLen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem,
  });
}

// `scrypt$N$r$p$saltHex$hashHex` — self-describing so a future param bump can verify
// legacy rows against their OWN stored params (never the current constants).
export function hashPassword(password) {
  const salt = randomBytes(SCRYPT.saltLen);
  const derived = scryptOne(password, salt);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("hex")}$${derived.toString("hex")}`;
}

// Timing-safe verify against a stored `scrypt$...` string. Unknown format → false
// (fail closed). Always derives with the STORED params, never the current constants.
export function verifyHash(password, stored) {
  if (typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]), r = Number(parts[2]), p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p) || N < 2 || r < 1 || p < 1) return false;
  let salt, want;
  try { salt = Buffer.from(parts[4], "hex"); want = Buffer.from(parts[5], "hex"); } catch { return false; }
  if (!salt.length || !want.length) return false;
  let got;
  try {
    got = scryptSync(Buffer.from(String(password), "utf8"), salt, want.length, { N, r, p, maxmem: SCRYPT.maxmem });
  } catch { return false; }
  if (got.length !== want.length) return false;
  try { return timingSafeEqual(got, want); } catch { return false; }
}

function newUserId() { return `usr_${randomBytes(9).toString("hex")}`; }

// ── accounts ────────────────────────────────────────────────────────────────
export function createUsers(deps = {}) {
  const db = deps.db?.db || deps.db; // accept the openDb handle OR the raw better-sqlite3
  if (!db || typeof db.prepare !== "function") throw new Error("createUsers: db handle required");
  const now = deps.now || (() => Date.now());
  const nowIso = () => new Date(now()).toISOString();

  const countStmt = db.prepare("SELECT COUNT(*) n FROM users");
  const byNameStmt = db.prepare("SELECT * FROM users WHERE name = ?");
  const byIdStmt = db.prepare("SELECT * FROM users WHERE id = ?");
  const listStmt = db.prepare("SELECT id, name, role, createdAt FROM users ORDER BY createdAt ASC, name ASC");
  const insStmt = db.prepare("INSERT INTO users(id, name, role, hash, createdAt) VALUES(?, ?, ?, ?, ?)");
  const delStmt = db.prepare("DELETE FROM users WHERE id = ?");

  const count = () => countStmt.get().n;

  // Public projection — NEVER carries `hash`.
  const publicUser = (row) => (row ? { id: row.id, name: row.name, role: row.role, createdAt: row.createdAt } : null);

  const getById = (id) => publicUser(byIdStmt.get(id) || null);
  const getByName = (name) => publicUser(byNameStmt.get(String(name)) || null);
  const listUsers = () => listStmt.all();
  const listApprovers = () => listStmt.all().filter((u) => u.role === "approver");

  function validate(name, password, role) {
    const nm = String(name ?? "").trim();
    if (!NAME_RE.test(nm)) return { error: "name must be 1–64 chars: letters, digits, space . _ @ -" };
    if (typeof password !== "string" || password.length < MIN_PASSWORD) return { error: `password must be at least ${MIN_PASSWORD} characters` };
    if (password.length > MAX_PASSWORD) return { error: `password too long (max ${MAX_PASSWORD})` };
    if (!ROLES.includes(role)) return { error: `role must be one of: ${ROLES.join(", ")}` };
    return { name: nm };
  }

  function createUser({ name, password, role } = {}) {
    const v = validate(name, password, role);
    if (v.error) return { error: v.error, code: 400 };
    if (byNameStmt.get(v.name)) return { error: "a user with that name already exists", code: 409 };
    const id = newUserId();
    // hashPassword derives BEFORE the row is written; the plaintext leaves scope here
    // and is never referenced again (no log, no return).
    insStmt.run(id, v.name, role, hashPassword(password), nowIso());
    return { user: getById(id) };
  }

  function deleteUser(id) {
    const existing = byIdStmt.get(String(id));
    if (!existing) return { error: "not found", code: 404 };
    delStmt.run(String(id));
    return { deleted: publicUser(existing) };
  }

  // Constant-time + non-enumerating credential check. Returns the PUBLIC user on
  // success, null on ANY failure (unknown name OR wrong password — same result,
  // same work: the unknown-name branch still runs a full scrypt against DUMMY_HASH).
  function verifyPassword(name, password) {
    const row = byNameStmt.get(String(name ?? ""));
    if (!row) { verifyHash(String(password ?? ""), DUMMY_HASH); return null; }
    return verifyHash(String(password ?? ""), row.hash) ? publicUser(row) : null;
  }

  return { count, createUser, deleteUser, verifyPassword, listUsers, listApprovers, getById, getByName };
}

// ── sessions (in-memory, opaque, revocable) ───────────────────────────────────
const SESSION_BYTES = 32;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h
const MAX_SESSIONS = 1024;

export function createSessions(deps = {}) {
  const now = deps.now || (() => Date.now());
  const ttlMs = Number(deps.ttlMs) > 0 ? Number(deps.ttlMs) : SESSION_TTL_MS;
  const maxSessions = Number(deps.maxSessions) > 0 ? Number(deps.maxSessions) : MAX_SESSIONS;
  const sessions = new Map(); // id → { userId, name, role, expiresAt }

  function sweep() {
    const t = now();
    for (const [id, s] of sessions) if (s.expiresAt <= t) sessions.delete(id);
  }

  function create({ userId, name, role } = {}) {
    sweep();
    if (sessions.size >= maxSessions) return { error: "too many sessions", code: 429 };
    const id = randomBytes(SESSION_BYTES).toString("hex");
    const expiresAt = now() + ttlMs;
    sessions.set(id, { userId, name, role, expiresAt });
    return { id, expiresAt, ttlMs };
  }

  // Timing-safe lookup — a valid-length candidate is compared constant-time against
  // every live id, so a match/no-match is not distinguishable by early-exit timing.
  function get(candidate) {
    if (typeof candidate !== "string" || candidate.length !== SESSION_BYTES * 2) return null;
    sweep();
    const buf = Buffer.from(candidate);
    for (const [id, s] of sessions) {
      if (id.length !== candidate.length) continue;
      let same = false;
      try { same = timingSafeEqual(Buffer.from(id), buf); } catch { same = false; }
      if (!same) continue;
      if (s.expiresAt <= now()) { sessions.delete(id); return null; }
      return { id, userId: s.userId, name: s.name, role: s.role, expiresAt: s.expiresAt };
    }
    return null;
  }

  function revoke(candidate) {
    if (typeof candidate !== "string") return false;
    // Delete via the timing-safe match so revoke can't be used as an oracle either.
    const found = get(candidate);
    if (!found) return false;
    return sessions.delete(found.id);
  }

  // Drop every session for a user (used when the account is deleted).
  function revokeUser(userId) {
    let n = 0;
    for (const [id, s] of sessions) if (s.userId === userId) { sessions.delete(id); n++; }
    return n;
  }

  const count = () => { sweep(); return sessions.size; };
  const clear = () => sessions.clear();

  return { create, get, revoke, revokeUser, sweep, count, clear };
}
