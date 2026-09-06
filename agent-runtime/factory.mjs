// Agent Factory — BOSS spawns AI-authored agents from the governed skill catalog.
//
// Four concerns, one module (imported by server.mjs which owns the HTTP + auth gates):
//   1. SKILL CATALOG    — the closed set of capabilities an agent may hold.
//   2. REGISTRY         — persist created agents (.claude/agents/<id>.md + factory/registry.json);
//                         expose their authored persona to the runtime's systemFor().
//   3. AGENT-CREATOR    — meta-prompt + spec parse/validate (NL → agent spec).
//   4. CREDENTIAL BROKER + POSTING — encrypted secret store keyed by connId (Claude never
//                         sees a raw secret); dry-run preview → BOSS-confirmed execute → audit.
//
// SECURITY POSTURE (mirrors the runtime token design):
//   • A raw credential exists ONLY in the POST /factory/connect request body and, encrypted,
//     in a tmp-dir store OUTSIDE the repo. It is never returned, logged, streamed, put in an
//     agent's read scope, or passed to a `claude` child env.
//   • Specs are catalog-constrained + charset-validated; no Bash/exec tool is representable.
//   • Posting is never automatic — preview is read-only; execute is a separate token-gated call
//     the dashboard only makes after the BOSS confirms an F3 gate. Rate-limited + per-account cap.

import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  appendFileSync,
} from "node:fs";
import { randomBytes, randomUUID, createCipheriv, createDecipheriv, createHash } from "node:crypto";

// Phase 10 — HR's creation path reuses the ROSTER's own rules rather than restating them.
// roster.mjs imports only guards.mjs, so this adds no cycle.
import { TOOL_ALLOW, fatalScopeProblem } from "./roster.mjs";
import { SEED_DIRS } from "./guards.mjs";

// Extended secret-shape detector (sr-security T1): the runtime's SECRET_RE plus
// bearer/oauth/access_token/JWT/google/meta/slack shapes. Used to (a) reject a
// secret-shaped persona at creation and (b) as a scrub source. NOTE: a `g` regex
// has stateful lastIndex — always test with a FRESH clone, never the shared object.
const SECRET_RE_EXT_SRC = [
  "sk-ant-[A-Za-z0-9_-]{6,}", "sk-[A-Za-z0-9]{20,}", "gh[pousr]_[A-Za-z0-9]{20,}",
  "AKIA[0-9A-Z]{12,}", "-----BEGIN [A-Z ]*PRIVATE KEY-----",
  "ya29\\.[0-9A-Za-z_-]{20,}", "EAA[A-Za-z0-9]{20,}", "xox[baprs]-[0-9A-Za-z-]{10,}",
  "[Bb]earer\\s+[A-Za-z0-9._~+/-]{20,}={0,2}",
  "(?:access_token|refresh_token|id_token|client_secret|api[_-]?key)\"?\\s*[:=]\\s*\"?[A-Za-z0-9._~+/-]{16,}",
  "eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{6,}",
].join("|");
const secretShaped = (s) => new RegExp(SECRET_RE_EXT_SRC).test(String(s ?? ""));
/** Scrub secret-shaped substrings from any string about to leave the box. */
export const scrubExt = (t) =>
  typeof t === "string" ? t.replace(new RegExp(SECRET_RE_EXT_SRC, "g"), "[redacted-secret]") : t;
const sha256 = (s) => createHash("sha256").update(String(s)).digest("hex");

const __dir = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dir, "..");
// Repo-bound write targets (the persona .md files and the TRACKED factory/registry.json)
// honor env overrides so a test run can isolate to a tmpdir and never pollute the repo.
// Resolved LAZILY (per call) so an in-process test that sets the env in a before() hook —
// which runs AFTER this module is imported — still redirects every write. Precedence:
//   FACTORY_REGISTRY_FILE (exact file) > RUNTIME_FACTORY_DIR/registry.json > repo default.
const agentsDir = () => process.env.RUNTIME_AGENTS_DIR || join(REPO_ROOT, ".claude", "agents");
const factoryDir = () => process.env.RUNTIME_FACTORY_DIR || join(REPO_ROOT, "factory");
const registryFile = () => process.env.FACTORY_REGISTRY_FILE || join(factoryDir(), "registry.json");
// Runtime, NOT committed: encrypted creds + posting audit live OUTSIDE the repo (tmp)
// so no agent read-scope (cwd=REPO_ROOT in read mode) can reach them.
const RUNTIME_DIR = process.env.RUNTIME_TOKEN_DIR || join(tmpdir(), "missionalpha-runtime");
const CONN_FILE = join(RUNTIME_DIR, "connections.json");
const CREDS_FILE = join(RUNTIME_DIR, "mcp-creds.json"); // generic (platform-less) MCP creds
const BROKER_KEY_FILE = join(RUNTIME_DIR, ".broker-key");
const AUDIT_FILE = join(RUNTIME_DIR, "factory-audit.log");
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const COMPOSIO_KEY = process.env.COMPOSIO_API_KEY || "";

// ── Skill catalog (CLOSED set — a spec may only reference these) ──────────────
// `posting:true` skills are the only ones that unlock an integration platform.
// `dev:true` skills are sandbox code-execution skills for factory dev-agents.
//   They grant {Read,Write,Run} inside the Docker jail ONLY — no MCP, no posting,
//   no SEED_DIRS/CONFIG_GUARD changes. They require an allowlisted `redirect`.
export const SKILL_CATALOG = [
  { id: "repo-read", label: "Read Repo", desc: "Inspect repository files (read-only).", tools: ["Read"], platforms: [], posting: false },
  { id: "repo-edit", label: "Edit in Sandbox", desc: "Propose file edits in an isolated sandbox (operator-applied).", tools: ["Read", "Write"], platforms: [], posting: false },
  { id: "research-brief", label: "Research Brief", desc: "Synthesize a topic into a structured brief.", tools: ["Read"], platforms: [], posting: false },
  { id: "data-summary", label: "Data Summary", desc: "Summarize structured data into insights.", tools: ["Read"], platforms: [], posting: false },
  // G4: dev skills — sandbox code execution inside the Docker jail only. No MCP, no posting.
  {
    id: "code-implement-go", label: "Implement in Go", dev: true,
    desc: "Write and test Go code inside the sandbox worktree (exec approval-forced, no host paths).",
    tools: ["Read", "Write", "Run"], platforms: [], posting: false,
    redirect: "golang-pro",
    stack: { langs: ["go"], frameworks: [], dbs: [] },
  },
  {
    id: "code-implement-angular", label: "Implement in Angular", dev: true,
    desc: "Write and test Angular/TypeScript components inside the sandbox worktree (exec approval-forced).",
    tools: ["Read", "Write", "Run"], platforms: [], posting: false,
    redirect: "angular-architect",
    stack: { langs: ["typescript"], frameworks: ["angular"], dbs: [] },
  },
  // S0 — station skills. `station: true` marks a standing brief held by one of the ten
  // seeded SE seats (seed-stations.mjs). Read-only: no tool beyond Read, no platform,
  // no posting, no sandbox exec — so they widen the catalog's vocabulary without
  // widening any agent's authority. They describe WHAT the seat is responsible for;
  // SCHEDULED runs ride the cadence engine (cadence.mjs) and each desc says so.
  { id: "repo-health-check", label: "Repo health check", station: true, desc: "Read recent commits and issues for patterns worth flagging to the operator. Scheduled runs ride the cadence engine.", tools: ["Read"], platforms: [], posting: false },
  { id: "workflow-audit", label: "Workflow audit", station: true, desc: "Find repeated manual steps across agent runs that are worth automating. Scheduled runs ride the cadence engine.", tools: ["Read"], platforms: [], posting: false },
  { id: "claude-code-handoff", label: "Claude Code handoff", station: true, desc: "Package a flagged improvement into a ready-to-run prompt for a coding agent. Scheduled runs ride the cadence engine.", tools: ["Read"], platforms: [], posting: false },
  // P7 — worker-seat skills. Each names a slice of the codebase a hired seat owns, and
  // each ships a brief at .claude/skills-curated/<id>/SKILL.md that states the slice AND
  // the files the seat must never touch.
  //
  // They are PLAIN entries on purpose — no `dev`, no `station`, no `redirect`, no
  // `stack`. Tools are {Read, Write} and nothing else:
  //   • Read is what Glob/Grep collapse to — the catalog has no finer read verb.
  //   • Write is what agent-tools.mjs `allowedToolsForAgent` turns into Write + Edit.
  //   • Run is DELIBERATELY ABSENT. Run is the exec-broker capability, and the G6 guard
  //     only demands an allowlisted `redirect` when a skill is `dev: true`. A plain entry
  //     carrying Run would hand out exec authority with no redirect check at all.
  //   • Bash/Glob/Grep/Edit are not in ALLOWED_TOOLS — naming them here would not grant
  //     them, it would just be dropped by the derivation filter and read as a lie.
  // platforms: [] + posting: false means no integration can attach to these seats.
  { id: "ui", label: "UI", desc: "Build and change the React front end in src/ — components, hooks, view state, theme and CSS.", tools: ["Read", "Write"], platforms: [], posting: false },
  { id: "api", label: "API", desc: "Build and change HTTP endpoints and runtime service modules under agent-runtime/.", tools: ["Read", "Write"], platforms: [], posting: false },
  { id: "db", label: "Database", desc: "Own the SQLite schema, the migration ladder and the data-access layer in agent-runtime/db.mjs.", tools: ["Read", "Write"], platforms: [], posting: false },
  { id: "test", label: "Test", desc: "Author node:test suites that fail against the defect before they pass against the fix.", tools: ["Read", "Write"], platforms: [], posting: false },
  { id: "notifications", label: "Notifications", desc: "Own outbound notification plumbing — how a delivery or alert reaches the operator.", tools: ["Read", "Write"], platforms: [], posting: false },
];

// G6: allowlist of specialist agent IDs that a dev skill's `redirect` may name.
// Keeps the redirect field from becoming an injection/abuse vector.
export const SPECIALIST_ALLOWLIST = new Set([
  "golang-pro", "angular-architect", "node-specialist", "python-pro",
  "react-specialist", "nextjs-developer", "typescript-pro", "java-architect",
  "spring-boot-engineer", "rust-engineer", "kotlin-specialist", "swift-expert",
]);
const SKILL_IDS = new Set(SKILL_CATALOG.map((s) => s.id));
export const PLATFORMS = [
  { id: "twitter", label: "X / Twitter", maxChars: 280, dailyCap: 25 },
  { id: "linkedin", label: "LinkedIn", maxChars: 3000, dailyCap: 15 },
];
const PLATFORM_BY_ID = new Map(PLATFORMS.map((p) => [p.id, p]));
const ALLOWED_TOOLS = new Set(["Read", "Write", "Run"]); // Bash/exec NOT representable
// S0: `architect` is NO LONGER reserved — it is one of the ten seeded SE seats
// (seed-stations.mjs), minted through the same factory path as the rest of the roster.
const BUILTIN_IDS = new Set([
  "ceo", "principal-ux-design", "principal-db-engineer",
  "senior-security-engineer", "senior-cicd-engineer", "senior-lead-dev",
  "senior-web-1", "senior-web-2", "principal-rn-mobile-1", "principal-rn-mobile-2",
  "senior-backend-1", "senior-backend-2", "senior-qa", "senior-code-reviewer",
  "memory-updater", "boss",
]);

// ── small utils ──────────────────────────────────────────────────────────────
// S0: min length is 2 (was 3) so short seat ids like `qa` are representable. The
// character class is UNCHANGED — lowercase letter first, then [a-z0-9-] only — so the
// containment properties every consumer relies on (filename safety, URL path safety)
// are exactly as before; only the floor moved.
const ID_RE = /^[a-z][a-z0-9-]{1,48}$/;
// Strip control chars + bus/markdown-format metacharacters from free text so a
// crafted persona/role can't inject a ```dispatch block, break the .md frontmatter,
// or poison the BROADCAST bus the dashboard parses.
// eslint-disable-next-line no-control-regex
const clean = (s, max) => String(s ?? "").replace(/[\x00-\x1f\x7f]/g, " ").replace(/```/g, "ʼʼʼ").replace(/\s+$/g, "").slice(0, max);
function ensureDirs() {
  for (const d of [agentsDir(), factoryDir(), dirname(registryFile()), RUNTIME_DIR]) mkdirSync(d, { recursive: true });
}

// ── REGISTRY ──────────────────────────────────────────────────────────────────
/** @type {Map<string, any>} id → spec */
const registry = new Map();
export function loadRegistry() {
  registry.clear();
  try {
    const arr = JSON.parse(readFileSync(registryFile(), "utf-8"));
    if (Array.isArray(arr)) for (const a of arr) if (a?.id) registry.set(a.id, a);
  } catch {
    /* none yet */
  }
  return registry;
}
function saveRegistry() {
  ensureDirs();
  writeFileSync(registryFile(), JSON.stringify([...registry.values()], null, 2), "utf-8");
}
/** Persona system-prompt for a created agent, or null if not a created agent. */
export function createdPersona(id) {
  const spec = registry.get(id);
  return spec ? spec.persona : null;
}
/** G3: true if `id` is a factory-minted (created) agent — used by tool-broker tier logic. */
export function isFactoryAgent(id) {
  return registry.has(String(id || ""));
}
/** G5: full spec for a factory agent (for tool derivation at the spawn frame), or null. */
export function specForAgent(id) {
  return registry.get(String(id || "")) || null;
}
export function listAgents() {
  return [...registry.values()].map((s) => ({ ...s, persona: undefined, personaPreview: s.persona.slice(0, 240) }));
}

// Write the persona to .claude/agents/<id>.md (committed; survives restart).
function writePersonaFile(spec) {
  const desc = clean(`${spec.title} — created by BOSS via Agent Factory. ${spec.role}`, 240).replace(/\n/g, " ");
  const md =
    `---\n` +
    `name: ${spec.id}\n` +
    `description: ${desc}\n` +
    `tools: ${spec.tools.join(", ") || "Read"}\n` +
    `factory: true\n` +
    `---\n\n` +
    `# ${spec.title}\n\n` +
    `**Role:** ${spec.role}\n\n` +
    `**Skills:** ${spec.skills.join(", ") || "—"}\n` +
    `**Integrations:** ${spec.integrations.join(", ") || "—"}\n\n` +
    `## Persona\n\n${spec.persona}\n`;
  writeFileSync(join(agentsDir(), `${spec.id}.md`), md, "utf-8");
}

// ── SPEC VALIDATION (the security choke point for agent creation) ─────────────
export function validateSpec(raw) {
  if (!raw || typeof raw !== "object") return { error: "spec must be an object" };
  const id = String(raw.id || "").trim().toLowerCase();
  if (!ID_RE.test(id)) return { error: "id must match ^[a-z][a-z0-9-]{1,48}$" };
  if (BUILTIN_IDS.has(id)) return { error: `id "${id}" is reserved (built-in agent)` };
  if (registry.has(id)) return { error: `id "${id}" already exists` };

  const role = clean(raw.role, 80);
  const title = clean(raw.title, 80);
  if (!role) return { error: "role required" };
  if (!title) return { error: "title required" };

  const persona = clean(raw.persona, 6000);
  if (persona.length < 20) return { error: "persona too short (min 20 chars)" };
  if (secretShaped(persona) || secretShaped(role) || secretShaped(title))
    return { error: "spec rejected: secret-shaped content not allowed" };

  const skills = Array.isArray(raw.skills) ? [...new Set(raw.skills.map(String))] : [];
  for (const s of skills) if (!SKILL_IDS.has(s)) return { error: `unknown skill: ${s}` };

  // G6: dev skills require an allowlisted redirect — ensures the minted agent delegates
  // to a vetted specialist and prevents redirect from becoming a free-text injection vector.
  const hasDevSkill = skills.some((s) => SKILL_CATALOG.find((c) => c.id === s)?.dev);
  if (hasDevSkill) {
    const redirect = String(raw.redirect || "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
    if (!redirect) return { error: "dev skill requires a redirect to an allowlisted specialist (redirect field missing)" };
    if (!SPECIALIST_ALLOWLIST.has(redirect)) return { error: `redirect "${redirect}" not in SPECIALIST_ALLOWLIST — use one of: ${[...SPECIALIST_ALLOWLIST].join(", ")}` };
  }

  let tools = Array.isArray(raw.tools) ? [...new Set(raw.tools.map(String))] : [];
  for (const t of tools) if (!ALLOWED_TOOLS.has(t)) return { error: `tool not allowed: ${t} (only Read|Write|Run)` };
  // Derive required tools from chosen skills (a posting skill needs Run, etc.).
  const need = new Set();
  for (const s of skills) for (const t of SKILL_CATALOG.find((c) => c.id === s)?.tools ?? []) need.add(t);
  tools = [...new Set([...tools, ...need])].filter((t) => ALLOWED_TOOLS.has(t));

  const integrations = Array.isArray(raw.integrations) ? [...new Set(raw.integrations.map(String))] : [];
  for (const p of integrations) if (!PLATFORM_BY_ID.has(p)) return { error: `unknown integration: ${p}` };
  // An integration is only valid if a posting skill that targets it was selected.
  const allowedPlatforms = new Set();
  for (const s of skills) for (const p of SKILL_CATALOG.find((c) => c.id === s)?.platforms ?? []) allowedPlatforms.add(p);
  for (const p of integrations) if (!allowedPlatforms.has(p)) return { error: `integration ${p} needs a matching posting skill` };

  // Preserve redirect only when a dev skill is present (clean + allowlist already checked above).
  const redirect = hasDevSkill
    ? String(raw.redirect || "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "")
    : undefined;

  return {
    spec: {
      id, role, title, persona, skills, tools, integrations,
      ...(redirect ? { redirect } : {}),
      createdBy: "BOSS", // forced — never trust client
      createdAt: raw.createdAt && /^\d{4}-\d{2}-\d{2}T/.test(String(raw.createdAt)) ? raw.createdAt : null,
    },
  };
}

// Best-effort: announce a created agent onto the comms bus so it shows on the live
// board (heartbeat → BROADCAST). Fire-and-forget; never blocks creation.
function announceOnBus(spec) {
  const HB = join(REPO_ROOT, "scripts", "agent-heartbeat.sh");
  if (!existsSync(HB)) return;
  const safe = (s) => String(s).replace(/[^\x20-\x7e]/g, " ").replace(/["'`|$=]/g, " ").slice(0, 90);
  try {
    spawn("bash", [HB, spec.id, "IDLE", safe(`spawned by BOSS: ${spec.title}`), "-", "", "await dispatch"], {
      stdio: "ignore", cwd: REPO_ROOT,
    });
  } catch {
    /* non-fatal */
  }
}

// `announce` exists for the B1 boot seed (seed-stations.mjs): a station that was
// created by a startup seed never streamed a heartbeat, so announcing one on the comms
// bus would put a fabricated event on the board. Every BOSS-driven path keeps the
// default (true) and is byte-identical to before.
export function createAgent(raw, { announce = true } = {}) {
  const v = validateSpec(raw);
  if (v.error) return v;
  const spec = v.spec;
  spec.createdAt = spec.createdAt || new Date(nowMs()).toISOString();
  ensureDirs();
  writePersonaFile(spec);
  registry.set(spec.id, spec);
  saveRegistry();
  if (announce) announceOnBus(spec);
  audit("agent.create", { id: spec.id, skills: spec.skills, integrations: spec.integrations });
  return { spec: { ...spec, persona: undefined, personaPreview: spec.persona.slice(0, 240) } };
}

// PATCH an existing created agent. Allowed fields ONLY: skills, tools, integrations,
// persona. The merged spec is re-run through the SAME constraints validateSpec uses
// (catalog ⊆, tools ⊆ {Read,Write,Run}, integration needs a matching posting skill,
// derived tools from skills, persona cleaned + length + secret-shape). id/role/title/
// createdBy/createdAt are immutable.
export function updateAgent(id, patch) {
  const existing = registry.get(String(id || ""));
  if (!existing) return { error: "not found" };
  const p = patch && typeof patch === "object" ? patch : {};

  // persona — only re-clean/validate when the patch supplies one.
  let persona = existing.persona;
  if (p.persona !== undefined) {
    persona = clean(p.persona, 6000);
    if (persona.length < 20) return { error: "persona too short (min 20 chars)" };
    if (secretShaped(persona)) return { error: "spec rejected: secret-shaped content not allowed" };
  }

  // skills ⊆ SKILL_CATALOG ids
  const skills = p.skills !== undefined
    ? (Array.isArray(p.skills) ? [...new Set(p.skills.map(String))] : [])
    : (Array.isArray(existing.skills) ? [...existing.skills] : []);
  for (const s of skills) if (!SKILL_IDS.has(s)) return { error: `unknown skill: ${s}` };

  // tools ⊆ {Read,Write,Run} (NO Bash); then derive required tools from chosen skills.
  let tools = p.tools !== undefined
    ? (Array.isArray(p.tools) ? [...new Set(p.tools.map(String))] : [])
    : (Array.isArray(existing.tools) ? [...existing.tools] : []);
  for (const t of tools) if (!ALLOWED_TOOLS.has(t)) return { error: `tool not allowed: ${t} (only Read|Write|Run)` };
  const need = new Set();
  for (const s of skills) for (const t of SKILL_CATALOG.find((c) => c.id === s)?.tools ?? []) need.add(t);
  tools = [...new Set([...tools, ...need])].filter((t) => ALLOWED_TOOLS.has(t));

  // integrations ⊆ PLATFORMS, each needs a matching posting skill among `skills`.
  const integrations = p.integrations !== undefined
    ? (Array.isArray(p.integrations) ? [...new Set(p.integrations.map(String))] : [])
    : (Array.isArray(existing.integrations) ? [...existing.integrations] : []);
  for (const pf of integrations) if (!PLATFORM_BY_ID.has(pf)) return { error: `unknown integration: ${pf}` };
  const allowedPlatforms = new Set();
  for (const s of skills) for (const pf of SKILL_CATALOG.find((c) => c.id === s)?.platforms ?? []) allowedPlatforms.add(pf);
  for (const pf of integrations) if (!allowedPlatforms.has(pf)) return { error: `integration ${pf} needs a matching posting skill` };

  const updatedSpec = {
    ...existing,
    persona, skills, tools, integrations,
    // immutable — never trust client to change these
    id: existing.id, role: existing.role, title: existing.title,
    createdBy: existing.createdBy, createdAt: existing.createdAt,
  };
  registry.set(updatedSpec.id, updatedSpec);
  saveRegistry();
  writePersonaFile(updatedSpec);
  audit("agent.update", { id: updatedSpec.id, skills: updatedSpec.skills, integrations: updatedSpec.integrations });
  return { spec: { ...updatedSpec, persona: undefined, personaPreview: persona.slice(0, 240) } };
}

export function deleteAgent(id) {
  if (!registry.has(id)) return { error: "not found" };
  registry.delete(id);
  saveRegistry();
  // Leave the .md (harmless, easy to re-derive); just drop from the live registry.
  audit("agent.delete", { id });
  return { ok: true };
}

// ── Phase 10 / task 10.0 — HR'S CREATION PATH ────────────────────────────────
//
// A SECOND DOOR, deliberately. `createAgent` above is the BOSS's: it forces
// `createdBy:"BOSS"`, allows only {Read,Write,Run} and knows nothing of seats or
// writeScope. Widening it to fit a roster worker would silently widen what every
// BOSS-made agent may hold, so HR gets its own choke point and `createAgent` is untouched.
//
// THIS IS THE PRIVILEGED OPERATION OF PHASE 10 — an AGENT is minting another agent's
// permissions. Every rule below is a boundary, not ergonomics.

/** Tools a roster worker may hold. The ROSTER's list, not a second copy. */
export const ROSTER_TOOL_ALLOW = TOOL_ALLOW;

/** One hire is one specialist. A general contractor is how a writeScope grows unnoticed. */
export const MAX_HIRE_SKILLS = 4;

/** The tools a hire gets when the request does not say. A worker seat's working set. */
const DEFAULT_HIRE_TOOLS = Object.freeze(["Read", "Glob", "Grep", "Edit", "Write", "Bash"]);

/**
 * The hire's NAME AND ID, derived from its primary catalog skill — never supplied.
 *
 * The name is interpolated verbatim into another agent's system prompt (server.mjs
 * `seatSystemPrompt`), beside the SKILL bodies that are capped and scrubbed precisely
 * because they land there. A name HR could choose is a name a hostile plan could write, so
 * HR does not choose it: the catalog does. Skill ids are already `^[a-z0-9-]+$` and
 * validated against SKILL_CATALOG, which makes this closed by construction.
 *
 * (The phase plan specified a fixed `NAME_POOL` of example-crew names — Jigglypuff and so
 * on. Deriving from the catalog is strictly MORE closed than a hand-maintained pool, and it
 * matches the roster this app actually runs, whose seats are role-descriptive:
 * `sr-backend`, `qa`, `docs-writer`. Recorded as a deviation in STATE.md.)
 */
export function rosterAgentName(skills) {
  const primary = String((Array.isArray(skills) ? skills[0] : "") ?? "").trim();
  return primary ? `${primary}-engineer` : "";
}

/**
 * The choke point. Returns `{member}` in ROSTER shape, or `{error}`.
 * `takenIds` is the set of ids already on the roster (HR passes `roster.all()`).
 */
export function validateRosterSpec(raw, { takenIds = new Set() } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "hire spec must be an object" };

  // ── skills: the only thing the caller really chooses ──────────────────────
  const skills = Array.isArray(raw.skills) ? [...new Set(raw.skills.map((x) => String(x)))] : [];
  if (!skills.length) return { error: "a hire needs at least one skill — a worker who can do nothing is not a hire" };
  if (skills.length > MAX_HIRE_SKILLS) {
    return { error: `a hire may hold at most ${MAX_HIRE_SKILLS} skills (asked for ${skills.length})` };
  }
  for (const sid of skills) if (!SKILL_IDS.has(sid)) return { error: `unknown skill: ${sid}` };

  // ── identity: DERIVED. raw.name / raw.id / raw.seat are not read at all. ──
  const id = rosterAgentName(skills);
  if (!id) return { error: "could not derive an id from the requested skills" };
  if (takenIds.has(id)) return { error: `a seat with id "${id}" already exists` };
  if (BUILTIN_IDS.has(id)) return { error: `id "${id}" is reserved (built-in agent)` };

  // ── tools ⊆ the roster allow-list ─────────────────────────────────────────
  const tools = Array.isArray(raw.tools) && raw.tools.length
    ? [...new Set(raw.tools.map((x) => String(x)))]
    : [...DEFAULT_HIRE_TOOLS];
  for (const t of tools) if (!ROSTER_TOOL_ALLOW.includes(t)) return { error: `tool not allowed: ${t}` };

  // ── writeScope: THE privilege ─────────────────────────────────────────────
  const writeScope = Array.isArray(raw.writeScope) ? [...new Set(raw.writeScope.map((x) => String(x)))] : [];
  if (!writeScope.length) {
    return { error: "a hire needs a writeScope — a worker that cannot write cannot do the task it was hired for" };
  }
  for (const entry of writeScope) {
    // The ROSTER's own rule: absolute, traversal, backslash, control chars, a literal
    // CORE_GUARD path, or a ReDoS-shaped glob.
    const bad = fatalScopeProblem(entry);
    if (bad) return { error: bad };
    // And REFUSE anything rooted outside the appliable dirs. roster.load() DROPS such an
    // entry (deliberately — a config change must never brick the boot), but dropping at
    // HIRE time would mint a worker with an empty scope whose task then fails for a reason
    // nobody can see. Refusing lets HR answer `hire-failed` with a readable cause.
    const rooted = entry === "**" || entry.startsWith("**/");
    if (!rooted && !SEED_DIRS.includes(entry.split("/")[0])) {
      return { error: `writeScope entry is outside the appliable dirs (SEED_DIRS=${SEED_DIRS.join(",")}): ${entry}` };
    }
  }

  return {
    member: {
      id,
      name: id,
      seat: id,
      // FORCED, never read from the caller. HR hires WORKERS. A hire that could name its own
      // role could mint itself a manager — and a manager is the only seat HR takes orders
      // from (mailbox routeAllowed), which is a complete privilege loop in one field.
      role: "worker",
      skills,
      writeScope,
      tools,
      // FORCED. Provenance is the runtime's to state; a hire that could call itself a `seed`
      // would launder its own origin past every audit that reads this field.
      createdBy: "hr",
      createdAt: new Date(nowMs()).toISOString(),
    },
  };
}

/**
 * Persist the hire's identity document and hand back the roster member.
 *
 * NOT REGISTERED IN THE FACTORY REGISTRY, on purpose. server.mjs picks a spawn's tools with
 * `seat ? seatAllowedTools(seat) : factoryTools`, so a registry entry could not widen a
 * hire's tools — but `strictMcp: allowedToolsForAgent(id) !== null` WOULD flip to true for
 * it, giving a hired worker a different MCP posture from a seeded one like `qa`. A hire must
 * behave exactly like the workers already on the roster. Pinned by FRA-15.
 *
 * The caller (hr.mjs) is what adds the member to roster.json, because `roster.add` is the
 * only writer of that file and it re-validates through `validateMember` anyway.
 */
export function createRosterAgent(raw, { takenIds = new Set() } = {}) {
  const v = validateRosterSpec(raw, { takenIds });
  if (v.error) return v;
  const m = v.member;
  ensureDirs();
  const desc = clean(`${m.name} — hired by HR on a Manager request. worker seat.`, 240).replace(/\n/g, " ");
  const md =
    `---\n` +
    `name: ${m.id}\n` +
    `description: ${desc}\n` +
    `tools: ${m.tools.join(", ")}\n` +
    `factory: false\n` +
    `---\n\n` +
    `# ${m.name}\n\n` +
    `**Role:** worker (roster seat)\n\n` +
    `**Skills:** ${m.skills.join(", ")}\n` +
    `**Write scope:**\n${m.writeScope.map((g) => `  - ${g}`).join("\n")}\n\n` +
    `Created by HR at ${m.createdAt} on a Manager hire-request. Its SKILL bodies are handed ` +
    `to it at spawn (server.mjs seatSystemPrompt); this file is the durable record of who it is.\n`;
  try {
    writeFileSync(join(agentsDir(), `${m.id}.md`), md, "utf-8");
  } catch (e) {
    return { error: `could not write the hire's identity file: ${e?.message ?? e}` };
  }
  audit("roster.hire", { id: m.id, skills: m.skills, writeScope: m.writeScope, createdBy: m.createdBy });
  return { member: m };
}

// nowMs is injected by server (Date.* is fine in this standalone service, but keep
// a single source so tests/replays can stub it).
let _now = () => Date.now();
export function setNow(fn) { _now = fn; }
function nowMs() { return _now(); }

// ── AGENT-CREATOR (NL → spec) ─────────────────────────────────────────────────
const catalogForPrompt = SKILL_CATALOG.map((s) => `  - ${s.id}: ${s.desc}${s.posting ? " [REAL POSTING → platform: " + s.platforms.join("/") + "]" : ""}`).join("\n");
export const AGENT_CREATOR_SYSTEM =
  `You are AGENT-CREATOR, a meta-agent inside the MissionAlpha swarm. The BOSS describes a need; ` +
  `you DESIGN one new agent and output its spec. Think briefly (2-4 caveman lines) about role + skills, ` +
  `then output EXACTLY ONE fenced \`\`\`spec block containing JSON with this shape:\n` +
  `{"id": "kebab-case-id", "role": "...", "title": "...", "persona": "system prompt for the agent", ` +
  `"skills": ["fromCatalog"], "tools": ["Read"|"Write"|"Run"], "integrations": []}\n\n` +
  `RULES:\n` +
  `- id: lowercase kebab, 2-49 chars, starts with a letter, unique-sounding (e.g. "perf-profiler").\n` +
  `- skills: choose ONLY from this catalog:\n${catalogForPrompt}\n` +
  `- integrations: leave EMPTY. An integration is only valid alongside a posting skill, and the ` +
  `catalog carries none — the swarm is engineering-only.\n` +
  `- tools: minimal. Read for analysis, Write for sandbox edits, Run for sandbox execution. NEVER request Bash/exec.\n` +
  `- persona: a sharp system prompt (2-5 sentences) telling the agent who it is + how it works. ` +
  `End the persona with: "Bus comms in /caveman full." Do NOT put any \`\`\`dispatch or \`\`\` fences inside persona.\n` +
  `Output the reasoning lines THEN the single \`\`\`spec block. Nothing after the block.`;

/** Extract + validate a spec JSON from the creator's raw text output. */
export function parseSpecFromText(text) {
  const m = /```(?:spec|json)?\s*\n([\s\S]*?)```/i.exec(text);
  if (!m) return { error: "no spec block found in output" };
  let obj;
  try {
    obj = JSON.parse(m[1].trim());
  } catch (e) {
    return { error: "spec JSON parse failed: " + e.message };
  }
  return validateSpec(obj);
}

// Run the local `claude` CLI to author a spec from a BOSS description. Streams the
// model's reasoning to `stream` (SSE tokens), then resolves with the raw text so the
// caller can parse+validate. No tools — authoring is pure text generation.
export function authorSpec(description, stream, onDone, modelId) {
  const prompt =
    `${AGENT_CREATOR_SYSTEM}\n\n--- BOSS NEED ---\n${description}\n\n--- now design the agent (reasoning then ONE \`\`\`spec block) ---`;
  const args = ["-p", "--output-format", "stream-json", "--include-partial-messages", "--verbose", "--no-session-persistence"];
  // modelId is ALWAYS a server-resolved allowlisted id (ADR-022) — never raw user
  // input. Appended as a distinct argv token (no shell), so it cannot flag-inject.
  if (modelId) args.push("--model", modelId);
  // strip secret-shaped env from the child (same posture as server.cliReply)
  const childEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/(_KEY|_SECRET|_TOKEN|PASSWORD|APIKEY)$/i.test(k) || k === "ANTHROPIC_API_KEY") continue;
    childEnv[k] = v;
  }
  let child;
  try {
    child = spawn(CLAUDE_BIN, args, { stdio: ["pipe", "pipe", "pipe"], cwd: REPO_ROOT, env: childEnv });
  } catch (e) {
    stream.error("claude spawn failed: " + e.message);
    return;
  }
  let acc = "", buf = "", streamed = false;
  child.stdout.on("data", (d) => {
    buf += d.toString();
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      const s = line.trim();
      if (!s) continue;
      let obj;
      try { obj = JSON.parse(s); } catch { continue; }
      if (obj.type === "stream_event" && obj.event?.type === "content_block_delta") {
        const t = obj.event.delta?.text;
        if (t) { acc += t; streamed = true; stream.token(t); }
      } else if (obj.type === "result" && typeof obj.result === "string" && !streamed) {
        acc = obj.result; stream.token(obj.result);
      }
    }
  });
  child.on("error", (e) => stream.error("claude CLI: " + e.message));
  child.on("close", () => onDone(acc));
  child.stdin.write(prompt);
  child.stdin.end();
}

// Mock author — when no `claude` available (or for deterministic tests). Picks a
// plausible spec from keywords so the create flow is demoable offline. Engineering-only
// as of S0: every skill it can pick is read-only, and it never proposes an integration.
export function mockAuthorSpec(description) {
  const d = description.toLowerCase();
  const wantsRepo = /(repo|code|codebase|build|test|ci|deploy)/.test(d);
  const skills = ["repo-read"];
  if (wantsRepo) skills.push("repo-health-check");
  else skills.push("research-brief");
  const base = d.replace(/[^a-z0-9 ]/g, "").trim().split(/\s+/).slice(0, 3).join("-").replace(/^[^a-z]+/, "") || "new-agent";
  const id = (base.length >= 3 ? base : "swarm-analyst").slice(0, 40);
  return {
    reasoning: `[mock author] need parsed. role = engineering analysis. skills = ${skills.join(", ")}. tools = Read. integrations = none.`,
    spec: {
      id, role: "Engineering analyst", title: "Engineering Analyst",
      persona:
        `You are an engineering analyst agent. You read the repository and the swarm's own run history, ` +
        `then report what you can source — findings first, recommendation second. You propose changes as ` +
        `reviewable work, never as silent edits. Bus comms in /caveman full.`,
      skills, tools: ["Read"], integrations: [],
    },
  };
}

// ── CREDENTIAL BROKER ─────────────────────────────────────────────────────────
// AES-256-GCM. Key from COMPOSIO/BROKER env or a 0600 file in the tmp runtime dir
// (never the repo). The raw secret enters ONLY via POST /factory/connect and is
// encrypted immediately; getSecret() is internal to the posting executor.
function brokerKey() {
  if (process.env.BROKER_KEY && process.env.BROKER_KEY.length >= 32) {
    return Buffer.from(process.env.BROKER_KEY.slice(0, 32));
  }
  ensureDirs();
  try {
    if (existsSync(BROKER_KEY_FILE)) {
      const k = readFileSync(BROKER_KEY_FILE);
      if (k.length >= 32) return k.subarray(0, 32);
    }
  } catch {
    /* regenerate */
  }
  const k = randomBytes(32);
  try { writeFileSync(BROKER_KEY_FILE, k, { mode: 0o600 }); } catch { /* in-mem only */ }
  return k;
}
function encrypt(plain) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", brokerKey(), iv);
  const enc = Buffer.concat([c.update(String(plain), "utf-8"), c.final()]);
  const tag = c.getAuthTag();
  return `${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}
function decrypt(blob) {
  const [iv, tag, enc] = String(blob).split(":");
  const d = createDecipheriv("aes-256-gcm", brokerKey(), Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(enc, "base64")), d.final()]).toString("utf-8");
}
function loadConnections() {
  try { return JSON.parse(readFileSync(CONN_FILE, "utf-8")); } catch { return []; }
}
function saveConnections(list) {
  ensureDirs();
  writeFileSync(CONN_FILE, JSON.stringify(list), { mode: 0o600 });
}
/** Public view of a connection — NEVER includes the secret. */
const pubConn = (c) => ({ connId: c.connId, platform: c.platform, handle: c.handle, createdAt: c.createdAt });

export function listConnections() {
  return loadConnections().map(pubConn);
}
export function connectAccount({ platform, handle, secret }) {
  if (!PLATFORM_BY_ID.has(String(platform))) return { error: "unknown platform" };
  const h = clean(handle, 80);
  if (!h) return { error: "handle required" };
  if (typeof secret !== "string" || secret.length < 4 || secret.length > 8000) return { error: "secret required (token / OAuth credential)" };
  const list = loadConnections();
  const connId = "conn_" + randomUUID().slice(0, 12);
  list.push({ connId, platform: String(platform), handle: h, createdAt: new Date(nowMs()).toISOString(), enc: encrypt(secret) });
  saveConnections(list);
  audit("conn.create", { connId, platform, handle: h }); // NOTE: secret never logged
  return { connection: pubConn({ connId, platform, handle: h, createdAt: new Date(nowMs()).toISOString() }) };
}
export function deleteConnection(connId) {
  const list = loadConnections();
  const next = list.filter((c) => c.connId !== connId);
  if (next.length === list.length) return { error: "not found" };
  saveConnections(next);
  audit("conn.delete", { connId });
  return { ok: true };
}
function getConn(connId) {
  return loadConnections().find((c) => c.connId === connId) || null;
}

// ── Generic MCP credentials (ADR-033) — platform-less secrets for MCP connectors.
// Same AES-256-GCM broker as accounts; raw secret enters ONLY here, encrypted at once,
// NEVER logged. getCredValue() (decrypt) is called ONLY at the spawn frame when the
// scoped .mcp.json is composed. Public listings expose ids only, never values.
function loadCreds() {
  try { return JSON.parse(readFileSync(CREDS_FILE, "utf-8")); } catch { return []; }
}
function saveCreds(list) {
  ensureDirs();
  writeFileSync(CREDS_FILE, JSON.stringify(list), { mode: 0o600 });
}
export function addCred(secret) {
  // min length 8: a too-short value would make the egress scrub redact common substrings
  // (e.g. "a") and garble chat output (sr-review LOW). Real MCP tokens are long.
  if (typeof secret !== "string" || secret.length < 8 || secret.length > 8000) return { error: "secret must be 8–8000 chars" };
  const list = loadCreds();
  const credId = "cred_" + randomUUID().slice(0, 12);
  list.push({ credId, createdAt: new Date(nowMs()).toISOString(), enc: encrypt(secret) });
  saveCreds(list);
  audit("cred.create", { credId }); // secret NEVER logged
  return { credId };
}
export function listCredIds() {
  return loadCreds().map((c) => ({ credId: c.credId, createdAt: c.createdAt }));
}
export function deleteCred(credId) {
  const list = loadCreds();
  const next = list.filter((c) => c.credId !== credId);
  if (next.length === list.length) return { error: "not found" };
  saveCreds(next);
  audit("cred.delete", { credId });
  return { ok: true };
}
// SENSITIVE — decrypt a cred value. Call ONLY at the spawn frame (scoped-config compose).
export function getCredValue(credId) {
  const rec = loadCreds().find((c) => c.credId === credId);
  if (!rec) return null;
  try { return decrypt(rec.enc); } catch { return null; }
}
export function credExists(credId) {
  return loadCreds().some((c) => c.credId === credId);
}

// ── POSTING (dry-run preview → BOSS-confirmed execute → audit) ────────────────
// Rate limit: in-memory rolling-24h timestamps per connId, capped at the platform
// dailyCap. Resets on restart (acceptable — caps are abuse guards, not billing).
const postTimes = new Map(); // connId → number[]
function rateState(connId, cap) {
  const cutoff = nowMs() - 24 * 3600 * 1000;
  const arr = (postTimes.get(connId) || []).filter((t) => t > cutoff);
  postTimes.set(connId, arr);
  return { used: arr.length, cap, remaining: Math.max(0, cap - arr.length) };
}

function validateContent(platform, content) {
  const p = PLATFORM_BY_ID.get(platform);
  if (!p) return { error: "unknown platform" };
  const text = String(content ?? "");
  if (!text.trim()) return { error: "content required" };
  if (text.length > p.maxChars) return { error: `content exceeds ${p.label} limit (${text.length}/${p.maxChars})` };
  return { text };
}

// connId confused-deputy guard (T6): a CREATED agent may only post through a
// connId whose platform is in that agent's integrations. Built-in / BOSS-direct
// posting (agentId not in registry) is allowed — it is already token+host gated.
function authorizePost(agentId, conn) {
  const spec = registry.get(String(agentId));
  if (!spec) return true; // BOSS-direct / built-in — runtime auth already gates it
  return Array.isArray(spec.integrations) && spec.integrations.includes(conn.platform);
}

// Single-use confirm tokens (T2/T4): preview mints one bound to a hash of the
// exact (agentId, connId, content); execute requires a fresh, unused, matching
// token. Blocks LLM-driven posts (no preview → no token), replay, and content-swap.
const confirmStore = new Map(); // token → {hash, exp}
const CONFIRM_TTL_MS = 120_000;
function postHash(agentId, connId, content) {
  return sha256(`${agentId} ${connId} ${content}`);
}
function mintConfirm(hash) {
  const token = "pc_" + randomBytes(18).toString("hex");
  confirmStore.set(token, { hash, exp: nowMs() + CONFIRM_TTL_MS });
  return token;
}
function consumeConfirm(token, hash) {
  const rec = confirmStore.get(token);
  if (!rec) return false;
  confirmStore.delete(token); // single use
  if (rec.exp < nowMs()) return false; // expired
  return rec.hash === hash; // content/target must match the previewed post
}

/** DRY RUN — what WOULD be posted. Reads nothing secret, posts nothing. Mints a
 *  single-use confirmToken the UI hands back to /execute after the BOSS confirms. */
export function previewPost({ agentId, connId, content }) {
  const conn = getConn(connId);
  if (!conn) return { error: "unknown connId" };
  if (!authorizePost(agentId, conn)) return { error: "agent not authorized for this account's platform" };
  const v = validateContent(conn.platform, content);
  if (v.error) return v;
  const p = PLATFORM_BY_ID.get(conn.platform);
  const rate = rateState(connId, p.dailyCap);
  const confirmToken = mintConfirm(postHash(String(agentId || ""), connId, v.text));
  return {
    dryRun: true,
    confirmToken,
    preview: {
      agentId: String(agentId || "").slice(0, 64),
      platform: conn.platform,
      platformLabel: p.label,
      handle: conn.handle,
      content: v.text,
      chars: v.text.length,
      maxChars: p.maxChars,
      composio: !!COMPOSIO_KEY,
    },
    rate,
  };
}

/** EXECUTE — only after the BOSS confirms the F3 gate. Requires a fresh confirmToken
 *  from previewPost bound to this exact post. Posts via composio when configured,
 *  else returns a clearly-marked simulated post. */
export async function executePost({ agentId, connId, content, confirmToken }) {
  const conn = getConn(connId);
  if (!conn) return { error: "unknown connId" };
  if (!authorizePost(agentId, conn)) return { error: "agent not authorized for this account's platform" };
  const v = validateContent(conn.platform, content);
  if (v.error) return v;
  if (!consumeConfirm(String(confirmToken || ""), postHash(String(agentId || ""), connId, v.text)))
    return { error: "missing/expired/mismatched confirmToken — preview + confirm again" };
  const p = PLATFORM_BY_ID.get(conn.platform);
  const rate = rateState(connId, p.dailyCap);
  if (rate.remaining <= 0) {
    audit("post.ratelimited", { agentId, connId, platform: conn.platform });
    return { error: `rate limit: ${rate.used}/${rate.cap} posts to this account in 24h` };
  }

  let result;
  if (COMPOSIO_KEY) {
    // Real path: hand the connId's secret to the platform via composio. The secret
    // is decrypted HERE, used immediately, and never returned/logged/streamed.
    try {
      const secret = decrypt(conn.enc);
      result = await composioPost(conn.platform, conn.handle, v.text, secret);
    } catch (e) {
      audit("post.error", { agentId, connId, platform: conn.platform, err: e.message });
      return { error: "post failed: " + e.message };
    }
  } else {
    // Simulated path (no COMPOSIO_API_KEY) — clearly marked, nothing leaves the box.
    result = { simulated: true, postId: "sim_" + randomUUID().slice(0, 10), url: null };
  }

  // record the post for rate limiting + audit (content HASH, not raw, in the log)
  postTimes.get(connId).push(nowMs());
  audit("post.execute", {
    agentId, connId, platform: conn.platform, handle: conn.handle,
    chars: v.text.length, simulated: !!result.simulated, postId: result.postId,
  });
  return {
    ok: true,
    simulated: !!result.simulated,
    postId: result.postId,
    url: result.url ?? null,
    platform: conn.platform,
    handle: conn.handle,
    rate: rateState(connId, p.dailyCap),
  };
}

// composio bridge (only reached when COMPOSIO_API_KEY is set). Kept minimal +
// isolated so the secret's lifetime is a single call frame.
async function composioPost(platform, handle, text, secret) {
  void secret; // passed to composio auth in a real integration; never logged
  void handle;
  // A real wiring would call the composio MCP/REST action for `platform` here.
  // Without verified live credentials we do NOT fabricate a network call; surface
  // a clear, auditable error so a half-configured setup never silently "succeeds".
  throw new Error(`composio posting for ${platform} not wired in this build (set up composio + map connId→action)`);
}

// ── AUDIT (runtime log, outside the repo) ─────────────────────────────────────
export function audit(event, data) {
  try {
    ensureDirs();
    appendFileSync(AUDIT_FILE, `${new Date(nowMs()).toISOString()}\t${event}\t${JSON.stringify(data)}\n`, "utf-8");
  } catch {
    /* non-fatal */
  }
}
export function readAudit(limit = 100) {
  try {
    const lines = readFileSync(AUDIT_FILE, "utf-8").split("\n").filter((l) => l.trim());
    return lines.slice(-limit).reverse().map((l) => {
      const [at, event, ...rest] = l.split("\t");
      let data = {};
      try { data = JSON.parse(rest.join("\t")); } catch { /* ignore */ }
      return { at, event, data };
    });
  } catch {
    return [];
  }
}
// P8 (ADR-055) — AUDIT.log lines whose leading ISO timestamp falls in [from,to]
// (inclusive), oldest first — the audit-export slice. ISO timestamps compare
// lexicographically, so a string bound filters correctly. Absent bounds are open.
// The caller (export route) scrubs the result on egress. This log is bounded (append
// tail), so a read+filter is acceptable here while the large sections (deliveries,
// usage) stream row-by-row.
export function readAuditRange(from, to) {
  try {
    const lines = readFileSync(AUDIT_FILE, "utf-8").split("\n").filter((l) => l.trim());
    const out = [];
    for (const l of lines) {
      const [at, event, ...rest] = l.split("\t");
      if (from && at < String(from)) continue;
      if (to && at > String(to)) continue;
      let data = {};
      try { data = JSON.parse(rest.join("\t")); } catch { /* ignore */ }
      out.push({ at, event, data });
    }
    return out;
  } catch {
    return [];
  }
}

export const factoryMeta = {
  composio: !!COMPOSIO_KEY,
  skills: SKILL_CATALOG.length,
  platforms: PLATFORMS.map((p) => p.id),
};
