// agent-runtime/pool.mjs — bridge the .claude/agents/*.md POOL into MissionAlpha.
// Pure parse + a thin fs lister. A pool agent is a Claude-Code subagent markdown file
// (frontmatter: name, description, tools + persona body). We DO NOT grant its raw tools
// (Bash/exec are not representable here) — the parsed `tools` is a DISPLAY mode only;
// real capability stays governed by the runtime's TOOLS mode + sandbox. No new exec path.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Governance docs in the pool dir that are NOT agents.
const POOL_DOCS = new Set(["ORCHESTRATION.md", "PROTOCOL.md", "SCHEDULER.md"]);
export function isPoolDoc(filename) {
  return POOL_DOCS.has(String(filename || ""));
}

// Map a pool md `tools:` line to a DISPLAY capability mode. Bash/Glob/Grep/WebFetch never
// grant write here; only Write/Edit imply a write surface (which, if ever enabled, is the
// sandbox copy — never the live repo). Default read.
export function mapTools(toolsRaw) {
  const list = String(toolsRaw || "").split(",").map((t) => t.trim()).filter(Boolean);
  return list.some((t) => /^(Write|Edit)$/i.test(t)) ? "write" : "read";
}

// Parse one pool markdown file into { id, role, persona, tools }. Returns null for a file
// with no frontmatter (a doc) or a too-short persona.
export function parsePoolAgent(md, filename) {
  const fileId = String(filename || "").replace(/\.md$/i, "").toLowerCase();
  const fm = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(String(md || ""));
  if (!fm) return null; // no frontmatter → not an importable agent
  const front = fm[1];
  const body = (fm[2] || "").trim();
  const field = (k) => {
    const m = new RegExp(`^${k}:\\s*(.+)$`, "im").exec(front);
    return m ? m[1].trim() : "";
  };
  const id = (field("name") || fileId).toLowerCase();
  const description = field("description");
  // role = first sentence of the description (or the id), capped.
  const role = (description.split(/[.\n]/)[0] || id).trim().slice(0, 80) || id;
  const persona = (body || description).slice(0, 6000); // cap = factory persona max
  if (persona.length < 20) return null;
  return { id, role, persona, tools: mapTools(field("tools")) };
}

// List every importable pool agent in a directory (skips docs + unparseable files).
export function listPoolFrom(dir) {
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => /\.md$/i.test(f) && !isPoolDoc(f));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    try {
      const a = parsePoolAgent(readFileSync(join(dir, f), "utf8"), f);
      if (a) out.push(a);
    } catch {
      /* skip unreadable file */
    }
  }
  return out;
}
