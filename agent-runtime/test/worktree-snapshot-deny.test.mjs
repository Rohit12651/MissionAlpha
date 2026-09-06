// 6.1 — THE SNAPSHOT DENY LIST CATCHES SECRET FILES, NEVER SOURCE MODULES.
//
// The defect, measured live on 2026-09-02: the row `/(^|\/)(credentials|secrets?)(\.|$)/i`
// matched `agent-runtime/providers/credentials.mjs` — a 16,610-byte SOURCE MODULE the
// operator had uncommitted. `snapshotAllowed` refused it, so it was never staged into the
// snapshot base and every worktree got HEAD's 8,302-byte copy instead. The agent then read
// stale code, and the broker (which diffs the worktree against the LIVE tree) reported the
// operator's own 8kB of work as a change the AGENT proposed — i.e. approving the Delivery
// would have REVERTED it.
//
// ONE RULE, STATED ONCE: that row applies only to paths that are NOT source code, where
// source code = under a source root (`agent-runtime/`, `src/`, `scripts/`, `electron/`)
// AND ending in `.mjs|.js|.ts|.tsx`. Everything else that row matched stays denied, and a
// new explicit row denies the `.credentials` DOTFILE (which the old row never matched at
// all — there is no `^` or `/` before the name, so it was allowed by accident).
//
// The threat line this pins (PLAN threat_model): a `.ts`/`.mjs` file under a source root is
// git-tracked code a human reviews; a real secret does not live as `src/lib/secrets.ts`.
// Root-level `secrets.js` stays denied because it is outside every source root. Both sides
// of that line are fixtures below, so neither can move without a test going red.
import { test } from "node:test";
import assert from "node:assert/strict";
import { snapshotAllowed } from "../worktree.mjs";

// The 12-path table from PLAN 6.1 — [path, allowed, why].
const TABLE = [
  // ALLOWED — source code under a source root.
  ["agent-runtime/providers/credentials.mjs", true, "the module that caused the defect"],
  ["src/lib/secrets.ts", true, "source root + source ext"],
  ["scripts/credentials.mjs", true, "scripts/ is a source root"],
  ["src/x.tsx", true, "never matched the row at all"],
  ["docs/a.md", true, "never matched the row at all"],
  ["agent-runtime/db.mjs", true, "never matched the row at all"],
  // DENIED — not source code, so the secret-name row still applies.
  ["credentials", false, "bare name, no source root, no ext"],
  ["config/credentials.json", false, "config/ is not a source root and .json is not source"],
  [".credentials", false, "dotfile — the NEW explicit row"],
  ["secrets.yaml", false, "root, not source"],
  ["secrets.js", false, "source EXT but no source ROOT — both are required"],
  ["secret.js", false, "the row is `secrets?` — singular counts too"],
  [".env.local", false, "unrelated row, must stay denied"],
];

test("SD-1: the 12-path fixture table — source code in, secrets out", () => {
  const got = TABLE.map(([p]) => [p, snapshotAllowed(p)]);
  const want = TABLE.map(([p, allowed]) => [p, allowed]);
  assert.deepEqual(got, want, "every row of the deny table is load-bearing");
});

test("SD-2: BOTH halves of 'source code' are required — root AND extension", () => {
  // A source root is not enough…
  assert.equal(snapshotAllowed("src/credentials.json"), false, "source root + non-source ext ⇒ denied");
  assert.equal(snapshotAllowed("agent-runtime/secrets.yaml"), false, "source root + non-source ext ⇒ denied");
  assert.equal(snapshotAllowed("electron/credentials.env.json"), false, "source root + non-source ext ⇒ denied");
  // …and neither is an extension.
  assert.equal(snapshotAllowed("config/secrets.ts"), false, "source ext + non-source root ⇒ denied");
  assert.equal(snapshotAllowed("infrastructure/credentials.js"), false, "source ext + non-source root ⇒ denied");
  // Both ⇒ allowed, for every declared root and every declared extension.
  for (const root of ["agent-runtime", "src", "scripts", "electron"]) {
    for (const ext of ["mjs", "js", "ts", "tsx"]) {
      assert.equal(snapshotAllowed(`${root}/a/credentials.${ext}`), true, `${root}/**/*.${ext} is source code`);
    }
  }
});

test("SD-3: the narrowing is scoped to ONE row — every other deny row is untouched", () => {
  // A source root + source ext does NOT buy an exemption from any other rule.
  assert.equal(snapshotAllowed("src/.env.local"), false, ".env row");
  assert.equal(snapshotAllowed("agent-runtime/.env"), false, ".env row");
  assert.equal(snapshotAllowed("src/deploy.pem"), false, "keymat row");
  assert.equal(snapshotAllowed("src/server.KEY"), false, "keymat row, case-insensitive");
  assert.equal(snapshotAllowed("src/id_rsa"), false, "ssh key row");
  assert.equal(snapshotAllowed("src/.git/config"), false, "repo-machinery row");
  assert.equal(snapshotAllowed("src/node_modules/pkg/index.js"), false, "repo-machinery row");
  assert.equal(snapshotAllowed(".claude/settings.json"), false, "repo-machinery row");
  // …and the predicate stays total: no input throws, traversal stays refused.
  assert.equal(snapshotAllowed("../etc/passwd"), false);
  assert.equal(snapshotAllowed("src/../../x.ts"), false);
  assert.equal(snapshotAllowed(""), false);
  assert.equal(snapshotAllowed(null), false);
  assert.equal(snapshotAllowed(undefined), false);
});

test("SD-4: case — an upper-case source root is NOT a source root (fail closed)", () => {
  // The deny row is case-insensitive; the source-code exemption is not. A path git did
  // not spell as one of the four roots does not get the exemption.
  assert.equal(snapshotAllowed("SRC/lib/secrets.ts"), false);
  assert.equal(snapshotAllowed("Agent-Runtime/providers/credentials.mjs"), false);
  // Backslashes normalise to forward slashes before the roots are read.
  assert.equal(snapshotAllowed("src\\lib\\secrets.ts"), true);
});


// 6.7 — security-review HIGH: auth-bearing dotfiles and key material must never reach the
// snapshot (it is bind-mounted into the jail). Verified live before the fix: `.npmrc`,
// `.netrc`, `.envrc` were ALLOWED. Pinned here; source-code exceptions are untouched.
test("SD-5: auth-bearing dotfiles and key material are refused at every level", () => {
  for (const p of [".npmrc", "packages/x/.npmrc", ".netrc", ".envrc", ".pypirc", ".dockercfg", ".docker/config.json",
    ".git-credentials", ".aws/credentials", "home/.ssh/id_x", ".gnupg/secring", ".config/gh/hosts.yml", "signing.p8", "k.ppk", "k.asc", "k.gpg", "vault.kdbx"]) {
    assert.equal(snapshotAllowed(p), false, `${p} must be refused`);
  }
  for (const p of ["src/lib/npmrc.ts", "docs/aws.md", "agent-runtime/ssh-client.mjs", ".github/workflows/ci.yml", ".eslintrc.cjs", "src/keys.tsx"]) {
    assert.equal(snapshotAllowed(p), true, `${p} is ordinary content and stays allowed`);
  }
});
