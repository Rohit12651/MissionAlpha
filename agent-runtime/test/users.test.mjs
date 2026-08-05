// P9 — users.mjs: scrypt accounts + in-memory session store. Direct-import unit
// tests (no HTTP). A throwaway tmp DB (migration v8) backs the accounts store.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const { openDb } = await import(join(__dir, "..", "db.mjs"));
const { createUsers, createSessions, hashPassword, verifyHash, SCRYPT } = await import(join(__dir, "..", "users.mjs"));

let root, store, users;

before(() => {
  root = mkdtempSync(join(tmpdir(), "p9-users-"));
  store = openDb({ path: join(root, "m.db"), patchesDir: join(root, "p") });
  users = createUsers({ db: store.db });
});
after(() => { try { store.close(); } catch { /* */ } rmSync(root, { recursive: true, force: true }); });

// ── scrypt ────────────────────────────────────────────────────────────────
test("hashPassword produces a self-describing scrypt string with the mandated params", () => {
  const h = hashPassword("correct horse battery");
  const parts = h.split("$");
  assert.equal(parts[0], "scrypt");
  assert.equal(Number(parts[1]), SCRYPT.N);
  assert.ok(SCRYPT.N >= 16384, "N must be >= 16384");
  assert.equal(parts[4].length, SCRYPT.saltLen * 2, "16-byte hex salt");
  assert.equal(parts[5].length, SCRYPT.keyLen * 2, "64-byte hex key");
});

test("verifyHash is correct for the right password, false for the wrong one", () => {
  const h = hashPassword("s3cret-passphrase");
  assert.equal(verifyHash("s3cret-passphrase", h), true);
  assert.equal(verifyHash("s3cret-passphras", h), false);   // one char short
  assert.equal(verifyHash("", h), false);
});

test("verifyHash fails closed on a malformed / unknown-format stored value", () => {
  assert.equal(verifyHash("pw", "not-a-hash"), false);
  assert.equal(verifyHash("pw", "bcrypt$10$abc"), false);
  assert.equal(verifyHash("pw", "scrypt$16384$8$1$zz$zz"), false); // non-hex
  assert.equal(verifyHash("pw", null), false);
});

test("two hashes of the same password differ (random salt) yet both verify", () => {
  const a = hashPassword("same-password-x");
  const b = hashPassword("same-password-x");
  assert.notEqual(a, b);
  assert.ok(verifyHash("same-password-x", a) && verifyHash("same-password-x", b));
});

// ── accounts ────────────────────────────────────────────────────────────────
test("createUser validates name, password length, and role", () => {
  assert.equal(users.count(), 0);
  assert.ok(users.createUser({ name: "Rohit", password: "longenough1", role: "approver" }).user);
  assert.equal(users.count(), 1);
  assert.match(users.createUser({ name: "x", password: "short", role: "viewer" }).error, /at least 8/);
  assert.match(users.createUser({ name: "!bad!", password: "longenough1", role: "viewer" }).error, /name must be/);
  assert.match(users.createUser({ name: "Ok", password: "longenough1", role: "root" }).error, /role must be/);
  assert.equal(users.createUser({ name: "Rohit", password: "longenough1", role: "viewer" }).code, 409); // dup
});

test("listUsers / getById / getByName NEVER expose the password hash", () => {
  const list = users.listUsers();
  assert.ok(list.length >= 1);
  for (const u of list) assert.ok(!("hash" in u), "list row must not carry hash");
  const one = users.getByName("Rohit");
  assert.ok(one && !("hash" in one));
  assert.equal(users.getById("nope"), null);
});

test("verifyPassword returns the public user on success, null on wrong password", () => {
  users.createUser({ name: "Bob", password: "bob-password-1", role: "viewer" });
  const ok = users.verifyPassword("Bob", "bob-password-1");
  assert.ok(ok && ok.role === "viewer" && !("hash" in ok));
  assert.equal(users.verifyPassword("Bob", "WRONG"), null);
});

test("no user enumeration: unknown-user and wrong-password are indistinguishable (both null, comparable timing)", () => {
  // Both return null (behavioural indistinguishability — the property that matters).
  assert.equal(users.verifyPassword("GhostUser", "anything"), null);
  assert.equal(users.verifyPassword("Bob", "definitely-wrong"), null);
  // And the unknown-user path is NOT a fast early return: it runs a full scrypt, so
  // its timing is the same order of magnitude as a real verify (no timing oracle).
  const t0 = performance.now(); users.verifyPassword("Bob", "bob-password-1"); const treal = performance.now() - t0;
  const t1 = performance.now(); users.verifyPassword("GhostUser", "anything");  const tnouser = performance.now() - t1;
  assert.ok(tnouser >= treal * 0.3, `unknown-user verify must do real work (real=${treal.toFixed(1)}ms nouser=${tnouser.toFixed(1)}ms)`);
});

test("deleteUser removes the account and returns 404 for an unknown id", () => {
  const bob = users.getByName("Bob");
  assert.ok(users.deleteUser(bob.id).deleted);
  assert.equal(users.getByName("Bob"), null);
  assert.equal(users.deleteUser("usr_missing").code, 404);
});

test("listApprovers returns only approver accounts", () => {
  const approvers = users.listApprovers();
  assert.ok(approvers.every((u) => u.role === "approver"));
});

// ── sessions ────────────────────────────────────────────────────────────────
test("sessions: create → get → revoke lifecycle, opaque 32-byte id", () => {
  const sess = createSessions({});
  const s = sess.create({ userId: "usr_1", name: "Rohit", role: "approver" });
  assert.equal(s.id.length, 64, "32 bytes = 64 hex chars");
  const got = sess.get(s.id);
  assert.ok(got && got.name === "Rohit" && got.role === "approver");
  assert.equal(sess.revoke(s.id), true);
  assert.equal(sess.get(s.id), null);
  assert.equal(sess.get("deadbeef"), null); // wrong length → null, no throw
});

test("sessions: expire after TTL", async () => {
  const sess = createSessions({ ttlMs: 40 });
  const s = sess.create({ userId: "usr_2", name: "Bob", role: "viewer" });
  assert.ok(sess.get(s.id));
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(sess.get(s.id), null);
});

test("sessions: revokeUser drops every session belonging to a user", () => {
  const sess = createSessions({});
  sess.create({ userId: "usr_3", name: "A", role: "approver" });
  sess.create({ userId: "usr_3", name: "A", role: "approver" });
  sess.create({ userId: "usr_4", name: "B", role: "viewer" });
  assert.equal(sess.revokeUser("usr_3"), 2);
  assert.equal(sess.count(), 1);
});
