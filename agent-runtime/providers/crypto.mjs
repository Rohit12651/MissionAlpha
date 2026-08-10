// Multi-Provider Credentials — Task 2: AES-256-GCM seal/open + machine key mgmt.
// The machine key lives at <dir>/cred.key (0600, OUTSIDE the repo — dir is TOKEN_DIR
// in prod, which server.mjs already asserts is outside REPO_ROOT). GCM's auth tag
// makes any tampered ciphertext fail to open — a corrupted store never yields a
// silently-wrong secret, it throws.
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const KEY_FILE = (dir) => join(dir, "cred.key");

export function ensureKey(dir) {
  const f = KEY_FILE(dir);
  if (!existsSync(f)) writeFileSync(f, randomBytes(32), { mode: 0o600 });
  return readFileSync(f);
}

export function sealSecret(dir, plaintext) {
  const key = ensureKey(dir);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return { iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ct: ct.toString("base64") };
}

export function openSecret(dir, sealed) {
  const key = ensureKey(dir);
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
  d.setAuthTag(Buffer.from(sealed.tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(sealed.ct, "base64")), d.final()]).toString("utf8");
}
