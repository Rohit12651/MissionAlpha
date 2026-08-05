# ADR-055 — Knowledge Vault (shared memory: markdown records on disk, SQLite index, venture scoping)

- **Status:** ACCEPTED — IMPLEMENTED (as-built 2026-07-30, shipped in B2)
- **Date:** 2026-07-30
- **Slug:** `vault`
- **Plan:** Business OS Program **B2 — Knowledge Vault** (`docs/superpowers/plans/2026-07-30-bos-B2.md`; program plan `2026-07-30-business-os-program-plan.md`)
- **Deciders:** architect, senior-backend-1 (owner), **senior-security-engineer (HARD gate — new store, new mutating endpoints, new disk writes)**
- **Builds on:** ADR-051 (`db.mjs` migration ladder + the store/verdict style `deliveries.mjs` established), ADR-052 (`vault.written` rides the existing bus — see §Amendment B2 there), `workspace.mjs` (the case-insensitive containment helpers), `server.mjs` auth gates (`needsAuth` / `routeNeedsApprover`)

> **Number collision, disclosed.** P8 shipped code comments citing "ADR-055" for the **audit export** (`server.mjs` L2019, `factory.mjs` L746, `deliveries.mjs` L608, `src/lib/factoryClient.ts`, `src/components/audit/AuditTrailPanel.tsx`, `test/audit-export.test.mjs`), but that ADR was **never written** — the number was reserved in comments and the document did not follow. The B2 task doc and the Business-OS program plan both assign ADR-055 to the Vault, and this is the document that actually exists at that number, so **ADR-055 = Knowledge Vault**. Those P8 comments are therefore stale citations to a document that was never authored. They are left untouched here (out of B2's scope, and rewriting six unrelated files to chase a comment is not a surgical change); re-numbering the audit-export record is a docs-debt item for whoever writes it.

## Context

B1 shipped the Command deck with `RECORDS READ` rendered as a literal `—`, and every station persona already claims it "writes findings into shared memory as tagged records the other stations read". Until B2 that shared memory did not exist: a station's work ended at a heartbeat line and a Delivery, both of which are *events*, not *knowledge*. The Captain had nothing to read.

B2 makes it real. The requirement is narrow and awkward at once: the artefact must be **durable, human-readable without the app, cheap to search, and scoped by venture** — and it is written by **agents**, which means every field on it is untrusted text and every path component derived from it is an attack surface.

## Decision

### 1. The file is the record; the row is the index

One markdown file per record at `data/vault/<venture>/<node>/<id>.md`, carrying a front-matter provenance header (`id`, `title`, `author`, `venture`, `node`, `written`, `source_run`) followed by the body. One `vault_records` row per file carrying the same metadata plus a 240-char `body_excerpt`.

| Option | Verdict | Why |
|---|---|---|
| **Markdown on disk + SQLite index** | **CHOSEN** | The record survives the app: `cat` and `grep` work, and a lost index can be rebuilt from the tree. The index makes search/stats/scoping O(index) instead of a filesystem walk, and it is the same `mission.db` the Inbox already opens — no second connection, no second migration ladder |
| Body in SQLite (a TEXT column) | REJECTED | Bodies are documents. It makes the DB the single point of loss for the *content*, not just the index, and it puts a growing blob in the same file the Delivery hot path writes |
| Files only, no index | REJECTED | Every search and every stat becomes a full-tree read; `q`, `byNode` and the venture switcher would all walk the disk on each keystroke |

`created_at` is epoch-ms INTEGER (these rows are ordered and range-filtered numerically), unlike the ISO TEXT `deliveries.createdAt` which is compared lexically by the audit export.

### 2. The node taxonomy is CLOSED and pinned in three places

Six nodes: `ventures` · `market` · `content` · `pipeline` · `tech` · `decisions`. They are a `CHECK` constraint in migration v9, a frozen array in `vault.mjs` (`VAULT_NODES`), and a frozen array in `src/lib/vaultClient.ts` — with a test pinning the client list to the server list. A seventh node is a migration plus an amendment to this ADR, never a caller's choice, so the on-disk tree cannot be widened by a crafted request.

### 3. Auto-write mapping — one source, no second table

`NODE_BY_AGENT` in `vault.mjs` is the SINGLE source: `coo-station→market` · `cmo-station→content` · `sales-station→pipeline` · `dev-station→tech` · `analyst-station→ventures` · **any other agent → `tech`**. Inbox decisions (approve / reject / request-changes) always land in `decisions`, authored by the **deciding identity** (the authenticated approver when auth is active, else the client-supplied `by`), never by the agent whose work was decided — the record is a record of the *decision*.

Two hooks, both at choke points that already exist:

- **Completion** — `engine.finishApplied()`, the one transition where a task reaches DONE. The record id is `task-<taskId>`, which makes the write **idempotent per work unit**: a re-run of the same task updates its record instead of minting a second one.
- **Decision** — `deliveries.decide()`, immediately after the status-flip transaction commits. Id `dec-<deliveryId>`, idempotent per delivery.

Both are wrapped so a vault fault can never un-apply an apply or un-decide a decision — the record is observational; the work it describes has already landed.

### 4. Ventures exist before records do

A record may only be written into a venture that **already exists** in the `ventures` table (seeded `waahyu`). `createVenture()` is the only door. This is a security decision, not a modelling one: auto-creating a venture from a write would mean a caller-supplied string conjures a directory, and "the directory got created" is one step from "the directory got created *there*".

### 5. Transport: `vault.written` on the existing bus

Emitted from `write()` under ADR-052 §2's emit-on-persist rule — the function that persists is the function that emits. Payload is **identity only** (`{id, node, venture, agent}`); title and body stay behind the auth-gated `GET /runtime/vault/record`. See ADR-052 §Amendment B2 for why, and for the four reserved sibling names.

### 6. HTTP surface — viewer-readable reads, approver-gated writes

| Route | Method | Gate |
|---|---|---|
| `/runtime/vault` | GET | `needsAuth` (token + origin + loopback Host); any authenticated seat |
| `/runtime/vault/record?id=` | GET | same — viewer-readable |
| `/runtime/vault/stats` | GET | same — viewer-readable |
| `/runtime/vault/record` | POST | same **+ `routeNeedsApprover`**: a viewer gets 403 via direct curl, not just a hidden button |

No new auth mechanism: the routes join the gate `/apply` and `/inbox` already use. Reading the shared memory is a glance; writing into it is an act.

## Security invariants

| Attack | Vector | Mitigation |
|---|---|---|
| **Path traversal** | `venture` / `node` / `id` used as path components | **Slug-only**: each must match `/^[a-z0-9][a-z0-9-]{0,63}$/`, which structurally excludes `.`, `/`, `\`, NUL and every `..` shape. The resolved destination is then re-asserted inside the vault root with `workspace.mjs` `isInside()` |
| **Case-sensitivity bypass** | mixed-case re-spelling walking past a `===` / `startsWith` on a case-insensitive FS (APFS/NTFS) — **this program has had two live bugs of exactly this shape** | Uppercase is **REFUSED, not folded**. Refusal is the only behaviour a case-insensitive filesystem cannot turn into an alias for an existing directory. The containment re-assert additionally uses the case-folded `isInside()` |
| **Symlink write-through** | a link pre-planted at the record path redirects the write outside the vault | `lstat` check before every write and before every read; same posture as `deliveries.mjs` L182 and the broker's apply-time guard |
| **Secret egress** | an agent's body/title contains a token-shaped string | The SHARED `scrub()` runs on title, body, excerpt and venture name **at rest** (before the bytes reach disk) **and again on egress**. No second `SECRET_RE` lives in `vault.mjs` |
| **Control-char / bus-format injection** | crafted title breaks the front matter or a downstream renderer | Control chars stripped (keeping `\t \n \r`); the title is additionally collapsed to one line and capped at 200; the body caps at 32KB |
| **SQL injection** | `q`, `venture`, `node` bound into SQL | Every statement parameterized. `venture`/`node` are validated against slug + allow-list *before* binding, and an unknown filter returns `[]` rather than a SQL error. `q` is bound as a LIKE pattern with `% _ \` escaped — a `%` in the search box searches for a literal `%`, it does not match the whole vault |
| **Unauthorised write** | a viewer (or an unauthenticated caller) posting a record | 401 without a token; 403 for a viewer session on POST via `routeNeedsApprover`; 400 for a bad node/venture. All four proven adversarially in `vault-http.test.mjs` |
| **Arbitrary delete** | a re-write that relocates a record deletes the old file | The recorded prior path is re-asserted with `isInside()` and lstat-checked before the unlink, so a tampered row cannot become an arbitrary delete |
| **XSS via record body** | agent-authored markdown rendered in the UI | **No `innerHTML` anywhere.** `parseMdLines()` produces a typed line array and React renders it as **text nodes only** — markup in a body is displayed, never executed |

## Consequences

**Positive** — shared memory is real and legible: the Captain's `RECORDS READ` is a live count, stations accumulate durable findings automatically at completion, decisions leave an auditable trail in `decisions`, and the artefact outlives the app (plain markdown in a plain tree).

**Negative / accepted** — a second on-disk store to back up and prune (there is no retention sweep in B2 — records are permanent until an operator deletes them, disclosed rather than silently unbounded); `q` searches the 240-char excerpt, not the full body, so a term appearing only deep in a long document will not match (a full-text index is a later phase, not a hidden failure — the search UI says it matches title and excerpt).

## Alternatives rejected

1. **Embeddings / vector search from day one** — rejected: the first requirement is "the Captain can read what the stations learned", not semantic retrieval. LIKE over title + excerpt answers that at zero infrastructure cost; a vector store is a decision to take when the corpus makes it necessary, on evidence.
2. **One file per venture (append-only log)** — rejected: concurrent station writes contend on one file, and a single corrupt write loses the venture's whole history.
3. **Reuse `deliveries` with a new `kind`** — rejected: a Delivery is a *decision request* with an SLA, a risk band and a patch set. A record is none of those. Overloading the table would put null-heavy rows in the Inbox hot path and make both concepts harder to reason about.
4. **Auto-create ventures on write** — rejected (§4): a caller-supplied string conjuring a directory is the first half of a traversal.
5. **Full body on the `vault.written` frame** — rejected (§5): a bus frame reaches every connected seat; the record's content belongs behind the gated read.

## As-built (2026-07-30)

Shipped in **B2**. `agent-runtime/vault.mjs` (store, containment, scrub, emit), `agent-runtime/db.mjs` migration **v9** (`ventures` seeded `waahyu` + `vault_records` with the 6-node CHECK and UNIQUE `path`), four routes in `server.mjs`, the two auto-write hooks (`engine.mjs` `finishApplied`, `deliveries.mjs` `decide`), and the client at `src/lib/vaultClient.ts` + `src/components/bos/VaultPage.tsx` (lazy chunk — the Vault UI is never in the main index). Tests: `agent-runtime/test/vault.test.mjs` (store + containment + scrub), `agent-runtime/test/vault-http.test.mjs` (real booted runtime: routes, SSE emit, hooks, adversarial 401/403/400/404), `src/lib/__tests__/vaultClient.test.ts` (markdown line parser + node meta).

`data/` is gitignored — vault records are runtime state and are **never** tracked, same posture as `engine-store/` and `mission.db`.
