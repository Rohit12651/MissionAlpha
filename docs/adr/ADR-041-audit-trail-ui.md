# ADR-041 — Audit-Trail UI (READ MODEL ONLY)

**Status:** ACCEPTED (Stage 4 / Build Order #6)
**Author:** architect
**Date:** 2026-06-18
**Stage:** S4 — Polish / DX / Observability
**Gap:** #22 (audit-trail UI)
**Security:** **READ-ONLY by construction.** This ADR adds NO new write path to audit
data and does NOT change how any audit record is produced. It only adds a richer
*read* + a searchable/filterable view over data the runtime already writes. Hard-gated
by senior-security-engineer (§6).

---

## 1. Context

The runtime already writes a rich audit stream but the cockpit surfaces only a thin
slice. Two existing, independent audit sources:

1. **Runtime factory audit** — `factory.audit(event, data)` appends TSV lines to
   `factory-audit.log` **outside the repo** (`factory.mjs:651`). Events include the
   whole tool loop + approvals + connectors + agents:
   `exec.run`, `exec.done`, `exec.approved`, `exec.denied`, `exec.forbidden`,
   `exec.kill`, `agent.create/update/delete`, `conn.create/delete`, `cred.create/delete`,
   `post.execute`, `post.ratelimited`. Read via `readAudit(limit)` → `GET /factory/audit`
   (auth-gated). **This is the executed-command + approval history.**
2. **Operator-command audit** — the swarm-written command trail (`AuditEntry`:
   `at/cmdId/issuedBy/type/target`) read via `getAudit()` → `/api/audit`. Surfaced today
   in `ControlPlanePanel` (ack/respawn/task lifecycle).
3. **Heartbeats** — already in `DashboardState.heartbeats` (per-tick agent state events).

There is no unified, searchable view. Phase 4.1 asks for a searchable/filterable READ
view over **audit + heartbeat + approval + executed-command history**.

## 2. Decision

Add a **unified, read-only Audit Trail** view that merges the three sources into a
single normalized record stream with **search + filter (source / kind / agent / time)**.

### 2.1 Read extension (the ONLY backend change — strictly READ)
`GET /factory/audit` currently hardcodes `readAudit(100)`. Extend it to honor a bounded
`?limit=` query param:
```
GET /factory/audit?limit=N   // N clamped to [1, 2000]; default 200
```
- This is a **read** change only. `factory.audit()` (the writer) and `factory-audit.log`
  format are **untouched**.
- `readAudit(limit)` already accepts a limit; we only pass the clamped query through.
- Still inside the auth-gated block (token + host/origin) — no new unauthenticated surface.

### 2.2 Normalized read model (frontend, pure)
`src/lib/auditModel.ts` (no React, unit-tested):
```ts
type AuditSource = "exec" | "approval" | "connector" | "agent" | "operator" | "heartbeat";
interface AuditRecord {
  ts: number;            // epoch ms (parsed; NaN-guarded)
  iso: string;
  source: AuditSource;
  kind: string;          // e.g. "exec.run", "exec.approved", "ack", "HEARTBEAT:IN_PROGRESS"
  agent: string | null;  // agentId where known
  summary: string;       // human one-liner (command preview already truncated server-side to 200)
  raw: unknown;          // original event payload for the detail row
}
```
- `normalizeFactory(entries)` maps `{at,event,data}` → records; `exec.*` → source `exec`,
  `exec.approved/denied` → `approval`, `conn.*`/`cred.*` → `connector`, `agent.*` → `agent`.
- `normalizeOperator(AuditEntry[])` → source `operator`.
- `normalizeHeartbeats(Heartbeat[])` → source `heartbeat` (capped — heartbeats are high-volume).
- `mergeAudit(...sources)` → sorted desc by ts, deduped, bounded.
- `filterAudit(records, {q, source, agent, sinceMs, untilMs})` → pure, case-insensitive
  substring search over `kind|agent|summary`, plus facet filters.

### 2.3 Component
`src/components/audit/AuditTrailPanel.tsx`:
- Polls the three reads (factory `?limit=`, operator `getAudit`, heartbeats from live state),
  normalizes + merges client-side. Default-collapsed (like ControlPlanePanel) to stay calm.
- Controls: search box (debounced), source facet chips, agent dropdown, quick time ranges
  (15m / 1h / all). Bounded table (cap rows, "showing latest N of M"), reduced-motion safe,
  OKLCH tokens only, sticky header, keyboard operable, `aria-live` on result count.
- Row click → detail disclosure showing `raw` (JSON, secrets already scrubbed at source —
  see §6).

## 3. Read-only invariants (NON-NEGOTIABLE)
- **No new write endpoint.** The only backend delta is a *read* query param.
- **No change to `factory.audit()`** or the log format / location.
- The UI never POSTs to audit; it cannot create, edit, or delete an entry.
- Heartbeats are read from the existing `DashboardState` already in memory.

## 4. Relationship to ControlPlanePanel
`ControlPlanePanel` stays (operator command lifecycle + its small audit slice). The new
`AuditTrailPanel` is the **superset, cross-source** view. Both are read-only; they share the
same `getAudit` source for the operator slice. No feature is removed.

## 5. Alternatives considered
- **Server-side search/filter** — rejected: would add query surface + complexity; the volume
  (bounded to ≤2000 factory rows + heartbeats already in memory) is small enough to filter
  client-side. Keeps the backend delta to a single read param.
- **Stream over SSE** — deferred to the global LiveStreamAdapter (Phase 6 / future). Polling
  matches the rest of the cockpit today.

## 6. Security review (senior-security-engineer — signed)
- **Read-only confirmed by construction:** sole backend change is a clamped `?limit=` on an
  existing GET, inside the auth-gated block. No writer touched; no new POST/DELETE.
- Secret hygiene preserved: the runtime already scrubs secrets at the source (`secret-scrub.mjs`,
  egress scrub) and `factory.audit` logs HASHES/refs, never raw secrets (`post.execute` logs a
  content hash; creds log only `credId`). The UI renders `raw` as-is — it inherits the existing
  no-secret guarantee and adds none of its own.
- `?limit=` clamped to [1,2000] → no unbounded read / DoS via huge slices.
- No regression to F2b / S2.5 cred handling / S3.5 exec audit — the write path is byte-for-byte
  unchanged.
- **VERDICT: APPROVED — read model only, no new write/exec path, no regression.**

## 7. Acceptance
- [ ] Audit Trail shows exec, approval, connector, agent, operator, and heartbeat events together.
- [ ] Search a past action (e.g. "exec.approved" or an agent id) → matching rows; filters work.
- [ ] `?limit=` honored + clamped; `factory.audit()`/log format unchanged (diff proves it).
- [ ] No POST/DELETE to audit anywhere in the client; read-only verified by security gate.
