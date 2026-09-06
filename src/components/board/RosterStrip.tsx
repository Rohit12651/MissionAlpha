/* Hallmark · component: info-card strip · genre: technical (operator cockpit)
 * theme: BOSS locked palette (preserved — no new tokens introduced)
 * states: default · hover · focus · active · disabled(n/a) · loading · error · empty
 * contrast: text/muted on panel-2 ≥ 4.5:1 (existing token pairs, unchanged)
 * pre-emit critique: P5 H4 E4 S5 R5 V4
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { ShieldCheck, Lock } from "lucide-react";
import { fetchRoster, isWriteBlocked, roleLabel, scopeSummary, type RosterMember } from "../../lib/rosterClient";
import type { RuntimeEvent } from "../../lib/useRuntimeEvents";

/*
  The roster strip (Phase 7 / task 7.4). Who is on the team, and what each seat is
  ALLOWED TO TOUCH — the writeScope that guards.applyAllowed enforces server-side.

  This renders a constraint; it does not impose one. The real control is the broker.
  Saying that plainly on the card matters: an operator who thinks this strip is the
  enforcement will trust it in the one situation where trusting it is wrong.

  DATA FLOW — push first, same shape as QueueStrip:
   · mount / resync   → GET /runtime/roster (authoritative)
   · roster.changed   → authoritative re-read (Phase 10: HR emits it on every hire)

  There is no optimistic reducer here on purpose. The roster changes about once a week,
  a hire is a single append, and a wrong optimistic card would misstate a seat's write
  scope — the one field on this card that must never be a guess.
*/

const EASE = [0.22, 1, 0.36, 1] as const;

/** Role → accent, using ONLY the locked palette tokens. Workers stay neutral: they are
 *  the majority, and colouring the majority is noise, not hierarchy. */
function roleAccent(role: RosterMember["role"]): string {
  if (role === "manager") return "var(--c-accent-cyan)";
  if (role === "ceo") return "var(--c-ceo-gold)";
  if (role === "hr") return "var(--c-factory-violet)";
  return "var(--c-border)";
}

function MemberCard({ m, index, reduce }: { m: RosterMember; index: number; reduce: boolean | null }) {
  const scope = scopeSummary(m.writeScope, m.role);
  // The padlock means "this seat cannot write", which is true only for a WORKER with an
  // empty scope. A Manager with an empty scope is un-narrowed, not blocked.
  const blocked = isWriteBlocked(m);
  // Provenance, not decoration: `hr` is the only value that is not operator-authored.
  const hired = m.createdBy === "hr";
  return (
    <motion.li
      initial={reduce ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reduce ? { duration: 0 } : { duration: 0.28, ease: EASE, delay: Math.min(index * 0.03, 0.18) }}
      tabIndex={0}
      // The scope is the point of the card, so it is in the accessible name — a
      // screen-reader user must not have to hover a tooltip to learn it.
      aria-label={`${m.name}, ${roleLabel(m.role)} seat ${m.seat}${hired ? ", hired by HR" : ""}. Write scope: ${scope}`}
      title={`write scope — ${scope}`}
      className="group relative w-[188px] shrink-0 rounded-lg border border-border bg-panel-2 px-3 py-2.5 outline-none transition-colors duration-150 hover:border-muted focus-visible:ring-2 focus-visible:ring-accent-cyan"
    >
      <span aria-hidden className="absolute left-0 top-2 bottom-2 w-[2px] rounded-full" style={{ backgroundColor: roleAccent(m.role) }} />
      <div className="flex items-baseline justify-between gap-2 pl-2">
        <span className="truncate text-[13px] font-medium text-text">{m.name}</span>
        <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted">{roleLabel(m.role)}</span>
      </div>
      <div className="mt-0.5 flex items-center gap-1.5 pl-2">
        <span className="truncate font-mono text-[11px] text-muted">{m.seat}</span>
        {/* Phase 10 — a seat HR hired is marked, because provenance changes how an operator
            reads it: a seeded seat was authored by a person, a hire was created by the
            runtime on the Manager's request. Deliberately quiet — the same muted register as
            the seat itself, not a badge. Colour is the existing HR token, so a hire is tied
            to the function that made it without introducing a new one. */}
        {hired && (
          <span
            className="shrink-0 rounded-sm px-1 text-[9px] font-medium uppercase tracking-wide"
            style={{ color: "var(--c-factory-violet)", border: "1px solid var(--c-factory-violet)" }}
          >
            hired
          </span>
        )}
      </div>
      {m.skills.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1 pl-2">
          {m.skills.map((s) => (
            <li key={s} className="rounded border border-border px-1.5 py-[1px] font-mono text-[10px] text-muted">{s}</li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex items-start gap-1 pl-2 text-[10px] leading-snug text-muted">
        {blocked
          ? <Lock size={11} className="mt-[1px] shrink-0" aria-hidden />
          : <ShieldCheck size={11} className="mt-[1px] shrink-0" aria-hidden />}
        <span className="line-clamp-2 break-all">{scope}</span>
      </div>
    </motion.li>
  );
}

export function RosterStrip({ lastEvent }: { lastEvent?: RuntimeEvent | null }) {
  const [members, setMembers] = useState<RosterMember[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const reduce = useReducedMotion();

  // roster.changed → authoritative re-read. Declared in 7.0b; HR emits it on each hire (Phase 10).
  const changed = lastEvent?.name === "roster.changed";
  useEffect(() => { if (changed) setNonce((n) => n + 1); }, [changed, lastEvent]);

  const load = useCallback(() => {
    let live = true;
    fetchRoster()
      .then((m) => { if (live) { setMembers(m); setError(null); } })
      .catch((e: unknown) => { if (live) setError(e instanceof Error ? e.message : "roster unavailable"); });
    return () => { live = false; };
  }, []);
  useEffect(load, [load, nonce]);

  const hiredCount = members?.filter((m) => m.createdBy === "hr").length ?? 0;

  const body = useMemo(() => {
    if (error) return <span className="text-[11px] text-stale-red" role="alert">roster unavailable — {error}</span>;
    if (members === null) return <span className="text-[11px] text-muted" role="status" aria-live="polite">reading the roster…</span>;
    if (members.length === 0) return <span className="text-[11px] text-muted">no seats on the roster yet</span>;
    return (
      <ul className="flex gap-2 overflow-x-auto pb-1">
        {members.map((m, i) => <MemberCard key={m.id} m={m} index={i} reduce={reduce} />)}
      </ul>
    );
  }, [members, error, reduce]);

  return (
    <section aria-label="Roster" className="border-b border-border px-4 py-2.5">
      <div className="mb-1.5 flex items-baseline gap-2">
        <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted">Roster</h3>
        {members !== null && !error && (
          <span className="font-mono text-[10px] text-muted">
            {members.length} seats{hiredCount > 0 ? ` · ${hiredCount} hired` : ""} · scope enforced by the broker
          </span>
        )}
      </div>
      {body}
    </section>
  );
}
