// B2 / ADR-055 — Knowledge Vault store: markdown records on disk + a SQLite index,
// provenance headers, venture scoping, the closed 6-node taxonomy, scrub-at-rest and
// CASE-INSENSITIVE slug-only path containment.
//
// The HTTP surface (auth gates, SSE emit) is proven separately in vault-http.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, mkdirSync, writeFileSync, symlinkSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../db.mjs";
import {
  createVault,
  VAULT_NODES,
  NODE_BY_AGENT,
  DEFAULT_NODE,
  DECISION_NODE,
  nodeForAgent,
  isSlug,
  slugify,
  recordPath,
  MAX_VAULT_TITLE,
  MAX_VAULT_BODY,
} from "../vault.mjs";

const SECRET_RE = /sk-ant-[A-Za-z0-9_-]{6,}/g;
const scrub = (s) => (typeof s === "string" ? s.replace(SECRET_RE, "[redacted-secret]") : s);

function harness(over = {}) {
  const root = mkdtempSync(join(tmpdir(), "ma-vault-"));
  const h = openDb({ path: join(root, "data", "mission.db") });
  const vaultRoot = join(root, "data", "vault");
  const v = createVault({ db: h, root: vaultRoot, scrub, ...over });
  return { root, vaultRoot, h, v, cleanup: () => { h.close(); rmSync(root, { recursive: true, force: true }); } };
}

// ── the closed taxonomy ──────────────────────────────────────────────────────

test("VAULT_NODES is EXACTLY the six fixed nodes", () => {
  assert.deepEqual([...VAULT_NODES], ["ventures", "market", "content", "pipeline", "tech", "decisions"]);
});

test("S0: NODE_BY_AGENT maps only docs-writer; every other seat falls to tech", () => {
  assert.deepEqual({ ...NODE_BY_AGENT }, {
    "docs-writer": "content",
  });
  assert.equal(DEFAULT_NODE, "tech");
  assert.equal(DECISION_NODE, "decisions");
  assert.equal(nodeForAgent("docs-writer"), "content");
  assert.equal(nodeForAgent("sr-backend"), "tech", "an engineering seat writes to tech");
  assert.equal(nodeForAgent("qa"), "tech");
  assert.equal(nodeForAgent("web-1"), "tech");
  assert.equal(nodeForAgent(""), "tech");
  assert.equal(nodeForAgent(null), "tech");
  // Every mapped node must itself be in the closed taxonomy.
  for (const n of Object.values(NODE_BY_AGENT)) assert.ok(VAULT_NODES.includes(n), n);
});

// ── slug + containment (the program's recurring security lesson) ─────────────

test("isSlug accepts lowercase slugs ONLY — every traversal shape is refused", () => {
  for (const good of ["waahyu", "market", "task-1a2b3c", "a", "0", "a-b-c"]) {
    assert.equal(isSlug(good), true, good);
  }
  for (const bad of [
    "", ".", "..", "../", "../../etc", "/etc/passwd", "C:\\win", "a/b", "a\\b",
    "WAAHYU", "Market", "wAaHyU",      // mixed case — a case-insensitive FS would fold these
    "-lead", "a b", "a_b", "a.b", "a%2f", "a\0b", "x".repeat(65), null, undefined, 42, {},
  ]) {
    assert.equal(isSlug(bad), false, JSON.stringify(bad));
  }
});

test("slugify folds a server-derived id to a slug and never yields a traversal", () => {
  assert.equal(slugify("task_1A2B3C"), "task-1a2b3c");
  assert.equal(slugify("01J0ABC"), "01j0abc");
  assert.equal(slugify("../../etc/passwd"), "etc-passwd");
  assert.equal(slugify("..."), null, "nothing slug-shaped left ⇒ null, never a bare dash");
  assert.equal(slugify(""), null);
  assert.equal(slugify("---"), null);
  for (const s of ["task_x", "../a", "A/B", "  spaced  "]) {
    const out = slugify(s);
    if (out !== null) assert.equal(isSlug(out), true, `${s} → ${out}`);
  }
});

test("recordPath refuses anything that leaves the vault root, case-insensitively", () => {
  const root = "/tmp/ma-vault-root";
  assert.equal(recordPath(root, "waahyu", "market", "abc"), join(root, "waahyu", "market", "abc.md"));
  for (const [ven, node, id] of [
    ["..", "market", "abc"],
    ["waahyu", "..", "abc"],
    ["waahyu", "market", ".."],
    ["waahyu", "market", "../../../etc/passwd"],
    ["/etc", "market", "abc"],
    ["waahyu", "market", "/abs"],
    ["WAAHYU", "market", "abc"],   // mixed-case escape — refused before any fold can help it
    ["waahyu", "MARKET", "abc"],
    ["waahyu", "market", "AbC"],
  ]) {
    assert.throws(() => recordPath(root, ven, node, id), /vault:/, `${ven}/${node}/${id}`);
  }
});

// ── migration (ventures + vault_records) ────────────────────────────────────

test("the migration creates ventures (seeded waahyu) and vault_records with its CHECKs", () => {
  const t = harness();
  try {
    const seeded = t.h.db.prepare("SELECT id, name, created_at FROM ventures").all();
    assert.deepEqual(seeded.map((r) => r.id), ["waahyu"]);
    assert.equal(seeded[0].name, "WAAHYU");
    assert.ok(Number.isFinite(seeded[0].created_at) && seeded[0].created_at > 0);

    const ins = (over = {}) => {
      const r = {
        id: "r1", venture: "waahyu", node: "market", title: "t", author: "pm-analyst",
        source_run: null, created_at: 1, body_excerpt: "", path: "/x/r1.md", ...over,
      };
      return t.h.db.prepare(
        `INSERT INTO vault_records(id,venture,node,title,author,source_run,created_at,body_excerpt,path)
         VALUES(@id,@venture,@node,@title,@author,@source_run,@created_at,@body_excerpt,@path)`,
      ).run(r);
    };
    ins();
    assert.throws(() => ins({ id: "r2", node: "not-a-node", path: "/x/r2.md" }), /CHECK/i);
    assert.throws(() => ins({ id: "r3" }), /UNIQUE/i, "path is UNIQUE");
    for (const n of VAULT_NODES) ins({ id: `ok-${n}`, node: n, path: `/x/${n}.md` });
  } finally { t.cleanup(); }
});

// ── write ───────────────────────────────────────────────────────────────────

test("write() lands a .md under <root>/<venture>/<node>/<id>.md with a provenance header + a row", () => {
  const t = harness();
  try {
    const r = t.v.write({
      venture: "waahyu", node: "market", title: "Competitor sweep",
      body: "# Findings\n\nThree new entrants.\n", author: "pm-analyst", sourceRun: "task_9f",
    });
    assert.ok(!r.error, r.error);
    assert.equal(isSlug(r.id), true);
    assert.equal(r.path, join(t.vaultRoot, "waahyu", "market", `${r.id}.md`));
    assert.ok(existsSync(r.path), "markdown file on disk");
    assert.equal(statSync(r.path).mode & 0o777, 0o600, "record file must be 0600");
    assert.equal(statSync(join(t.vaultRoot, "waahyu", "market")).mode & 0o777, 0o700, "node dir must be 0700");

    const text = readFileSync(r.path, "utf-8");
    assert.match(text, /^---\n/, "front-matter provenance header");
    assert.match(text, /\nid: /);
    assert.match(text, /\ntitle: Competitor sweep\n/);
    assert.match(text, /\nauthor: pm-analyst\n/);
    assert.match(text, /\nventure: waahyu\n/);
    assert.match(text, /\nnode: market\n/);
    assert.match(text, /\nwritten: \d{4}-\d{2}-\d{2}T[\d:.]+Z\n/, "ISO timestamp");
    assert.match(text, /\nsource_run: task_9f\n/);
    assert.ok(text.includes("Three new entrants."), "body follows the header");

    const row = t.h.db.prepare("SELECT * FROM vault_records WHERE id = ?").get(r.id);
    assert.equal(row.venture, "waahyu");
    assert.equal(row.node, "market");
    assert.equal(row.title, "Competitor sweep");
    assert.equal(row.author, "pm-analyst");
    assert.equal(row.source_run, "task_9f");
    assert.equal(row.path, r.path);
    assert.match(row.body_excerpt, /Three new entrants/);
  } finally { t.cleanup(); }
});

test("write() SCRUBS the title, the body on disk, and the stored excerpt", () => {
  const t = harness();
  try {
    const r = t.v.write({
      venture: "waahyu", node: "tech", title: "key sk-ant-DEADBEEF01 leaked",
      body: "header\n\ntoken sk-ant-DEADBEEF01 in the body\n", author: "sr-backend",
    });
    assert.ok(!r.error, r.error);
    assert.ok(!r.title.includes("sk-ant-DEADBEEF01"), "returned title scrubbed");
    const disk = readFileSync(r.path, "utf-8");
    assert.ok(!disk.includes("sk-ant-DEADBEEF01"), "NOTHING secret reaches disk");
    assert.match(disk, /\[redacted-secret\]/);
    const row = t.h.db.prepare("SELECT title, body_excerpt FROM vault_records WHERE id = ?").get(r.id);
    assert.ok(!row.title.includes("sk-ant-DEADBEEF01"));
    assert.ok(!row.body_excerpt.includes("sk-ant-DEADBEEF01"));
    assert.ok(!t.v.get(r.id).body.includes("sk-ant-DEADBEEF01"), "and not on egress either");
  } finally { t.cleanup(); }
});

test("write() rejects an unknown node without touching disk", () => {
  const t = harness();
  try {
    const r = t.v.write({ venture: "waahyu", node: "finance", title: "x", body: "y", author: "a" });
    assert.equal(r.code, 400);
    assert.match(r.error, /node/);
    assert.equal(t.h.db.prepare("SELECT COUNT(*) n FROM vault_records").get().n, 0);
    assert.equal(existsSync(join(t.vaultRoot, "waahyu", "finance")), false);
  } finally { t.cleanup(); }
});

test("write() rejects an UNKNOWN venture — ventures are created only via createVenture()", () => {
  const t = harness();
  try {
    const r = t.v.write({ venture: "ghost", node: "market", title: "x", body: "y", author: "a" });
    assert.equal(r.code, 400);
    assert.match(r.error, /venture/);
    assert.equal(existsSync(join(t.vaultRoot, "ghost")), false, "no directory auto-created");

    assert.ok(!t.v.createVenture({ id: "orbit", name: "Orbit" }).error);
    const ok = t.v.write({ venture: "orbit", node: "market", title: "x", body: "y", author: "a" });
    assert.ok(!ok.error, ok.error);
    assert.equal(ok.venture, "orbit");
  } finally { t.cleanup(); }
});

test("write() refuses every traversal shape in venture / node / id — nothing escapes the root", () => {
  const t = harness();
  try {
    const attempts = [
      { venture: "../../../etc", node: "market", id: "abc" },
      { venture: "waahyu", node: "../..", id: "abc" },
      { venture: "waahyu", node: "market", id: "../../../../tmp/pwned" },
      { venture: "/etc", node: "market", id: "abc" },
      { venture: "waahyu", node: "market", id: "/abs/pwned" },
      { venture: "WAAHYU", node: "market", id: "abc" },       // mixed-case escape
      { venture: "waahyu", node: "MARKET", id: "abc" },
      { venture: "waahyu", node: "market", id: "AbC" },
      { venture: "waahyu", node: "market", id: "a\0b" },
    ];
    for (const a of attempts) {
      const r = t.v.write({ ...a, title: "x", body: "y", author: "a" });
      assert.equal(r.code, 400, JSON.stringify(a));
      assert.ok(/venture|node|id/.test(r.error), `${JSON.stringify(a)} → ${r.error}`);
    }
    assert.equal(t.h.db.prepare("SELECT COUNT(*) n FROM vault_records").get().n, 0, "no row survived any attempt");
    assert.equal(existsSync(join(t.root, "data", "pwned")), false);
    assert.equal(existsSync(join(t.root, "pwned")), false);
  } finally { t.cleanup(); }
});

test("write() never writes THROUGH a symlink planted at the record path", () => {
  const t = harness();
  try {
    const outside = join(t.root, "outside.md");
    writeFileSync(outside, "ORIGINAL\n");
    const dir = join(t.vaultRoot, "waahyu", "tech");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    symlinkSync(outside, join(dir, "planted.md"));
    const r = t.v.write({ id: "planted", venture: "waahyu", node: "tech", title: "x", body: "PWNED", author: "a" });
    assert.equal(r.code, 400);
    assert.match(r.error, /symlink/i);
    assert.equal(readFileSync(outside, "utf-8"), "ORIGINAL\n", "the link target is untouched");
  } finally { t.cleanup(); }
});

test("write() refuses a symlink planted at ANY level of the record's directory chain", () => {
  // The file-level check alone is not enough: mkdirSync({recursive:true}) succeeds on
  // an existing symlink-to-directory, so a link at the vault ROOT, <root>/<venture> or
  // <root>/<venture>/<node> would redirect the write just as effectively.
  // `root` was added after the B2 security review PROVED a root-level link relocated
  // every record while the write still answered ACCEPTED (sr-security MED-1).
  for (const level of ["root", "venture", "node"]) {
    const t = harness();
    try {
      const outside = join(t.root, "escape-hatch");
      mkdirSync(outside, { recursive: true });
      const linkAt = level === "root"
        ? t.vaultRoot
        : level === "venture" ? join(t.vaultRoot, "waahyu") : join(t.vaultRoot, "waahyu", "tech");
      if (level === "root") { try { rmSync(t.vaultRoot, { recursive: true, force: true }); } catch { /* absent is fine */ } }
      mkdirSync(dirname(linkAt), { recursive: true, mode: 0o700 });
      symlinkSync(outside, linkAt);
      const r = t.v.write({ venture: "waahyu", node: "tech", title: "x", body: "PWNED", author: "a" });
      assert.equal(r.code, 400, level);
      assert.match(r.error, /symlink/i, level);
      assert.deepEqual(readdirSync(outside), [], `nothing was written through the ${level} link`);
      assert.equal(t.h.db.prepare("SELECT COUNT(*) n FROM vault_records").get().n, 0, level);
    } finally { t.cleanup(); }
  }
});

test("list() coerces fractional / non-finite limit+offset to integers (no SQLite datatype 500)", () => {
  // sr-security LOW-4: `Number("1.5")` reached SQLite as a float and threw
  // `datatype mismatch` → a 500 on a plain GET. Floor + finite-check now precede the
  // clamp, so every hostile shape degrades to a sane integer instead of an error.
  const t = harness();
  try {
    for (const n of [1, 2, 3]) t.v.write({ venture: "waahyu", node: "tech", title: `r${n}`, body: "x", author: "sr-backend" });
    for (const bad of ["1.5", "2.9", "1e21", "-4", "NaN", "abc", "", Infinity, -Infinity]) {
      const rows = t.v.list({ limit: bad, offset: bad });
      assert.ok(Array.isArray(rows), `limit/offset ${String(bad)} returned rows`);
    }
    assert.equal(t.v.list({ limit: "2.9" }).length, 2, "2.9 floors to 2");
    assert.equal(t.v.list({ limit: "1.5", offset: "1.9" }).length, 1, "offset 1.9 floors to 1");
  } finally { t.cleanup(); }
});

test("write() scrubs a secret-shaped author instead of storing it verbatim", () => {
  // sr-security LOW-5: `author` was the one field neither scrubbed at rest nor on
  // egress. Scrub now runs BEFORE slugify.
  const t = harness();
  try {
    const r = t.v.write({ venture: "waahyu", node: "tech", title: "t", body: "b", author: "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" });
    if (!r.error) {
      assert.ok(!/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/.test(r.author), "raw secret not stored as author");
      assert.ok(!/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/.test(readFileSync(r.path, "utf-8")), "raw secret not in front matter");
    }
  } finally { t.cleanup(); }
});

test("write() is idempotent per id — a re-write UPDATES the row and file, never duplicates", () => {
  const t = harness();
  try {
    const a = t.v.write({ id: "task-1a2b", venture: "waahyu", node: "tech", title: "first", body: "one", author: "sr-backend" });
    assert.equal(a.id, "task-1a2b");
    const b = t.v.write({ id: "task-1a2b", venture: "waahyu", node: "tech", title: "second", body: "two", author: "sr-backend" });
    assert.ok(!b.error, b.error);
    assert.equal(t.h.db.prepare("SELECT COUNT(*) n FROM vault_records").get().n, 1, "no duplicate row");
    assert.equal(t.h.db.prepare("SELECT title FROM vault_records WHERE id=?").get("task-1a2b").title, "second");
    assert.match(readFileSync(a.path, "utf-8"), /two/);
  } finally { t.cleanup(); }
});

test("a re-write that moves nodes relocates the file and leaves no orphan", () => {
  const t = harness();
  try {
    const a = t.v.write({ id: "movable", venture: "waahyu", node: "tech", title: "t", body: "b", author: "a" });
    const b = t.v.write({ id: "movable", venture: "waahyu", node: "market", title: "t", body: "b", author: "a" });
    assert.ok(!b.error, b.error);
    assert.equal(existsSync(a.path), false, "old path removed");
    assert.ok(existsSync(b.path));
    assert.equal(t.h.db.prepare("SELECT COUNT(*) n FROM vault_records").get().n, 1);
  } finally { t.cleanup(); }
});

test("write() caps the title and the body, and refuses an empty title", () => {
  const t = harness();
  try {
    const long = t.v.write({
      venture: "waahyu", node: "tech", title: "T".toLowerCase().repeat(MAX_VAULT_TITLE + 50),
      body: "b".repeat(MAX_VAULT_BODY + 5000), author: "a",
    });
    assert.ok(!long.error, long.error);
    assert.equal(long.title.length, MAX_VAULT_TITLE);
    assert.equal(t.v.get(long.id).body.length, MAX_VAULT_BODY);

    assert.equal(t.v.write({ venture: "waahyu", node: "tech", title: "   ", body: "b", author: "a" }).code, 400);
    assert.equal(t.v.write({ venture: "waahyu", node: "tech", title: "t", body: "b", author: "!!!" }).code, 400, "author must slugify to something");
  } finally { t.cleanup(); }
});

// ── list / get / stats ──────────────────────────────────────────────────────

test("list() filters by venture, by node and by q (title OR body excerpt), newest first", () => {
  const t = harness();
  try {
    t.v.createVenture({ id: "orbit", name: "Orbit" });
    t.v.write({ id: "a1", venture: "waahyu", node: "market", title: "Alpha sweep", body: "nothing", author: "pm-analyst" });
    t.v.write({ id: "b2", venture: "waahyu", node: "tech", title: "Repo health", body: "beta signal inside", author: "sr-backend" });
    t.v.write({ id: "c3", venture: "orbit", node: "market", title: "Orbit intel", body: "nothing", author: "pm-analyst" });

    assert.deepEqual(t.v.list({}).map((r) => r.id).sort(), ["a1", "b2", "c3"]);
    assert.deepEqual(t.v.list({ venture: "waahyu" }).map((r) => r.id).sort(), ["a1", "b2"]);
    assert.deepEqual(t.v.list({ node: "market" }).map((r) => r.id).sort(), ["a1", "c3"]);
    assert.deepEqual(t.v.list({ venture: "waahyu", node: "market" }).map((r) => r.id), ["a1"]);
    assert.deepEqual(t.v.list({ q: "Alpha" }).map((r) => r.id), ["a1"], "title hit");
    assert.deepEqual(t.v.list({ q: "beta signal" }).map((r) => r.id), ["b2"], "excerpt hit");
    assert.deepEqual(t.v.list({ q: "alpha" }).map((r) => r.id), ["a1"], "case-insensitive");
    assert.deepEqual(t.v.list({ q: "%" }), [], "a LIKE wildcard is literal, not a match-all");
    assert.deepEqual(t.v.list({ venture: "nope" }), [], "unknown filter ⇒ empty, never an error");
    assert.deepEqual(t.v.list({ node: "../etc" }), []);
    // Newest first (ids mint monotonically; explicit ids sort by created_at then id).
    const ids = t.v.list({ venture: "waahyu" }).map((r) => r.id);
    assert.deepEqual(ids, ["b2", "a1"]);
    assert.equal(t.v.list({ limit: 1 }).length, 1);
  } finally { t.cleanup(); }
});

test("get() returns {meta, body} from disk; unknown or malformed id ⇒ null", () => {
  const t = harness();
  try {
    const w = t.v.write({ venture: "waahyu", node: "content", title: "Brief", body: "# H\n\npara\n", author: "docs-writer", sourceRun: "task_7" });
    const g = t.v.get(w.id);
    assert.equal(g.meta.id, w.id);
    assert.equal(g.meta.title, "Brief");
    assert.equal(g.meta.node, "content");
    assert.equal(g.meta.venture, "waahyu");
    assert.equal(g.meta.author, "docs-writer");
    assert.equal(g.meta.sourceRun, "task_7");
    assert.match(g.meta.createdAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(g.body, "# H\n\npara\n", "body only — the front matter is stripped");
    assert.equal(t.v.get("nope"), null);
    assert.equal(t.v.get("../../etc/passwd"), null);
    assert.equal(t.v.get(""), null);
    assert.equal(t.v.get(null), null);
  } finally { t.cleanup(); }
});

test("get() survives a record file that was deleted underneath it", () => {
  const t = harness();
  try {
    const w = t.v.write({ venture: "waahyu", node: "tech", title: "t", body: "b", author: "a" });
    rmSync(w.path);
    const g = t.v.get(w.id);
    assert.equal(g.meta.id, w.id, "the indexed metadata still answers");
    assert.equal(g.body, "");
  } finally { t.cleanup(); }
});

test("stats() reports total, byNode (all six, zero-filled) and byVenture", () => {
  const t = harness();
  try {
    assert.deepEqual(t.v.stats(), {
      total: 0,
      byNode: { ventures: 0, market: 0, content: 0, pipeline: 0, tech: 0, decisions: 0 },
      byVenture: { waahyu: 0 },
    });
    t.v.createVenture({ id: "orbit", name: "Orbit" });
    t.v.write({ id: "a1", venture: "waahyu", node: "market", title: "a", body: "x", author: "a" });
    t.v.write({ id: "a2", venture: "waahyu", node: "market", title: "b", body: "x", author: "a" });
    t.v.write({ id: "a3", venture: "orbit", node: "decisions", title: "c", body: "x", author: "a" });
    const s = t.v.stats();
    assert.equal(s.total, 3);
    assert.equal(s.byNode.market, 2);
    assert.equal(s.byNode.decisions, 1);
    assert.equal(s.byNode.tech, 0, "zero-filled, never absent");
    assert.deepEqual(s.byVenture, { waahyu: 2, orbit: 1 });
    assert.deepEqual(t.v.stats({ venture: "waahyu" }), {
      total: 2,
      byNode: { ventures: 0, market: 2, content: 0, pipeline: 0, tech: 0, decisions: 0 },
      byVenture: { waahyu: 2, orbit: 1 },
    }, "byVenture stays global so the switcher can list every scope");
  } finally { t.cleanup(); }
});

test("createVenture validates the slug, is idempotent, and listVentures reports counts", () => {
  const t = harness();
  try {
    assert.equal(t.v.createVenture({ id: "../etc", name: "x" }).code, 400);
    assert.equal(t.v.createVenture({ id: "ORBIT", name: "x" }).code, 400);
    assert.equal(t.v.createVenture({ id: "", name: "x" }).code, 400);
    assert.ok(!t.v.createVenture({ id: "orbit", name: "Orbit" }).error);
    assert.ok(t.v.createVenture({ id: "orbit", name: "Orbit again" }).deduped, "idempotent");
    assert.equal(t.h.db.prepare("SELECT COUNT(*) n FROM ventures").get().n, 2);
    assert.deepEqual(t.v.listVentures().map((r) => r.id).sort(), ["orbit", "waahyu"]);
    // A name is scrubbed + capped like every other free-text field.
    const n = t.v.createVenture({ id: "leaky", name: "sk-ant-DEADBEEF01" });
    assert.ok(!n.name.includes("sk-ant-DEADBEEF01"));
  } finally { t.cleanup(); }
});
