// Phase 7 / task 7.4 — the roster client. Typed fetcher over the vite-proxied
// /runtime/roster route, plus the PURE layer RosterStrip renders from (zero DOM, zero
// network, so it is unit-testable under `node --experimental-strip-types`).
//
// Token pattern is cloned verbatim from cadenceClient.ts: same same-origin runtime token,
// same x-runtime-token header, same runtimeUrl() base so it works dev-proxied AND packaged.
//
// THE PARSER IS DEFENSIVE ON PURPOSE. The roster is the file that decides what each seat
// may write; the strip that renders it must never be the reason the board white-screens.
// A malformed member is DROPPED and the rest still render — six honest cards beat a blank
// page. Nothing here enforces anything: the real control is guards.applyAllowed on the
// server. This is a window onto that constraint, not the constraint.

import { runtimeToken, runtimeUrl } from "./runtimeBase.ts";

export const ROSTER_ROLES = ["manager", "hr", "ceo", "worker"] as const;
export type RosterRole = (typeof ROSTER_ROLES)[number];

export interface RosterMember {
  id: string;
  name: string;
  seat: string;
  role: RosterRole;
  skills: string[];
  writeScope: string[];
  tools: string[];
  createdBy: string;
  createdAt: string;
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : [];

const str = (v: unknown, fallback = ""): string => (typeof v === "string" && v ? v : fallback);

/**
 * PURE. Parse a /runtime/roster payload into typed members.
 * A member with no usable id is dropped; every other field degrades to a safe default.
 * An unknown role degrades to "worker" — the most restricted rendering, never the least.
 */
export function parseRoster(raw: unknown): RosterMember[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const members = (raw as { members?: unknown }).members;
  if (!Array.isArray(members)) return [];
  const out: RosterMember[] = [];
  for (const m of members) {
    if (!m || typeof m !== "object" || Array.isArray(m)) continue;
    const rec = m as Record<string, unknown>;
    const id = str(rec.id);
    if (!id) continue;
    const role = rec.role as RosterRole;
    out.push({
      id,
      name: str(rec.name, id),
      seat: str(rec.seat, "—"),
      // Fail toward the LEAST privileged rendering, never the most.
      role: ROSTER_ROLES.includes(role) ? role : "worker",
      skills: strings(rec.skills),
      writeScope: strings(rec.writeScope),
      tools: strings(rec.tools),
      createdBy: str(rec.createdBy, "seed"),
      createdAt: str(rec.createdAt),
    });
  }
  return out;
}

/** PURE. The role as an operator reads it — acronyms upper, roles lower. */
export function roleLabel(role: RosterRole | string): string {
  if (role === "ceo") return "CEO";
  if (role === "hr") return "HR";
  return role === "manager" ? "manager" : "worker";
}

/**
 * PURE. The writeScope as one line for the card.
 *
 * AN EMPTY ARRAY MEANS OPPOSITE THINGS BY ROLE, and rendering both as "no write access"
 * was a lie on one of them. guards.applyAllowed narrows ONLY `role:"worker"`:
 *   • worker    + [] → writes NOTHING. matchesWriteScope refuses every path.
 *   • non-worker + [] → NOT NARROWED. The legacy rule returns before writeScope is read,
 *                       so the seat writes whatever any un-narrowed agent writes.
 * The board previously showed a padlock and "no write access" for the Manager, HR and Ash
 * cards while the broker would have applied their writes.
 */
export function scopeSummary(writeScope: string[], role?: RosterRole): string {
  if (writeScope.length > 0) return writeScope.join(" · ");
  return role && role !== "worker"
    ? "not narrowed by writeScope"
    : "no write access";
}

/** PURE. True when the seat is genuinely prevented from writing (worker + empty scope). */
export function isWriteBlocked(m: Pick<RosterMember, "role" | "writeScope">): boolean {
  return m.role === "worker" && m.writeScope.length === 0;
}

/** Fetch the roster. Network + auth; the pure layer above is what tests assert. */
export async function fetchRoster(): Promise<RosterMember[]> {
  const token = await runtimeToken();
  const res = await fetch(runtimeUrl("/runtime/roster"), {
    headers: { "x-runtime-token": token },
  });
  if (!res.ok) throw new Error(`roster: HTTP ${res.status}`);
  return parseRoster(await res.json());
}
