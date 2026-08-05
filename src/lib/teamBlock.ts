// P1-F6 — the Tech Lead's team proposal. It may end a boss-thread reply with a fenced
// ```team block; each line is `<agent-id> <role title> | <skill,skill>`. This module is
// PURE (no fetch, no DOM) so the whole proposal path is unit-testable, and it mirrors
// parseDispatch's shape: {clean, members}.
//
// SECURITY: this parser is a FILTER, not a trust boundary. Every field is re-validated by
// the runtime's factory.validateSpec on POST /factory/create (id regex, reserved built-in
// ids, skill ⊆ catalog, persona length + secret-shape). Nothing here can widen capability:
// the skill list is checked against the catalog the server itself served us, and
// `integrations` is always empty, so no minted agent can post anywhere.

/** One proposed team member. */
export interface TeamMember {
  id: string;
  role: string;
  skills: string[];
}

export interface TeamParse {
  clean: string;
  members: TeamMember[];
}

/** Mirrors the factory's ID_RE (`^[a-z][a-z0-9-]{1,48}$`). */
const ID_RE = /^[a-z][a-z0-9-]{1,48}$/;
const ROLE_MAX = 80;
/** Hard cap on a single proposal so one reply can't queue 50 agent creations. */
export const TEAM_MAX = 8;

/**
 * Extract a ```team block. `knownSkills` is the governed factory catalog (from
 * GET /factory/skills) — a line naming any skill outside it is dropped whole, so the
 * confirm card can never show an agent the server would then reject.
 */
export function parseTeamBlock(content: string, knownSkills: ReadonlySet<string>): TeamParse {
  const m = /```team\s*\n([\s\S]*?)```/.exec(content);
  if (!m) return { clean: content, members: [] };

  const members: TeamMember[] = [];
  const seen = new Set<string>();
  for (const raw of m[1].split("\n")) {
    if (members.length >= TEAM_MAX) break;
    const line = raw.trim();
    if (!line) continue;

    const [left, right] = line.split("|");
    const head = left.trim().split(/\s+/);
    const id = (head.shift() || "").toLowerCase();
    const role = head.join(" ").slice(0, ROLE_MAX).trim();
    if (!ID_RE.test(id) || !role || seen.has(id)) continue;

    const skills = (right ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (skills.some((s) => !knownSkills.has(s))) continue; // unknown skill → drop the member

    seen.add(id);
    members.push({ id, role, skills: [...new Set(skills)] });
  }
  return { clean: content.replace(m[0], "").trim(), members };
}

/** Build the POST /factory/create payload for one member. The server re-validates it all. */
export function teamMemberToSpec(member: TeamMember, job: string) {
  const brief = job.replace(/\s+/g, " ").trim().slice(0, 600);
  const persona =
    `You are the ${member.role} on a team the Tech Lead assembled for this job: ${brief || "an unspecified job"}. ` +
    `Own your lane end to end, report progress to the Tech Lead in /caveman full, and flag blockers early. ` +
    `You never post externally and never claim work you did not do.`;
  return {
    id: member.id,
    role: member.role,
    title: member.role,
    persona: persona.slice(0, 6000),
    skills: member.skills,
    tools: [] as string[], // derived server-side from the chosen skills
    integrations: [] as string[], // never granted from a chat proposal
  };
}
