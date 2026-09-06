// B2 / ADR-055 — the Knowledge Vault. Shared memory the stations WRITE and the
// Captain READS: one markdown file per record on disk, a SQLite row per record for
// search/stats/scoping, and a fixed 6-node taxonomy.
//
// The FILE is the record (a human can read data/vault/ with `cat`); the ROW is only
// its index. That ordering is deliberate — a lost DB can be rebuilt from disk, a lost
// disk cannot be rebuilt from the index.
//
// SECURITY (B2 is a BLOCKING-security phase):
//   • PATH CONTAINMENT is SLUG-ONLY and CASE-INSENSITIVE. `venture`, `node` and `id`
//     must each match /^[a-z0-9][a-z0-9-]{0,63}$/ — which structurally excludes `.`,
//     `/`, `\`, NUL and every `..` shape — and the RESOLVED destination is then
//     re-asserted inside the vault root through workspace.mjs's isInside(), the same
//     case-folded helper server.mjs uses. Two prior live bugs in this program were
//     case-sensitivity bypasses (a mixed-case re-spelling walking past a `===` or a
//     `startsWith`), so an uppercase slug is REFUSED rather than folded: refusing is
//     the only behaviour a case-insensitive filesystem cannot turn into an alias.
//   • NEVER writes through a symlink — a pre-planted link at the record path would
//     redirect the write outside the vault. Same posture as deliveries.mjs L182.
//   • TITLE, BODY, EXCERPT and venture NAME are scrubbed with the server's SHARED
//     scrub AT REST and again on egress. No second SECRET_RE lives here.
//   • A record may only be written into a venture that ALREADY EXISTS. Directories
//     are never conjured from caller input; createVenture() is the one door.
//   • The node taxonomy is CLOSED (and CHECK-pinned in the schema), so a caller
//     cannot widen the on-disk tree.
//   • Every statement is parameterized; `q` is bound as a LIKE pattern with its
//     wildcards escaped, so a `%` in the search box matches a literal `%`.
//   • Emit-on-persist (ADR-052 §2): the function that writes the record is the
//     function that emits `vault.written` — no watcher, no dual path.

import { mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync, rmSync, chmodSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { isInside } from "./workspace.mjs";

/**
 * The CLOSED node taxonomy (B2 spec). Mirrored — and pinned by a test — in
 * src/lib/vaultClient.ts for the client. A seventh node is a migration + an ADR
 * amendment, never a caller choice.
 */
export const VAULT_NODES = Object.freeze(["ventures", "market", "content", "pipeline", "tech", "decisions"]);

/**
 * Which node an agent's completion record lands in. The SINGLE source for the mapping.
 *
 * S0 (story pipeline): the five business stations that owned `market` / `content` /
 * `pipeline` / `ventures` are gone. The SE roster is engineering work, so every seat
 * falls through to `tech` — except `docs-writer`, whose release notes are documents.
 * The node TAXONOMY is unchanged (VAULT_NODES is a closed enum mirrored client-side and
 * already carries stored records); only the agent→node mapping moved.
 */
export const NODE_BY_AGENT = Object.freeze({
  "docs-writer": "content",
});
/** Any agent outside the mapping — every other SE seat included — writes to `tech`. */
export const DEFAULT_NODE = "tech";
/** Inbox decisions (approve / reject / request-changes) always land here. */
export const DECISION_NODE = "decisions";

export const MAX_VAULT_TITLE = 200;
/** Bodies are DOCUMENTS, not comments — 32KB, matching the endpoint's body cap. */
export const MAX_VAULT_BODY = 32_768;
export const MAX_VENTURE_NAME = 80;
const EXCERPT_CHARS = 240;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** node for an agent id. Total: an unknown / empty / non-string agent yields DEFAULT_NODE. */
export function nodeForAgent(agentId) {
  return NODE_BY_AGENT[String(agentId ?? "")] ?? DEFAULT_NODE;
}

// ── slugs (the containment primitive) ────────────────────────────────────────
// Lowercase, digits and inner dashes only, 1..64 chars. `.` `/` `\` NUL and every
// `..` shape are excluded by construction, and uppercase is REFUSED (not folded) so
// a case-insensitive filesystem is never handed two spellings of one directory.
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isSlug(s) {
  return typeof s === "string" && SLUG_RE.test(s);
}

/**
 * Fold a SERVER-DERIVED identifier (a task id, an agent id, a delivery ULID) into a
 * slug, or null when nothing slug-shaped survives. This is for ids the runtime itself
 * produced — write() still validates the result with isSlug(), so slugify is a
 * convenience for callers and NEVER a way to launder hostile input into a path.
 */
export function slugify(s) {
  const out = String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  return isSlug(out) ? out : null;
}

/**
 * The on-disk path for a record. THROWS on anything that is not slug-shaped or that
 * resolves outside `root` — the caller turns that into a 400, never a 500 body the
 * attacker can read a filesystem layout out of.
 */
export function recordPath(root, venture, node, id) {
  if (!isSlug(venture)) throw new Error("vault: invalid venture");
  if (!isSlug(node) || !VAULT_NODES.includes(node)) throw new Error("vault: invalid node");
  if (!isSlug(id)) throw new Error("vault: invalid id");
  const base = resolve(root);
  const target = resolve(base, venture, node, `${id}.md`);
  // Belt AND braces: the slug regex already makes an escape unrepresentable, but the
  // resolved path is re-asserted inside the root with the case-folded helper the rest
  // of the runtime uses. If this ever fires, the regex above regressed.
  if (!isInside(target, base)) throw new Error("vault: path escapes the vault root");
  return target;
}

// ── record file (provenance header + body) ───────────────────────────────────
const FM = "---";

/** Front matter a human can read with `cat`. Every value is already scrubbed + capped. */
function renderRecord(meta, body) {
  return [
    FM,
    `id: ${meta.id}`,
    `title: ${meta.title}`,
    `author: ${meta.author}`,
    `venture: ${meta.venture}`,
    `node: ${meta.node}`,
    `written: ${meta.createdAt}`,
    `source_run: ${meta.sourceRun ?? "-"}`,
    FM,
    "",
    body,
  ].join("\n");
}

/**
 * Body of a record file — everything after the closing `---`. A file without a
 * well-formed header is returned whole rather than half-eaten: the INDEX is the
 * authority on metadata, so a malformed header costs nothing but its own parse.
 */
export function recordBody(text) {
  const s = String(text ?? "");
  if (!s.startsWith(`${FM}\n`)) return s;
  const end = s.indexOf(`\n${FM}\n`, FM.length);
  if (end < 0) return s;
  return s.slice(end + FM.length + 2).replace(/^\n/, "");
}

// LIKE pattern with the wildcards neutralised, so a `%` typed in the search box
// searches for a literal `%` instead of matching the entire vault.
const likePattern = (q) => `%${String(q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

// ── the store ────────────────────────────────────────────────────────────────
export function createVault(deps = {}) {
  const store = deps.db;
  if (!store || !store.db) throw new Error("createVault: db handle required");
  const db = store.db;
  const events = deps.events || { emit: () => {} };
  const scrub = deps.scrub || ((s) => s);
  const now = deps.now || (() => Date.now());
  const root = resolve(deps.root || join(dirname(store.path), "vault"));

  // Strip control chars (keeping \t \n \r so a document stays readable), run the
  // SHARED scrub, then cap. Scrub-at-rest AND on egress, exactly like deliveries.mjs.
  // eslint-disable-next-line no-control-regex
  const CTRL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
  const clean = (s, cap) => scrub(String(s ?? "").replace(CTRL, "")).slice(0, cap);
  const oneLine = (s, cap) => clean(s, cap).replace(/\s+/g, " ").trim().slice(0, cap);

  // Lowercase ULID-ish: 10 base36 chars of ms + 12 random. Slug-shaped by
  // construction (so it survives isSlug), and lexicographically time-ordered.
  function mintId(ms = now()) {
    const t = Math.max(0, Math.floor(ms)).toString(36).padStart(10, "0").slice(-10);
    return `${t}${randomBytes(9).toString("hex").slice(0, 12)}`;
  }

  const ventureRow = (id) => db.prepare("SELECT id, name, created_at FROM ventures WHERE id = ?").get(id) || null;
  const recordRow = (id) => db.prepare("SELECT * FROM vault_records WHERE id = ?").get(id) || null;

  /** Row → the client-facing meta shape, scrubbed on the way out. */
  function hydrate(row) {
    if (!row) return null;
    return {
      id: row.id,
      venture: row.venture,
      node: row.node,
      title: scrub(row.title),
      author: row.author,
      sourceRun: row.source_run ?? null,
      createdAt: new Date(row.created_at).toISOString(),
      excerpt: scrub(row.body_excerpt || ""),
    };
  }

  // ── ventures ───────────────────────────────────────────────────────────────
  function createVenture(input = {}) {
    const id = input.id;
    if (!isSlug(id)) return { code: 400, error: "venture id must be a lowercase slug (a-z, 0-9, -)" };
    const existing = ventureRow(id);
    if (existing) return { ...existing, deduped: true };
    const name = oneLine(input.name || id, MAX_VENTURE_NAME) || id;
    db.prepare("INSERT INTO ventures(id, name, created_at) VALUES(?, ?, ?)").run(id, name, now());
    return { id, name, created_at: ventureRow(id).created_at };
  }

  function listVentures() {
    const counts = new Map();
    for (const r of db.prepare("SELECT venture, COUNT(*) n FROM vault_records GROUP BY venture").all()) {
      counts.set(r.venture, r.n);
    }
    return db.prepare("SELECT id, name, created_at FROM ventures ORDER BY created_at ASC, id ASC").all()
      .map((r) => ({ id: r.id, name: scrub(r.name), createdAt: new Date(r.created_at).toISOString(), records: counts.get(r.id) || 0 }));
  }

  // ── write (emit-on-persist) ────────────────────────────────────────────────
  /**
   * Persist one record. Returns the hydrated meta (plus `path`), or a
   * `{code, error}` verdict — NEVER throws for bad input, so the HTTP layer can 400
   * with a readable reason instead of 500-ing.
   *
   * `id` is optional: omit it for a fresh record, pass a STABLE server-derived slug
   * (e.g. `task-<taskId>`) to make the write idempotent for that work unit.
   */
  function write(input = {}) {
    const venture = input.venture;
    if (!isSlug(venture)) return { code: 400, error: "invalid venture" };
    const node = input.node;
    if (!isSlug(node) || !VAULT_NODES.includes(node)) {
      return { code: 400, error: `invalid node (valid: ${VAULT_NODES.join("|")})` };
    }
    const id = input.id === undefined || input.id === null ? mintId() : input.id;
    if (!isSlug(id)) return { code: 400, error: "invalid id" };
    // A record may only enter a venture that ALREADY exists — no directory is ever
    // conjured from caller input.
    if (!ventureRow(venture)) return { code: 400, error: `unknown venture '${String(venture).slice(0, 64)}'` };

    const title = oneLine(input.title || "", MAX_VAULT_TITLE);
    if (!title) return { code: 400, error: "title required" };
    // sr-security LOW-5: scrub BEFORE slugify — a slug is [a-z0-9-] and could still
    // carry a lowercase hex token verbatim; scrub first so a secret-shaped author
    // arrives redacted (and then fails the slug check) instead of landing in the
    // front matter + row untouched.
    const author = slugify(scrub(String(input.author ?? "")));
    if (!author) return { code: 400, error: "author required" };
    const sourceRun = input.sourceRun ? oneLine(input.sourceRun, 80) : null;
    const body = clean(input.body ?? "", MAX_VAULT_BODY);

    let dest;
    try { dest = recordPath(root, venture, node, id); }
    catch (e) { return { code: 400, error: String(e?.message || e) }; }

    // Never write THROUGH a symlink. Checking the FILE alone is NOT enough: a link
    // planted at the vault ROOT, `<root>/<venture>` or `<root>/<venture>/<node>`
    // redirects the write just as effectively, and mkdirSync({recursive:true})
    // succeeds happily on an existing symlink-to-directory. So the WHOLE chain
    // root → venture → node → file is checked and any link in it refuses the write.
    // (root added after the B2 security review demonstrated `data/vault -> /elsewhere`
    // relocating every record — sr-security MED-1.)
    for (const p of [resolve(root), resolve(root, venture), resolve(root, venture, node), dest]) {
      try { if (lstatSync(p).isSymbolicLink()) return { code: 400, error: "refusing to write through a symlink" }; }
      catch { /* absent — fine, mkdir will create it as a real directory */ }
    }

    const prior = recordRow(id);
    const createdAt = prior ? prior.created_at : now();
    const meta = { id, venture, node, title, author, sourceRun, createdAt: new Date(createdAt).toISOString() };

    // File BEFORE the row, so a crash can only ever leave an orphan file (harmless,
    // id-scoped) — never a row pointing at nothing.
    try {
      mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
      try { chmodSync(dirname(dest), 0o700); } catch (e) { console.warn(`[vault] chmod 0700 failed on ${dirname(dest)}: ${e?.message}`); }
      writeFileSync(dest, renderRecord(meta, body), { mode: 0o600 });
      try { chmodSync(dest, 0o600); } catch (e) { console.warn(`[vault] chmod 0600 failed on ${dest}: ${e?.message}`); }
    } catch (e) {
      return { code: 500, error: `vault write failed: ${scrub(String(e?.message || e))}` };
    }

    const excerpt = body.slice(0, EXCERPT_CHARS);
    db.transaction(() => {
      db.prepare(
        `INSERT INTO vault_records(id, venture, node, title, author, source_run, created_at, body_excerpt, path)
         VALUES(@id, @venture, @node, @title, @author, @sourceRun, @createdAt, @excerpt, @path)
         ON CONFLICT(id) DO UPDATE SET
           venture = excluded.venture, node = excluded.node, title = excluded.title,
           author = excluded.author, source_run = excluded.source_run,
           body_excerpt = excluded.body_excerpt, path = excluded.path`,
      ).run({ id, venture, node, title, author, sourceRun, createdAt, excerpt, path: dest });
    })();

    // A re-write that moved nodes (or ventures) leaves the previous file behind. Drop
    // it — but only after re-asserting containment on the RECORDED path, so a tampered
    // row can never turn this into an arbitrary delete.
    if (prior && prior.path && prior.path !== dest) {
      try { if (isInside(prior.path, root) && existsSync(prior.path) && !lstatSync(prior.path).isSymbolicLink()) rmSync(prior.path); }
      catch { /* orphan file is harmless; the index is authoritative */ }
    }

    const out = { ...hydrate(recordRow(id)), path: dest };
    // Emit-on-persist: the SAME call writes the record and pushes the frame. The
    // payload carries identity ONLY (no title, no body) — the bus is a notification,
    // and the record itself is behind the auth-gated GET.
    events.emit("vault.written", { id, node, venture, agent: author });
    return out;
  }

  // ── list / get / stats ─────────────────────────────────────────────────────
  function list(q = {}) {
    const where = [];
    const args = [];
    if (q.venture) {
      if (!isSlug(q.venture)) return [];           // unknown filter → empty, never a SQL error
      where.push("venture = ?"); args.push(q.venture);
    }
    if (q.node) {
      if (!VAULT_NODES.includes(q.node)) return [];
      where.push("node = ?"); args.push(q.node);
    }
    const term = typeof q.q === "string" ? q.q.trim().slice(0, 120) : "";
    if (term) {
      where.push("(title LIKE ? ESCAPE '\\' OR body_excerpt LIKE ? ESCAPE '\\')");
      args.push(likePattern(term), likePattern(term));
    }
    // Integers only — a fractional or non-finite LIMIT/OFFSET reaches SQLite as a
    // float and throws `datatype mismatch` → 500 (sr-security LOW-4). Floor + finite-
    // check BEFORE the clamp so 1.5 → 1, 1e21 → MAX, NaN → default.
    const rawLimit = Number(q.limit);
    const rawOffset = Number(q.offset);
    const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? Math.floor(rawLimit) : DEFAULT_LIMIT, 1), MAX_LIMIT);
    const offset = Math.min(Math.max(Number.isFinite(rawOffset) ? Math.floor(rawOffset) : 0, 0), Number.MAX_SAFE_INTEGER);
    const sql = `SELECT * FROM vault_records ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`;
    return db.prepare(sql).all(...args, limit, offset).map(hydrate);
  }

  /** One record: `{meta, body}`. Unknown or non-slug id ⇒ null (never a path probe). */
  function get(id) {
    if (!isSlug(id)) return null;
    const row = recordRow(id);
    if (!row) return null;
    let body = "";
    try {
      const p = recordPath(root, row.venture, row.node, row.id);
      // Read only the path the INDEX + the containment rule agree on, and never
      // through a symlink someone swapped in after the write.
      if (existsSync(p) && !lstatSync(p).isSymbolicLink()) body = recordBody(readFileSync(p, "utf-8"));
    } catch { body = ""; }
    return { meta: hydrate(row), body: scrub(body).slice(0, MAX_VAULT_BODY) };
  }

  /**
   * `{total, byNode, byVenture}`. `byNode` is zero-filled across the whole taxonomy so
   * the graph never has to invent a missing key. `byVenture` stays GLOBAL even when a
   * venture scope is passed — the switcher lists every scope, including empty ones.
   */
  function stats(q = {}) {
    const scope = isSlug(q.venture) ? q.venture : null;
    const byNode = {};
    for (const n of VAULT_NODES) byNode[n] = 0;
    const nodeRows = scope
      ? db.prepare("SELECT node, COUNT(*) n FROM vault_records WHERE venture = ? GROUP BY node").all(scope)
      : db.prepare("SELECT node, COUNT(*) n FROM vault_records GROUP BY node").all();
    let total = 0;
    for (const r of nodeRows) {
      if (!(r.node in byNode)) continue;           // a node outside the taxonomy cannot exist (CHECK), but never trust a row blindly
      byNode[r.node] = r.n;
      total += r.n;
    }
    const byVenture = {};
    for (const r of db.prepare("SELECT id FROM ventures").all()) byVenture[r.id] = 0;
    for (const r of db.prepare("SELECT venture, COUNT(*) n FROM vault_records GROUP BY venture").all()) {
      byVenture[r.venture] = r.n;
    }
    return { total, byNode, byVenture };
  }

  // MUNDER-ADOPTION A4 — the ONE removal door, for the condenser only (NOT routed over
  // HTTP; there is deliberately no DELETE endpoint). Same containment posture as write():
  // the RECORDED path must sit inside the vault root and must not be a symlink, so a
  // tampered row can never turn this into an arbitrary delete. Row first, then file —
  // an orphan FILE is harmless and rebuildable state ("the file is the record"), while
  // an orphan ROW points at nothing; this ordering can only produce the harmless one.
  function remove(id) {
    if (!isSlug(id)) return { code: 400, error: "invalid id" };
    const row = recordRow(id);
    if (!row) return { code: 404, error: "unknown record" };
    db.prepare("DELETE FROM vault_records WHERE id = ?").run(id);
    try {
      if (row.path && isInside(row.path, root) && existsSync(row.path) && !lstatSync(row.path).isSymbolicLink()) rmSync(row.path);
    } catch { /* orphan file is harmless; the index is authoritative */ }
    return { id, removed: true };
  }

  return { write, list, get, stats, createVenture, listVentures, remove, root, VAULT_NODES };
}
