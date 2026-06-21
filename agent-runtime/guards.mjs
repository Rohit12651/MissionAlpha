// F2b apply-broker GUARDS — extracted verbatim from server.mjs so the engine
// (ADR-024) and policy (ADR-029) can reuse the EXACT same predicates without
// booting the HTTP server. LOGIC IS UNCHANGED — this is a move, not a rewrite.
// server.mjs imports these back, so its behavior is byte-for-byte identical.
//
// sr-security: applyAllowed / configGuardViolation / APPLY_DENY / CONFIG_GUARD /
// SEED_DIRS / SEED_FILES are the security boundary. Any change here changes the
// broker. Diff against the original server.mjs definitions to confirm equivalence.

import { dirname, resolve, relative, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dir, ".."); // MissionAlpha repo root

// Seeded + appliable scope. src/ + public/ + README + package.json. Still EXCLUDES
// *.config.ts + scripts/ + infrastructure/ + .github/ (pure exec / CI). package.json
// IS appliable BUT its exec/supply-chain keys are hard-guarded server-side
// (CONFIG_GUARD) — sr-security F2b.
//
// public/ is the static-deliverable surface: a /run "build" (e.g. an agent producing
// billsplit.html) writes its output here so it surfaces via /changes and is operator-
// appliable. It carries no exec semantics (Vite serves it verbatim), and apply stays
// gated by APPLY_DENY + containment + symlink/realpath checks. SEED_DIRS is the SINGLE
// source of truth for both the copy-sandbox broker AND the engine worktree broker.
export const SEED_DIRS = ["src", "public"];
export const SEED_FILES = ["README.md", "package.json"];
// apply() refuses any path matching these (defense beyond the .claude denylist).
export const APPLY_DENY = /(^|\/)(\.env|\.git|\.claude|node_modules|.*\.(pem|key|p12))(\/|$)/i;
// public/ is appliable for STATIC deliverables only. An agent's /run "build" must NOT
// land: (a) public/index.html — Vite serves it at / AHEAD of the SPA shell on every
// dashboard load, so an applied one could swap the UI + exfiltrate the runtime token
// (fetched same-origin from localhost); or (b) any script/executable type — served
// verbatim by Vite = browser RCE/XSS surface. Non-index .html / css / images / fonts /
// json stay appliable (e.g. billsplit.html). sr-security: PUBLIC_GUARD.
export const PUBLIC_DENY = /^public\/(index\.html$|.*\.(sh|bash|zsh|py|rb|pl|ps1|bat|cmd|exe|dll|so|dylib|wasm|mjs|cjs|jsx?|tsx?)$)/i;
// Files whose exec-relevant keys must NEVER change via the broker. If any protected
// key differs between repo + sandbox, the whole file apply is refused.
export const CONFIG_GUARD = {
  "package.json": ["scripts", "dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "bin", "main", "module", "exports"],
};

// True if a relPath is safe to apply — validated on the RESOLVED path, not the raw
// string (sr-security F2b: re-derive scope from the normalized path).
export function applyAllowed(relPath) {
  if (!relPath || typeof relPath !== "string") return false;
  if (isAbsolute(relPath)) return false;
  if (/[\x00-\x1f]/.test(relPath)) return false; // control chars / NUL
  if (/["'`|$=]/.test(relPath)) return false; // bus-format metachars — no legit use in src/
  const dest = resolve(REPO_ROOT, relPath);
  const rootPrefix = resolve(REPO_ROOT) + sep;
  if (!dest.startsWith(rootPrefix)) return false; // containment (kills ../ escape)
  const relNorm = relative(REPO_ROOT, dest); // canonical
  if (APPLY_DENY.test(relNorm)) return false;
  const relSlash = relNorm.split(sep).join("/"); // platform-stable for the public/ guard
  if (PUBLIC_DENY.test(relSlash)) return false;
  const top = relNorm.split(sep)[0];
  return SEED_DIRS.includes(top) || SEED_FILES.includes(relNorm);
}

// Config guard — for a CONFIG_GUARD file, return the first protected key that
// differs between repo (before) and sandbox (after), or null if safe. Blocks
// supply-chain / exec-on-apply key changes (e.g. package.json scripts/deps).
export function configGuardViolation(relNorm, before, after) {
  const keys = CONFIG_GUARD[relNorm];
  if (!keys) return null;
  let a, b;
  try {
    b = JSON.parse(before ?? "{}");
    a = JSON.parse(after);
  } catch {
    return "unparseable JSON"; // refuse if we can't verify
  }
  const norm = (v) => JSON.stringify(v ?? null);
  for (const k of keys) {
    if (norm(b[k]) !== norm(a[k])) return k;
  }
  return null;
}
