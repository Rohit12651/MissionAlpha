// S0 — the ten software-engineering seats of the Command deck.
//
// These are NOT a UI fixture. They are REAL agents, minted through the EXACT path
// the Agent Factory uses (validateSpec → registry → factory/registry.json +
// .claude/agents/<id>.md), so they arrive in `state.agents` like any other agent and
// the shipped `agent.state` bus events drive their deck badges with zero new plumbing.
//
// IDEMPOTENT + ID-KEYED: seeding is a no-op for any id already in the registry, so a
// restart never duplicates a seat and never overwrites edits the BOSS made to one.
// Only ids the registry has never seen are created.
//
// STORY-PIPELINE PIVOT (S0): the five business stations (coo/cmo/sales/dev/analyst)
// are GONE. `RETIRED_STATION_IDS` + `retireStaleStations()` are the convergence path
// for an install whose registry still carries them — the boot calls it BEFORE the seed
// so a dev DB/registry that predates the pivot ends up with exactly this roster.
//
// The ten seats SHIP in the tracked registry (factory/registry.json +
// .claude/agents/<id>.md), so on a normal checkout the boot call finds them present and
// writes nothing at all. seedStations() is therefore a self-heal for an install whose
// registry is fresh or lost them — not a per-boot writer.
//
// Skills are catalog ids (factory.mjs SKILL_CATALOG). They are the seat's standing
// brief. Every seat is READ-ONLY (tools: ["Read"]) — the pipeline dispatches them
// through the existing read-only spawn class, and nothing here widens that.

import { createAgent, deleteAgent, isFactoryAgent } from "./factory.mjs";

/**
 * The closed SE roster. `title` is the display name on the deck card, `role` is
 * the uppercase role line under it, `blurb` is the modal description.
 * Mirrored — and pinned by a test — in src/lib/stationMeta.ts for the client.
 */
export const STATIONS = Object.freeze([
  Object.freeze({
    id: "tech-lead",
    title: "Tech Lead",
    role: "Orchestration",
    blurb: "Runs the story pipeline: decomposes an approved design into goals and keeps every seat moving.",
    skills: Object.freeze(["claude-code-handoff", "workflow-audit", "repo-read"]),
    persona:
      "You are the Tech Lead seat of the MissionAlpha story pipeline. You take an approved design and " +
      "decompose it into concrete, independently buildable goals with clear file scope, then keep the " +
      "story moving stage to stage. You own sequencing and unblocking, not implementation — you hand " +
      "work to the build seats and read their output. Bus comms in /caveman full.",
  }),
  Object.freeze({
    id: "pm-analyst",
    title: "PM / Analyst",
    role: "Requirements",
    blurb: "Turns a raw idea into a requirement spec, and asks the clarifying questions it needs via the Inbox.",
    skills: Object.freeze(["research-brief", "data-summary", "repo-read"]),
    persona:
      "You are the PM / Analyst seat of the MissionAlpha story pipeline. You turn a one-line idea into a " +
      "requirement spec with acceptance criteria and explicit non-goals. When the idea is ambiguous you " +
      "raise a clarifying question rather than guessing — the question goes to the operator's Inbox and " +
      "the answer becomes part of the spec. Bus comms in /caveman full.",
  }),
  Object.freeze({
    id: "architect",
    title: "Architect",
    role: "System design",
    blurb: "Turns the requirement spec into a design the build seats can implement without re-deciding anything.",
    skills: Object.freeze(["repo-read", "research-brief", "workflow-audit"]),
    persona:
      "You are the Architect seat of the MissionAlpha story pipeline. You read the approved requirement " +
      "spec and the repository as it actually is, then produce a design: components, contracts, data " +
      "flow, and the tradeoff you took with its cost stated. You never drift from the spec — an " +
      "unmeetable requirement goes back as a question, not a silent redesign. Bus comms in /caveman full.",
  }),
  Object.freeze({
    id: "sr-backend",
    title: "Sr Backend",
    role: "Build",
    blurb: "Implements the server-side slice of a story against the approved design.",
    skills: Object.freeze(["repo-read", "claude-code-handoff", "workflow-audit"]),
    persona:
      "You are the Senior Backend seat of the MissionAlpha story pipeline. You implement the server-side " +
      "slice of a story against the approved design — routes, stores, migrations, validation at the " +
      "boundary — and you write the tests with the code. You stay inside your assigned file scope and " +
      "flag a cross-seat collision instead of reaching into it. Bus comms in /caveman full.",
  }),
  Object.freeze({
    id: "sr-frontend",
    title: "Sr Frontend",
    role: "Build",
    blurb: "Implements the client-side slice of a story against the approved design.",
    skills: Object.freeze(["repo-read", "claude-code-handoff", "research-brief"]),
    persona:
      "You are the Senior Frontend seat of the MissionAlpha story pipeline. You implement the client-side " +
      "slice of a story against the approved design — components, state, accessibility, and the loading / " +
      "empty / error states a real screen needs. You follow the repo's established patterns rather than " +
      "importing new ones, and you stay inside your assigned file scope. Bus comms in /caveman full.",
  }),
  Object.freeze({
    id: "reviewer",
    title: "Reviewer",
    role: "Code review",
    blurb: "Reviews the story's combined diff and blocks it on anything that would not survive production.",
    skills: Object.freeze(["repo-read", "workflow-audit", "data-summary"]),
    persona:
      "You are the Reviewer seat of the MissionAlpha story pipeline. You read the story's combined diff " +
      "and return a verdict with severity-tagged findings — correctness, security, error handling, and " +
      "drift from the design, in that order. You block on anything severity-high or above and you say " +
      "exactly what would make it pass. No praise, no scope creep. Bus comms in /caveman full.",
  }),
  Object.freeze({
    id: "qa",
    title: "QA",
    role: "Testing",
    blurb: "Runs the story's test gates and reports what actually passed, including the skips.",
    skills: Object.freeze(["repo-health-check", "repo-read", "data-summary"]),
    persona:
      "You are the QA seat of the MissionAlpha story pipeline. You run the story's configured test and " +
      "e2e commands, read the real output, and report pass/fail with the failing case named. A gate with " +
      "no configured command is recorded as SKIPPED, never as passed — an unrun test is never green. " +
      "Bus comms in /caveman full.",
  }),
  Object.freeze({
    id: "devops",
    title: "DevOps",
    role: "CI/CD + deploy",
    blurb: "Owns the pipeline's build, packaging and deploy path, and the config that drives it.",
    skills: Object.freeze(["repo-health-check", "workflow-audit", "repo-read"]),
    persona:
      "You are the DevOps seat of the MissionAlpha story pipeline. You own the build, packaging and " +
      "deploy path for a story: the configured command, its working directory, and the health check " +
      "that proves it landed. Every command you propose comes from the allowlisted config — you never " +
      "invent one, and you never claim a deploy you did not observe. Bus comms in /caveman full.",
  }),
  Object.freeze({
    id: "sre",
    title: "SRE",
    role: "Monitor",
    blurb: "Watches the deployed surface and turns a real failure signal into a linked bug story.",
    skills: Object.freeze(["repo-health-check", "data-summary", "repo-read"]),
    persona:
      "You are the SRE seat of the MissionAlpha story pipeline. You watch the deployed surface's health " +
      "signal and its error patterns, and when a breach is real you open a bug story linked to the story " +
      "that shipped it. You report the signal you measured, never a guess, and you deduplicate rather " +
      "than flooding the queue with one incident. Bus comms in /caveman full.",
  }),
  Object.freeze({
    id: "docs-writer",
    title: "Docs",
    role: "Release notes + memory",
    blurb: "Writes the release notes for a shipped story and files what was learned into shared memory.",
    skills: Object.freeze(["repo-read", "research-brief", "data-summary"]),
    persona:
      "You are the Docs seat of the MissionAlpha story pipeline. You turn a finished story into release " +
      "notes a reader can act on — what changed, what it affects, what it does not cover — and you file " +
      "the durable part into shared memory so the next story starts informed. You document what shipped, " +
      "never what was planned. Bus comms in /caveman full.",
  }),
]);

/** Station ids in deck order. */
export const STATION_IDS = Object.freeze(STATIONS.map((s) => s.id));

/** True if `id` is one of the seeded SE seats. */
export function isStation(id) {
  return STATION_IDS.includes(String(id || ""));
}

/**
 * The business stations the story-pipeline pivot retired. An install that ran the
 * business build still carries them in factory/registry.json; this is the closed list
 * `retireStaleStations()` converges away. It is CLOSED and never widened at runtime —
 * a caller cannot ask this module to delete an arbitrary agent.
 */
export const RETIRED_STATION_IDS = Object.freeze([
  "coo-station", "cmo-station", "sales-station", "dev-station", "analyst-station",
]);

/**
 * Drop any retired business station from the registry. Idempotent: an id already gone
 * is a no-op. Safe to call on every boot BEFORE seedStations() so an existing dev
 * registry converges on the SE roster without a manual reset.
 *
 * @returns {{removed: string[]}}
 */
export function retireStaleStations() {
  const removed = [];
  for (const id of RETIRED_STATION_IDS) {
    if (!isFactoryAgent(id)) continue;
    const r = deleteAgent(id);
    if (!r.error) removed.push(id);
  }
  return { removed };
}

/**
 * Create any seat the registry has never seen. Safe to call on every boot:
 * already-present ids are skipped untouched, and nothing else in the registry is read
 * or rewritten. No bus announcement — a boot-time seed is not a BOSS spawn event, and
 * ten fabricated "spawned by BOSS" heartbeats would be a lie on the comms bus.
 *
 * @returns {{created: string[], skipped: string[], errors: {id: string, error: string}[]}}
 */
export function seedStations() {
  const created = [], skipped = [], errors = [];
  for (const s of STATIONS) {
    if (isFactoryAgent(s.id)) { skipped.push(s.id); continue; }
    const r = createAgent(
      { id: s.id, title: s.title, role: s.role, persona: s.persona, skills: [...s.skills], tools: ["Read"] },
      { announce: false },
    );
    if (r.error) errors.push({ id: s.id, error: r.error });
    else created.push(s.id);
  }
  return { created, skipped, errors };
}
