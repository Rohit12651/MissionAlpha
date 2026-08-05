// Pure helpers for the "attach skills to an agent" flow (the 1879 prompt-template skills).
// Attaching a skill = appending its prompt text to the agent's persona — BEHAVIOR priming
// ONLY. It grants NO tool/exec capability: real access stays governed by the runtime TOOLS
// mode + sandbox + the 9-skill factory capability catalog (the security choke point).

export interface AttachSkill {
  id: string;
  title: string;
  hint: string;
  family: string;
  prompt: string;
}

// Hard cap on the appended block so a big multi-select can't blow the 6000-char persona
// budget (factory validateSpec) or bloat every spawn's input tokens.
export const ATTACH_CAP = 4000;

// Filter the catalog by a free-text query over id/title/hint/family. Caps the result count
// so a 1879-row list stays cheap to render.
export function searchSkills(all: AttachSkill[], q: string, cap = 200): AttachSkill[] {
  const s = q.trim().toLowerCase();
  const match = s
    ? all.filter((k) =>
        k.id.toLowerCase().includes(s) ||
        k.title.toLowerCase().includes(s) ||
        k.hint.toLowerCase().includes(s) ||
        k.family.toLowerCase().includes(s))
    : all;
  return match.slice(0, cap);
}

// Build the persona suffix from the chosen skills (deduped by id, length-capped).
export function buildAttachSuffix(skills: AttachSkill[], maxChars = ATTACH_CAP): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const k of skills) {
    if (seen.has(k.id)) continue;
    seen.add(k.id);
    lines.push(`- ${k.title}: ${k.prompt}`.replace(/\s+/g, " ").trim());
  }
  if (!lines.length) return "";
  const header = "\n\nATTACHED SKILLS (apply when relevant to the task):\n";
  let body = lines.join("\n");
  const budget = maxChars - header.length;
  if (body.length > budget) body = body.slice(0, Math.max(0, budget));
  return header + body;
}
